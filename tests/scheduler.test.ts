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

  it('never offers events beyond the canon lookahead window', () => {
    const near = storyEvent({ id: 'near', canonicalOrder: 20 });
    const edge = storyEvent({ id: 'edge', canonicalOrder: 25 });
    const beyond = storyEvent({ id: 'beyond', canonicalOrder: 26 });
    const plan = storyPlan([near, edge, beyond]);
    const projection = createEmptyProjection('story-1');

    expect(scheduleStoryEvents(plan, projection, 'follow').map(item => item.event.id).sort())
      .toEqual(['edge', 'near']);

    // An explicit window keeps the behaviour inspectable.
    expect(scheduleStoryEvents(plan, projection, 'follow', 10, 30).map(item => item.event.id).sort())
      .toEqual(['beyond', 'edge', 'near']);
    expect(scheduleStoryEvents(plan, projection, 'follow', 10, 0)).toEqual([]);
  });

  it('gates distant anchors out of the window instead of reordering them', () => {
    // The lookahead is an eligibility gate, not a re-ranker. Within the window
    // base scores still dominate (a follow-mode hard anchor scores 80 against
    // 74 for a nearby flexible beat), which is acceptable because injection
    // emits every candidate, not just the top one. What matters is that the
    // 200-orders-away spoiler never becomes a candidate at all.
    const nextBeat = storyEvent({
      id: 'next-beat', canonicalOrder: 1, kind: 'character_beat', rigidity: 'flexible'
    });
    const anchorInWindow = storyEvent({
      id: 'anchor-in-window', canonicalOrder: 25, kind: 'hard_anchor', rigidity: 'hard'
    });
    const anchorBeyond = storyEvent({
      id: 'anchor-beyond', canonicalOrder: 26, kind: 'hard_anchor', rigidity: 'hard'
    });
    const plan = storyPlan([nextBeat, anchorInWindow, anchorBeyond]);
    const projection = createEmptyProjection('story-1');

    // Both in-window events stay available regardless of their relative order.
    expect(scheduleStoryEvents(plan, projection, 'follow').map(item => item.event.id).sort())
      .toEqual(['anchor-in-window', 'next-beat']);

    // The next beat is still reachable as a candidate, so imminence is not lost.
    expect(scheduleStoryEvents(plan, projection, 'follow')).toHaveLength(2);

    // Advancing the cursor by one admits the anchor that was just out of reach.
    projection.canonCursor.eventOrder = 1;
    expect(scheduleStoryEvents(plan, projection, 'follow').map(item => item.event.id).sort())
      .toEqual(['anchor-beyond', 'anchor-in-window', 'next-beat']);
  });

  it('applies the lookahead window to world events too', () => {
    // World immunity is about divergence, not about spoiler distance.
    const farFlood = storyEvent({ id: 'far-flood', scope: 'world', canonicalOrder: 200 });
    const plan = storyPlan([farFlood]);
    const projection = createEmptyProjection('story-1');

    expect(scheduleStoryEvents(plan, projection, 'follow')).toEqual([]);
    projection.canonCursor.eventOrder = 190;
    expect(scheduleStoryEvents(plan, projection, 'follow').map(item => item.event.id)).toEqual(['far-flood']);
  });

  it('drives a world event from a time precondition without any player action', () => {
    // The world clock is not a new mechanism: a deterministic `preconditions`
    // rule over `time.relativeMinutes` already makes a world event fire on its
    // own schedule, independent of what the branch does.
    //
    // Caveat: `time.relativeMinutes` only advances when the extractor confirms a
    // quantifiable duration really elapsed, so it can stay at 0 for a long time
    // in ordinary chat. `turn` is the reliable default clock; this test pins the
    // mechanism, not a recommendation to gate on minutes.
    const tide = storyEvent({
      id: 'spring-tide',
      scope: 'world',
      kind: 'hard_anchor',
      rigidity: 'hard',
      preconditions: { '>=': [{ var: 'time.relativeMinutes' }, 1440] }
    });
    const plan = storyPlan([tide]);
    const projection = createEmptyProjection('story-1');

    // Not yet due: reported as delayed rather than eligible.
    projection.time.relativeMinutes = 1439;
    expect(scheduleStoryEvents(plan, projection, 'parallel')).toEqual([]);

    // Due: the world event surfaces on its own, even on a fully diverged branch.
    projection.time.relativeMinutes = 1440;
    projection.divergence.structuralLevel = 1;
    expect(scheduleStoryEvents(plan, projection, 'parallel').map(item => item.event.id))
      .toEqual(['spring-tide']);
  });

  it('drives a world event from the turn counter', () => {
    // `turn` increments on every applied record, so it is the clock that always
    // ticks during ordinary play.
    const rebellion = storyEvent({
      id: 'rebellion',
      scope: 'world',
      preconditions: { '>=': [{ var: 'turn' }, 5] }
    });
    const plan = storyPlan([rebellion]);
    const projection = createEmptyProjection('story-1');

    projection.turn = 4;
    expect(scheduleStoryEvents(plan, projection, 'follow')).toEqual([]);
    projection.turn = 5;
    expect(scheduleStoryEvents(plan, projection, 'follow').map(item => item.event.id))
      .toEqual(['rebellion']);
  });

  it('combines a time gate with a causal gate on the same world event', () => {
    // Time decides "is it due"; forbiddenWhen decides "was the cause removed".
    const flood = storyEvent({
      id: 'seasonal-flood',
      scope: 'world',
      preconditions: { '>=': [{ var: 'time.relativeMinutes' }, 1440] },
      forbiddenWhen: { '==': [{ var: 'flags.levee_repaired' }, true] }
    });
    const plan = storyPlan([flood]);
    const projection = createEmptyProjection('story-1');
    projection.time.relativeMinutes = 1440;

    expect(scheduleStoryEvents(plan, projection, 'follow').map(item => item.event.id))
      .toEqual(['seasonal-flood']);

    // Due but causally prevented -> invalidated, not eligible.
    projection.flags.levee_repaired = true;
    expect(scheduleStoryEvents(plan, projection, 'follow')).toEqual([]);
    expect(findInvalidatedEvents(plan, projection, 'follow').map(item => item.event.id))
      .toEqual(['seasonal-flood']);
  });
});
