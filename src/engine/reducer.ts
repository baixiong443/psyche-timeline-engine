import { isSafePath } from './conditions';
import type {
  CanonEventStatus,
  DomainOperation,
  JsonValue,
  RelationshipState,
  StoryEvent,
  StoryProjection,
  TimelineOperation
} from '../model/types';

const CANON_TRANSITIONS: Record<CanonEventStatus, ReadonlySet<CanonEventStatus>> = {
  locked: new Set(['eligible', 'delayed', 'skipped', 'invalidated']),
  eligible: new Set(['active', 'delayed', 'skipped', 'invalidated']),
  active: new Set(['completed_canonical', 'completed_adapted', 'delayed', 'invalidated']),
  completed_canonical: new Set(),
  completed_adapted: new Set(),
  delayed: new Set(['eligible', 'active', 'skipped', 'invalidated']),
  skipped: new Set(['eligible']),
  invalidated: new Set()
};

export function allowedCanonEventTransitions(status: CanonEventStatus): CanonEventStatus[] {
  return [...CANON_TRANSITIONS[status]];
}

export function findCanonEventTransitionPath(
  from: CanonEventStatus,
  to: CanonEventStatus
): CanonEventStatus[] | null {
  if (from === to) return [];
  const queue: Array<{ status: CanonEventStatus; path: CanonEventStatus[] }> = [{ status: from, path: [] }];
  const visited = new Set<CanonEventStatus>([from]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of CANON_TRANSITIONS[current.status]) {
      if (visited.has(next)) continue;
      const path = [...current.path, next];
      if (next === to) return path;
      visited.add(next);
      queue.push({ status: next, path });
    }
  }
  return null;
}

export interface ApplyOperationResult {
  projection: StoryProjection;
  applied: boolean;
  error?: string;
}

function cloneProjection(projection: StoryProjection): StoryProjection {
  return structuredClone(projection);
}

export function isProjectionPathLocked(projection: StoryProjection, path: string): boolean {
  return projection.lockedPaths.some(locked => (
    path === locked
    || path.startsWith(`${locked}.`)
    || locked.startsWith(`${path}.`)
  ));
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 160 && isSafePath(value.replaceAll('/', '.'));
}

function normalizeConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function relationshipFor(projection: StoryProjection, pairId: string): RelationshipState {
  return projection.relationships[pairId] ?? {
    pairId,
    stage: 'unknown',
    directions: {},
    axes: {}
  };
}

function fail(projection: StoryProjection, error: string): ApplyOperationResult {
  return { projection, applied: false, error };
}

