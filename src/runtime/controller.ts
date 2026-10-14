import { extractAndAuditTurn } from '../ai/extractor';
import { EXTENSION_KEY, PROMPT_KEY, MESSAGE_FIELD } from '../constants';
import { applyOperations, findCanonEventTransitionPath } from '../engine/reducer';
import {
  advanceCanonCursorFromOperations,
  shouldAdvanceStoryTurn,
  shouldCreateCheckpoint
} from '../engine/projection';
import type {
  CanonEventStatus,
  DomainOperation,
  ManualOperation,
  ManualStateDraft,
  StoryProjection,
  TimelineOperation,
  TurnRecord
} from '../model/types';
import {
  activeSwipeId,
  ensureMessageTimeline,
  findPrecedingUserMessage,
  getMessageId,
  getSwipeRecord,
  markRecordsStaleFromMessage,
  mirrorActiveSwipe,
  reindexRecordsAfterSwipeDeletion,
  setSwipeRecord,
  type SillyTavernMessage
} from '../storage/messages';
import { hashJson, sha256Text } from '../utils/hash';
import { validateDomainOperations } from '../schema/validators';
import { getInstalledPsycheBook, installPsycheBook, parseStoryFile } from '../storage/packageDb';
import { ensureLazySourceCompilation } from '../ai/sourceCompiler';
import {
  getSourceCompilationRecord,
  resetSourceCompilationAttempts,
  retrySourceCompilation
} from '../storage/sourceDb';
import { PsycheTimelinePanel, type PanelState } from '../ui/panel';
import { clearTurnBadges, renderTurnBadges } from '../ui/turnBadge';
import { getSillyTavernContext, type SillyTavernContext } from './context';
import { buildActiveSession, createSessionInjection, type ActiveSession } from './session';
import {
  applyStoryModeDefaults,
  loadSettings,
  saveSettings,
  storyModeSettingsFrom,
  type PsycheTimelineSettings
} from './settings';
import {
  applyTimelineBackup,
  captureTimelineState,
  createTimelineBackup,
  inspectTimelineBackupTarget,
  parseTimelineBackupFile,
  restoreTimelineState,
  timelineBackupPreview,
  type TimelineBackupV1
} from './backup';
import {
  appendManualTurnRecord,
  bindStoryToChat,
  createManualStory,
  findManualTurnRecord,
  inspectPackageBinding,
  resolveGenerationCharacterId,
  resolveMessageCharacterId,
  resolveActiveStoryWithStatus,
  readChatModeSettings,
  writeChatModeSettings,
  type ActiveStory
} from './story';

export interface ManualStateOperationResult {
  operations: DomainOperation[];
  errors: string[];
}

export function buildCanonTransitionOperations(
  eventId: string,
  from: CanonEventStatus,
  target: CanonEventStatus
): { operations: DomainOperation[]; errors: string[] } {
  const path = findCanonEventTransitionPath(from, target);
  if (path === null) return { operations: [], errors: [`不能把事件从 ${from} 转换为 ${target}。`] };
  return {
    operations: path.map((status, index) => ({
      id: `manual-canon-${index + 1}`,
      type: 'transition_canon_event',
      confidence: 1,
      evidenceIds: [],
      eventId,
      status
    })),
    errors: []
  };
}

export function buildManualStateOperations(
  projection: StoryProjection,
  draft: ManualStateDraft
): ManualStateOperationResult {
  const operations: DomainOperation[] = [];
  const errors: string[] = [];
  const absoluteInput = draft.absoluteTime.trim();
  let absolute: string | null = null;
  if (absoluteInput) {
    const timestamp = Date.parse(absoluteInput);
    if (Number.isNaN(timestamp)) errors.push('绝对时间不是有效的 ISO 8601 时间。');
    else absolute = new Date(timestamp).toISOString();
  }
  const currentAbsoluteTimestamp = projection.time.absolute === null
    ? Number.NaN
    : Date.parse(projection.time.absolute);
  const comparableCurrentAbsolute = projection.time.absolute !== null && !Number.isNaN(currentAbsoluteTimestamp)
    ? new Date(currentAbsoluteTimestamp).toISOString()
    : projection.time.absolute;
  if (!Number.isFinite(draft.relativeMinutes)) errors.push('相对分钟必须是有限数字。');
  const delta = draft.relativeMinutes - projection.time.relativeMinutes;
  if (Number.isFinite(delta) && Math.abs(delta) > 525_600) errors.push('单次相对时间修正不能超过 525600 分钟。');
  const location = {
    area: draft.location.area.trim(),
    place: draft.location.place.trim(),
    position: draft.location.position.trim()
  };
  if (Object.values(location).some(value => value.length > 500)) errors.push('地点字段不能超过 500 个字符。');
  if (!Number.isFinite(draft.divergenceLevel) || draft.divergenceLevel < 0 || draft.divergenceLevel > 1) {
    errors.push('分歧度必须是 0 到 1 之间的有限数字。');
  }
  const divergenceSummary = draft.divergenceSummary.trim();
  if (divergenceSummary.length > 2000) errors.push('分支摘要不能超过 2000 个字符。');
  const unknownCharacters = Object.keys(draft.characterPresence)
    .filter(characterId => !Object.hasOwn(projection.characters, characterId));
  if (unknownCharacters.length > 0) errors.push(`存在未知角色：${unknownCharacters.join('、')}`);
  if (errors.length > 0) return { operations, errors };

  const base = { confidence: 1, evidenceIds: [] as string[] };
  if (absolute !== comparableCurrentAbsolute) {
    operations.push({ ...base, id: 'manual-set-time', type: 'set_time', absolute });
  }
  if (delta !== 0) {
    operations.push({ ...base, id: 'manual-advance-time', type: 'advance_time', minutes: delta });
  }
  if (Object.keys(location).some(key => location[key as keyof typeof location] !== projection.location[key as keyof typeof location])) {
    operations.push({ ...base, id: 'manual-move-location', type: 'move_location', location });
  }
  if (
    draft.divergenceLevel !== projection.divergence.structuralLevel
    || divergenceSummary !== projection.divergence.summary
  ) {
    operations.push({
      ...base,
      id: 'manual-set-divergence',
      type: 'set_divergence',
      structuralLevel: draft.divergenceLevel,
      summary: divergenceSummary
    });
  }
  let presenceIndex = 0;
  for (const [characterId, present] of Object.entries(draft.characterPresence)) {
    if (projection.characters[characterId]?.present === present) continue;
    presenceIndex += 1;
    operations.push({
      ...base,
      id: `manual-presence-${presenceIndex}`,
      type: 'set_character_presence',
      characterId,
      present
    });
  }
  return { operations, errors };
}

