import { EXTENSION_KEY, MESSAGE_FIELD } from '../constants';
import type { MessageTimelineData, StoryProjection, TurnRecord } from '../model/types';
import { validateCardExtension, validateProjection, validateStoryPlan, validateTurnRecord } from '../schema/validators';
import { ensureMessageTimeline, getMessageId, mirrorAllSwipes, type SillyTavernMessage } from '../storage/messages';
import { hashJson } from '../utils/hash';
import type { SillyTavernContext } from './context';
import { validateStoryModeSettings, type ChatStoryBinding } from './story';

const BACKUP_FORMAT = 'psyche-timeline-backup';
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_MESSAGES = 200_000;

export interface TimelineBackupMessage {
  message_id: string;
  timeline: MessageTimelineData;
}

export interface TimelineBackupPayloadV1 {
  format: typeof BACKUP_FORMAT;
  schema_version: 1;
  exported_at: string;
  story_id: string;
  package_digest: string | null;
  binding: ChatStoryBinding;
  messages: TimelineBackupMessage[];
  projection: StoryProjection;
  projection_hash: string;
}

export interface TimelineBackupV1 extends TimelineBackupPayloadV1 {
  backup_hash: string;
}

export interface TimelineBackupPreview {
  storyId: string;
  packageDigest: string | null;
  exportedAt: string;
  messageCount: number;
  recordCount: number;
}

export interface TimelineStateSnapshot {
  hadBinding: boolean;
  binding: unknown;
  messages: Array<{ index: number; timeline: MessageTimelineData | undefined }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateBinding(value: unknown): ChatStoryBinding {
  if (!isRecord(value) || value.schema_version !== 1 || (value.source !== 'card' && value.source !== 'psychebook')) {
    throw new Error('备份中的故事绑定格式无效。');
  }
  const card = validateCardExtension(value.card);
  if (!card.valid || !card.value) throw new Error(`备份中的角色卡绑定无效：${card.errors.join('; ')}`);
  const inlinePlan = value.inline_plan === undefined ? undefined : validateStoryPlan(value.inline_plan);
  if (inlinePlan && (!inlinePlan.valid || !inlinePlan.value)) {
    throw new Error(`备份中的内联故事无效：${inlinePlan.errors.join('; ')}`);
  }
  if (value.package_digest !== undefined && typeof value.package_digest !== 'string') {
    throw new Error('备份中的故事包摘要格式无效。');
  }
  const manualRecords = value.manual_records;
  if (manualRecords !== undefined && !Array.isArray(manualRecords)) throw new Error('备份中的手动记录必须是数组。');
  const validatedManualRecords = (manualRecords ?? []).map((record, index) => {
    const validation = validateTurnRecord(record);
    if (!validation.valid || !validation.value) {
      throw new Error(`备份中的手动记录 ${index + 1} 无效：${validation.errors.join('; ')}`);
    }
    return validation.value;
  });
  const modeSettings = value.mode_settings === undefined ? undefined : validateStoryModeSettings(value.mode_settings);
  if (value.mode_settings !== undefined && !modeSettings) {
    throw new Error('备份中的聊天模式设置无效。');
  }
  return {
    schema_version: 1,
    source: value.source,
    card: card.value,
    ...(inlinePlan?.value ? { inline_plan: inlinePlan.value } : {}),
    ...(typeof value.package_digest === 'string' ? { package_digest: value.package_digest } : {}),
    ...(manualRecords !== undefined ? { manual_records: validatedManualRecords } : {}),
    ...(modeSettings ? { mode_settings: modeSettings } : {})
  };
}

function validateTimeline(value: unknown, expectedMessageId: string, recordIds: Set<string>): MessageTimelineData {
  if (!isRecord(value) || value.schema_version !== 1 || value.message_id !== expectedMessageId || !isRecord(value.records_by_swipe)) {
    throw new Error(`消息 ${expectedMessageId} 的时间线数据无效。`);
  }
  const recordsBySwipe: Record<string, TurnRecord> = {};
  for (const [key, candidate] of Object.entries(value.records_by_swipe)) {
    const swipeId = Number(key);
    if (!Number.isInteger(swipeId) || swipeId < 0) throw new Error(`消息 ${expectedMessageId} 包含无效 Swipe 编号：${key}`);
    const validation = validateTurnRecord(candidate);
    if (!validation.valid || !validation.value) {
      throw new Error(`消息 ${expectedMessageId} 的 Swipe ${key} 记录无效：${validation.errors.join('; ')}`);
    }
    if (validation.value.swipeId !== swipeId) throw new Error(`消息 ${expectedMessageId} 的 Swipe 编号与记录不一致。`);
    if (recordIds.has(validation.value.recordId)) throw new Error(`备份包含重复记录 ID：${validation.value.recordId}`);
    recordIds.add(validation.value.recordId);
    recordsBySwipe[key] = validation.value;
  }
  return { schema_version: 1, message_id: expectedMessageId, records_by_swipe: recordsBySwipe };
}

function nonSystemMessages(chat: SillyTavernMessage[]): Array<{ message: SillyTavernMessage; index: number }> {
  return chat
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => !message.is_system);
}

