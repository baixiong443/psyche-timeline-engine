import { eventScope, findInvalidatedEvents, scheduleStoryEvents } from '../src/engine/scheduler';
import { createEmptyProjection } from '../src/model/defaults';
import { storyEvent, storyPlan } from './fixtures';

describe('canon scheduler', () => {
  it('changes priority by participation mode and disables anchors in free mode', () => {
    const projection = createEmptyProjection('story-1');
    const hard = storyEvent({ id: 'hard', rigidity: 'hard', canonicalOrder: 5 });
    const flexible = storyEvent({ id: 'flexible', rigidity: 'flexible', kind: 'chance', canonicalOrder: 1 });
    const plan = storyPlan([flexible, hard]);

    expect(scheduleStoryEvents(plan, projection, 'follow')[0]?.event.id).toBe('hard');
    expect(scheduleStoryEvents(plan, projection, 'adaptive')[0]?.event.id).toBe('hard');
    expect(scheduleStoryEvents(plan, projection, 'free')).toEqual([]);
  });

  it('separates forbidden events from eligible candidates', () => {
    const projection = createEmptyProjection('story-1');
    projection.flags.bridge_destroyed = true;
    const event = storyEvent({ forbiddenWhen: { var: 'flags.bridge_destroyed' } });
    const plan = storyPlan([event]);

    expect(scheduleStoryEvents(plan, projection, 'follow')).toEqual([]);
    expect(findInvalidatedEvents(plan, projection, 'follow')[0]?.event.id).toBe(event.id);
  });

  it('does not reinject a manually delayed event until it is restored', () => {
    const projection = createEmptyProjection('story-1');
    const event = storyEvent({ id: 'delayed-event' });
    const plan = storyPlan([event]);
    projection.canonEvents[event.id] = 'delayed';

    expect(scheduleStoryEvents(plan, projection, 'adaptive')).toEqual([]);
    projection.canonEvents[event.id] = 'eligible';
    expect(scheduleStoryEvents(plan, projection, 'adaptive')[0]?.event.id).toBe(event.id);
  });

  it('keeps active-only event details hidden until the event is active', () => {
    const projection = createEmptyProjection('story-1');
    const event = storyEvent({ id: 'active-secret', revealPolicy: 'active_only' });
    const plan = storyPlan([event]);

    expect(scheduleStoryEvents(plan, projection, 'follow')).toEqual([]);
    projection.canonEvents[event.id] = 'eligible';
    expect(scheduleStoryEvents(plan, projection, 'follow')).toEqual([]);
    projection.canonEvents[event.id] = 'active';
    expect(scheduleStoryEvents(plan, projection, 'follow')[0]?.event.id).toBe(event.id);
  });

  it('stops canon injection after mode-specific structural divergence thresholds', () => {
    const projection = createEmptyProjection('story-1');
    const event = storyEvent({ id: 'future-canon' });
    const plan = storyPlan([event]);

    projection.divergence.structuralLevel = 0.49;
    expect(scheduleStoryEvents(plan, projection, 'parallel')).toHaveLength(1);
    projection.divergence.structuralLevel = 0.5;
    expect(scheduleStoryEvents(plan, projection, 'parallel')).toEqual([]);
    projection.divergence.structuralLevel = 0.74;
    expect(scheduleStoryEvents(plan, projection, 'adaptive')).toHaveLength(1);
    projection.divergence.structuralLevel = 0.75;
    expect(scheduleStoryEvents(plan, projection, 'adaptive')).toEqual([]);
    projection.divergence.structuralLevel = 1;
    expect(scheduleStoryEvents(plan, projection, 'follow')).toEqual([]);
    projection.canonEvents[event.id] = 'active';
    expect(scheduleStoryEvents(plan, projection, 'parallel')).toHaveLength(1);
  });

  it('keeps world-scope events alive regardless of branch divergence', () => {
    // A flood is a world process: leaving canon does not stop it.
    const flood = storyEvent({ id: 'great-flood', kind: 'hard_anchor', rigidity: 'hard', scope: 'world' });
    const plan = storyPlan([flood]);

    for (const mode of ['follow', 'adaptive', 'parallel'] as const) {
      for (const level of [0, 0.25, 0.5, 0.75, 0.9, 1]) {
        const projection = createEmptyProjection('story-1');
        projection.divergence.structuralLevel = level;
        expect(scheduleStoryEvents(plan, projection, mode).map(item => item.event.id)).toEqual(['great-flood']);
      }
    }
  });

  it('treats an omitted or unknown scope as interpersonal', () => {
    const legacy = storyEvent({ id: 'legacy-event' });
    expect(eventScope(legacy)).toBe('interpersonal');
    expect(eventScope({ scope: undefined })).toBe('interpersonal');
    expect(eventScope({ scope: 'anything-else' } as never)).toBe('interpersonal');
    expect(eventScope({ scope: 'world' })).toBe('world');

    // A legacy event must keep the old divergence-sensitive behaviour.
    const plan = storyPlan([legacy]);
    const projection = createEmptyProjection('story-1');
    projection.divergence.structuralLevel = 0.5;
    expect(scheduleStoryEvents(plan, projection, 'parallel')).toEqual([]);
  });

  it('still lets an explicit cause cancel a world event', () => {
    // Divergence immunity is about the abstract divergence level, not causality.
    // If the branch actually removes the cause, the world event must be blocked.
    const flood = storyEvent({
      id: 'great-flood',
      scope: 'world',
      kind: 'hard_anchor',
      rigidity: 'hard',
      forbiddenWhen: { '==': [{ var: 'flags.levee_repaired' }, true] }
    });
    const plan = storyPlan([flood]);
    const projection = createEmptyProjection('story-1');
    projection.divergence.structuralLevel = 1;

    // Cause intact -> the flood still happens even on a fully diverged branch.
    expect(scheduleStoryEvents(plan, projection, 'parallel').map(item => item.event.id)).toEqual(['great-flood']);

    // Cause removed by the player -> the flood is genuinely prevented.
    projection.flags.levee_repaired = true;
    expect(scheduleStoryEvents(plan, projection, 'parallel')).toEqual([]);
    expect(findInvalidatedEvents(plan, projection, 'parallel').map(item => item.event.id)).toEqual(['great-flood']);
  });
});