interface GenerationSnapshot {
  session: ActiveSession;
  baseProjectionHash: string;
  parentRecordId: string | null;
}

interface CompletedGeneration {
  messageIndex: number;
  generationType: string;
}

export class GenerationCompletionLatch<TCompleted, TSnapshot> {
  private ended = false;
  private completed: TCompleted | null = null;
  private snapshot: TSnapshot | null = null;

  reset(): void {
    this.ended = false;
    this.completed = null;
    this.snapshot = null;
  }

  begin(snapshot: TSnapshot): void {
    this.reset();
    this.snapshot = snapshot;
  }

  markEnded(): { completed: TCompleted; snapshot: TSnapshot } | null {
    this.ended = true;
    return this.takeReady();
  }

  markRendered(completed: TCompleted): { completed: TCompleted; snapshot: TSnapshot } | null {
    this.completed = completed;
    return this.takeReady();
  }

  takeRenderedFallback(): { completed: TCompleted; snapshot: TSnapshot } | null {
    if (!this.completed || !this.snapshot) return null;
    const ready = { completed: this.completed, snapshot: this.snapshot };
    this.reset();
    return ready;
  }

  private takeReady(): { completed: TCompleted; snapshot: TSnapshot } | null {
    if (!this.ended || !this.completed || !this.snapshot) return null;
    const ready = { completed: this.completed, snapshot: this.snapshot };
    this.reset();
    return ready;
  }
}

export function shouldSkipExistingExtraction(
  existingOutputHash: string | undefined,
  outputHash: string,
  generationType: string
): boolean {
  return generationType !== 'manual_retry' && existingOutputHash === outputHash;
}

export function shouldSkipGenerationEvent(args: unknown[]): boolean {
  const type = String(args[0] ?? '');
  const options = args[1] as Record<string, unknown> | undefined;
  const dryRun = Boolean(args[2]);
  return dryRun || type === 'quiet' || Boolean(options?.quiet_prompt);
}

export function forcedCharacterIndexFromGenerationEvent(args: unknown[]): number | undefined {
  const options = args[1] as Record<string, unknown> | undefined;
  const forcedCharacterIndex = Number(options?.force_chid);
  return Number.isInteger(forcedCharacterIndex) && forcedCharacterIndex >= 0
    ? forcedCharacterIndex
    : undefined;
}

export function markRecordsStaleAfterCheckpoint(
  records: TurnRecord[],
  targetRecordId: string | null
): string[] {
  const targetIndex = targetRecordId === null
    ? -1
    : records.findIndex(record => record.recordId === targetRecordId);
  if (targetRecordId !== null && targetIndex < 0) return [];
  const changed: string[] = [];
  for (const record of records.slice(targetIndex + 1)) {
    if (record.application.status === 'stale' && record.audit.status === 'stale') continue;
    record.application.status = 'stale';
    record.audit.status = 'stale';
    changed.push(record.recordId);
  }
  return changed;
}

const EMPTY_PANEL_STATE = (settings: PsycheTimelineSettings): PanelState => ({
  settings,
  status: settings.enabled ? 'unbound' : 'disabled',
  statusText: settings.enabled ? '未绑定故事' : '已停用',
  storyTitle: null,
  source: null,
  projection: null,
  pendingRecords: [],
  records: [],
  candidates: [],
  storyDetails: null,
  connectionProfiles: [],
  error: null
});

export class PsycheTimelineController {
  private context: SillyTavernContext;
  private baseSettings: PsycheTimelineSettings;
  private settings: PsycheTimelineSettings;
  private story: ActiveStory | null = null;
  private session: ActiveSession | null = null;
  private generation = new GenerationCompletionLatch<CompletedGeneration, GenerationSnapshot>();
  private generationFallbackTimer: number | null = null;
  private processing: Promise<void> = Promise.resolve();
  private panel: PsycheTimelinePanel;

