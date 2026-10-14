import { CARD_EXTENSION_KEY, EXTENSION_KEY } from '../constants';
import { createEmptyProjection } from '../model/defaults';
import type { InstalledPsycheBook } from '../model/package';
import type { CardTimelineExtension, StoryPlan, StoryProjection, TurnRecord } from '../model/types';
import { validateCardExtension, validateStoryPlan, validateTurnRecord } from '../schema/validators';
import { getInstalledPsycheBook } from '../storage/packageDb';
import { getCompiledSourceEvents } from '../storage/sourceDb';
import { mergeCompiledEventsIntoPlan } from '../ai/sourceCompiler';
import type { SillyTavernContext } from './context';
import type { SillyTavernMessage } from '../storage/messages';
import type { StoryModeSettings } from './settings';

export interface ChatStoryBinding {
  schema_version: 1;
  source: 'card' | 'psychebook';
  card: CardTimelineExtension;
  inline_plan?: StoryPlan;
  package_digest?: string;
  manual_records?: TurnRecord[];
  mode_settings?: StoryModeSettings;
}

export interface ActiveStory {
  source: ChatStoryBinding['source'];
  card: CardTimelineExtension;
  plan: StoryPlan;
  packageStatus: 'inline' | 'verified';
  packageVersion: string | null;
}

export type StoryBindingIssueCode =
  | 'invalid_binding'
  | 'missing_digest'
  | 'missing_package'
  | 'digest_mismatch'
  | 'story_mismatch'
  | 'unsupported_version';

export interface StoryBindingIssue {
  code: StoryBindingIssueCode;
  message: string;
  storyId: string | null;
  packageDigest: string | null;
}

export interface ActiveStoryResolution {
  story: ActiveStory | null;
  issue: StoryBindingIssue | null;
}

export interface ManualRecordReadResult {
  records: TurnRecord[];
  errors: string[];
}

function rawChatBinding(context: SillyTavernContext): ChatStoryBinding | null {
  const value = context.chatMetadata[EXTENSION_KEY];
  return value && typeof value === 'object' ? value as ChatStoryBinding : null;
}

export function validateStoryModeSettings(value: unknown): StoryModeSettings | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<StoryModeSettings>;
  if (!['follow', 'adaptive', 'parallel', 'free'].includes(String(candidate.participationMode))) return null;
  if (!['off', 'standard', 'strict'].includes(String(candidate.auditMode))) return null;
  if (typeof candidate.autoApply !== 'boolean') return null;
  return {
    participationMode: candidate.participationMode!,
    auditMode: candidate.auditMode!,
    autoApply: candidate.autoApply
  };
}

export function readChatModeSettings(context: SillyTavernContext): StoryModeSettings | null {
  return validateStoryModeSettings(rawChatBinding(context)?.mode_settings);
}

export function readManualTurnRecords(context: SillyTavernContext): ManualRecordReadResult {
  const raw = rawChatBinding(context)?.manual_records;
  if (!Array.isArray(raw)) return { records: [], errors: [] };
  const records: TurnRecord[] = [];
  const errors: string[] = [];
  raw.forEach((candidate, index) => {
    const validation = validateTurnRecord(candidate);
    if (validation.valid && validation.value) records.push(candidate);
    else errors.push(`manual-${index + 1}: ${validation.errors.join('; ')}`);
  });
  return { records, errors };
}

export function appendManualTurnRecord(context: SillyTavernContext, record: TurnRecord): void {
  const binding = rawChatBinding(context);
  if (!binding) throw new Error('Current chat has no story binding.');
  binding.manual_records ??= [];
  binding.manual_records.push(structuredClone(record));
}

export function findManualTurnRecord(context: SillyTavernContext, recordId: string): TurnRecord | null {
  return rawChatBinding(context)?.manual_records?.find(record => record.recordId === recordId) ?? null;
}

function cardFromCharacter(context: SillyTavernContext): CardTimelineExtension | null {
  if (context.groupId != null || context.characterId === undefined) return null;
  const raw = context.characters[context.characterId]?.data?.extensions?.[CARD_EXTENSION_KEY];
  const result = validateCardExtension(raw);
  return result.valid ? result.value ?? null : null;
}

function boundCharacterIdFromIndex(
  context: SillyTavernContext,
  characterIndex: number,
  storyId: string
): string | null {
  const character = context.characters[characterIndex];
  if (!character) return null;
  const result = validateCardExtension(character.data?.extensions?.[CARD_EXTENSION_KEY]);
  if (result.valid && result.value?.story_id === storyId) return result.value.bindings.character_id;
  return null;
}

