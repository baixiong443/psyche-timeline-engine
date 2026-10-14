import type { RuntimeStorySourceContext } from '../engine/sourceContext';
import type { StorySourceAnalysisUnit } from '../model/source';
import type { StoryEvent, StoryPlan, StoryProjection } from '../model/types';
import { validateStoryPlan } from '../schema/validators';
import {
  beginSourceCompilationAttempt,
  getCompiledSourceEvents,
  getSourceCompilationRecord,
  markSourceCompilationFailed,
  putCompiledSourceWindow
} from '../storage/sourceDb';
import type { SillyTavernContext } from '../runtime/context';
import type { PsycheTimelineSettings } from '../runtime/settings';
import type { ActiveStory } from '../runtime/story';
import { generateText } from './extractor';
import { EXTRACTION_GENERATION_SCHEMA } from './schemas';

const START = '<<<PTE_SOURCE_WINDOW_JSON>>>';
const END = '<<<END_PTE_SOURCE_WINDOW_JSON>>>';

interface SourceWindowResponse {
  schemaVersion: 1;
  sourceUnitId: string;
  events: StoryEvent[];
}

function sourceWindowJson(response: string): unknown {
  const marked = response.match(/<<<PTE_SOURCE_WINDOW_JSON>>>\s*([\s\S]*?)\s*<<<END_PTE_SOURCE_WINDOW_JSON>>>/i)?.[1]?.trim();
  const text = (marked ?? response).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Fall through to the stable user-facing error below.
      }
    }
    throw new Error(marked ? '懒编译边界内不是有效 JSON。' : '懒编译输出不是有效 JSON，也没有完整边界标记。');
  }
}

function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function normalizeStringArray(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (typeof value !== 'string') return value;
  return value.split(/[,，、\n]/).map(item => item.trim()).filter(Boolean);
}

function normalizeEventKind(value: unknown): unknown {
  const kind = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, StoryEvent['kind']> = {
    hard: 'hard_anchor', hard_event: 'hard_anchor', hard_anchor: 'hard_anchor',
    soft: 'soft_anchor', soft_event: 'soft_anchor', soft_anchor: 'soft_anchor',
    character: 'character_beat', character_event: 'character_beat', character_beat: 'character_beat',
    transition: 'transition', atmosphere: 'atmosphere', atmospheric: 'atmosphere', chance: 'chance'
  };
  return aliases[kind] ?? value;
}

function normalizeEventRigidity(value: unknown): unknown {
  const rigidity = String(value ?? '').trim().toLowerCase();
  if (['hard', 'rigid', 'fixed'].includes(rigidity)) return 'hard';
  if (['soft', 'semi_fixed', 'semi-fixed'].includes(rigidity)) return 'soft';
  if (['flexible', 'free', 'adaptable'].includes(rigidity)) return 'flexible';
  return value;
}

function normalizeEventScope(value: unknown): unknown {
  const scope = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, 'world' | 'interpersonal'> = {
    world: 'world', global: 'world', world_scale: 'world', worldscale: 'world',
    environmental: 'world', disaster: 'world', ambient: 'world',
    interpersonal: 'interpersonal', character: 'interpersonal', personal: 'interpersonal',
    relationship: 'interpersonal', social: 'interpersonal'
  };
  return aliases[scope] ?? value;
}

function normalizeSourceEffect(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = structuredClone(value) as Record<string, unknown>;
  const args = firstDefined(source, ['args', 'parameters', 'params']);
  const base: Record<string, unknown> = { ...source };
  delete base.args;
  delete base.parameters;
  delete base.params;
  if (args && typeof args === 'object' && !Array.isArray(args)) Object.assign(base, args);
  base.id = firstDefined(base, ['id', 'operationId', 'operation_id']);
  base.type = firstDefined(base, ['type', 'operationType', 'operation_type']);
  base.evidenceIds = normalizeStringArray(firstDefined(base, ['evidenceIds', 'evidence_ids', 'evidenceRefs', 'evidence_refs']));
  delete base.operationId;
  delete base.operation_id;
  delete base.operationType;
  delete base.operation_type;
  delete base.evidence_ids;
  delete base.evidenceRefs;
  delete base.evidence_refs;
  return base;
}