  private constructor(context: SillyTavernContext) {
    this.context = context;
    this.baseSettings = loadSettings(context);
    this.settings = { ...this.baseSettings };
    this.panel = new PsycheTimelinePanel({
      onSettingsChanged: settings => this.queueSettingsChange(settings),
      onApplyRecord: recordId => void this.applyPendingRecord(recordId),
      onRejectRecord: recordId => void this.rejectPendingRecord(recordId),
      onUpdateRecordOperations: (recordId, operations) => this.updatePendingRecordOperations(recordId, operations),
      onRebuild: () => void this.refresh(true),
      onRetryExtraction: () => void this.retryCurrentReply(),
      onRetrySourceCompilation: sourceUnitId => void this.retryCurrentSourceCompilation(sourceUnitId),
      onResetSourceCompilationAttempts: sourceUnitId => void this.resetCurrentSourceCompilationAttempts(sourceUnitId),
      onCreateCheckpoint: () => void this.createCurrentCheckpoint(),
      onRollbackToCheckpoint: recordId => void this.rollbackToCheckpoint(recordId),
      onApplyManualState: draft => this.applyManualState(draft),
      onApplyManualOperations: (operations, description) => this.appendManualOperations(operations, description),
      onSetPathLocked: (path, locked) => this.setPathLocked(path, locked),
      onTransitionCanonEvent: (eventId, status) => this.transitionCanonEvent(eventId, status),
      onCreate: () => void this.createCurrentCharacterStory(),
      onUnbind: () => void this.unbindCurrentChat(),
      onImport: file => void this.importStory(file),
      onInspectBackup: file => this.inspectBackup(file),
      onRestoreBackup: file => this.restoreBackup(file),
      onExport: () => void this.exportTimelineBackup()
    }, EMPTY_PANEL_STATE(this.settings));
  }

  static create(): PsycheTimelineController | null {
    const context = getSillyTavernContext();
    return context ? new PsycheTimelineController(context) : null;
  }

  async initialize(): Promise<void> {
    this.panel.mount();
    this.registerEvents();
    await this.refresh();
    console.info('[Psyche Timeline Engine] runtime initialized.');
  }

  private event(name: string, handler: (...args: unknown[]) => unknown): void {
    const eventName = this.context.eventTypes[name];
    if (eventName) this.context.eventSource.on(eventName, handler);
  }

  private registerEvents(): void {
    this.event('CHAT_CHANGED', () => this.queueRefresh());
    this.event('CHAT_LOADED', () => this.queueRefresh());
    this.event('GENERATION_AFTER_COMMANDS', (...args) => this.onBeforeGeneration(...args));
    this.event('CHARACTER_MESSAGE_RENDERED', (...args) => this.onCharacterMessageRendered(...args));
    this.event('GENERATION_ENDED', () => this.onGenerationEnded());
    this.event('MESSAGE_SWIPED', (messageId) => this.onMessageSwiped(messageId));
    this.event('MESSAGE_EDITED', (messageId) => this.onMessageEdited(messageId));
    this.event('MESSAGE_DELETED', () => this.queueRefresh());
    this.event('MESSAGE_SWIPE_DELETED', (payload) => this.onSwipeDeleted(payload));
  }

  private queueRefresh(): void {
    this.processing = this.processing.then(() => this.refresh()).catch(error => this.reportError(error));
  }

  private queueSettingsChange(settings: PsycheTimelineSettings): void {
    this.processing = this.processing.then(async () => {
      this.baseSettings = { ...settings };
      this.settings = { ...settings };
      saveSettings(this.context, this.baseSettings);
      if (this.story) {
        writeChatModeSettings(this.context, this.story, storyModeSettingsFrom(settings));
        await this.context.saveChat();
      }
      await this.refresh();
    }).catch(error => this.reportError(error));
  }

  private refreshContext(): void {
    const current = getSillyTavernContext();
    if (current) this.context = current;
  }

  private connectionProfileOptions(): PanelState['connectionProfiles'] {
    try {
      return (this.context.ConnectionManagerRequestService?.getSupportedProfiles() ?? []).map(profile => ({
        id: profile.id,
        label: [profile.name || profile.id, profile.model].filter(Boolean).join(' · ')
      }));
    } catch {
      return [];
    }
  }

  private clearPrompt(): void {
    this.context.setExtensionPrompt(PROMPT_KEY, '', -1, 1, false, 0);
  }

  private pendingRecords(): TurnRecord[] {
    return this.session?.records.filter(record => record.application.status === 'pending_user') ?? [];
  }

