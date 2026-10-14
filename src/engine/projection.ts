import type { StoryEvent, StoryProjection, TimelineOperation, TurnRecord } from '../model/types';
import { CHECKPOINT_INTERVAL } from '../constants';
import { validateProjection } from '../schema/validators';
import { hashJson } from '../utils/hash';
import { applyOperations } from './reducer';

export interface ReplayResult {
  projection: StoryProjection;
  appliedRecordIds: string[];
  skippedRecordIds: string[];
  errors: Array<{ recordId: string; errors: string[] }>;
}

export function shouldAdvanceStoryTurn(record: Pick<TurnRecord, 'kind' | 'operations'>): boolean {
  return record.kind !== 'manual' && record.operations.length > 0;
}

export function advanceCanonCursorFromOperations(
  projection: StoryProjection,
  operations: TimelineOperation[],
  events: StoryEvent[]
): void {
  const eventsById = new Map(events.map(event => [event.id, event]));
  for (const operation of operations) {
    if (operation.type !== 'transition_canon_event') continue;
    if (!['active', 'completed_canonical', 'completed_adapted'].includes(operation.status)) continue;
    const event = eventsById.get(operation.eventId);
    if (!event || event.canonicalOrder < projection.canonCursor.eventOrder) continue;
    projection.canonCursor = {
      chapterId: event.chapterId,
      sceneId: event.sceneId,
      eventOrder: event.canonicalOrder
    };
  }
}

export function replayTurnRecords(
  initial: StoryProjection,
  records: TurnRecord[],
  events: StoryEvent[] = []
): ReplayResult {
  let projection = structuredClone(initial);
  let lastAppliedRecordId: string | null = null;
  const appliedRecordIds: string[] = [];
  const skippedRecordIds: string[] = [];
  const errors: Array<{ recordId: string; errors: string[] }> = [];

  for (const record of records) {
    if (record.application.status !== 'applied' || record.audit.status === 'stale') {
      skippedRecordIds.push(record.recordId);
      continue;
    }
    if (record.parentRecordId !== lastAppliedRecordId) {
      errors.push({
        recordId: record.recordId,
        errors: [`Record parent mismatch: expected ${lastAppliedRecordId ?? 'null'}, received ${record.parentRecordId ?? 'null'}.`]
      });
      skippedRecordIds.push(record.recordId);
      continue;
    }
    const result = applyOperations(projection, record.operations, events);
    if (result.rejected.length > 0) {
      errors.push({
        recordId: record.recordId,
        errors: result.rejected.map(item => item.error)
      });
      skippedRecordIds.push(record.recordId);
      continue;
    }
    projection = result.projection;
    advanceCanonCursorFromOperations(projection, record.operations, events);
    if (shouldAdvanceStoryTurn(record)) projection.turn += 1;
    appliedRecordIds.push(record.recordId);
    lastAppliedRecordId = record.recordId;
  }

  return { projection, appliedRecordIds, skippedRecordIds, errors };
}

export function shouldCreateCheckpoint(turn: number, interval = CHECKPOINT_INTERVAL): boolean {
  return interval > 0 && turn > 0 && turn % interval === 0;
}

async function findTrustedCheckpoint(records: TurnRecord[]): Promise<number> {
  let expectedParent: string | null = null;
  let latest = -1;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.application.status !== 'applied' || record.audit.status === 'stale') break;
    if (record.parentRecordId !== expectedParent) break;
    expectedParent = record.recordId;

    if (!record.checkpoint || !record.projectionHash) continue;
    if (!validateProjection(record.checkpoint).valid) continue;
    if (await hashJson(record.checkpoint) === record.projectionHash) latest = index;
  }

  return latest;
}

export async function replayTurnRecordsWithCheckpoints(
  initial: StoryProjection,
  records: TurnRecord[],
  events: StoryEvent[] = []
): Promise<ReplayResult> {
  const checkpointIndex = await findTrustedCheckpoint(records);
  if (checkpointIndex < 0) return replayTurnRecords(initial, records, events);

  const checkpointRecord = records[checkpointIndex]!;
  const checkpoint = structuredClone(checkpointRecord.checkpoint!);
  const tail = records.slice(checkpointIndex + 1).map(record => structuredClone(record));
  const replayHead = tail.find(record => (
    record.application.status === 'applied'
    && record.audit.status !== 'stale'
  ));
  if (replayHead?.parentRecordId === checkpointRecord.recordId) replayHead.parentRecordId = null;
  const replayedTail = replayTurnRecords(checkpoint, tail, events);

  return {
    projection: replayedTail.projection,
    appliedRecordIds: [
      ...records.slice(0, checkpointIndex + 1).map(record => record.recordId),
      ...replayedTail.appliedRecordIds
    ],
    skippedRecordIds: replayedTail.skippedRecordIds,
    errors: replayedTail.errors
  };
}
