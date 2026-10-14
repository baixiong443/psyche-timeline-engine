import { buildRuntimeInjection } from '../engine/injection';
import { replayTurnRecordsWithCheckpoints } from '../engine/projection';
import { scheduleStoryEvents } from '../engine/scheduler';
import { loadRuntimeStorySourceContext, type RuntimeStorySourceContext } from '../engine/sourceContext';
import type { SchedulerCandidate, StoryProjection, TurnRecord } from '../model/types';
import {
  collectActiveTurnRecords,
  ensureChatMessageIds,
  invalidateRecordsWithChangedContent,
  mirrorActiveSwipe
} from '../storage/messages';
import type { PsycheTimelineSettings } from './settings';
import { readManualTurnRecords, type ActiveStory } from './story';
import type { SillyTavernContext } from './context';

export interface ActiveSession {
  story: ActiveStory;
  projection: StoryProjection;
  candidates: SchedulerCandidate[];
  records: TurnRecord[];
  replayErrors: string[];
  sourceContext: RuntimeStorySourceContext | null;
}

export function propagateStaleRecords(records: TurnRecord[]): number {
  const staleIds = new Set(
    records
      .filter(record => record.application.status === 'stale' || record.audit.status === 'stale')
      .map(record => record.recordId)
  );
  let changed = 0;
  let grew = true;
  while (grew) {
    grew = false;
    for (const record of records) {
      if (!record.parentRecordId || staleIds.has(record.recordId) || !staleIds.has(record.parentRecordId)) continue;
      staleIds.add(record.recordId);
      record.application.status = 'stale';
      record.audit.status = 'stale';
      changed += 1;
      grew = true;
    }
  }
  return changed;
}

export async function buildActiveSession(
  context: SillyTavernContext,
  story: ActiveStory,
  settings: PsycheTimelineSettings
): Promise<{ session: ActiveSession; createdMessageIds: number; invalidatedRecords: number }> {
  const createdMessageIds = ensureChatMessageIds(context.chat);
  const contentInvalidations = await invalidateRecordsWithChangedContent(context.chat);
  for (const message of context.chat) {
    if (!message.is_system && !message.is_user) mirrorActiveSwipe(message);
  }

  const manual = readManualTurnRecords(context);
  const records = [...collectActiveTurnRecords(context.chat), ...manual.records]
    .sort((left, right) => left.createdAt - right.createdAt || left.recordId.localeCompare(right.recordId));
  const descendantInvalidations = propagateStaleRecords(records);
  if (descendantInvalidations > 0) {
    for (const message of context.chat) {
      if (!message.is_system && !message.is_user) mirrorActiveSwipe(message);
    }
  }
  const invalidatedRecords = contentInvalidations + descendantInvalidations;
  const replay = await replayTurnRecordsWithCheckpoints(story.plan.initialState, records, story.plan.events);
  const candidates = scheduleStoryEvents(story.plan, replay.projection, settings.participationMode);
  const sourceContext = await loadRuntimeStorySourceContext(context, story, replay.projection);
  const replayErrors = [
    ...manual.errors,
    ...replay.errors.flatMap(error => error.errors.map(message => `${error.recordId}: ${message}`))
  ];

  return {
    session: {
      story,
      projection: replay.projection,
      candidates,
      records,
      replayErrors,
      sourceContext
    },
    createdMessageIds,
    invalidatedRecords
  };
}

export function createSessionInjection(
  session: ActiveSession,
  settings: PsycheTimelineSettings,
  responderCharacterId?: string | null
): string {
  return buildRuntimeInjection({
    projection: session.projection,
    candidates: session.candidates,
    card: session.story.card,
    maxChars: settings.injectionMaxChars,
    responderCharacterId,
    sourceContext: session.sourceContext,
    promptOverride: settings.promptOverrides.injection
  });
}