  private async refresh(forceSave = false): Promise<void> {
    this.refreshContext();
    if (!this.baseSettings.enabled) {
      this.settings = { ...this.baseSettings };
      this.story = null;
      this.session = null;
      this.clearPrompt();
      this.panel.update(EMPTY_PANEL_STATE(this.settings));
      clearTurnBadges();
      return;
    }

    const resolution = await resolveActiveStoryWithStatus(this.context);
    this.story = resolution.story;
    if (!this.story) {
      this.settings = { ...this.baseSettings };
      this.session = null;
      this.clearPrompt();
      this.panel.update({
        ...EMPTY_PANEL_STATE(this.settings),
        status: resolution.issue ? 'error' : 'unbound',
        statusText: resolution.issue ? '故事包异常' : '未绑定故事',
        storyTitle: resolution.issue?.storyId ?? null,
        source: resolution.issue ? '故事包' : null,
        bindingIssue: resolution.issue,
        connectionProfiles: this.connectionProfileOptions()
      });
      clearTurnBadges();
      return;
    }

    const storedModeSettings = readChatModeSettings(this.context);
    this.settings = applyStoryModeDefaults(this.baseSettings, this.story.card, storedModeSettings);
    const initializedModeSettings = storedModeSettings === null;
    if (initializedModeSettings) {
      writeChatModeSettings(this.context, this.story, storyModeSettingsFrom(this.settings));
    }

    const { session, createdMessageIds, invalidatedRecords } = await buildActiveSession(this.context, this.story, this.settings);
    this.session = session;
    const sourceUnitId = session.sourceContext?.compileUnit?.id;
    const sourceCompilation = sourceUnitId && session.story.card.package_digest
      ? await getSourceCompilationRecord(session.story.card.package_digest, sourceUnitId)
      : undefined;
    const responderCharacterId = resolveGenerationCharacterId(this.context, session.story, session.projection);
    this.context.setExtensionPrompt(
      PROMPT_KEY,
      createSessionInjection(session, this.settings, responderCharacterId),
      1,
      1,
      false,
      0
    );
    if (createdMessageIds > 0 || invalidatedRecords > 0 || initializedModeSettings || forceSave) {
      await this.context.saveChat();
    }

    this.panel.update({
      settings: this.settings,
      status: session.replayErrors.length > 0 ? 'error' : 'ready',
      statusText: session.replayErrors.length > 0 ? '分支记录异常' : '运行中',
      storyTitle: session.story.plan.title,
      source: session.story.source === 'card' ? '角色卡' : '故事包',
      projection: session.projection,
      pendingRecords: this.pendingRecords(),
      records: session.records,
      candidates: session.candidates,
      storyDetails: {
        storyId: session.story.plan.storyId,
        packageDigest: session.story.card.package_digest ?? null,
        packageStatus: session.story.packageStatus,
        packageVersion: session.story.packageVersion,
        entryPoint: {
          chapterId: session.story.card.entry_point.chapter_id,
          sceneId: session.story.card.entry_point.scene_id,
          eventId: session.story.card.entry_point.event_id ?? null
        },
        eventCount: session.story.plan.events.length
      },
      bindingIssue: null,
      canonEventDetails: session.story.plan.events
        .filter(event => (
          session.candidates.some(candidate => candidate.event.id === event.id)
          || Object.hasOwn(session.projection.canonEvents, event.id)
        ))
        .map(event => ({
          id: event.id,
          summary: event.summary,
          canonicalOrder: event.canonicalOrder,
          kind: event.kind,
          rigidity: event.rigidity,
          adaptation: structuredClone(event.adaptation)
        })),
      connectionProfiles: this.connectionProfileOptions(),
      sourceCompilation: sourceCompilation ? {
        sourceUnitId: sourceCompilation.sourceUnitId,
        level: sourceCompilation.level,
        status: sourceCompilation.deepCompilationStatus,
        eventCount: sourceCompilation.eventIds.length,
        attemptCount: sourceCompilation.attemptCount ?? 0,
        maxAttempts: sourceCompilation.maxAttempts,
        error: sourceCompilation.error ?? null
      } : null,
      sourceProgress: session.sourceContext?.progress ? {
        ...session.sourceContext.progress,
        warnings: [...session.sourceContext.warnings]
      } : null,
      error: session.replayErrors.join('\n') || null
    });
    renderTurnBadges(this.context.chat, () => this.panel.open());
  }

  private async onBeforeGeneration(...args: unknown[]): Promise<void> {
    if (shouldSkipGenerationEvent(args) || !this.settings.enabled) return;
    this.clearGenerationFallback();
    this.generation.reset();
    const draftedCharacterIndex = forcedCharacterIndexFromGenerationEvent(args);
    this.refreshContext();
    if (
      this.context.groupId != null
      && this.context.characterId === undefined
      && draftedCharacterIndex === undefined
    ) {
      this.clearPrompt();
      return;
    }
    await this.processing;
    this.refreshContext();
    await this.refresh();
    if (!this.session) return;
    try {
      const knownEventIds = new Set(this.session.story.plan.events.map(event => event.id));
      const compiled = await ensureLazySourceCompilation(
        this.context,
        this.session.story,
        this.session.projection,
        this.session.sourceContext,
        this.settings
      );
      if (compiled.some(event => !knownEventIds.has(event.id))) {
        await this.refresh();
        if (!this.session) return;
      }
    } catch (error) {
      console.warn('[Psyche Timeline Engine] Lazy source compilation failed; continuing with verified state and retrieved source.', error);
    }
    const responderCharacterId = resolveGenerationCharacterId(
      this.context,
      this.session.story,
      this.session.projection,
      draftedCharacterIndex
    );
    this.context.setExtensionPrompt(
      PROMPT_KEY,
      createSessionInjection(this.session, this.settings, responderCharacterId),
      1,
      1,
      false,
      0
    );
    const parent = [...this.session.records].reverse().find(record => record.application.status === 'applied');
    this.generation.begin({
      session: this.session,
      baseProjectionHash: await hashJson(this.session.projection),
      parentRecordId: parent?.recordId ?? null
    });
  }

  private onCharacterMessageRendered(...args: unknown[]): void {
    if (this.story) renderTurnBadges(this.context.chat, () => this.panel.open());
    const messageIndex = Number(args[0]);
    const generationType = String(args[1] ?? 'normal');
    if (!Number.isInteger(messageIndex) || generationType === 'first_message' || generationType === 'extension') return;
    const ready = this.generation.markRendered({ messageIndex, generationType });
    if (ready) {
      this.queueCompletedGeneration(ready);
      return;
    }
    this.clearGenerationFallback();
    this.generationFallbackTimer = window.setTimeout(() => {
      this.generationFallbackTimer = null;
      const fallback = this.generation.takeRenderedFallback();
      if (fallback) this.queueCompletedGeneration(fallback);
    }, 250);
  }

  private onGenerationEnded(): void {
    const ready = this.generation.markEnded();
    if (ready) this.queueCompletedGeneration(ready);
  }

  private queueCompletedGeneration(ready: { completed: CompletedGeneration; snapshot: GenerationSnapshot }): void {
    this.clearGenerationFallback();
    this.processing = this.processing
      .then(() => this.processCompletedGeneration(ready.completed, ready.snapshot))
      .catch(error => this.reportError(error));
  }

  private clearGenerationFallback(): void {
    if (this.generationFallbackTimer === null) return;
    window.clearTimeout(this.generationFallbackTimer);
    this.generationFallbackTimer = null;
  }

