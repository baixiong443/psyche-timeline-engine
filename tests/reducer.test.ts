import { applyOperation, applyOperations, findCanonEventTransitionPath } from '../src/engine/reducer';
import { createEmptyProjection } from '../src/model/defaults';
import type { DomainOperation, ManualOperation } from '../src/model/types';
import { operation, storyEvent } from './fixtures';

describe('domain reducer', () => {
  it('rejects illegal canon transitions', () => {
    const initial = createEmptyProjection('story-1');
    const result = applyOperation(initial, operation<DomainOperation>({
      type: 'transition_canon_event',
      eventId: 'arrival',
      status: 'completed_canonical'
    }));

    expect(result.applied).toBe(false);
    expect(result.error).toContain('locked -> completed_canonical');
    expect(initial.canonEvents.arrival).toBeUndefined();
  });

  it('finds the legal multi-step path for a manual adapted completion', () => {
    expect(findCanonEventTransitionPath('locked', 'completed_adapted')).toEqual([
      'eligible', 'active', 'completed_adapted'
    ]);
    expect(findCanonEventTransitionPath('invalidated', 'eligible')).toBeNull();
  });

  it('never allows inventory underflow', () => {
    const initial = createEmptyProjection('story-1');
    initial.inventory.coin = { count: 1 };
    const result = applyOperation(initial, operation<DomainOperation>({
      type: 'change_inventory',
      itemId: 'coin',
      delta: -2
    }));

    expect(result.applied).toBe(false);
    expect(result.projection).toBe(initial);
    expect(initial.inventory.coin?.count).toBe(1);
  });

  it('changes relationship axes deterministically and respects field locks', () => {
    const initial = createEmptyProjection('story-1');
    initial.relationships.hero_user = {
      pairId: 'hero_user',
      stage: 'acquaintances',
      directions: {},
      axes: { affinity: 12.5 }
    };
    const changed = applyOperation(initial, operation<DomainOperation>({
      type: 'change_relationship_axis',
      pairId: 'hero_user',
      axis: 'affinity',
      delta: 2.5
    }));

    expect(changed.applied).toBe(true);
    expect(changed.projection.relationships.hero_user?.axes.affinity).toBe(15);
    changed.projection.lockedPaths.push('relationships.hero_user.axes.affinity');
    const blocked = applyOperation(changed.projection, operation<DomainOperation>({
      type: 'change_relationship_axis',
      pairId: 'hero_user',
      axis: 'affinity',
      delta: 1
    }));
    expect(blocked.applied).toBe(false);
    expect(blocked.error).toBe('Relationship axis is locked.');
  });

  it('updates structural divergence within the protocol range', () => {
    const initial = createEmptyProjection('story-1');
    const changed = applyOperation(initial, operation<DomainOperation>({
      type: 'set_divergence',
      structuralLevel: 0.75,
      summary: 'The original rescue route is no longer reachable.'
    }));

    expect(changed.applied).toBe(true);
    expect(changed.projection.divergence).toEqual({
      structuralLevel: 0.75,
      summary: 'The original rescue route is no longer reachable.'
    });
    const invalid = applyOperation(changed.projection, operation<DomainOperation>({
      type: 'set_divergence',
      structuralLevel: 1.1,
      summary: 'invalid'
    }));
    expect(invalid.applied).toBe(false);
  });

  it('applies canon effects exactly when an event first completes canonically', () => {
    const initial = createEmptyProjection('story-1');
    initial.narrativePurposes.reveal_signal = 'pending';
    const event = storyEvent({
      id: 'signal',
      narrativePurposes: ['reveal_signal'],
      effects: [operation<DomainOperation>({ id: 'signal-flag', type: 'set_flag', flag: 'signal_seen', value: true })]
    });
    const result = applyOperations(initial, [
      operation<DomainOperation>({ id: 'eligible', type: 'transition_canon_event', eventId: event.id, status: 'eligible' }),
      operation<DomainOperation>({ id: 'active', type: 'transition_canon_event', eventId: event.id, status: 'active' }),
      operation<DomainOperation>({ id: 'complete', type: 'transition_canon_event', eventId: event.id, status: 'completed_canonical' })
    ], [event]);

    expect(result.rejected).toEqual([]);
    expect(result.projection.flags.signal_seen).toBe(true);
    expect(result.projection.narrativePurposes.reveal_signal).toBe('fulfilled');
    expect(result.applied.map(item => item.id)).toEqual([
      'eligible', 'active', 'complete', 'signal-flag', 'canon-purpose-signal-reveal_signal'
    ]);
  });

  it('does not force canonical effects onto an adapted completion', () => {
    const initial = createEmptyProjection('story-1');
    initial.narrativePurposes.reveal_signal = 'pending';
    const event = storyEvent({
      id: 'signal',
      narrativePurposes: ['reveal_signal'],
      effects: [operation<DomainOperation>({ id: 'signal-flag', type: 'set_flag', flag: 'signal_seen', value: true })]
    });
    const result = applyOperations(initial, [
      operation<DomainOperation>({ id: 'eligible', type: 'transition_canon_event', eventId: event.id, status: 'eligible' }),
      operation<DomainOperation>({ id: 'active', type: 'transition_canon_event', eventId: event.id, status: 'active' }),
      operation<DomainOperation>({ id: 'adapted', type: 'transition_canon_event', eventId: event.id, status: 'completed_adapted' })
    ], [event]);

    expect(result.rejected).toEqual([]);
    expect(result.projection.flags.signal_seen).toBeUndefined();
    expect(result.projection.narrativePurposes.reveal_signal).toBe('fulfilled');
  });

  it('enforces event adaptation policy before changing canon status', () => {
    const initial = createEmptyProjection('story-1');
    const event = storyEvent({
      id: 'rigid-event',
      adaptation: { allowDelay: false, allowRelocation: false, allowSubstitution: false }
    });
    initial.canonEvents[event.id] = 'eligible';
    const delayed = applyOperations(initial, [operation<DomainOperation>({
      type: 'transition_canon_event', eventId: event.id, status: 'delayed'
    })], [event]);
    expect(delayed.rejected[0]?.error).toContain('does not allow delay');

    initial.canonEvents[event.id] = 'active';
    const adapted = applyOperations(initial, [operation<DomainOperation>({
      type: 'transition_canon_event', eventId: event.id, status: 'completed_adapted'
    })], [event]);
    expect(adapted.rejected[0]?.error).toContain('does not allow adapted completion');
  });

  it('blocks a parent write when any child path is locked', () => {
    const initial = createEmptyProjection('story-1');
    initial.lockedPaths.push('location.place');
    const result = applyOperation(initial, operation<DomainOperation>({
      type: 'move_location',
      location: { area: 'north', place: 'station', position: 'platform' }
    }));

    expect(result.applied).toBe(false);
    expect(result.error).toBe('Location place is locked.');
  });

  it('stores normalized lock paths and enforces them on later operations', () => {
    const initial = createEmptyProjection('story-1');
    const locked = applyOperation(initial, operation<ManualOperation>({
      type: 'set_locked_paths',
      paths: ['time.absolute', 'time.absolute']
    }));
    const changed = applyOperation(locked.projection, operation<DomainOperation>({
      type: 'set_time',
      absolute: '1922-02-10T20:21:00Z'
    }));

    expect(locked.applied).toBe(true);
    expect(locked.projection.lockedPaths).toEqual(['time.absolute']);
    expect(changed.applied).toBe(false);
    expect(changed.error).toBe('Absolute time is locked.');
  });

  it('allows an unlocked location field to change without rewriting a locked sibling', () => {
    const initial = createEmptyProjection('story-1');
    initial.location = { area: 'lake', place: 'shore', position: 'stone' };
    initial.lockedPaths = ['location.area'];
    const result = applyOperation(initial, operation<DomainOperation>({
      type: 'move_location',
      location: { area: 'lake', place: 'slope', position: 'stone' }
    }));

    expect(result.applied).toBe(true);
    expect(result.projection.location.place).toBe('slope');
  });

  it('keeps valid operations while reporting invalid candidates outside transactional replay', () => {
    const initial = createEmptyProjection('story-1');
    const result = applyOperations(initial, [
      operation<DomainOperation>({ id: 'time', type: 'advance_time', minutes: 10 }),
      operation<DomainOperation>({ id: 'coins', type: 'change_inventory', itemId: 'coin', delta: -1 })
    ]);

    expect(result.projection.time.relativeMinutes).toBe(10);
    expect(result.applied).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
  });
});
