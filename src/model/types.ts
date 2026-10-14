export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonLogicRule = JsonValue;

export type ParticipationMode = 'follow' | 'adaptive' | 'parallel' | 'free';
export type AuditMode = 'off' | 'standard' | 'strict';

export type CanonEventStatus =
  | 'locked'
  | 'eligible'
  | 'active'
  | 'completed_canonical'
  | 'completed_adapted'
  | 'delayed'
  | 'skipped'
  | 'invalidated';

export type PurposeStatus = 'pending' | 'fulfilled' | 'abandoned';
export type KnowledgeState = 'knows' | 'suspects' | 'believes_false' | 'unaware' | 'hiding';
export type FactTruthStatus = 'true' | 'false' | 'unknown';
export type EventKind = 'hard_anchor' | 'soft_anchor' | 'character_beat' | 'transition' | 'atmosphere' | 'chance';
export type EventRigidity = 'hard' | 'soft' | 'flexible';
/**
 * Which part of the story an event belongs to.
 *
 * - `interpersonal` (default): driven by character behaviour and relationships,
 *   so a diverged branch can legitimately change or cancel it.
 * - `world`: a world-scale process (natural disaster, war, plague, regime
 *   change) that unfolds on its own timeline. It is intentionally immune to
 *   branch divergence, because the player leaving canon does not stop it.
 *
 * Omitted means `interpersonal`, which keeps every pre-`scope` package valid.
 */
export type EventScope = 'world' | 'interpersonal';

export interface StoryLocation {
  area: string;
  place: string;
  position: string;
}

export interface StoryTime {
  absolute: string | null;
  relativeMinutes: number;
}

export interface CanonCursor {
  chapterId: string;
  sceneId: string;
  eventOrder: number;
}

export interface CharacterState {
  present: boolean;
  location?: StoryLocation;
  mood?: string[];
  activity?: string | null;
  physical?: string[];
  outfit?: Record<string, string | null>;
  custom?: Record<string, JsonValue>;
}

export interface RelationshipDirection {
  toward: string;
  stance: string[];
  wants: string[];
  secrets: string[];
}

export interface RelationshipState {
  pairId: string;
  stage: string;
  directions: Record<string, RelationshipDirection>;
  axes: Record<string, number>;
}

export interface FactState {
  truth: string;
  status: FactTruthStatus;
  evidenceRefs: string[];
}

export interface KnowledgeEntry {
  state: KnowledgeState;
  sourceRecordId?: string;
  perceivedTruth?: string;
}

export interface InventoryEntry {
  count: number;
  description?: string;
  ownerId?: string;
}

export interface OpenThread {
  title: string;
  status: 'open' | 'resolved' | 'abandoned';
  evidenceRefs: string[];
}

export interface StoryProjection {
  schemaVersion: 1;
  storyId: string;
  turn: number;
  canonCursor: CanonCursor;
  time: StoryTime;
  location: StoryLocation;
  characters: Record<string, CharacterState>;
  relationships: Record<string, RelationshipState>;
  inventory: Record<string, InventoryEntry>;
  facts: Record<string, FactState>;
  knowledge: Record<string, Record<string, KnowledgeEntry>>;
  flags: Record<string, JsonValue>;
  canonEvents: Record<string, CanonEventStatus>;
  narrativePurposes: Record<string, PurposeStatus>;
  openThreads: Record<string, OpenThread>;
  custom: Record<string, JsonValue>;
  lockedPaths: string[];
  divergence: {
    structuralLevel: number;
    summary: string;
  };
}

export interface ManualStateDraft {
  absoluteTime: string;
  relativeMinutes: number;
  location: StoryLocation;
  characterPresence: Record<string, boolean>;
  divergenceLevel: number;
  divergenceSummary: string;
}

export interface AdaptationPolicy {
  allowDelay: boolean;
  allowRelocation: boolean;
  allowSubstitution: boolean;
}

export interface StoryEvent {
  id: string;
  chapterId: string;
  sceneId: string;
  canonicalOrder: number;
  kind: EventKind;
  rigidity: EventRigidity;
  /** Defaults to `interpersonal` when omitted or unknown. */
  scope?: EventScope;
  summary: string;
  participants: string[];
  preconditions?: JsonLogicRule;
  forbiddenWhen?: JsonLogicRule;
  effects: DomainOperation[];
  narrativePurposes: string[];
  evidenceRefs: string[];
  revealPolicy: 'eligible_only' | 'active_only' | 'never';
  adaptation: AdaptationPolicy;
}