export function normalizeSourceWindowWire(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const root = Array.isArray(value) ? { events: value } : value;
  let source = structuredClone(root) as Record<string, unknown>;
  const eventKeys = [
    'events', 'storyEvents', 'story_events', 'compiledEvents', 'compiled_events',
    'sourceEvents', 'source_events', 'timelineEvents', 'timeline_events', 'eventList', 'event_list',
    'event', 'storyEvent', 'story_event', 'compiledEvent', 'compiled_event', 'sourceEvent', 'source_event'
  ];
  const wrapped = firstDefined(source, ['result', 'data', 'output', 'response', 'payload', 'sourceWindow', 'source_window']);
  const rootEvents = firstDefined(source, eventKeys);
  if ((!Array.isArray(rootEvents) || rootEvents.length === 0)
    && wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
    source = wrapped as Record<string, unknown>;
  }
  const events = firstDefined(source, eventKeys);
  const eventList = events && typeof events === 'object' && !Array.isArray(events) ? [events] : events;
  return {
    schemaVersion: Number(firstDefined(source, ['schemaVersion', 'schema_version'])),
    sourceUnitId: firstDefined(source, ['sourceUnitId', 'source_unit_id', 'unitId', 'unit_id']),
    events: Array.isArray(eventList) ? eventList.map(candidate => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
      const event = candidate as Record<string, unknown>;
      const adaptation = firstDefined(event, ['adaptation', 'adaptationPolicy', 'adaptation_policy']);
      const adaptationRecord = adaptation && typeof adaptation === 'object' && !Array.isArray(adaptation)
        ? adaptation as Record<string, unknown>
        : {};
      const effects = firstDefined(event, ['effects', 'operations', 'stateChanges', 'state_changes']);
      return {
        id: firstDefined(event, ['id', 'eventId', 'event_id']),
        chapterId: firstDefined(event, ['chapterId', 'chapter_id']),
        sceneId: firstDefined(event, ['sceneId', 'scene_id']),
        canonicalOrder: Number(firstDefined(event, ['canonicalOrder', 'canonical_order', 'order'])),
        kind: normalizeEventKind(firstDefined(event, ['kind', 'eventKind', 'event_kind', 'eventType', 'event_type'])),
        rigidity: normalizeEventRigidity(firstDefined(event, ['rigidity', 'eventRigidity', 'event_rigidity'])),
        ...(firstDefined(event, ['scope', 'eventScope', 'event_scope']) !== undefined
          ? { scope: normalizeEventScope(firstDefined(event, ['scope', 'eventScope', 'event_scope'])) } : {}),
        summary: firstDefined(event, ['summary', 'description', 'eventSummary', 'event_summary']),
        participants: normalizeStringArray(firstDefined(event, ['participants', 'participantIds', 'participant_ids'])),
        ...(firstDefined(event, ['preconditions', 'precondition']) !== undefined
          ? { preconditions: firstDefined(event, ['preconditions', 'precondition']) } : {}),
        ...(firstDefined(event, ['forbiddenWhen', 'forbidden_when']) !== undefined
          ? { forbiddenWhen: firstDefined(event, ['forbiddenWhen', 'forbidden_when']) } : {}),
        effects: Array.isArray(effects) ? effects.map(normalizeSourceEffect) : effects,
        narrativePurposes: normalizeStringArray(firstDefined(event, ['narrativePurposes', 'narrative_purposes', 'purposes'])),
        evidenceRefs: normalizeStringArray(firstDefined(event, ['evidenceRefs', 'evidence_refs', 'evidenceIds', 'evidence_ids'])),
        revealPolicy: firstDefined(event, ['revealPolicy', 'reveal_policy']),
        adaptation: {
          allowDelay: firstDefined(adaptationRecord, ['allowDelay', 'allow_delay']),
          allowRelocation: firstDefined(adaptationRecord, ['allowRelocation', 'allow_relocation']),
          allowSubstitution: firstDefined(adaptationRecord, ['allowSubstitution', 'allow_substitution'])
        }
      };
    }) : eventList
  };
}