export function applyOperation(current: StoryProjection, operation: TimelineOperation): ApplyOperationResult {
  if (!operation.id || !normalizeConfidence(operation.confidence)) {
    return fail(current, 'Operation id or confidence is invalid.');
  }
  const next = cloneProjection(current);

  switch (operation.type) {
    case 'advance_time': {
      if (!Number.isFinite(operation.minutes) || Math.abs(operation.minutes) > 525_600) {
        return fail(current, 'Time delta is invalid.');
      }
      if (isProjectionPathLocked(next, 'time.relativeMinutes')) return fail(current, 'Relative time is locked.');
      next.time.relativeMinutes += operation.minutes;
      return { projection: next, applied: true };
    }
    case 'set_time': {
      if (operation.absolute !== null && Number.isNaN(Date.parse(operation.absolute))) {
        return fail(current, 'Absolute time must be an ISO-compatible date.');
      }
      if (isProjectionPathLocked(next, 'time.absolute')) return fail(current, 'Absolute time is locked.');
      next.time.absolute = operation.absolute;
      return { projection: next, applied: true };
    }
    case 'move_location': {
      const lockedField = (['area', 'place', 'position'] as const).find(field => (
        next.location[field] !== operation.location[field]
        && isProjectionPathLocked(next, `location.${field}`)
      ));
      if (lockedField) return fail(current, `Location ${lockedField} is locked.`);
      next.location = { ...operation.location };
      return { projection: next, applied: true };
    }
    case 'set_character_presence': {
      if (!validIdentifier(operation.characterId)) return fail(current, 'Character id is invalid.');
      const path = `characters.${operation.characterId}.present`;
      if (isProjectionPathLocked(next, path)) return fail(current, 'Character presence is locked.');
      next.characters[operation.characterId] = {
        ...(next.characters[operation.characterId] ?? { present: false }),
        present: operation.present
      };
      return { projection: next, applied: true };
    }
    case 'set_character_state': {
      if (!validIdentifier(operation.characterId)) return fail(current, 'Character id is invalid.');
      const path = `characters.${operation.characterId}.${operation.field}`;
      if (isProjectionPathLocked(next, path)) return fail(current, 'Character field is locked.');
      const state = next.characters[operation.characterId] ?? { present: false };
      if (operation.field === 'activity') {
        if (operation.value !== null && typeof operation.value !== 'string') return fail(current, 'Activity must be text or null.');
        state.activity = operation.value;
      } else if (operation.field === 'mood' || operation.field === 'physical') {
        if (!Array.isArray(operation.value) || !operation.value.every(value => typeof value === 'string')) {
          return fail(current, `${operation.field} must be a string array.`);
        }
        state[operation.field] = [...operation.value];
      } else if (operation.field === 'outfit') {
        if (!operation.value || Array.isArray(operation.value) || typeof operation.value !== 'object') {
          return fail(current, 'Outfit must be an object.');
        }
        state.outfit = operation.value as Record<string, string | null>;
      } else {
        if (!operation.value || Array.isArray(operation.value) || typeof operation.value !== 'object') {
          return fail(current, 'Custom character state must be an object.');
        }
        state.custom = operation.value as Record<string, JsonValue>;
      }
      next.characters[operation.characterId] = state;
      return { projection: next, applied: true };
    }
    case 'add_fact': {
      if (!validIdentifier(operation.factId)) return fail(current, 'Fact id is invalid.');
      if (isProjectionPathLocked(next, `facts.${operation.factId}`)) return fail(current, 'Fact is locked.');
      next.facts[operation.factId] = structuredClone(operation.fact);
      return { projection: next, applied: true };
    }
    case 'set_knowledge': {
      if (!validIdentifier(operation.characterId) || !validIdentifier(operation.factId)) {
        return fail(current, 'Knowledge identifiers are invalid.');
      }
      if (!next.facts[operation.factId]) return fail(current, 'Knowledge cannot reference an unknown fact.');
      const path = `knowledge.${operation.characterId}.${operation.factId}`;
      if (isProjectionPathLocked(next, path)) return fail(current, 'Knowledge entry is locked.');
      next.knowledge[operation.characterId] ??= {};
      next.knowledge[operation.characterId]![operation.factId] = {
        state: operation.state,
        sourceRecordId: operation.id,
        perceivedTruth: operation.perceivedTruth
      };
      return { projection: next, applied: true };
    }
    case 'set_relationship_stage': {
      if (!validIdentifier(operation.pairId)) return fail(current, 'Relationship id is invalid.');
      if (isProjectionPathLocked(next, `relationships.${operation.pairId}.stage`)) return fail(current, 'Relationship stage is locked.');
      const relationship = relationshipFor(next, operation.pairId);
      relationship.stage = operation.stage;
      next.relationships[operation.pairId] = relationship;
      return { projection: next, applied: true };
    }
    case 'set_relationship_attitude': {
      if (![operation.pairId, operation.fromCharacterId, operation.towardCharacterId].every(validIdentifier)) {
        return fail(current, 'Relationship identifiers are invalid.');
      }
      const path = `relationships.${operation.pairId}.directions.${operation.fromCharacterId}`;
      if (isProjectionPathLocked(next, path)) return fail(current, 'Relationship direction is locked.');
      const relationship = relationshipFor(next, operation.pairId);
      relationship.directions[operation.fromCharacterId] = {
        toward: operation.towardCharacterId,
        stance: [...operation.stance],
        wants: [...(operation.wants ?? [])],
        secrets: [...(operation.secrets ?? [])]
      };
      next.relationships[operation.pairId] = relationship;
      return { projection: next, applied: true };
    }
    case 'change_relationship_axis': {
      if (!validIdentifier(operation.pairId) || !validIdentifier(operation.axis)) {
        return fail(current, 'Relationship axis identifiers are invalid.');
      }
      if (!Number.isFinite(operation.delta) || Math.abs(operation.delta) > 1_000_000) {
        return fail(current, 'Relationship axis change is invalid.');
      }
      const path = `relationships.${operation.pairId}.axes.${operation.axis}`;
      if (isProjectionPathLocked(next, path)) return fail(current, 'Relationship axis is locked.');
      const relationship = relationshipFor(next, operation.pairId);
      const value = (relationship.axes[operation.axis] ?? 0) + operation.delta;
      if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
        return fail(current, 'Relationship axis value exceeds the safe range.');
      }
      relationship.axes[operation.axis] = value;
      next.relationships[operation.pairId] = relationship;
      return { projection: next, applied: true };
    }
    case 'change_inventory': {
      if (!validIdentifier(operation.itemId) || !Number.isInteger(operation.delta) || Math.abs(operation.delta) > 1_000_000) {
        return fail(current, 'Inventory change is invalid.');
      }
      if (isProjectionPathLocked(next, `inventory.${operation.itemId}`)) return fail(current, 'Inventory item is locked.');
      const previous = next.inventory[operation.itemId] ?? { count: 0 };
      const count = previous.count + operation.delta;
      if (count < 0) return fail(current, 'Inventory count cannot become negative.');
      next.inventory[operation.itemId] = {
        count,
        description: operation.description ?? previous.description,
        ownerId: operation.ownerId ?? previous.ownerId
      };
      return { projection: next, applied: true };
    }
    case 'set_divergence': {
      if (!Number.isFinite(operation.structuralLevel) || operation.structuralLevel < 0 || operation.structuralLevel > 1) {
        return fail(current, 'Divergence level must be between 0 and 1.');
      }
      if (typeof operation.summary !== 'string' || operation.summary.length > 2000) {
        return fail(current, 'Divergence summary is invalid.');
      }
      const levelChanged = next.divergence.structuralLevel !== operation.structuralLevel;
      const summaryChanged = next.divergence.summary !== operation.summary;
      if (levelChanged && isProjectionPathLocked(next, 'divergence.structuralLevel')) {
        return fail(current, 'Divergence level is locked.');
      }
      if (summaryChanged && isProjectionPathLocked(next, 'divergence.summary')) {
        return fail(current, 'Divergence summary is locked.');
      }
      next.divergence = { structuralLevel: operation.structuralLevel, summary: operation.summary };
      return { projection: next, applied: true };
    }
    case 'set_flag': {
      if (!validIdentifier(operation.flag)) return fail(current, 'Flag id is invalid.');
      if (isProjectionPathLocked(next, `flags.${operation.flag}`)) return fail(current, 'Flag is locked.');
      next.flags[operation.flag] = structuredClone(operation.value);
      return { projection: next, applied: true };
    }
    case 'open_thread': {
      if (!validIdentifier(operation.threadId)) return fail(current, 'Thread id is invalid.');
      if (isProjectionPathLocked(next, `openThreads.${operation.threadId}`)) return fail(current, 'Thread is locked.');
      next.openThreads[operation.threadId] = {
        title: operation.title,
        status: 'open',
        evidenceRefs: [...operation.evidenceIds]
      };
      return { projection: next, applied: true };
    }
    case 'resolve_thread': {
      const thread = next.openThreads[operation.threadId];
      if (!thread) return fail(current, 'Thread does not exist.');
      if (isProjectionPathLocked(next, `openThreads.${operation.threadId}`)) return fail(current, 'Thread is locked.');
      thread.status = operation.status;
      return { projection: next, applied: true };
    }
    case 'transition_canon_event': {
      if (!validIdentifier(operation.eventId)) return fail(current, 'Canon event id is invalid.');
      if (isProjectionPathLocked(next, `canonEvents.${operation.eventId}`)) return fail(current, 'Canon event is locked.');
      const previous = next.canonEvents[operation.eventId] ?? 'locked';
      if (previous === operation.status) return { projection: next, applied: true };
      if (!CANON_TRANSITIONS[previous].has(operation.status)) {
        return fail(current, `Illegal canon event transition: ${previous} -> ${operation.status}.`);
      }
      next.canonEvents[operation.eventId] = operation.status;
      return { projection: next, applied: true };
    }
    case 'set_narrative_purpose': {
      if (!validIdentifier(operation.purposeId)) return fail(current, 'Purpose id is invalid.');
      if (isProjectionPathLocked(next, `narrativePurposes.${operation.purposeId}`)) return fail(current, 'Purpose is locked.');
      next.narrativePurposes[operation.purposeId] = operation.status;
      return { projection: next, applied: true };
    }
    case 'set_locked_paths': {
      const allowedRoots = new Set([
        'time', 'location', 'characters', 'relationships', 'inventory', 'facts', 'knowledge',
        'flags', 'canonEvents', 'narrativePurposes', 'openThreads', 'custom', 'divergence'
      ]);
      if (operation.paths.length > 200 || operation.paths.some(path => (
        !isSafePath(path) || !allowedRoots.has(path.split('.')[0] ?? '')
      ))) {
        return fail(current, 'Locked paths contain an unsafe or unsupported path.');
      }
      next.lockedPaths = [...new Set(operation.paths)].sort();
      return { projection: next, applied: true };
    }
  }
}