  private assistantText(message: SillyTavernMessage, swipeId: number): string {
    return String(message.swipes?.[swipeId] ?? message.mes ?? '');
  }

  private isGenerationErrorMessage(message: SillyTavernMessage, text: string): boolean {
    const extra = message.extra ?? {};
    if (extra.error || extra.api_error || extra.isSmallSys) return true;
    if (text.length > 600) return false;
    return [
      /^网络状态[：:].*(网络连接异常|连接异常)/s,
      /^(API Error|API 请求失败|Failed to fetch|Network Error)/i,
      /请检查网络设置/
    ].some(pattern => pattern.test(text));
  }

  private async processCompletedGeneration(completed: CompletedGeneration, snapshot: GenerationSnapshot): Promise<void> {
    const message = this.context.chat[completed.messageIndex];
    if (!message || message.is_user || message.is_system) return;
    ensureMessageTimeline(message);
    const swipeId = activeSwipeId(message);
    const assistantText = this.assistantText(message, swipeId);
    if (this.isGenerationErrorMessage(message, assistantText)) {
      await this.refresh();
      return;
    }
    const userEntry = findPrecedingUserMessage(this.context.chat, completed.messageIndex);
    if (!userEntry) return;
    const userTimeline = ensureMessageTimeline(userEntry.message);
    const userText = String(userEntry.message.mes ?? '');
    const inputHash = await sha256Text(userText);
    const outputHash = await sha256Text(assistantText);
    if (shouldSkipExistingExtraction(getSwipeRecord(message, swipeId)?.outputHash, outputHash, completed.generationType)) return;
    if (!this.settings.extractionEnabled) {
      await this.refresh();
      return;
    }

    this.panel.update({ status: 'busy', statusText: '正在提取状态', error: null });
    const extracted = await extractAndAuditTurn(this.context, {
      userText,
      assistantText,
      userRoleId: snapshot.session.story.card.bindings.user_role_id,
      responderCharacterId: resolveMessageCharacterId(
        this.context,
        snapshot.session.story,
        snapshot.session.projection,
        message
      ),
      projection: snapshot.session.projection,
      candidates: snapshot.session.candidates,
      auditMode: this.settings.auditMode,
      responseTokens: this.settings.extractionResponseTokens,
      extractorProfileId: this.settings.extractorProfileId,
      auditorProfileId: this.settings.auditorProfileId,
      profileFallback: this.settings.profileFallback,
      extractionPromptOverride: this.settings.promptOverrides.extraction,
      auditPromptOverride: this.settings.promptOverrides.audit
    });

    const assistantMessageId = ensureMessageTimeline(message).message_id;
    const record: TurnRecord = {
      schemaVersion: 1,
      kind: 'extracted',
      recordId: crypto.randomUUID(),
      parentRecordId: snapshot.parentRecordId,
      userMessageId: userTimeline.message_id,
      assistantMessageId,
      swipeId,
      inputHash,
      outputHash,
      baseProjectionHash: snapshot.baseProjectionHash,
      operations: extracted.response.operations,
      evidence: extracted.response.evidence,
      audit: {
        mode: this.settings.auditMode,
        status: extracted.auditStatus,
        violations: extracted.response.violations,
        model: extracted.model
      },
      application: {
        status: 'pending_user',
        appliedAt: null
      },
      checkpoint: null,
      projectionHash: null,
      createdAt: Date.now()
    };
    const persistedRecord = setSwipeRecord(message, record);

    const noChange = persistedRecord.operations.length === 0 && persistedRecord.audit.status === 'passed';
    const canAutoApply = noChange || (
      this.settings.autoApply
      && extracted.response.confidence >= this.settings.autoApplyThreshold
      && persistedRecord.operations.every(operation => operation.confidence >= this.settings.autoApplyThreshold)
      && persistedRecord.audit.status === 'passed'
    );
    if (canAutoApply) await this.applyRecord(message, persistedRecord);
    await this.context.saveChat();
    await this.refresh();
  }

  private findRecord(recordId: string): { message: SillyTavernMessage | null; record: TurnRecord } | null {
    for (const message of this.context.chat) {
      const data = message[MESSAGE_FIELD];
      if (!data) continue;
      const record = Object.values(data.records_by_swipe).find(candidate => candidate.recordId === recordId);
      if (record) return { message, record };
    }
    const manual = findManualTurnRecord(this.context, recordId);
    if (manual) return { message: null, record: manual };
    return null;
  }

  private async applyRecord(message: SillyTavernMessage, record: TurnRecord): Promise<boolean> {
    await this.refresh();
    if (!this.session) return false;
    const parent = [...this.session.records].reverse().find(candidate => candidate.application.status === 'applied');
    record.parentRecordId = parent?.recordId ?? null;
    record.baseProjectionHash = await hashJson(this.session.projection);
    const reduced = applyOperations(this.session.projection, record.operations, this.session.story.plan.events);
    if (reduced.rejected.length > 0) {
      record.audit.status = 'failed';
      record.audit.violations.push(...reduced.rejected.map(({ operation, error }) => ({
        code: 'application_rejected_operation',
        severity: 'error' as const,
        message: `${operation.id}: ${error}`,
        evidenceIds: operation.evidenceIds
      })));
      mirrorActiveSwipe(message);
      return false;
    }

    if (shouldAdvanceStoryTurn(record)) reduced.projection.turn += 1;
    advanceCanonCursorFromOperations(reduced.projection, record.operations, this.session.story.plan.events);
    record.application = { status: 'applied', appliedAt: Date.now() };
    record.projectionHash = await hashJson(reduced.projection);
    record.checkpoint = shouldCreateCheckpoint(reduced.projection.turn)
      ? structuredClone(reduced.projection)
      : null;
    mirrorActiveSwipe(message);
    return true;
  }

