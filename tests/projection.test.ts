import { replayTurnRecords, replayTurnRecordsWithCheckpoints, shouldCreateCheckpoint } from '../src/engine/projection';
import { hashJson } from '../src/utils/hash';
import { createEmptyProjection } from '../src/model/defaults';
import type { DomainOperation } from '../src/model/types';
import { operation, storyEvent, turnRecord } from './fixtures';

describe('projection replay', () => {
  it('skips stale records and descendants whose parent chain no longer matches', () => {
    const initial = createEmptyProjection('story-1');
    const first = turnRecord({
      recordId: 'record-1',
      audit: { mode: 'standard', status: 'stale', violations: [], model: null }
    });
    const child = turnRecord({
      recordId: 'record-2',
      parentRecordId: 'record-1',
      operations: [operation<DomainOperation>({ type: 'advance_time', minutes: 20 })]
    });

    const result = replayTurnRecords(initial, [first, child]);
    expect(result.appliedRecordIds).toEqual([]);
    expect(result.skippedRecordIds).toEqual(['record-1', 'record-2']);
    expect(result.errors[0]?.errors[0]).toContain('parent mismatch');
    expect(result.projection.time.relativeMinutes).toBe(0);
  });

  it('applies a valid linked chain transactionally', () => {
    const initial = createEmptyProjection('story-1');
    const first = turnRecord({
      operations: [operation<DomainOperation>({ type: 'advance_time', minutes: 5 })]
    });
    const second = turnRecord({
      recordId: 'record-2',
      parentRecordId: 'record-1',
      operations: [operation<DomainOperation>({ type: 'set_flag', flag: 'arrived', value: true })]
    });

    const result = replayTurnRecords(initial, [first, second]);
    expect(result.errors).toEqual([]);
    expect(result.projection.turn).toBe(2);
    expect(result.projection.flags.arrived).toBe(true);
  });

  it('replays manual correction records without advancing the story turn', () => {
    const initial = createEmptyProjection('story-1');
    const manual = turnRecord({
      kind: 'manual',
      operations: [operation<DomainOperation>({ type: 'advance_time', minutes: 5 })]
    });
    const extracted = turnRecord({
      recordId: 'record-2',
      parentRecordId: 'record-1',
      operations: [operation<DomainOperation>({ type: 'set_flag', flag: 'continued', value: true })]
    });

    const result = replayTurnRecords(initial, [manual, extracted]);
    expect(result.errors).toEqual([]);
    expect(result.projection.turn).toBe(1);
    expect(result.projection.time.relativeMinutes).toBe(5);
  });

  it('keeps zero-change audit records in the parent chain without advancing the story turn', () => {
    const initial = createEmptyProjection('story-1');
    initial.turn = 2;
    initial.time.relativeMinutes = 14;
    const noChange = turnRecord({ recordId: 'no-change', operations: [] });
    const changed = turnRecord({
      recordId: 'changed',
      parentRecordId: 'no-change',
      operations: [operation<DomainOperation>({ type: 'set_flag', flag: 'continued', value: true })]
    });

    const result = replayTurnRecords(initial, [noChange, changed]);

    expect(result.errors).toEqual([]);
    expect(result.appliedRecordIds).toEqual(['no-change', 'changed']);
    expect(result.projection.turn).toBe(3);
    expect(result.projection.time.relativeMinutes).toBe(14);
    expect(result.projection.flags.continued).toBe(true);
  });

  it('rebuilds the canon cursor from event transitions during replay', () => {
    const initial = createEmptyProjection('story-1');
    const event = storyEvent({
      id: 'event-12',
      chapterId: 'chapter-12',
      sceneId: 'scene-3',
      canonicalOrder: 120
    });
    const record = turnRecord({
      kind: 'manual',
      operations: [
        operation<DomainOperation>({
          id: 'eligible',
          type: 'transition_canon_event',
          eventId: event.id,
          status: 'eligible'
        }),
        operation<DomainOperation>({
          id: 'active',
          type: 'transition_canon_event',
          eventId: event.id,
          status: 'active'
        })
      ]
    });

    const result = replayTurnRecords(initial, [record], [event]);
    expect(result.projection.canonCursor).toEqual({
      chapterId: 'chapter-12',
      sceneId: 'scene-3',
      eventOrder: 120
    });
  });

  it('replays canonical event effects from the immutable story plan', () => {
    const initial = createEmptyProjection('story-1');
    const event = storyEvent({
      id: 'event-with-effect',
      effects: [operation<DomainOperation>({
        id: 'effect-opened',
        type: 'set_flag',
        flag: 'gate_opened',
        value: true
      })]
    });
    const record = turnRecord({
      operations: [
        operation<DomainOperation>({ id: 'eligible', type: 'transition_canon_event', eventId: event.id, status: 'eligible' }),
        operation<DomainOperation>({ id: 'active', type: 'transition_canon_event', eventId: event.id, status: 'active' }),
        operation<DomainOperation>({ id: 'complete', type: 'transition_canon_event', eventId: event.id, status: 'completed_canonical' })
      ]
    });

    const result = replayTurnRecords(initial, [record], [event]);
    expect(result.errors).toEqual([]);
    expect(result.projection.flags.gate_opened).toBe(true);
  });

  it('uses only hash-verified checkpoints', async () => {
    const initial = createEmptyProjection('story-1');
    const checkpoint = createEmptyProjection('story-1');
    checkpoint.turn = 25;
    checkpoint.time.relativeMinutes = 100;
    const first = turnRecord({
      checkpoint,
      projectionHash: await hashJson(checkpoint)
    });
    const second = turnRecord({
      recordId: 'record-2',
      parentRecordId: 'record-1',
      operations: [operation<DomainOperation>({ type: 'advance_time', minutes: 5 })]
    });

    const result = await replayTurnRecordsWithCheckpoints(initial, [first, second]);
    expect(result.projection.turn).toBe(26);
    expect(result.projection.time.relativeMinutes).toBe(105);
    expect(shouldCreateCheckpoint(25)).toBe(true);
    expect(shouldCreateCheckpoint(24)).toBe(false);
  });

  it('rebases the first applied record after skipped checkpoint-tail records', async () => {
    const initial = createEmptyProjection('story-1');
    const checkpoint = createEmptyProjection('story-1');
    checkpoint.turn = 2;
    checkpoint.time.relativeMinutes = 14;
    const first = turnRecord({
      recordId: 'record-1',
      checkpoint,
      projectionHash: await hashJson(checkpoint)
    });
    const rejected = turnRecord({
      recordId: 'record-rejected',
      parentRecordId: 'record-1',
      application: { status: 'rejected', appliedAt: null }
    });
    const manual = turnRecord({
      kind: 'manual',
      recordId: 'record-manual',
      parentRecordId: 'record-1',
      operations: [operation<DomainOperation>({ type: 'set_flag', flag: 'manual_applied', value: true })]
    });

    const result = await replayTurnRecordsWithCheckpoints(initial, [first, rejected, manual]);

    expect(result.errors).toEqual([]);
    expect(result.appliedRecordIds).toEqual(['record-1', 'record-manual']);
    expect(result.skippedRecordIds).toEqual(['record-rejected']);
    expect(result.projection.turn).toBe(2);
    expect(result.projection.time.relativeMinutes).toBe(14);
    expect(result.projection.flags.manual_applied).toBe(true);
  });
});
