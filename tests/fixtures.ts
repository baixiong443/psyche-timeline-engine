import { createEmptyProjection } from '../src/model/defaults';
import type { StoryEvent, StoryPlan, TimelineOperation, TurnRecord } from '../src/model/types';

type OperationInput<T extends TimelineOperation> = T extends TimelineOperation
  ? Omit<T, 'id' | 'confidence' | 'evidenceIds'> & Partial<Pick<T, 'id' | 'confidence' | 'evidenceIds'>>
  : never;

export function operation<T extends TimelineOperation>(value: OperationInput<T>): T {
  return {
    id: 'op-1',
    confidence: 0.9,
    evidenceIds: [],
    ...value
  } as unknown as T;
}

export function storyEvent(overrides: Partial<StoryEvent> = {}): StoryEvent {
  return {
    id: 'event-1',
    chapterId: 'chapter-1',
    sceneId: 'scene-1',
    canonicalOrder: 1,
    kind: 'hard_anchor',
    rigidity: 'hard',
    summary: 'A scheduled event.',
    participants: [],
    effects: [],
    narrativePurposes: [],
    evidenceRefs: [],
    revealPolicy: 'eligible_only',
    adaptation: {
      allowDelay: true,
      allowRelocation: true,
      allowSubstitution: false
    },
    ...overrides
  };
}

export function storyPlan(events: StoryEvent[]): StoryPlan {
  return {
    schemaVersion: 1,
    storyId: 'story-1',
    title: 'Test story',
    initialState: createEmptyProjection('story-1'),
    events
  };
}

export function turnRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    recordId: 'record-1',
    parentRecordId: null,
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    swipeId: 0,
    inputHash: `sha256:${'1'.repeat(64)}`,
    outputHash: `sha256:${'2'.repeat(64)}`,
    baseProjectionHash: `sha256:${'3'.repeat(64)}`,
    operations: [],
    evidence: [],
    audit: {
      mode: 'standard',
      status: 'passed',
      violations: [],
      model: null
    },
    application: {
      status: 'applied',
      appliedAt: 1
    },
    checkpoint: null,
    projectionHash: null,
    createdAt: 1,
    ...overrides
  };
}