  private async applyPendingRecord(recordId: string): Promise<void> {
    const found = this.findRecord(recordId);
    if (!found?.message || found.record.application.status !== 'pending_user') return;
    const applied = await this.applyRecord(found.message, found.record);
    await this.context.saveChat();
    await this.refresh();
    if (applied) window.toastr?.success('状态变更已应用。', '剧情时间线');
    else window.toastr?.error('状态变更未通过本地规则校验。', '剧情时间线');
  }

  private async rejectPendingRecord(recordId: string): Promise<void> {
    const found = this.findRecord(recordId);
    if (!found?.message || found.record.application.status !== 'pending_user') return;
    found.record.application = { status: 'rejected', appliedAt: null };
    mirrorActiveSwipe(found.message);
    await this.context.saveChat();
    await this.refresh();
  }

  private async updatePendingRecordOperations(recordId: string, value: unknown): Promise<string[]> {
    await this.refresh();
    const found = this.findRecord(recordId);
    if (!found?.message || found.record.application.status !== 'pending_user' || !this.session) {
      return ['待确认记录已经不存在或状态已经变化。'];
    }

    const validation = validateDomainOperations(value);
    if (!validation.valid || !validation.value) return validation.errors;

    const operationIds = new Set<string>();
    const evidenceIds = new Set(found.record.evidence.map(item => item.id));
    const referenceErrors: string[] = [];
    for (const operation of validation.value) {
      if (operationIds.has(operation.id)) referenceErrors.push(`操作 ID 重复：${operation.id}`);
      operationIds.add(operation.id);
      if (operation.evidenceIds.length === 0) referenceErrors.push(`${operation.id} 缺少证据。`);
      for (const evidenceId of operation.evidenceIds) {
        if (!evidenceIds.has(evidenceId)) referenceErrors.push(`${operation.id} 引用了不存在的证据：${evidenceId}`);
      }
    }
    if (referenceErrors.length > 0) return referenceErrors;

    const reduced = applyOperations(this.session.projection, validation.value, this.session.story.plan.events);
    if (reduced.rejected.length > 0) {
      return reduced.rejected.map(({ operation, error }) => `${operation.id}: ${error}`);
    }

    found.record.operations = structuredClone(validation.value);
    found.record.audit.status = found.record.audit.mode === 'off' ? 'unreviewed' : 'warning';
    found.record.audit.violations = found.record.audit.violations
      .filter(item => item.code !== 'user_edited_pending_operations');
    found.record.audit.violations.push({
      code: 'user_edited_pending_operations',
      severity: 'info',
      message: '用户在应用前修改了候选状态操作。',
      evidenceIds: [...new Set(validation.value.flatMap(operation => operation.evidenceIds))]
    });
    found.record.projectionHash = null;
    found.record.checkpoint = null;
    mirrorActiveSwipe(found.message);
    await this.context.saveChat();
    await this.refresh();
    window.toastr?.success('待确认变更已更新。', '剧情时间线');
    return [];
  }

  private async appendManualOperations(operations: TimelineOperation[], description: string): Promise<string[]> {
    await this.refresh();
    if (!this.session) return ['当前聊天没有启用时间线。'];
    if (operations.length === 0) {
      window.toastr?.info('当前状态没有变化。', '剧情时间线');
      return [];
    }
    const reduced = applyOperations(this.session.projection, operations, this.session.story.plan.events);
    if (reduced.rejected.length > 0) {
      return reduced.rejected.map(({ operation, error }) => `${operation.id}: ${error}`);
    }
    advanceCanonCursorFromOperations(reduced.projection, operations, this.session.story.plan.events);

    const recordId = crypto.randomUUID();
    const parent = [...this.session.records].reverse().find(record => record.application.status === 'applied');
    const createdAt = Math.max(
      Date.now(),
      (this.session.records.at(-1)?.createdAt ?? 0) + 1
    );
    const record: TurnRecord = {
      schemaVersion: 1,
      kind: 'manual',
      recordId,
      parentRecordId: parent?.recordId ?? null,
      userMessageId: `manual-user-${recordId}`,
      assistantMessageId: `manual-state-${recordId}`,
      swipeId: 0,
      inputHash: await sha256Text(description),
      outputHash: await hashJson(operations),
      baseProjectionHash: await hashJson(this.session.projection),
      operations: structuredClone(operations),
      evidence: [],
      audit: {
        mode: 'off',
        status: 'unreviewed',
        violations: [],
        model: null
      },
      application: {
        status: 'applied',
        appliedAt: createdAt
      },
      checkpoint: null,
      projectionHash: await hashJson(reduced.projection),
      createdAt
    };
    appendManualTurnRecord(this.context, record);
    await this.context.saveChat();
    await this.refresh();
    window.toastr?.success(description, '剧情时间线');
    return [];
  }

  private async applyManualState(draft: ManualStateDraft): Promise<string[]> {
    await this.refresh();
    if (!this.session) return ['当前聊天没有启用时间线。'];
    const result = buildManualStateOperations(this.session.projection, draft);
    if (result.errors.length > 0) return result.errors;
    return this.appendManualOperations(result.operations, '手动状态修正已保存。');
  }