export interface ApplyOperationsResult {
  projection: StoryProjection;
  applied: TimelineOperation[];
  rejected: Array<{ operation: TimelineOperation; error: string }>;
}

export function applyOperations(
  current: StoryProjection,
  operations: TimelineOperation[],
  events: StoryEvent[] = []
): ApplyOperationsResult {
  let projection = cloneProjection(current);
  const applied: TimelineOperation[] = [];
  const rejected: Array<{ operation: TimelineOperation; error: string }> = [];
  const eventsById = new Map(events.map(event => [event.id, event]));
  const explicitOperationIds = new Set(operations.map(operation => operation.id));
  for (const operation of operations) {
    if (operation.type === 'transition_canon_event') {
      const event = eventsById.get(operation.eventId);
      if (event && operation.status === 'delayed' && !event.adaptation.allowDelay) {
        rejected.push({ operation, error: `Canon event ${operation.eventId} does not allow delay.` });
        continue;
      }
      if (
        event
        && operation.status === 'completed_adapted'
        && !event.adaptation.allowRelocation
        && !event.adaptation.allowSubstitution
      ) {
        rejected.push({ operation, error: `Canon event ${operation.eventId} does not allow adapted completion.` });
        continue;
      }
    }
    const previousCanonStatus = operation.type === 'transition_canon_event'
      ? projection.canonEvents[operation.eventId] ?? 'locked'
      : null;
    const result = applyOperation(projection, operation);
    if (result.applied) {
      projection = result.projection;
      applied.push(operation);
      if (
        operation.type === 'transition_canon_event'
        && ['completed_canonical', 'completed_adapted'].includes(operation.status)
        && previousCanonStatus !== operation.status
      ) {
        const event = eventsById.get(operation.eventId);
        if (operation.status === 'completed_canonical') {
          for (const effect of event?.effects ?? []) {
            if (explicitOperationIds.has(effect.id)) continue;
            const effectResult = applyOperation(projection, effect);
            if (effectResult.applied) {
              projection = effectResult.projection;
              applied.push(effect);
            } else {
              rejected.push({
                operation: effect,
                error: `Canon event ${operation.eventId} effect failed: ${effectResult.error ?? 'Unknown error.'}`
              });
            }
          }
        }
        for (const purposeId of event?.narrativePurposes ?? []) {
          const path = `narrativePurposes.${purposeId}`;
          if (isProjectionPathLocked(projection, path)) continue;
          if ((projection.narrativePurposes[purposeId] ?? 'pending') !== 'pending') continue;
          const purposeEffect: DomainOperation = {
            id: `canon-purpose-${event!.id}-${purposeId}`,
            type: 'set_narrative_purpose',
            confidence: 1,
            evidenceIds: [],
            purposeId,
            status: 'fulfilled'
          };
          const purposeResult = applyOperation(projection, purposeEffect);
          if (purposeResult.applied) {
            projection = purposeResult.projection;
            applied.push(purposeEffect);
          } else {
            rejected.push({
              operation: purposeEffect,
              error: `Canon event ${operation.eventId} purpose failed: ${purposeResult.error ?? 'Unknown error.'}`
            });
          }
        }
      }
    } else {
      rejected.push({ operation, error: result.error ?? 'Unknown reducer error.' });
    }
  }
  return { projection, applied, rejected };
}