function sourceWindowSchema(unit: StorySourceAnalysisUnit, projection: StoryProjection) {
  const operation = EXTRACTION_GENERATION_SCHEMA.properties.operations.items;
  return {
    name: 'psyche_timeline_source_window',
    strict: true,
    returnInvalid: true,
    value: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'sourceUnitId', 'events'],
      properties: {
        schemaVersion: { const: 1 },
        sourceUnitId: { const: unit.id },
        events: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id', 'chapterId', 'sceneId', 'canonicalOrder', 'kind', 'rigidity', 'summary',
              'participants', 'effects', 'narrativePurposes', 'evidenceRefs', 'revealPolicy', 'adaptation'
            ],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 160 },
              chapterId: { type: 'string', minLength: 1, maxLength: 160 },
              sceneId: { type: 'string', minLength: 1, maxLength: 160 },
              canonicalOrder: { type: 'integer', minimum: projection.canonCursor.eventOrder + 1 },
              kind: { enum: ['hard_anchor', 'soft_anchor', 'character_beat', 'transition', 'atmosphere', 'chance'] },
              rigidity: { enum: ['hard', 'soft', 'flexible'] },
              scope: { enum: ['world', 'interpersonal'] },
              summary: { type: 'string', minLength: 1, maxLength: 1200 },
              participants: { type: 'array', items: { type: 'string' }, maxItems: 20 },
              effects: { type: 'array', items: operation, maxItems: 20 },
              narrativePurposes: { type: 'array', items: { type: 'string' }, maxItems: 20 },
              evidenceRefs: {
                type: 'array', minItems: 1, maxItems: unit.retrievalChunkIds.length,
                uniqueItems: true, items: { enum: unit.retrievalChunkIds }
              },
              revealPolicy: { enum: ['eligible_only', 'active_only', 'never'] },
              adaptation: {
                type: 'object',
                additionalProperties: false,
                required: ['allowDelay', 'allowRelocation', 'allowSubstitution'],
                properties: {
                  allowDelay: { type: 'boolean' },
                  allowRelocation: { type: 'boolean' },
                  allowSubstitution: { type: 'boolean' }
                }
              }
            }
          }
        }
      }
    }
  };
}

function sourceEventExample(projection: StoryProjection, unit: StorySourceAnalysisUnit): StoryEvent {
  return {
    id: `${unit.id}-event-1`,
    chapterId: projection.canonCursor.chapterId,
    sceneId: projection.canonCursor.sceneId,
    canonicalOrder: projection.canonCursor.eventOrder + 1,
    kind: 'character_beat',
    rigidity: 'flexible',
    scope: 'interpersonal',
    summary: '这里只写有原文证据支持、尚未向角色泄露未来结果的事件摘要。',
    participants: [],
    effects: [],
    narrativePurposes: [],
    evidenceRefs: [unit.retrievalChunkIds[0] ?? ''],
    revealPolicy: 'eligible_only',
    adaptation: { allowDelay: true, allowRelocation: true, allowSubstitution: false }
  };
}

function conciseValidationErrors(errors: string[], limit = 12): string {
  const visible = errors.slice(0, limit);
  const remaining = errors.length - visible.length;
  return `${visible.join('; ')}${remaining > 0 ? `; 其余 ${remaining} 项错误已省略` : ''}`;
}

function portableProjection(projection: StoryProjection): Record<string, unknown> {
  return {
    canonCursor: projection.canonCursor,
    time: projection.time,
    location: projection.location,
    characters: projection.characters,
    relationships: projection.relationships,
    inventory: projection.inventory,
    facts: projection.facts,
    knowledge: projection.knowledge,
    flags: projection.flags,
    narrativePurposes: projection.narrativePurposes,
    openThreads: projection.openThreads,
    divergence: projection.divergence
  };
}