  private async setPathLocked(path: string, locked: boolean): Promise<string[]> {
    await this.refresh();
    if (!this.session) return ['当前聊天没有启用时间线。'];
    const current = this.session.projection.lockedPaths;
    let paths: string[];
    if (locked) {
      if (current.some(existing => path === existing || path.startsWith(`${existing}.`))) return [];
      paths = [...current.filter(existing => !existing.startsWith(`${path}.`)), path];
    } else {
      paths = current.filter(existing => !(
        path === existing || path.startsWith(`${existing}.`) || existing.startsWith(`${path}.`)
      ));
    }
    const operation: ManualOperation = {
      id: 'manual-set-locked-paths',
      type: 'set_locked_paths',
      confidence: 1,
      evidenceIds: [],
      paths
    };
    return this.appendManualOperations([operation], locked ? '字段已锁定。' : '字段已解锁。');
  }

  private async transitionCanonEvent(eventId: string, target: CanonEventStatus): Promise<string[]> {
    await this.refresh();
    if (!this.session) return ['当前聊天没有启用时间线。'];
    const event = this.session.story.plan.events.find(candidate => candidate.id === eventId);
    if (!event) return ['原作事件已经不存在于当前故事包。'];
    const current = this.session.projection.canonEvents[eventId] ?? 'locked';
    const result = buildCanonTransitionOperations(eventId, current, target);
    if (result.errors.length > 0) return result.errors;
    return this.appendManualOperations(result.operations, `原作事件“${event.summary}”已更新。`);
  }

  private async createCurrentCheckpoint(): Promise<void> {
    try {
      await this.refresh();
      if (!this.session) throw new Error('当前聊天没有启用时间线。');
      const head = [...this.session.records].reverse().find(record => record.application.status === 'applied');
      if (!head) throw new Error('当前还没有可建立检查点的已应用回合。');
      const found = this.findRecord(head.recordId);
      if (!found) throw new Error('无法定位当前分支头记录。');
      found.record.checkpoint = structuredClone(this.session.projection);
      found.record.projectionHash = await hashJson(this.session.projection);
      if (found.message) mirrorActiveSwipe(found.message);
      await this.context.saveChat();
      await this.refresh();
      window.toastr?.success(`已在回合 ${this.session?.projection.turn ?? '?'} 创建检查点。`, '剧情时间线');
    } catch (error) {
      this.reportError(error);
    }
  }

  private async retryCurrentSourceCompilation(sourceUnitId: string): Promise<void> {
    try {
      await this.refresh();
      const digest = this.session?.story.card.package_digest;
      if (!digest) throw new Error('当前故事没有可重试的原文库。');
      await retrySourceCompilation(digest, sourceUnitId);
      await this.refresh();
      window.toastr?.success('原文窗口已恢复为待编译，将在下一次生成前重试。', '剧情时间线');
    } catch (error) {
      this.reportError(error);
    }
  }

  private async resetCurrentSourceCompilationAttempts(sourceUnitId: string): Promise<void> {
    try {
      await this.refresh();
      const digest = this.session?.story.card.package_digest;
      if (!digest) throw new Error('当前故事没有可重置的原文库。');
      await resetSourceCompilationAttempts(digest, sourceUnitId);
      await this.refresh();
      window.toastr?.warning('已重置连续失败计数。请确认连接配置或提示词已修正，系统将在下一次生成前重试。', '剧情时间线');
    } catch (error) {
      this.reportError(error);
    }
  }

