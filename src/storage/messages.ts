import { MESSAGE_FIELD } from '../constants';
import { validateTurnRecord } from '../schema/validators';
import { sha256Text } from '../utils/hash';
import type {
  MessageTimelineData,
  SwipeTimelineMirror,
  TurnRecord
} from '../model/types';

export interface SillyTavernSwipeInfo {
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SillyTavernMessage {
  name?: string;
  original_avatar?: string;
  mes?: string;
  is_user?: boolean;
  is_system?: boolean;
  swipe_id?: number;
  swipes?: string[];
  swipe_info?: SillyTavernSwipeInfo[];
  extra?: Record<string, unknown>;
  [MESSAGE_FIELD]?: MessageTimelineData;
  [key: string]: unknown;
}

export type IdFactory = () => string;

export function activeSwipeId(message: SillyTavernMessage): number {
  const value = Number(message.swipe_id ?? 0);
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

function isTimelineData(value: unknown): value is MessageTimelineData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<MessageTimelineData>;
  return data.schema_version === 1
    && typeof data.message_id === 'string'
    && data.message_id.length > 0
    && Boolean(data.records_by_swipe)
    && typeof data.records_by_swipe === 'object';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function persistedMirrors(message: SillyTavernMessage): Array<{ mirror: Record<string, unknown>; swipeId: number }> {
  const mirrors: Array<{ mirror: Record<string, unknown>; swipeId: number }> = [];
  const current = message.extra?.[MESSAGE_FIELD];
  if (isRecord(current)) mirrors.push({ mirror: current, swipeId: activeSwipeId(message) });
  for (const [swipeId, swipe] of (message.swipe_info ?? []).entries()) {
    const candidate = swipe.extra?.[MESSAGE_FIELD];
    if (isRecord(candidate)) mirrors.push({ mirror: candidate, swipeId });
  }
  return mirrors;
}

function persistedMessageId(message: SillyTavernMessage): string | null {
  for (const { mirror } of persistedMirrors(message)) {
    const timeline = mirror.timeline;
    if (isTimelineData(timeline)) return timeline.message_id;
    if (typeof mirror.message_id === 'string' && mirror.message_id.length > 0) return mirror.message_id;
  }
  return null;
}

function hydrateTimelineFromMirrors(message: SillyTavernMessage, timeline: MessageTimelineData): void {
  for (const { mirror, swipeId } of persistedMirrors(message)) {
    const persistedTimeline = mirror.timeline;
    if (isTimelineData(persistedTimeline) && persistedTimeline.message_id === timeline.message_id) {
      for (const [key, candidate] of Object.entries(persistedTimeline.records_by_swipe)) {
        if (timeline.records_by_swipe[key]) continue;
        const validation = validateTurnRecord(candidate);
        if (validation.valid && validation.value && validation.value.swipeId === Number(key)) {
          timeline.records_by_swipe[key] = structuredClone(validation.value);
        }
      }
    }

    if (mirror.message_id !== timeline.message_id || timeline.records_by_swipe[String(swipeId)]) continue;
    const validation = validateTurnRecord(mirror.record);
    if (validation.valid && validation.value && validation.value.swipeId === swipeId) {
      timeline.records_by_swipe[String(swipeId)] = structuredClone(validation.value);
    }
  }
}

function clearPersistedMirrors(message: SillyTavernMessage): void {
  if (message.extra) delete message.extra[MESSAGE_FIELD];
  for (const swipe of message.swipe_info ?? []) {
    if (swipe.extra) delete swipe.extra[MESSAGE_FIELD];
  }
}

export function ensureMessageTimeline(
  message: SillyTavernMessage,
  createId: IdFactory = () => crypto.randomUUID()
): MessageTimelineData {
  const current = message[MESSAGE_FIELD];
  const timeline = isTimelineData(current)
    ? current
    : {
        schema_version: 1 as const,
        message_id: persistedMessageId(message) ?? createId(),
        records_by_swipe: {}
      };
  hydrateTimelineFromMirrors(message, timeline);
  if (!isTimelineData(current)) message[MESSAGE_FIELD] = timeline;
  return timeline;
}

export function ensureChatMessageIds(
  chat: SillyTavernMessage[],
  createId: IdFactory = () => crypto.randomUUID()
): number {
  let created = 0;
  for (const message of chat) {
    if (message.is_system) continue;
    const missing = !isTimelineData(message[MESSAGE_FIELD]);
    ensureMessageTimeline(message, createId);
    if (missing) created += 1;
  }
  return created;
}

export function getMessageId(message: SillyTavernMessage): string | null {
  const timeline = message[MESSAGE_FIELD];
  return isTimelineData(timeline) ? timeline.message_id : null;
}

export function getSwipeRecord(message: SillyTavernMessage, swipeId = activeSwipeId(message)): TurnRecord | null {
  const timeline = message[MESSAGE_FIELD];
  if (!isTimelineData(timeline)) return null;
  return timeline.records_by_swipe[String(swipeId)] ?? null;
}

export function setSwipeRecord(
  message: SillyTavernMessage,
  record: TurnRecord,
  createId?: IdFactory
): TurnRecord {
  const timeline = ensureMessageTimeline(message, createId);
  const persisted = structuredClone(record);
  timeline.records_by_swipe[String(record.swipeId)] = persisted;
  mirrorSwipe(message, record.swipeId);
  return persisted;
}

function createMirror(
  message: SillyTavernMessage,
  swipeId: number,
  includeTimeline = false
): SwipeTimelineMirror {
  const timeline = ensureMessageTimeline(message);
  const record = timeline.records_by_swipe[String(swipeId)] ?? null;
  return {
    schema_version: 1,
    message_id: timeline.message_id,
    swipe_id: swipeId,
    record_id: record?.recordId ?? null,
    application_status: record?.application.status ?? 'none',
    audit_status: record?.audit.status ?? 'none',
    projection_hash: record?.projectionHash ?? null,
    turn: record?.checkpoint?.turn ?? null,
    record: record ? structuredClone(record) : null,
    ...(includeTimeline ? { timeline: structuredClone(timeline) } : {})
  };
}

export function mirrorSwipe(message: SillyTavernMessage, swipeId: number): SwipeTimelineMirror {
  const mirror = createMirror(message, swipeId);
  const activeMirror = createMirror(message, activeSwipeId(message), true);
  message.extra ??= {};
  message.extra[MESSAGE_FIELD] = structuredClone(activeMirror);

  const swipeInfo = message.swipe_info?.[swipeId];
  if (swipeInfo) {
    swipeInfo.extra ??= {};
    swipeInfo.extra[MESSAGE_FIELD] = structuredClone(mirror);
  }
  return mirror;
}

export function mirrorActiveSwipe(message: SillyTavernMessage): SwipeTimelineMirror {
  return mirrorSwipe(message, activeSwipeId(message));
}

export function mirrorAllSwipes(message: SillyTavernMessage): SwipeTimelineMirror {
  const timeline = ensureMessageTimeline(message);
  const swipeIds = new Set<number>([
    activeSwipeId(message),
    ...(message.swipe_info ?? []).map((_, index) => index),
    ...Object.keys(timeline.records_by_swipe).map(Number).filter(Number.isInteger)
  ]);
  for (const swipeId of swipeIds) mirrorSwipe(message, swipeId);
  return mirrorActiveSwipe(message);
}

export function reindexRecordsAfterSwipeDeletion(message: SillyTavernMessage, deletedSwipeId: number): void {
  const timeline = ensureMessageTimeline(message);
  const reindexed: Record<string, TurnRecord> = {};

  for (const [key, record] of Object.entries(timeline.records_by_swipe)) {
    const oldSwipeId = Number(key);
    if (!Number.isInteger(oldSwipeId) || oldSwipeId === deletedSwipeId) continue;
    const newSwipeId = oldSwipeId > deletedSwipeId ? oldSwipeId - 1 : oldSwipeId;
    reindexed[String(newSwipeId)] = { ...record, swipeId: newSwipeId };
  }

  timeline.records_by_swipe = reindexed;
  clearPersistedMirrors(message);
  mirrorAllSwipes(message);
}

export function collectActiveTurnRecords(chat: SillyTavernMessage[]): TurnRecord[] {
  const records: TurnRecord[] = [];
  for (const message of chat) {
    if (message.is_user || message.is_system) continue;
    const record = getSwipeRecord(message);
    if (record) records.push(record);
  }
  return records;
}

function textForSwipe(message: SillyTavernMessage, swipeId: number): string | null {
  const stored = message.swipes?.[swipeId];
  if (typeof stored === 'string') return stored;
  if (activeSwipeId(message) === swipeId && typeof message.mes === 'string') return message.mes;
  return null;
}

export async function invalidateRecordsWithChangedContent(chat: SillyTavernMessage[]): Promise<number> {
  const messagesById = new Map<string, SillyTavernMessage>();
  const records: Array<{ message: SillyTavernMessage; record: TurnRecord }> = [];
  for (const message of chat) {
    const messageId = getMessageId(message);
    if (messageId) messagesById.set(messageId, message);
    const timeline = message[MESSAGE_FIELD];
    if (isTimelineData(timeline)) {
      for (const record of Object.values(timeline.records_by_swipe)) records.push({ message, record });
    }
  }

  const invalidIds = new Set(
    records
      .filter(({ record }) => record.application.status === 'stale' || record.audit.status === 'stale')
      .map(({ record }) => record.recordId)
  );

  for (const { record } of records) {
    const userMessage = messagesById.get(record.userMessageId);
    const assistantMessage = messagesById.get(record.assistantMessageId);
    const userText = userMessage?.mes;
    const assistantText = assistantMessage ? textForSwipe(assistantMessage, record.swipeId) : null;
    if (typeof userText !== 'string' || assistantText === null) {
      invalidIds.add(record.recordId);
      continue;
    }
    const [inputHash, outputHash] = await Promise.all([
      sha256Text(userText),
      sha256Text(assistantText)
    ]);
    if (inputHash !== record.inputHash || outputHash !== record.outputHash) invalidIds.add(record.recordId);
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const { record } of records) {
      if (!record.parentRecordId || invalidIds.has(record.recordId)) continue;
      if (invalidIds.has(record.parentRecordId)) {
        invalidIds.add(record.recordId);
        grew = true;
      }
    }
  }

  let changed = 0;
  const changedMessages = new Set<SillyTavernMessage>();
  for (const { message, record } of records) {
    if (!invalidIds.has(record.recordId)) continue;
    if (record.application.status !== 'stale' || record.audit.status !== 'stale') {
      record.application.status = 'stale';
      record.audit.status = 'stale';
      changed += 1;
      changedMessages.add(message);
    }
  }
  for (const message of changedMessages) mirrorAllSwipes(message);
  return changed;
}

export function findPrecedingUserMessage(
  chat: SillyTavernMessage[],
  beforeIndex: number
): { message: SillyTavernMessage; index: number } | null {
  for (let index = Math.min(beforeIndex - 1, chat.length - 1); index >= 0; index -= 1) {
    const message = chat[index];
    if (message?.is_user && !message.is_system) return { message, index };
  }
  return null;
}

export function markRecordsStaleFromMessage(
  chat: SillyTavernMessage[],
  messageIndex: number,
  activeSwipeOnlyAtStart = false
): number {
  let changed = 0;
  for (let index = Math.max(0, messageIndex); index < chat.length; index += 1) {
    const message = chat[index];
    if (!message) continue;
    const timeline = message[MESSAGE_FIELD];
    if (!isTimelineData(timeline)) continue;
    const records = activeSwipeOnlyAtStart && index === messageIndex
      ? [timeline.records_by_swipe[String(activeSwipeId(message))]].filter((record): record is TurnRecord => Boolean(record))
      : Object.values(timeline.records_by_swipe);
    for (const record of records) {
      if (record.application.status === 'stale' && record.audit.status === 'stale') continue;
      record.application.status = 'stale';
      record.audit.status = 'stale';
      changed += 1;
    }
    mirrorAllSwipes(message);
  }
  return changed;
}