export function buildSourceWindowCompilationPrompt(
  story: ActiveStory,
  projection: StoryProjection,
  unit: StorySourceAnalysisUnit,
  feedback = ''
): string {
  return `你是 PTE 的原作窗口编译 AI。只把给定原文单元编译成当前游标之后、可执行且可适配的 StoryEvent。\n` +
    `这是控制器内部调用，不能把未来事实写入当前状态、角色知识或关系。只输出 ${START} 与 ${END} 之间的 JSON。\n\n` +
    `硬规则：\n` +
    `- 根对象必须是 {"schemaVersion":1,"sourceUnitId":"${unit.id}","events":[]}。\n` +
    `- 输出 1 到 3 个事件；每个 canonicalOrder 必须大于 ${projection.canonCursor.eventOrder}，且不得与已有事件顺序重复。\n` +
    `- 每个 evidenceRefs 只能引用：${unit.retrievalChunkIds.join(', ')}，且至少一个。\n` +
    `- participants 只能使用当前状态已登记角色；未知角色先不编译为参与者。\n` +
    `- effects 只描述事件真正发生后才应用的变化，不得使用 transition_canon_event。\n` +
    `- effects 无法从原文安全确定时必须写 []；需要变化时使用 {"id","type","confidence","evidenceIds","args"} 协议，业务参数全部放入 args。\n` +
    `- preconditions/forbiddenWhen 用当前状态可验证字段；无法安全执行时宁可减少事件。\n` +
    `- scope 标明事件属于谁：世界级进程（天灾、战争、瘟疫、政权更迭）用 "world"；由角色行为与关系驱动的事件用 "interpersonal"。\n` +
    `- scope=world 的事件不会因为剧情分歧被自动放弃，所以必须用它真正的前因写 forbiddenWhen（例如堤坝已修复、敌军已被歼灭），不能用分歧度代替因果。\n` +
    `- revealPolicy 默认 eligible_only；秘密信息在条件满足前不能出现在事件摘要。\n` +
    `- 保留原作叙事目的，但允许 delay/relocation/substitution 必须按事件性质分别判断。\n` +
    `${feedback ? `\n上一版校验错误，必须修复：\n${feedback}\n` : ''}` +
    `\n【故事】\n${story.plan.title}\n` +
    `\n【当前分支状态】\n${JSON.stringify(portableProjection(projection))}\n` +
    `\n【已有事件摘要】\n${JSON.stringify(story.plan.events.map(event => ({ id: event.id, canonicalOrder: event.canonicalOrder, summary: event.summary })))}\n` +
    `\n【原文单元 ${unit.id} / ${unit.title}】\n${unit.text}\n` +
    `\n【完整事件结构示例】\n${JSON.stringify({ schemaVersion: 1, sourceUnitId: unit.id, events: [sourceEventExample(projection, unit)] })}\n` +
    `\n${START}\n{"schemaVersion":1,"sourceUnitId":"${unit.id}","events":[]}\n${END}`;
}

export function buildSourceWindowAuditPrompt(
  story: ActiveStory,
  projection: StoryProjection,
  unit: StorySourceAnalysisUnit,
  candidate: SourceWindowResponse,
  feedback = ''
): string {
  return `你是独立的 PTE 原作窗口审计 AI。核对候选事件与原文、当前分支和知识边界，直接输出修订后的完整对象。\n` +
    `不得增加无证据事件，不得把未来结果提前写成当前事实。只输出 ${START} 与 ${END} 之间的 JSON。\n` +
    `${feedback ? `上一版审计结果仍无效：${feedback}\n` : ''}` +
    `允许的 evidenceRefs：${unit.retrievalChunkIds.join(', ')}\n` +
    `当前 eventOrder：${projection.canonCursor.eventOrder}\n` +
    `已有事件：${JSON.stringify(story.plan.events.map(event => ({ id: event.id, order: event.canonicalOrder })))}\n` +
    `原文：\n${unit.text}\n\n候选：\n${JSON.stringify(candidate)}\n` +
    `完整结构示例：\n${JSON.stringify({ schemaVersion: 1, sourceUnitId: unit.id, events: [sourceEventExample(projection, unit)] })}\n` +
    `${START}\n（输出审计后的完整 JSON）\n${END}`;
}

