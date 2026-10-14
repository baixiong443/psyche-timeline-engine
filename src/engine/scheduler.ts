import { DEFAULT_CANON_LOOKAHEAD, DEFAULT_MAX_CANDIDATE_EVENTS } from '../constants';
import type {
  EventScope,
  ParticipationMode,
  SchedulerCandidate,
  StoryEvent,
  StoryPlan,
  StoryProjection
} from '../model/types';
import { evaluateCondition, validateConditionRule } from './conditions';

const TERMINAL_EVENT_STATES = new Set([
  'completed_canonical', 'completed_adapted', 'skipped', 'invalidated'
]);

/**
 * Resolve an event's scope, treating omitted or unrecognized values as
 * `interpersonal` so packages written before `scope` existed keep their
 * original (divergence-sensitive) behaviour.
 */
export function eventScope(event: Pick<StoryEvent, 'scope'>): EventScope {
  return event.scope === 'world' ? 'world' : 'interpersonal';
}

function rigidityScore(event: StoryEvent, mode: ParticipationMode): number {
  if (mode === 'free') return -10_000;
  if (event.rigidity === 'hard') return mode === 'follow' ? 60 : mode === 'adaptive' ? 42 : 20;
  if (event.rigidity === 'soft') return mode === 'follow' ? 36 : mode === 'adaptive' ? 30 : 12;
  return mode === 'follow' ? 18 : mode === 'adaptive' ? 14 : 8;
}

function kindScore(event: StoryEvent): number {
  switch (event.kind) {
    case 'hard_anchor': return 30;
    case 'soft_anchor': return 20;
    case 'character_beat': return 18;
    case 'transition': return 8;
    case 'atmosphere': return 5;
    case 'chance': return 2;
  }
}

function participantScore(event: StoryEvent, projection: StoryProjection): number {
  return event.participants.reduce((score, id) => score + (projection.characters[id]?.present ? 5 : -2), 0);
}

function divergenceSuppressesCanon(
  projection: StoryProjection,
  mode: ParticipationMode,
  event: StoryEvent
): boolean {
  // A world-scale process runs on its own timeline. The branch leaving canon
  // does not stop a flood, a war or a plague, so divergence must not remove it.
  if (eventScope(event) === 'world') return false;
  const level = projection.divergence.structuralLevel;
  return (mode === 'parallel' && level >= 0.5)
    || ((mode === 'adaptive' || mode === 'follow') && level >= 0.75);
}

function divergencePenalty(
  projection: StoryProjection,
  mode: ParticipationMode,
  event: StoryEvent
): number {
  // Same reasoning as `divergenceSuppressesCanon`: a world event must not be
  // ranked down merely because the branch diverged.
  if (eventScope(event) === 'world') return 0;
  const multiplier = mode === 'follow' ? 10 : mode === 'adaptive' ? 80 : 120;
  return projection.divergence.structuralLevel * multiplier;
}

export function evaluateStoryEvent(
  event: StoryEvent,
  projection: StoryProjection,
  mode: ParticipationMode,
  lookahead = DEFAULT_CANON_LOOKAHEAD
): SchedulerCandidate | null {
  const storedState = projection.canonEvents[event.id];
  if (storedState && TERMINAL_EVENT_STATES.has(storedState)) return null;
  if (storedState === 'delayed') {
    return { event, score: -1_000, state: 'delayed', reasons: ['Event was manually delayed.'] };
  }
  if (mode === 'free' || event.revealPolicy === 'never') return null;
  if (event.revealPolicy === 'active_only' && storedState !== 'active') return null;
  if (divergenceSuppressesCanon(projection, mode, event) && storedState !== 'active') return null;

  const preconditionValidation = validateConditionRule(event.preconditions);
  const forbiddenValidation = validateConditionRule(event.forbiddenWhen);
  if (!preconditionValidation.valid || !forbiddenValidation.valid) {
    return {
      event,
      score: -10_000,
      state: 'invalidated',
      reasons: [...preconditionValidation.errors, ...forbiddenValidation.errors]
    };
  }

  if (event.forbiddenWhen && evaluateCondition(event.forbiddenWhen, projection)) {
    return { event, score: -5_000, state: 'invalidated', reasons: ['A forbidden condition is true.'] };
  }

  if (event.preconditions && !evaluateCondition(event.preconditions, projection)) {
    return { event, score: -1_000, state: 'delayed', reasons: ['Preconditions are not satisfied.'] };
  }

  const distance = Math.max(0, event.canonicalOrder - projection.canonCursor.eventOrder);

  // Imminence is a gate, not a weight. Base scores (a follow-mode hard anchor is
  // 90) exceed the entire 80-point proximity range, so a distant anchor would
  // otherwise outrank the next beat. Causal checks above still ran, so an event
  // whose cause was removed is still reported as invalidated rather than hidden.
  if (distance > lookahead) return null;

  const proximityScore = Math.max(-40, 40 - distance * 2);
  const pendingPurposeCount = event.narrativePurposes.filter(
    id => (projection.narrativePurposes[id] ?? 'pending') === 'pending'
  ).length;
  const score = rigidityScore(event, mode)
    + kindScore(event)
    + participantScore(event, projection)
    + proximityScore
    + pendingPurposeCount * 6
    - divergencePenalty(projection, mode, event);

  return {
    event,
    score,
    state: 'eligible',
    reasons: [
      `canonical distance ${distance}`,
      `${pendingPurposeCount} pending narrative purpose(s)`,
      `branch divergence ${projection.divergence.structuralLevel}`
    ]
  };
}

export function scheduleStoryEvents(
  plan: StoryPlan,
  projection: StoryProjection,
  mode: ParticipationMode,
  limit = DEFAULT_MAX_CANDIDATE_EVENTS,
  lookahead = DEFAULT_CANON_LOOKAHEAD
): SchedulerCandidate[] {
  const safeLimit = Math.max(0, Math.min(10, Math.trunc(limit)));
  const safeLookahead = Math.max(0, Math.trunc(lookahead));
  return plan.events
    .map(event => evaluateStoryEvent(event, projection, mode, safeLookahead))
    .filter((candidate): candidate is SchedulerCandidate => candidate?.state === 'eligible')
    .sort((left, right) => right.score - left.score || left.event.canonicalOrder - right.event.canonicalOrder)
    .slice(0, safeLimit);
}

export function findInvalidatedEvents(plan: StoryPlan, projection: StoryProjection, mode: ParticipationMode): SchedulerCandidate[] {
  return plan.events
    .map(event => evaluateStoryEvent(event, projection, mode))
    .filter((candidate): candidate is SchedulerCandidate => candidate?.state === 'invalidated');
}