function projectionCharacterFallback(
  context: SillyTavernContext,
  projection: StoryProjection,
  characterIndex: number
): string | null {
  const character = context.characters[characterIndex];
  const candidates = [character?.name, character?.avatar].filter((value): value is string => Boolean(value));
  return candidates.find(id => Object.hasOwn(projection.characters, id) || Object.hasOwn(projection.knowledge, id)) ?? null;
}

export function resolveGenerationCharacterId(
  context: SillyTavernContext,
  story: ActiveStory,
  projection: StoryProjection,
  draftedCharacterIndex?: number
): string | null {
  const characterIndex = draftedCharacterIndex ?? Number(context.characterId);
  if (Number.isInteger(characterIndex) && characterIndex >= 0) {
    return boundCharacterIdFromIndex(context, characterIndex, story.plan.storyId)
      ?? projectionCharacterFallback(context, projection, characterIndex)
      ?? (context.groupId == null ? story.card.bindings.character_id : null);
  }
  return context.groupId == null ? story.card.bindings.character_id : null;
}

export function resolveMessageCharacterId(
  context: SillyTavernContext,
  story: ActiveStory,
  projection: StoryProjection,
  message: SillyTavernMessage
): string | null {
  const characterIndex = context.characters.findIndex(character => (
    Boolean(message.original_avatar) && character.avatar === message.original_avatar
  ) || (
    !message.original_avatar && Boolean(message.name) && character.name === message.name
  ));
  if (characterIndex >= 0) {
    return boundCharacterIdFromIndex(context, characterIndex, story.plan.storyId)
      ?? projectionCharacterFallback(context, projection, characterIndex)
      ?? (context.groupId == null ? story.card.bindings.character_id : null);
  }
  return context.groupId == null ? story.card.bindings.character_id : null;
}