function countRecords(backup: TimelineBackupV1): number {
  return (backup.binding.manual_records?.length ?? 0)
    + backup.messages.reduce((sum, message) => sum + Object.keys(message.timeline.records_by_swipe).length, 0);
}

export function timelineBackupPreview(backup: TimelineBackupV1): TimelineBackupPreview {
  return {
    storyId: backup.story_id,
    packageDigest: backup.package_digest,
    exportedAt: backup.exported_at,
    messageCount: backup.messages.length,
    recordCount: countRecords(backup)
  };
}

export async function createTimelineBackup(
  context: SillyTavernContext,
  projection: StoryProjection
): Promise<TimelineBackupV1> {
  const binding = validateBinding(context.chatMetadata[EXTENSION_KEY]);
  if (binding.card.story_id !== projection.storyId) throw new Error('当前 Projection 与聊天故事绑定不一致。');
  const messages = nonSystemMessages(context.chat).map(({ message }) => {
    const timeline = ensureMessageTimeline(message);
    return { message_id: timeline.message_id, timeline: structuredClone(timeline) };
  });
  const projectionHash = await hashJson(projection);
  const payload: TimelineBackupPayloadV1 = {
    format: BACKUP_FORMAT,
    schema_version: 1,
    exported_at: new Date().toISOString(),
    story_id: projection.storyId,
    package_digest: binding.package_digest ?? binding.card.package_digest ?? null,
    binding: structuredClone(binding),
    messages,
    projection: structuredClone(projection),
    projection_hash: projectionHash
  };
  const backup = { ...payload, backup_hash: await hashJson(payload) };
  return parseTimelineBackupText(JSON.stringify(backup));
}

export async function parseTimelineBackupText(text: string): Promise<TimelineBackupV1> {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('时间线备份超过 64 MiB 上限。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`时间线备份不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || parsed.format !== BACKUP_FORMAT || parsed.schema_version !== 1) {
    throw new Error('文件不是受支持的时间线备份。');
  }
  if (typeof parsed.backup_hash !== 'string') throw new Error('时间线备份缺少完整性摘要。');
  const { backup_hash: backupHash, ...rawPayload } = parsed;
  if (await hashJson(rawPayload) !== backupHash) throw new Error('时间线备份完整性摘要不匹配。');
  if (
    typeof rawPayload.exported_at !== 'string'
    || !Number.isFinite(Date.parse(rawPayload.exported_at))
    || typeof rawPayload.story_id !== 'string'
    || rawPayload.story_id.length === 0
    || (rawPayload.package_digest !== null && typeof rawPayload.package_digest !== 'string')
    || !Array.isArray(rawPayload.messages)
    || rawPayload.messages.length > MAX_BACKUP_MESSAGES
    || typeof rawPayload.projection_hash !== 'string'
  ) {
    throw new Error('时间线备份头信息无效。');
  }
  const binding = validateBinding(rawPayload.binding);
  const bindingDigest = binding.package_digest ?? binding.card.package_digest ?? null;
  if (bindingDigest !== rawPayload.package_digest) throw new Error('时间线备份中的故事包摘要不一致。');
  const projectionValidation = validateProjection(rawPayload.projection);
  if (!projectionValidation.valid || !projectionValidation.value) {
    throw new Error(`时间线备份中的 Projection 无效：${projectionValidation.errors.join('; ')}`);
  }
  if (await hashJson(projectionValidation.value) !== rawPayload.projection_hash) {
    throw new Error('时间线备份中的 Projection 摘要不匹配。');
  }
  if (
    binding.card.story_id !== rawPayload.story_id
    || projectionValidation.value.storyId !== rawPayload.story_id
  ) {
    throw new Error('时间线备份中的故事 ID 不一致。');
  }
  const recordIds = new Set<string>();
  for (const record of binding.manual_records ?? []) {
    if (recordIds.has(record.recordId)) throw new Error(`备份包含重复记录 ID：${record.recordId}`);
    recordIds.add(record.recordId);
  }
  const messageIds = new Set<string>();
  const messages = rawPayload.messages.map((candidate, index) => {
    if (!isRecord(candidate) || typeof candidate.message_id !== 'string' || candidate.message_id.length === 0) {
      throw new Error(`备份中的第 ${index + 1} 条消息缺少 UUID。`);
    }
    if (messageIds.has(candidate.message_id)) throw new Error(`备份包含重复消息 UUID：${candidate.message_id}`);
    messageIds.add(candidate.message_id);
    return {
      message_id: candidate.message_id,
      timeline: validateTimeline(candidate.timeline, candidate.message_id, recordIds)
    };
  });
  const knownRecordIds = recordIds;
  for (const record of [
    ...(binding.manual_records ?? []),
    ...messages.flatMap(message => Object.values(message.timeline.records_by_swipe))
  ]) {
    if (record.parentRecordId && !knownRecordIds.has(record.parentRecordId)) {
      throw new Error(`记录 ${record.recordId} 引用了备份中不存在的父记录 ${record.parentRecordId}。`);
    }
  }
  return {
    format: BACKUP_FORMAT,
    schema_version: 1,
    exported_at: rawPayload.exported_at,
    story_id: rawPayload.story_id,
    package_digest: rawPayload.package_digest,
    binding,
    messages,
    projection: projectionValidation.value,
    projection_hash: rawPayload.projection_hash,
    backup_hash: backupHash
  };
}