export function validateSourceWindowResponse(
  value: unknown,
  story: ActiveStory,
  projection: StoryProjection,
  unit: StorySourceAnalysisUnit
): SourceWindowResponse {
  const normalized = normalizeSourceWindowWire(value);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) throw new Error('懒编译根节点必须是对象');
  const response = normalized as Partial<SourceWindowResponse>;
  if (!Array.isArray(response.events) || response.events.length < 1 || response.events.length > 3) {
    const rawKeys = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>).slice(0, 12).join(', ') || '无'
      : Array.isArray(value) ? '直接数组' : typeof value;
    const received = Array.isArray(response.events) ? `数组长度 ${response.events.length}` : typeof response.events;
    throw new Error(`懒编译必须输出 1 到 3 个事件（收到 ${received}；原始根字段：${rawKeys}）`);
  }
  const events = response.events as StoryEvent[];
  const existingIds = new Set(story.plan.events.map(event => event.id));
  const existingOrders = new Set(story.plan.events.map(event => event.canonicalOrder));
  const allowedEvidence = new Set(unit.retrievalChunkIds);
  const allowedParticipants = new Set(Object.keys(projection.characters));
  const newIds = new Set<string>();
  const newOrders = new Set<number>();
  for (const event of events) {
    if (!event || typeof event !== 'object') throw new Error('懒编译事件必须是对象');
    if (typeof event.id !== 'string' || !event.id || existingIds.has(event.id) || newIds.has(event.id)) throw new Error(`懒编译事件 ID 冲突：${String(event.id)}`);
    if (!Number.isInteger(event.canonicalOrder)
      || event.canonicalOrder <= projection.canonCursor.eventOrder
      || existingOrders.has(event.canonicalOrder)
      || newOrders.has(event.canonicalOrder)) throw new Error(`懒编译事件顺序无效：${String(event.canonicalOrder)}`);
    if (!Array.isArray(event.evidenceRefs) || event.evidenceRefs.length === 0
      || event.evidenceRefs.some(id => !allowedEvidence.has(id))) throw new Error(`事件 ${event.id} 的 evidenceRefs 越界`);
    if (!Array.isArray(event.participants)) throw new Error(`事件 ${event.id} 的 participants 必须是数组`);
    const unknownParticipants = event.participants.filter(id => !allowedParticipants.has(id));
    if (unknownParticipants.length > 0) {
      throw new Error(`事件 ${event.id} 的 participants 包含未知角色：${unknownParticipants.join('、')}`);
    }
    newIds.add(event.id);
    newOrders.add(event.canonicalOrder);
  }
  const initialState = structuredClone(story.plan.initialState);
  for (const event of events) initialState.canonEvents[event.id] = 'locked';
  const candidatePlan: StoryPlan = {
    ...structuredClone(story.plan),
    initialState,
    events: [...structuredClone(story.plan.events), ...structuredClone(events)]
      .sort((left, right) => left.canonicalOrder - right.canonicalOrder)
  };
  const validation = validateStoryPlan(candidatePlan);
  if (!validation.valid) throw new Error(`懒编译事件不符合 StoryPlan：${conciseValidationErrors(validation.errors)}`);
  return { schemaVersion: 1, sourceUnitId: unit.id, events: structuredClone(events) };
}

export function validateCachedSourceWindow(
  events: readonly StoryEvent[],
  story: ActiveStory,
  projection: StoryProjection,
  unit: StorySourceAnalysisUnit
): StoryEvent[] {
  const cachedIds = new Set(events.map(event => event.id));
  const validationStory = structuredClone(story);
  validationStory.plan.events = validationStory.plan.events.filter(event => !cachedIds.has(event.id));
  return validateSourceWindowResponse({
    schemaVersion: 1,
    sourceUnitId: unit.id,
    events: structuredClone(events)
  }, validationStory, projection, unit).events;
}

