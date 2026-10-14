import { findInvalidatedEvents, scheduleStoryEvents } from '../src/engine/scheduler';
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
});