export async function parseTimelineBackupFile(file: File): Promise<TimelineBackupV1> {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('时间线备份超过 64 MiB 上限。');
  return parseTimelineBackupText(await file.text());
}

export function inspectTimelineBackupTarget(context: SillyTavernContext, backup: TimelineBackupV1): string[] {
  const currentIds = nonSystemMessages(context.chat).map(({ message }) => getMessageId(message));
  const backupIds = backup.messages.map(message => message.message_id);
  if (currentIds.some(id => !id)) return ['当前聊天存在没有稳定 UUID 的消息，无法安全恢复。'];
  if (currentIds.length !== backupIds.length) return ['备份与当前聊天的消息数量不同，已拒绝恢复。'];
  const mismatch = currentIds.findIndex((id, index) => id !== backupIds[index]);
  if (mismatch >= 0) return [`备份与当前聊天在第 ${mismatch + 1} 条消息的 UUID 不一致，已拒绝恢复。`];
  const currentBinding = context.chatMetadata[EXTENSION_KEY];
  if (isRecord(currentBinding)) {
    const card = validateCardExtension(currentBinding.card);
    if (card.valid && card.value && card.value.story_id !== backup.story_id) {
      return ['备份故事 ID 与当前聊天不同，已拒绝恢复。'];
    }
  }
  return [];
}

export function captureTimelineState(context: SillyTavernContext): TimelineStateSnapshot {
  return {
    hadBinding: Object.hasOwn(context.chatMetadata, EXTENSION_KEY),
    binding: structuredClone(context.chatMetadata[EXTENSION_KEY]),
    messages: context.chat.map((message, index) => ({
      index,
      timeline: message[MESSAGE_FIELD] ? structuredClone(message[MESSAGE_FIELD]) : undefined
    }))
  };
}

function replaceTimeline(message: SillyTavernMessage, timeline: MessageTimelineData | undefined): void {
  if (timeline) message[MESSAGE_FIELD] = structuredClone(timeline);
  else delete message[MESSAGE_FIELD];
  if (message.extra) delete message.extra[MESSAGE_FIELD];
  for (const swipe of message.swipe_info ?? []) {
    if (swipe.extra) delete swipe.extra[MESSAGE_FIELD];
  }
  if (timeline) mirrorAllSwipes(message);
}

export function applyTimelineBackup(context: SillyTavernContext, backup: TimelineBackupV1): void {
  const errors = inspectTimelineBackupTarget(context, backup);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  context.chatMetadata[EXTENSION_KEY] = structuredClone(backup.binding);
  const targets = nonSystemMessages(context.chat);
  targets.forEach(({ message }, index) => replaceTimeline(message, backup.messages[index]!.timeline));
}

export function restoreTimelineState(context: SillyTavernContext, snapshot: TimelineStateSnapshot): void {
  if (snapshot.hadBinding) context.chatMetadata[EXTENSION_KEY] = structuredClone(snapshot.binding);
  else delete context.chatMetadata[EXTENSION_KEY];
  for (const item of snapshot.messages) {
    const message = context.chat[item.index];
    if (message) replaceTimeline(message, item.timeline);
  }
}