async function generateValidated(
  context: SillyTavernContext,
  prompt: (feedback: string) => string,
  profileId: string,
  fallback: boolean,
  story: ActiveStory,
  projection: StoryProjection,
  unit: StorySourceAnalysisUnit
): Promise<SourceWindowResponse> {
  let feedback = '';
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const raw = await generateText(context, {
        prompt: prompt(feedback),
        systemPrompt: '严格按照给定 JSON Schema 输出完整对象。不要输出解释；支持边界标记时保留边界标记。',
        responseLength: 3600,
        instructOverride: false,
        quietToLoud: false,
        jsonSchema: sourceWindowSchema(unit, projection)
      }, profileId, fallback);
      return validateSourceWindowResponse(sourceWindowJson(raw), story, projection, unit);
    } catch (error) {
      lastError = error;
      feedback = (error instanceof Error ? error.message : String(error)).slice(0, 6000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('原作窗口连续编译失败');
}

export async function compileAndAuditSourceWindow(
  context: SillyTavernContext,
  story: ActiveStory,
  projection: StoryProjection,
  unit: StorySourceAnalysisUnit,
  settings: PsycheTimelineSettings
): Promise<StoryEvent[]> {
  const candidate = await generateValidated(
    context,
    feedback => buildSourceWindowCompilationPrompt(story, projection, unit, feedback),
    settings.sourceCompilerProfileId || settings.extractorProfileId,
    settings.profileFallback,
    story,
    projection,
    unit
  );
  const audited = await generateValidated(
    context,
    feedback => buildSourceWindowAuditPrompt(story, projection, unit, candidate, feedback),
    settings.auditorProfileId,
    settings.profileFallback,
    story,
    projection,
    unit
  );
  return audited.events;
}

export async function ensureLazySourceCompilation(
  context: SillyTavernContext,
  story: ActiveStory,
  projection: StoryProjection,
  sourceContext: RuntimeStorySourceContext | null,
  settings: PsycheTimelineSettings
): Promise<StoryEvent[]> {
  const digest = story.card.package_digest;
  const unit = sourceContext?.compileUnit;
  if (!digest || !unit || !sourceContext || sourceContext.futureController.length === 0) return [];
  const existing = await getSourceCompilationRecord(digest, unit.id);
  if (existing?.level === 4 && existing.deepCompilationStatus === 'completed') {
    const eventIds = new Set(existing.eventIds);
    const cached = (await getCompiledSourceEvents(digest)).filter(event => eventIds.has(event.id));
    try {
      return validateCachedSourceWindow(cached, story, projection, unit);
    } catch (error) {
      const message = `缓存的原文窗口重新校验失败：${error instanceof Error ? error.message : String(error)}`;
      await markSourceCompilationFailed(digest, unit.id, message);
      throw new Error(message);
    }
  }
  if (existing?.deepCompilationStatus === 'failed') return [];
  const packaged = story.plan.events.filter(event => event.evidenceRefs.some(ref => unit.retrievalChunkIds.includes(ref)));
  if (packaged.length > 0) {
    await putCompiledSourceWindow(digest, unit.id, packaged);
    return packaged;
  }
  const attempt = await beginSourceCompilationAttempt(digest, unit.id);
  if (attempt !== 'started') return [];
  try {
    const events = await compileAndAuditSourceWindow(context, story, projection, unit, settings);
    await putCompiledSourceWindow(digest, unit.id, events);
    return events;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markSourceCompilationFailed(digest, unit.id, message);
    throw error;
  }
}

export function mergeCompiledEventsIntoPlan(plan: StoryPlan, events: readonly StoryEvent[]): StoryPlan {
  const existingById = new Map(plan.events.map(event => [event.id, event]));
  const existingByOrder = new Map(plan.events.map(event => [event.canonicalOrder, event.id]));
  const incomingIds = new Set<string>();
  const incomingOrders = new Set<number>();
  const added: StoryEvent[] = [];
  for (const event of events) {
    const sameId = existingById.get(event.id);
    if (sameId) {
      if (JSON.stringify(sameId) !== JSON.stringify(event)) {
        throw new Error(`缓存的懒编译事件 ID 与故事计划冲突：${event.id}`);
      }
      continue;
    }
    if (incomingIds.has(event.id)) throw new Error(`缓存的懒编译事件 ID 重复：${event.id}`);
    const sameOrder = existingByOrder.get(event.canonicalOrder);
    if (sameOrder || incomingOrders.has(event.canonicalOrder)) {
      throw new Error(`缓存的懒编译事件顺序冲突：${event.canonicalOrder}`);
    }
    incomingIds.add(event.id);
    incomingOrders.add(event.canonicalOrder);
    added.push(structuredClone(event));
  }
  if (added.length === 0) return plan;
  const initialState = structuredClone(plan.initialState);
  for (const event of added) initialState.canonEvents[event.id] ??= 'locked';
  const merged: StoryPlan = {
    ...structuredClone(plan),
    initialState,
    events: [...structuredClone(plan.events), ...structuredClone(added)]
      .sort((left, right) => left.canonicalOrder - right.canonicalOrder)
  };
  const validation = validateStoryPlan(merged);
  if (!validation.valid) throw new Error(`缓存的懒编译事件无效：${validation.errors.join('; ')}`);
  return merged;
}