  private async rollbackToCheckpoint(recordId: string | null): Promise<void> {
    try {
      await this.refresh();
      if (!this.session) throw new Error('当前聊天没有启用时间线。');
      if (recordId) {
        const checkpoint = this.session.records.find(record => record.recordId === recordId);
        if (!checkpoint || checkpoint.application.status !== 'applied' || !checkpoint.checkpoint || !checkpoint.projectionHash) {
          throw new Error('所选检查点已经失效或不属于当前活动 Swipe。');
        }
        if (await hashJson(checkpoint.checkpoint) !== checkpoint.projectionHash) {
          throw new Error('检查点摘要校验失败，已拒绝回溯。');
        }
      }

      const changedIds = markRecordsStaleAfterCheckpoint(this.session.records, recordId);
      for (const changedId of changedIds) {
        const found = this.findRecord(changedId);
        if (found?.message) mirrorActiveSwipe(found.message);
      }
      if (changedIds.length > 0) await this.context.saveChat();
      await this.refresh();
      if (changedIds.length > 0) {
        window.toastr?.success(`已回溯状态，${changedIds.length} 条后续记录被标记为过期。`, '剧情时间线');
      } else {
        window.toastr?.info('当前已经位于所选回溯位置。', '剧情时间线');
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private async retryCurrentReply(): Promise<void> {
    try {
      await this.refresh();
      if (!this.session) throw new Error('当前聊天没有启用时间线。');
      let messageIndex = -1;
      for (let index = this.context.chat.length - 1; index >= 0; index -= 1) {
        const message = this.context.chat[index];
        if (message && !message.is_user && !message.is_system) {
          messageIndex = index;
          break;
        }
      }
      if (messageIndex < 0) throw new Error('当前聊天没有可提取的角色回复。');
      const parent = [...this.session.records].reverse().find(record => record.application.status === 'applied');
      const snapshot: GenerationSnapshot = {
        session: this.session,
        baseProjectionHash: await hashJson(this.session.projection),
        parentRecordId: parent?.recordId ?? null
      };
      await this.processCompletedGeneration({ messageIndex, generationType: 'manual_retry' }, snapshot);
    } catch (error) {
      this.reportError(error);
    }
  }

  private onMessageSwiped(messageId: unknown): void {
    this.refreshContext();
    const index = Number(messageId);
    const message = this.context.chat[index];
    if (message) mirrorActiveSwipe(message);
    this.queueRefresh();
  }

  private onMessageEdited(messageId: unknown): void {
    this.refreshContext();
    const index = Number(messageId);
    const message = this.context.chat[index];
    if (!message || !Number.isInteger(index)) return;
    markRecordsStaleFromMessage(this.context.chat, index, !message.is_user);
    void this.context.saveChat();
    this.queueRefresh();
  }

  private onSwipeDeleted(payload: unknown): void {
    this.refreshContext();
    if (!payload || typeof payload !== 'object') return;
    const value = payload as { messageId?: unknown; swipeId?: unknown };
    const messageId = Number(value.messageId);
    const swipeId = Number(value.swipeId);
    const message = this.context.chat[messageId];
    if (!message || !Number.isInteger(swipeId)) return;
    reindexRecordsAfterSwipeDeletion(message, swipeId);
    this.queueRefresh();
  }

  private async backupPackageErrors(backup: TimelineBackupV1): Promise<string[]> {
    if (backup.binding.source !== 'psychebook') return [];
    const digest = backup.binding.package_digest ?? backup.binding.card.package_digest;
    const book = digest ? await getInstalledPsycheBook(digest) : undefined;
    const issue = inspectPackageBinding(backup.binding, book);
    return issue ? [issue.message] : [];
  }

  private async inspectBackup(file: File): Promise<{
    preview: ReturnType<typeof timelineBackupPreview> | null;
    errors: string[];
  }> {
    try {
      this.refreshContext();
      const backup = await parseTimelineBackupFile(file);
      const errors = [
        ...inspectTimelineBackupTarget(this.context, backup),
        ...await this.backupPackageErrors(backup)
      ];
      return { preview: timelineBackupPreview(backup), errors };
    } catch (error) {
      return { preview: null, errors: [error instanceof Error ? error.message : String(error)] };
    }
  }

  private async restoreBackup(file: File): Promise<string[]> {
    this.refreshContext();
    let snapshot: ReturnType<typeof captureTimelineState> | null = null;
    try {
      const backup = await parseTimelineBackupFile(file);
      const preflightErrors = [
        ...inspectTimelineBackupTarget(this.context, backup),
        ...await this.backupPackageErrors(backup)
      ];
      if (preflightErrors.length > 0) return preflightErrors;
      snapshot = captureTimelineState(this.context);
      applyTimelineBackup(this.context, backup);
      await this.context.saveChat();
      await this.refresh(true);
      if (!this.session) throw new Error('恢复后的故事无法建立活动时间线。');
      const replayHash = await hashJson(this.session.projection);
      if (replayHash !== backup.projection_hash) {
        throw new Error('恢复后的重放结果与备份 Projection 摘要不一致。');
      }
      window.toastr?.success('时间线备份已恢复并通过重放校验。', '剧情时间线');
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!snapshot) return [message];
      try {
        restoreTimelineState(this.context, snapshot);
        await this.context.saveChat();
        await this.refresh(true);
        return [`${message} 原状态已自动恢复。`];
      } catch (rollbackError) {
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        return [`${message} 自动回滚失败：${rollbackMessage}`];
      }
    }
  }

  private async exportTimelineBackup(): Promise<void> {
    try {
      await this.refresh(true);
      if (!this.session) throw new Error('当前聊天没有可导出的活动时间线。');
      const backup = await createTimelineBackup(this.context, this.session.projection);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const safeStoryId = this.session.story.plan.storyId.replace(/[^a-zA-Z0-9._-]/g, '_');
      link.href = url;
      link.download = `${safeStoryId}-timeline-backup.psychetimeline`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      window.toastr?.success('完整时间线备份已导出。', '剧情时间线');
    } catch (error) {
      this.reportError(error);
    }
  }

  private async importStory(file: File): Promise<void> {
    try {
      this.refreshContext();
      this.panel.update({ status: 'busy', statusText: '正在导入故事包', error: null });
      const book = await parseStoryFile(file);
      await installPsycheBook(book);
      const story: ActiveStory = {
        source: 'psychebook',
        card: book.card,
        plan: book.plan,
        packageStatus: 'verified',
        packageVersion: book.manifest.version
      };
      bindStoryToChat(this.context, story);
      await this.context.saveChat();
      await this.refresh();
      window.toastr?.success(`已导入：${book.manifest.title}`, '剧情时间线');
    } catch (error) {
      this.reportError(error);
    }
  }

  private async createCurrentCharacterStory(): Promise<void> {
    try {
      this.refreshContext();
      const characterId = Number(this.context.characterId);
      if (!Number.isInteger(characterId) || characterId < 0) throw new Error('请先打开一个真实角色的聊天。');
      const character = this.context.characters[characterId];
      const characterName = String(character?.name ?? '').trim();
      if (!character || !characterName) throw new Error('当前聊天没有可绑定的角色。');
      const userName = String(this.context.name1 ?? '').trim() || undefined;
      const story = createManualStory(
        `story_${crypto.randomUUID()}`,
        `${characterName}的故事`,
        characterName,
        userName
      );
      bindStoryToChat(this.context, story);
      await this.context.saveChat();
      await this.refresh();
      window.toastr?.success('已为当前角色创建时间线。', '剧情时间线');
    } catch (error) {
      this.reportError(error);
    }
  }

  private async unbindCurrentChat(): Promise<void> {
    this.refreshContext();
    delete this.context.chatMetadata[EXTENSION_KEY];
    await this.context.saveChat();
    await this.refresh();
    window.toastr?.success('已解除当前聊天的时间线绑定。', '剧情时间线');
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Psyche Timeline Engine]', error);
    this.panel.update({ status: 'error', statusText: '运行异常', error: message });
    window.toastr?.error(message, '剧情时间线');
  }
}
