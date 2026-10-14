import {
  GenerationCompletionLatch,
  buildManualStateOperations,
  buildCanonTransitionOperations,
  forcedCharacterIndexFromGenerationEvent,
  markRecordsStaleAfterCheckpoint,
  shouldSkipExistingExtraction,
  shouldSkipGenerationEvent
} from '../src/runtime/controller';
import { createEmptyProjection } from '../src/model/defaults';
import { turnRecord } from './fixtures';

describe('manual extraction retry', () => {
  it('bypasses hash deduplication without weakening automatic duplicate suppression', () => {
    const hash = `sha256:${'a'.repeat(64)}`;

    expect(shouldSkipExistingExtraction(hash, hash, 'normal')).toBe(true);
    expect(shouldSkipExistingExtraction(hash, hash, 'manual_retry')).toBe(false);
    expect(shouldSkipExistingExtraction(undefined, hash, 'normal')).toBe(false);
  });
});

describe('generation event filtering', () => {
  it('keeps foreground group generations eligible while skipping raw quiet work', () => {
    expect(shouldSkipGenerationEvent(['normal', { force_chid: 4 }, false])).toBe(false);
    expect(shouldSkipGenerationEvent(['quiet', {}, false])).toBe(true);
    expect(shouldSkipGenerationEvent(['normal', { quiet_prompt: 'audit' }, false])).toBe(true);
    expect(shouldSkipGenerationEvent(['normal', {}, true])).toBe(true);
  });

  it('reads only a valid forced group member index from the generation event', () => {
    expect(forcedCharacterIndexFromGenerationEvent(['normal', { force_chid: 4 }, false])).toBe(4);
    expect(forcedCharacterIndexFromGenerationEvent(['normal', { force_chid: -1 }, false])).toBeUndefined();
    expect(forcedCharacterIndexFromGenerationEvent(['normal', {}, false])).toBeUndefined();
  });
});

describe('generation completion ordering', () => {
  it('releases a completed generation once when rendering happens before generation end', () => {
    const latch = new GenerationCompletionLatch<string, string>();
    latch.begin('snapshot');

    expect(latch.markRendered('reply')).toBeNull();
    expect(latch.markEnded()).toEqual({ completed: 'reply', snapshot: 'snapshot' });
    expect(latch.markEnded()).toBeNull();
  });

  it('releases a streaming generation once when generation end happens before rendering', () => {
    const latch = new GenerationCompletionLatch<string, string>();
    latch.begin('snapshot');

    expect(latch.markEnded()).toBeNull();
    expect(latch.markRendered('reply')).toEqual({ completed: 'reply', snapshot: 'snapshot' });
    expect(latch.markRendered('duplicate')).toBeNull();
  });

  it('can release a rendered reply when the host omits the generation-end event', () => {
    const latch = new GenerationCompletionLatch<string, string>();
    latch.begin('snapshot');

    expect(latch.markRendered('reply')).toBeNull();
    expect(latch.takeRenderedFallback()).toEqual({ completed: 'reply', snapshot: 'snapshot' });
    expect(latch.takeRenderedFallback()).toBeNull();
  });
});

describe('checkpoint rollback', () => {
  it('marks only records after the target checkpoint stale', () => {
    const first = turnRecord({ recordId: 'record-1' });
    const checkpoint = turnRecord({ recordId: 'record-2', parentRecordId: 'record-1' });
    const third = turnRecord({ recordId: 'record-3', parentRecordId: 'record-2' });

    expect(markRecordsStaleAfterCheckpoint([first, checkpoint, third], 'record-2')).toEqual(['record-3']);
    expect(first.application.status).toBe('applied');
    expect(checkpoint.application.status).toBe('applied');
    expect(third.application.status).toBe('stale');
    expect(third.audit.status).toBe('stale');
  });

  it('can roll back the active Swipe to the initial state', () => {
    const first = turnRecord({ recordId: 'record-1' });
    const second = turnRecord({ recordId: 'record-2', parentRecordId: 'record-1' });

    expect(markRecordsStaleAfterCheckpoint([first, second], null)).toEqual(['record-1', 'record-2']);
    expect(first.application.status).toBe('stale');
    expect(second.application.status).toBe('stale');
  });
});

describe('manual state correction', () => {
  it('builds only changed, schema-compatible domain operations', () => {
    const projection = createEmptyProjection('story-1');
    projection.location = { area: '旧区域', place: '旧地点', position: '旧位置' };
    projection.characters['敏明'] = { present: true };

    const result = buildManualStateOperations(projection, {
      absoluteTime: '1922-02-10 20:21:00Z',
      relativeMinutes: 6,
      location: { area: '绿绮湖', place: '近坡岸', position: '湖滩边' },
      characterPresence: { 敏明: false },
      divergenceLevel: 0.4,
      divergenceSummary: '用户提前封闭了原作中的湖岸路线。'
    });

    expect(result.errors).toEqual([]);
    expect(result.operations.map(operation => operation.type)).toEqual([
      'set_time', 'advance_time', 'move_location', 'set_divergence', 'set_character_presence'
    ]);
    expect(result.operations[0]).toMatchObject({ absolute: '1922-02-10T20:21:00.000Z' });
  });

  it('rejects malformed time and unknown characters before creating a record', () => {
    const projection = createEmptyProjection('story-1');
    const result = buildManualStateOperations(projection, {
      absoluteTime: 'not-a-date',
      relativeMinutes: Number.NaN,
      location: projection.location,
      characterPresence: { unknown: true },
      divergenceLevel: 0,
      divergenceSummary: ''
    });

    expect(result.operations).toEqual([]);
    expect(result.errors).toHaveLength(3);
  });

  it('does not create a correction for an equivalent ISO timestamp spelling', () => {
    const projection = createEmptyProjection('story-1');
    projection.time.absolute = '1922-02-10T20:21:00Z';
    const result = buildManualStateOperations(projection, {
      absoluteTime: '1922-02-10T20:21:00.000Z',
      relativeMinutes: 0,
      location: projection.location,
      characterPresence: {},
      divergenceLevel: 0,
      divergenceSummary: ''
    });

    expect(result.errors).toEqual([]);
    expect(result.operations).toEqual([]);
  });
});

describe('manual canon control', () => {
  it('builds a replayable path to adapted completion', () => {
    const result = buildCanonTransitionOperations('event-1', 'locked', 'completed_adapted');

    expect(result.errors).toEqual([]);
    expect(result.operations.map(operation => (
      operation.type === 'transition_canon_event' ? operation.status : null
    ))).toEqual(['eligible', 'active', 'completed_adapted']);
  });

  it('rejects transitions out of an invalidated event', () => {
    const result = buildCanonTransitionOperations('event-1', 'invalidated', 'eligible');
    expect(result.operations).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });
});