export interface StoryPlan {
  schemaVersion: 1;
  storyId: string;
  title: string;
  initialState: StoryProjection;
  events: StoryEvent[];
}

export interface EvidenceItem {
  id: string;
  source: 'user' | 'assistant' | 'canon';
  quote: string;
  claim: string;
}

export interface OperationBase {
  id: string;
  confidence: number;
  evidenceIds: string[];
}

export type DomainOperation =
  | (OperationBase & { type: 'advance_time'; minutes: number })
  | (OperationBase & { type: 'set_time'; absolute: string | null })
  | (OperationBase & { type: 'move_location'; location: StoryLocation })
  | (OperationBase & { type: 'set_character_presence'; characterId: string; present: boolean })
  | (OperationBase & { type: 'set_character_state'; characterId: string; field: 'mood' | 'activity' | 'physical' | 'outfit' | 'custom'; value: JsonValue })
  | (OperationBase & { type: 'add_fact'; factId: string; fact: FactState })
  | (OperationBase & { type: 'set_knowledge'; characterId: string; factId: string; state: KnowledgeState; perceivedTruth?: string })
  | (OperationBase & { type: 'set_relationship_stage'; pairId: string; stage: string })
  | (OperationBase & { type: 'set_relationship_attitude'; pairId: string; fromCharacterId: string; towardCharacterId: string; stance: string[]; wants?: string[]; secrets?: string[] })
  | (OperationBase & { type: 'change_relationship_axis'; pairId: string; axis: string; delta: number })
  | (OperationBase & { type: 'change_inventory'; itemId: string; delta: number; description?: string; ownerId?: string })
  | (OperationBase & { type: 'set_divergence'; structuralLevel: number; summary: string })
  | (OperationBase & { type: 'set_flag'; flag: string; value: JsonValue })
  | (OperationBase & { type: 'open_thread'; threadId: string; title: string })
  | (OperationBase & { type: 'resolve_thread'; threadId: string; status: 'resolved' | 'abandoned' })
  | (OperationBase & { type: 'transition_canon_event'; eventId: string; status: CanonEventStatus })
  | (OperationBase & { type: 'set_narrative_purpose'; purposeId: string; status: PurposeStatus });

export type ManualOperation = OperationBase & {
  type: 'set_locked_paths';
  paths: string[];
};

export type TimelineOperation = DomainOperation | ManualOperation;

export interface AuditViolation {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  evidenceIds: string[];
}

export interface TurnRecord {
  schemaVersion: 1;
  kind?: 'extracted' | 'manual';
  recordId: string;
  parentRecordId: string | null;
  userMessageId: string;
  assistantMessageId: string;
  swipeId: number;
  inputHash: string;
  outputHash: string;
  baseProjectionHash: string;
  operations: TimelineOperation[];
  evidence: EvidenceItem[];
  audit: {
    mode: AuditMode;
    status: 'unreviewed' | 'pending' | 'passed' | 'warning' | 'failed' | 'stale';
    violations: AuditViolation[];
    model: string | null;
  };
  application: {
    status: 'pending_user' | 'applied' | 'rejected' | 'stale';
    appliedAt: number | null;
  };
  checkpoint: StoryProjection | null;
  projectionHash: string | null;
  createdAt: number;
}

export interface ExtractionResponse {
  schemaVersion: 1;
  summary: string;
  confidence: number;
  evidence: EvidenceItem[];
  operations: DomainOperation[];
  violations: AuditViolation[];
}

export interface MessageTimelineData {
  schema_version: 1;
  message_id: string;
  records_by_swipe: Record<string, TurnRecord>;
}

export interface SwipeTimelineMirror {
  schema_version: 1;
  message_id: string;
  swipe_id: number;
  record_id: string | null;
  application_status: TurnRecord['application']['status'] | 'none';
  audit_status: TurnRecord['audit']['status'] | 'none';
  projection_hash: string | null;
  turn: number | null;
  record?: TurnRecord | null;
  timeline?: MessageTimelineData;
}

export interface CardTimelineExtension {
  schema_version: '1.0';
  story_id: string;
  package_digest?: string;
  entry_point: {
    chapter_id: string;
    scene_id: string;
    event_id?: string;
  };
  bindings: {
    character_id: string;
    user_role_id?: string;
  };
  mode_defaults?: {
    participation?: ParticipationMode;
    audit?: AuditMode;
    auto_apply?: boolean;
  };
  initial_state?: StoryProjection;
  inline_plan?: StoryPlan;
}

export interface SchedulerCandidate {
  event: StoryEvent;
  score: number;
  state: 'eligible' | 'delayed' | 'invalidated';
  reasons: string[];
}