function bindingFromChat(context: SillyTavernContext): ChatStoryBinding | null {
  const raw = context.chatMetadata[EXTENSION_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<ChatStoryBinding>;
  if (candidate.schema_version !== 1 || (candidate.source !== 'card' && candidate.source !== 'psychebook')) return null;
  const card = validateCardExtension(candidate.card);
  if (!card.valid || !card.value) return null;
  const inline = candidate.inline_plan ? validateStoryPlan(candidate.inline_plan) : null;
  if (candidate.inline_plan && (!inline?.valid || !inline.value)) return null;
  return {
    schema_version: 1,
    source: candidate.source,
    card: card.value,
    inline_plan: inline?.value,
    package_digest: candidate.package_digest,
    manual_records: Array.isArray(candidate.manual_records) ? candidate.manual_records : undefined,
    mode_settings: validateStoryModeSettings(candidate.mode_settings) ?? undefined
  };
}

function planFromCard(card: CardTimelineExtension): StoryPlan | null {
  if (card.inline_plan) return card.inline_plan;
  if (!card.initial_state) return null;
  const initial = structuredClone(card.initial_state);
  initial.storyId = card.story_id;
  return {
    schemaVersion: 1,
    storyId: card.story_id,
    title: card.story_id,
    initialState: initial,
    events: []
  };
}

async function planFromPackage(card: CardTimelineExtension): Promise<StoryPlan | null> {
  if (!card.package_digest) return null;
  const book = await getInstalledPsycheBook(card.package_digest);
  if (!book || book.manifest.story_id !== card.story_id) return null;
  return mergeCompiledEventsIntoPlan(book.plan, await getCompiledSourceEvents(card.package_digest));
}

export function inspectPackageBinding(
  binding: ChatStoryBinding,
  book: InstalledPsycheBook | undefined
): StoryBindingIssue | null {
  if (binding.source !== 'psychebook') return null;
  const bindingDigest = binding.package_digest ?? null;
  const cardDigest = binding.card.package_digest ?? null;
  const packageDigest = bindingDigest ?? cardDigest;
  const issue = (code: StoryBindingIssueCode, message: string): StoryBindingIssue => ({
    code,
    message,
    storyId: binding.card.story_id || null,
    packageDigest
  });
  if (!packageDigest) return issue('missing_digest', '当前聊天没有记录故事包摘要，请重新导入原故事包。');
  if (bindingDigest && cardDigest && bindingDigest !== cardDigest) {
    return issue('digest_mismatch', '聊天绑定与角色卡记录的故事包摘要不一致，已停止加载。');
  }
  if (!book) return issue('missing_package', '当前设备缺少此聊天绑定的故事包，请重新导入摘要匹配的原文件。');
  if (book.digest !== packageDigest || book.card.package_digest !== packageDigest) {
    return issue('digest_mismatch', '已安装故事包的摘要与聊天绑定不一致，已停止加载。');
  }
  if (book.manifest.schema_version !== '1.0' || book.manifest.format !== 'psychebook') {
    return issue('unsupported_version', '故事包格式版本不受当前扩展支持，请升级扩展或重新导出故事包。');
  }
  if (
    book.manifest.story_id !== binding.card.story_id
    || book.card.story_id !== binding.card.story_id
    || book.plan.storyId !== binding.card.story_id
  ) {
    return issue('story_mismatch', '故事包中的故事 ID 与当前聊天绑定不一致，已停止加载。');
  }
  return null;
}

export async function resolveActiveStoryWithStatus(context: SillyTavernContext): Promise<ActiveStoryResolution> {
  const rawBinding = context.chatMetadata[EXTENSION_KEY];
  if (rawBinding !== undefined && rawBinding !== null) {
    const binding = bindingFromChat(context);
    if (!binding) {
      return {
        story: null,
        issue: {
          code: 'invalid_binding',
          message: '当前聊天的时间线绑定数据无效或版本不受支持。',
          storyId: null,
          packageDigest: null
        }
      };
    }
    if (binding.source === 'psychebook') {
      const digest = binding.package_digest ?? binding.card.package_digest;
      const book = digest ? await getInstalledPsycheBook(digest) : undefined;
      const issue = inspectPackageBinding(binding, book);
      if (issue) return { story: null, issue };
      return {
        story: {
          source: binding.source,
          card: binding.card,
          plan: mergeCompiledEventsIntoPlan(book!.plan, await getCompiledSourceEvents(digest!)),
          packageStatus: 'verified',
          packageVersion: book!.manifest.version
        },
        issue: null
      };
    }
    const plan = binding.inline_plan ?? await planFromPackage(binding.card) ?? planFromCard(binding.card);
    if (!plan) {
      return {
        story: null,
        issue: {
          code: 'invalid_binding',
          message: '当前角色卡绑定没有可加载的内联时间线。',
          storyId: binding.card.story_id,
          packageDigest: binding.card.package_digest ?? null
        }
      };
    }
    return {
      story: {
        source: binding.source,
        card: binding.card,
        plan,
        packageStatus: binding.card.package_digest ? 'verified' : 'inline',
        packageVersion: null
      },
      issue: null
    };
  }

  const card = cardFromCharacter(context);
  if (!card) return { story: null, issue: null };
  const plan = await planFromPackage(card) ?? planFromCard(card);
  if (!plan) return { story: null, issue: null };
  return {
    story: {
      source: 'card',
      card,
      plan,
      packageStatus: card.package_digest ? 'verified' : 'inline',
      packageVersion: null
    },
    issue: null
  };
}

export async function resolveActiveStory(context: SillyTavernContext): Promise<ActiveStory | null> {
  return (await resolveActiveStoryWithStatus(context)).story;
}

export function createManualStory(
  storyId: string,
  title: string,
  characterId: string,
  userRoleId?: string
): ActiveStory {
  const initial = createEmptyProjection(storyId);
  initial.location = { area: '未记录', place: '未记录', position: '未记录' };
  initial.characters[characterId] = { present: true };
  if (userRoleId && userRoleId !== characterId) initial.characters[userRoleId] = { present: true };
  const card: CardTimelineExtension = {
    schema_version: '1.0',
    story_id: storyId,
    entry_point: { chapter_id: 'start', scene_id: 'start' },
    bindings: { character_id: characterId, user_role_id: userRoleId },
    initial_state: initial
  };
  return {
    source: 'card',
    card,
    packageStatus: 'inline',
    packageVersion: null,
    plan: {
      schemaVersion: 1,
      storyId,
      title,
      initialState: initial,
      events: []
    }
  };
}

export function bindStoryToChat(
  context: SillyTavernContext,
  story: ActiveStory,
  modeSettings?: StoryModeSettings
): void {
  const binding: ChatStoryBinding = {
    schema_version: 1,
    source: story.source,
    card: structuredClone(story.card),
    inline_plan: story.source === 'card' ? structuredClone(story.plan) : undefined,
    package_digest: story.card.package_digest,
    mode_settings: modeSettings ? structuredClone(modeSettings) : undefined
  };
  context.chatMetadata[EXTENSION_KEY] = binding;
}

export function writeChatModeSettings(
  context: SillyTavernContext,
  story: ActiveStory,
  settings: StoryModeSettings
): void {
  let binding = rawChatBinding(context);
  if (!binding || binding.card?.story_id !== story.card.story_id) {
    bindStoryToChat(context, story, settings);
    return;
  }
  binding.mode_settings = structuredClone(settings);
}
