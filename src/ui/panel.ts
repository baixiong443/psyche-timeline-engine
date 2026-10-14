import { allowedCanonEventTransitions, isProjectionPathLocked } from '../engine/reducer';
import type {
  CanonEventStatus,
  DomainOperation,
  EventKind,
  EventRigidity,
  FactTruthStatus,
  KnowledgeState,
  ManualStateDraft,
  SchedulerCandidate,
  StoryProjection,
  TurnRecord
} from '../model/types';
import type { PsycheTimelineSettings } from '../runtime/settings';
import {
  PTE_PROMPT_TEMPLATES,
  type PromptCustomizationMode,
  type PtePromptTarget
} from '../model/promptCustomization';

export interface PanelState {
  settings: PsycheTimelineSettings;
  status: 'disabled' | 'unbound' | 'ready' | 'busy' | 'error';
  statusText: string;
  storyTitle: string | null;
  source: string | null;
  projection: StoryProjection | null;
  pendingRecords: TurnRecord[];
  records: TurnRecord[];
  candidates: SchedulerCandidate[];
  storyDetails: {
    storyId: string;
    packageDigest: string | null;
    packageStatus?: 'inline' | 'verified';
    packageVersion?: string | null;
    entryPoint: { chapterId: string; sceneId: string; eventId: string | null };
    eventCount: number;
  } | null;
  bindingIssue?: {
    code: string;
    message: string;
    storyId: string | null;
    packageDigest: string | null;
  } | null;
  canonEventDetails?: Array<{
    id: string;
    summary: string;
    canonicalOrder: number;
    kind: EventKind;
    rigidity: EventRigidity;
    adaptation: {
      allowDelay: boolean;
      allowRelocation: boolean;
      allowSubstitution: boolean;
    };
  }>;
  connectionProfiles: Array<{ id: string; label: string }>;
  sourceCompilation?: {
    sourceUnitId: string;
    level: number;
    status: string;
    eventCount: number;
    attemptCount?: number;
    maxAttempts?: number;
    error: string | null;
  } | null;
  sourceProgress?: {
    preparationMode: 'quick' | 'balanced' | 'complete';
    cursorOrder: number;
    retrievalChunkCount: number;
    analysisUnitCount: number;
    claimCount: number;
    l2Count: number;
    l3Count: number;
    l4Count: number;
    failedCount: number;
    vector: {
      source: string;
      indexed: number;
      total: number;
      complete: boolean;
    } | null;
    warnings: string[];
  } | null;
  error: string | null;
}

export interface PanelCallbacks {
  onSettingsChanged: (settings: PsycheTimelineSettings) => void;
  onApplyRecord: (recordId: string) => void;
  onRejectRecord: (recordId: string) => void;
  onUpdateRecordOperations: (recordId: string, operations: unknown) => Promise<string[]>;
  onRebuild: () => void;
  onRetryExtraction: () => void;
  onRetrySourceCompilation: (sourceUnitId: string) => void;
  onResetSourceCompilationAttempts: (sourceUnitId: string) => void;
  onCreateCheckpoint: () => void;
  onRollbackToCheckpoint: (recordId: string | null) => void;
  onApplyManualState: (draft: ManualStateDraft) => Promise<string[]>;
  onApplyManualOperations: (operations: DomainOperation[], description: string) => Promise<string[]>;
  onSetPathLocked: (path: string, locked: boolean) => Promise<string[]>;
  onTransitionCanonEvent: (eventId: string, status: CanonEventStatus) => Promise<string[]>;
  onCreate: () => void;
  onUnbind: () => void;
  onImport: (file: File) => void;
  onInspectBackup: (file: File) => Promise<{
    preview: {
      storyId: string;
      packageDigest: string | null;
      exportedAt: string;
      messageCount: number;
      recordCount: number;
    } | null;
    errors: string[];
  }>;
  onRestoreBackup: (file: File) => Promise<string[]>;
  onExport: () => void;
}

const OPERATION_LABELS: Record<string, string> = {
  advance_time: '推进时间',
  set_time: '设置时间',
  move_location: '移动地点',
  set_character_presence: '角色在场状态',
  set_character_state: '角色状态',
  add_fact: '新增事实',
  set_knowledge: '角色知识',
  set_relationship_stage: '关系阶段',
  set_relationship_attitude: '关系态度',
  change_relationship_axis: '关系数值轴',
  change_inventory: '物品变化',
  set_divergence: '分支偏离',
  set_flag: '剧情标记',
  open_thread: '新增线索',
  resolve_thread: '解决线索',
  transition_canon_event: '原作事件状态',
  set_narrative_purpose: '叙事目的状态',
  set_locked_paths: '字段锁定'
};

const AUDIT_LABELS: Record<TurnRecord['audit']['status'], string> = {
  unreviewed: '未审计',
  pending: '审计中',
  passed: '已通过',
  warning: '需留意',
  failed: '未通过',
  stale: '已过期'
};

type PanelTab = 'state' | 'events' | 'pending' | 'knowledge' | 'assets' | 'checkpoints' | 'audit' | 'story';

const PANEL_TABS: Array<[PanelTab, string]> = [
  ['state', '当前状态'],
  ['events', '近期事件'],
  ['pending', '待确认'],
  ['knowledge', '人物知识'],
  ['assets', '关系与物品'],
  ['checkpoints', '检查点与回溯'],
  ['audit', '审计记录'],
  ['story', '故事包']
];

const APPLICATION_LABELS: Record<TurnRecord['application']['status'], string> = {
  pending_user: '待确认',
  applied: '已应用',
  rejected: '已拒绝',
  stale: '已过期'
};

const KNOWLEDGE_LABELS: Record<string, string> = {
  knows: '已知',
  suspects: '怀疑',
  believes_false: '错误认知',
  unaware: '未知',
  hiding: '知情但隐瞒'
};

const CANON_STATUS_LABELS: Record<string, string> = {
  locked: '未解锁',
  eligible: '可发生',
  active: '进行中',
  completed_canonical: '按原作完成',
  completed_adapted: '适配后完成',
  delayed: '已延迟',
  skipped: '已跳过',
  invalidated: '已失效'
};

const CANON_ACTIONS: Partial<Record<CanonEventStatus, {
  icon: string;
  title: string;
  dangerous: boolean;
}>> = {
  eligible: { icon: 'fa-rotate-left', title: '恢复为可发生', dangerous: false },
  active: { icon: 'fa-play', title: '开始事件', dangerous: false },
  completed_canonical: { icon: 'fa-circle-check', title: '标记为按原作完成', dangerous: true },
  completed_adapted: { icon: 'fa-code-branch', title: '标记为适配完成', dangerous: true },
  delayed: { icon: 'fa-pause', title: '延迟事件', dangerous: false },
  skipped: { icon: 'fa-forward', title: '跳过事件', dangerous: true },
  invalidated: { icon: 'fa-ban', title: '标记事件失效', dangerous: true }
};

function profileOptions(
  profiles: PanelState['connectionProfiles'],
  selected: string,
  emptyLabel: string
): Array<[string, string]> {
  const values: Array<[string, string]> = [
    ['', emptyLabel],
    ...profiles.map(profile => [profile.id, profile.label] as [string, string])
  ];
  if (selected && !profiles.some(profile => profile.id === selected)) values.push([selected, `[配置缺失] ${selected}`]);
  return values;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function iconButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = element('button', 'menu_button psyche-icon-button') as HTMLButtonElement;
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  const iconElement = element('i', `fa-solid ${icon}`);
  button.append(iconElement);
  button.addEventListener('click', onClick);
  return button;
}

function commandButton(icon: string, text: string, onClick: () => void): HTMLButtonElement {
  const button = element('button', 'menu_button psyche-command-button') as HTMLButtonElement;
  button.type = 'button';
  button.append(element('i', `fa-solid ${icon}`), document.createTextNode(text));
  button.addEventListener('click', onClick);
  return button;
}

function checkbox(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLLabelElement {
  const wrapper = element('label', 'checkbox_label');
  const input = element('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  wrapper.append(input, element('span', '', label));
  return wrapper;
}

function selectControl(
  label: string,
  value: string,
  options: Array<[string, string]>,
  onChange: (value: string) => void
): HTMLLabelElement {
  const wrapper = element('label', 'psyche-field');
  wrapper.append(element('span', '', label));
  const select = element('select', 'text_pole') as HTMLSelectElement;
  for (const [optionValue, optionLabel] of options) {
    const option = element('option', '', optionLabel) as HTMLOptionElement;
    option.value = optionValue;
    option.selected = optionValue === value;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  wrapper.append(select);
  return wrapper;
}

function labeledControl(label: string, control: HTMLElement): HTMLLabelElement {
  const wrapper = element('label', 'psyche-field');
  wrapper.append(element('span', '', label), control);
  return wrapper;
}

function textInput(value = '', placeholder = ''): HTMLInputElement {
  const input = element('input', 'text_pole') as HTMLInputElement;
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  return input;
}

function numberInput(value = 0): HTMLInputElement {
  const input = textInput(String(value));
  input.type = 'number';
  input.step = '1';
  return input;
}

function selectInput(value: string, options: Array<[string, string]>): HTMLSelectElement {
  const select = element('select', 'text_pole') as HTMLSelectElement;
  for (const [optionValue, label] of options) {
    const option = element('option', '', label) as HTMLOptionElement;
    option.value = optionValue;
    option.selected = optionValue === value;
    select.append(option);
  }
  return select;
}

function addSuggestions(input: HTMLInputElement, id: string, values: string[]): HTMLDataListElement {
  input.setAttribute('list', id);
  const list = element('datalist') as HTMLDataListElement;
  list.id = id;
  for (const value of [...new Set(values)].filter(Boolean)) {
    const option = element('option') as HTMLOptionElement;
    option.value = value;
    list.append(option);
  }
  return list;
}

function splitList(value: string): string[] {
  return value.split(/[\n,，、;；]+/).map(item => item.trim()).filter(Boolean);
}

function projectionSummary(projection: StoryProjection): string {
  const location = [projection.location.area, projection.location.place, projection.location.position]
    .filter(Boolean)
    .join(' / ') || '未记录';
  return [
    `回合：${projection.turn}`,
    `时间：${projection.time.absolute ?? `相对 ${projection.time.relativeMinutes} 分钟`}`,
    `地点：${location}`,
    `在场角色：${Object.entries(projection.characters).filter(([, state]) => state.present).map(([id]) => id).join('、') || '未记录'}`,
    `物品种类：${Object.keys(projection.inventory).length}`,
    `未结线索：${Object.values(projection.openThreads).filter(thread => thread.status === 'open').length}`,
    `分歧度：${projection.divergence.structuralLevel}`
  ].join('\n');
}

function operationLabel(type: string): string {
  return OPERATION_LABELS[type] ?? type;
}

function recordOperationSummary(record: TurnRecord): string {
  const summary = record.operations.length > 0
    ? record.operations.map(operation => operationLabel(operation.type)).join('、')
    : '无状态变化';
  return record.kind === 'manual' ? `手动修正：${summary}` : summary;
}

function formatTimestamp(value: number | null): string {
  if (!value || !Number.isFinite(value)) return '未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function section(title: string): HTMLElement {
  const value = element('section', 'psyche-section');
  value.append(element('h4', '', title));
  return value;
}

function emptyView(text: string): HTMLElement {
  return element('div', 'psyche-empty', text);
}

function dataList(rows: Array<[string, string]>): HTMLElement {
  const list = element('dl', 'psyche-data-list');
  for (const [label, value] of rows) {
    const row = element('div', 'psyche-data-row');
    row.append(element('dt', '', label), element('dd', '', value || '未记录'));
    list.append(row);
  }
  return list;
}

export class PsycheTimelinePanel {
  private root: HTMLElement | null = null;
  private state: PanelState;
  private expanded = false;
  private activeTab: PanelTab = 'state';
  private stateEditorOpen = false;
  private stateActionError = '';
  private knowledgeEditorOpen = false;
  private assetsEditorOpen = false;
  private structuredActionError: { tab: 'knowledge' | 'assets'; message: string } | null = null;
  private pendingCanonAction: { eventId: string; target: CanonEventStatus } | null = null;
  private canonActionError: { eventId: string; message: string } | null = null;
  private pendingRollbackTarget: string | null | undefined;
  private pendingBackupFile: File | null = null;
  private pendingBackupPreview: Awaited<ReturnType<PanelCallbacks['onInspectBackup']>>['preview'] = null;
  private backupInspecting = false;
  private backupRestoring = false;
  private backupActionError = '';
  private promptEditorOpen = false;

  constructor(private readonly callbacks: PanelCallbacks, initialState: PanelState) {
    this.state = initialState;
  }

  mount(): void {
    this.mountQuickOpenButton();
    if (document.getElementById('psyche-timeline-settings')) {
      this.root = document.getElementById('psyche-timeline-settings');
      this.render();
      return;
    }
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) return;
    this.root = element('div', 'extension_container');
    this.root.id = 'psyche-timeline-settings';
    host.append(this.root);
    this.render();
  }

  open(): void {
    const settingsDrawer = document.getElementById('rm_extensions_block');
    if (settingsDrawer?.classList.contains('closedDrawer')) {
      document.querySelector<HTMLElement>('#extensions-settings-button > .drawer-toggle > .drawer-icon')?.click();
    }
    this.expanded = true;
    this.render();
    window.setTimeout(() => this.root?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }), 0);
  }

  update(next: Partial<PanelState>): void {
    this.state = { ...this.state, ...next };
    this.render();
  }

  private updateSettings(patch: Partial<PsycheTimelineSettings>): void {
    const settings = { ...this.state.settings, ...patch };
    this.state.settings = settings;
    this.callbacks.onSettingsChanged(settings);
    this.render();
  }

  private updatePromptOverride(
    target: PtePromptTarget,
    patch: Partial<{ mode: PromptCustomizationMode; text: string }>
  ): void {
    this.updateSettings({
      promptOverrides: {
        ...this.state.settings.promptOverrides,
        [target]: { ...this.state.settings.promptOverrides[target], ...patch }
      }
    });
  }

  private renderPromptControls(): HTMLElement {
    const details = element('details', 'psyche-prompt-settings') as HTMLDetailsElement;
    details.open = this.promptEditorOpen;
    details.addEventListener('toggle', () => {
      this.promptEditorOpen = details.open;
    });
    const summary = element('summary', '', '提示词编辑');
    details.append(summary);

    const intro = element(
      'p',
      'psyche-help-text',
      '追加模式保留 PTE 的默认连续性和证据规则；替换模式只替换控制指令，动态状态、聊天原文和 JSON Schema 仍由插件生成。'
    );
    details.append(intro);

    const targets: Array<{ id: PtePromptTarget; title: string; description: string }> = [
      { id: 'injection', title: '生成前叙事控制', description: '随当前状态和原作候选事件一起注入主叙事模型。' },
      { id: 'extraction', title: '回复后状态提取', description: '指导提取 AI 判断本轮真正发生了哪些变化。' },
      { id: 'audit', title: '严格审计', description: '指导第二层 AI 审核提取操作与原文证据。' }
    ];

    for (const target of targets) {
      const configured = this.state.settings.promptOverrides[target.id];
      const block = element('section', 'psyche-prompt-block');
      const header = element('div', 'psyche-prompt-header');
      const titleBlock = element('div');
      titleBlock.append(
        element('strong', '', target.title),
        element('span', 'psyche-help-text', target.description)
      );
      const mode = selectInput(configured.mode, [
        ['builtin', '使用内置'],
        ['append', '追加指令'],
        ['replace', '替换基础规则']
      ]);
      mode.setAttribute('aria-label', `${target.title}提示词模式`);
      header.append(titleBlock, mode);

      const textarea = element('textarea', 'text_pole psyche-prompt-textarea') as HTMLTextAreaElement;
      textarea.value = configured.text;
      textarea.placeholder = `输入${target.title}的自定义控制指令`;
      textarea.spellcheck = false;
      textarea.disabled = configured.mode === 'builtin';
      textarea.addEventListener('input', () => this.updatePromptOverride(target.id, { text: textarea.value }));

      const footer = element('div', 'psyche-prompt-footer');
      const hint = element(
        'span',
        configured.mode === 'replace' ? 'psyche-prompt-risk' : 'psyche-help-text',
        configured.mode === 'replace'
          ? '替换模式会移除这一层的内置控制规则。'
          : configured.mode === 'append'
            ? '自定义内容会追加到内置规则之后。'
            : '当前只使用内置规则。'
      );
      const actions = element('div', 'psyche-prompt-actions');
      const template = commandButton('fa-file-lines', '加载参考模板', () => {
        mode.value = 'append';
        textarea.disabled = false;
        textarea.value = PTE_PROMPT_TEMPLATES[target.id];
        hint.className = 'psyche-help-text';
        hint.textContent = '自定义内容会追加到内置规则之后。';
        this.updatePromptOverride(target.id, { mode: 'append', text: textarea.value });
      });
      const reset = commandButton('fa-rotate-left', '恢复内置', () => {
        mode.value = 'builtin';
        textarea.value = '';
        textarea.disabled = true;
        hint.className = 'psyche-help-text';
        hint.textContent = '当前只使用内置规则。';
        this.updatePromptOverride(target.id, { mode: 'builtin', text: '' });
      });
      actions.append(template, reset);
      footer.append(hint, actions);

      mode.addEventListener('change', () => {
        const selected = mode.value as PromptCustomizationMode;
        textarea.disabled = selected === 'builtin';
        hint.className = selected === 'replace' ? 'psyche-prompt-risk' : 'psyche-help-text';
        hint.textContent = selected === 'replace'
          ? '替换模式会移除这一层的内置控制规则。'
          : selected === 'append'
            ? '自定义内容会追加到内置规则之后。'
            : '当前只使用内置规则。';
        this.updatePromptOverride(target.id, { mode: selected });
      });

      block.append(header, textarea, footer);
      details.append(block);
    }

    details.append(element(
      'div',
      'psyche-prompt-warning',
      '自定义提示词风险声明：使用者应自行检查修改结果。由自定义提示词造成的模型拒答、JSON 解析失败、事实遗漏、审计失效、时间线错误、额外 API 费用或其他功能异常，不属于插件默认行为的保证范围，开发者不承担由此产生的责任。遇到问题请先恢复内置提示词复测。'
    ));
    return details;
  }

  private mountQuickOpenButton(): void {
    if (document.getElementById('psyche-timeline-wand-button')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const container = element('div', 'extension_container psyche-wand-container');
    container.id = 'psyche-timeline-wand-container';
    const button = element('button', 'list-group-item flex-container flexGap5 psyche-wand-button') as HTMLButtonElement;
    button.id = 'psyche-timeline-wand-button';
    button.type = 'button';
    button.title = '打开剧情时间线';
    button.append(
      element('i', 'fa-solid fa-timeline extensionsMenuExtensionButton'),
      element('span', '', '剧情时间线')
    );
    button.addEventListener('click', () => {
      menu.style.display = 'none';
      this.open();
    });
    container.append(button);
    menu.append(container);
  }

  private stateLockButton(projection: StoryProjection, path: string, label: string): HTMLButtonElement {
    const locked = isProjectionPathLocked(projection, path);
    return iconButton(locked ? 'fa-lock' : 'fa-lock-open', `${locked ? '解锁' : '锁定'}${label}`, () => {
      void (async () => {
        const errors = await this.callbacks.onSetPathLocked(path, !locked);
        this.stateActionError = errors.join('\n');
        if (errors.length > 0) this.render();
      })();
    });
  }

  private stateEditorField(
    projection: StoryProjection,
    label: string,
    path: string,
    input: HTMLInputElement
  ): HTMLLabelElement {
    const wrapper = element('label', 'psyche-state-field');
    const header = element('span', 'psyche-state-field-header');
    header.append(element('span', '', label), this.stateLockButton(projection, path, label));
    input.classList.add('text_pole');
    input.disabled = isProjectionPathLocked(projection, path);
    wrapper.append(header, input);
    return wrapper;
  }

  private renderStateEditor(projection: StoryProjection): HTMLElement {
    const editor = section('手动修正');
    editor.classList.add('psyche-state-editor');
    const absolute = element('input') as HTMLInputElement;
    absolute.type = 'text';
    absolute.value = projection.time.absolute ?? '';
    absolute.placeholder = '例如 1922-02-10T20:21:00Z';
    const relative = element('input') as HTMLInputElement;
    relative.type = 'number';
    relative.step = '1';
    relative.value = String(projection.time.relativeMinutes);
    const area = element('input') as HTMLInputElement;
    area.type = 'text';
    area.value = projection.location.area;
    const place = element('input') as HTMLInputElement;
    place.type = 'text';
    place.value = projection.location.place;
    const position = element('input') as HTMLInputElement;
    position.type = 'text';
    position.value = projection.location.position;
    const divergenceLevel = element('input') as HTMLInputElement;
    divergenceLevel.type = 'number';
    divergenceLevel.min = '0';
    divergenceLevel.max = '1';
    divergenceLevel.step = '0.05';
    divergenceLevel.value = String(projection.divergence.structuralLevel);
    const divergenceSummary = element('input') as HTMLInputElement;
    divergenceSummary.type = 'text';
    divergenceSummary.value = projection.divergence.summary;
    divergenceSummary.placeholder = '当前分支与原作的结构差异';

    const fields = element('div', 'psyche-state-grid');
    fields.append(
      this.stateEditorField(projection, '绝对时间', 'time.absolute', absolute),
      this.stateEditorField(projection, '相对分钟', 'time.relativeMinutes', relative),
      this.stateEditorField(projection, '区域', 'location.area', area),
      this.stateEditorField(projection, '地点', 'location.place', place),
      this.stateEditorField(projection, '具体位置', 'location.position', position),
      this.stateEditorField(projection, '分歧度', 'divergence.structuralLevel', divergenceLevel),
      this.stateEditorField(projection, '分支摘要', 'divergence.summary', divergenceSummary)
    );
    editor.append(fields);

    const presence = section('人物在场状态');
    for (const [characterId, state] of Object.entries(projection.characters)) {
      const path = `characters.${characterId}.present`;
      const row = element('div', 'psyche-lock-row');
      const label = checkbox(characterId, state.present, () => undefined);
      const input = label.querySelector('input');
      if (input) input.disabled = isProjectionPathLocked(projection, path);
      row.append(label, this.stateLockButton(projection, path, `${characterId}在场状态`));
      presence.append(row);
    }
    editor.append(presence);

    const error = element('div', 'psyche-editor-error', this.stateActionError);
    const save = commandButton('fa-floppy-disk', '保存状态修正', () => {
      void (async () => {
        const characterPresence: Record<string, boolean> = {};
        const rows = presence.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
        Object.keys(projection.characters).forEach((characterId, index) => {
          characterPresence[characterId] = rows[index]?.checked ?? projection.characters[characterId]?.present ?? false;
        });
        const draft: ManualStateDraft = {
          absoluteTime: absolute.value,
          relativeMinutes: Number(relative.value),
          location: { area: area.value, place: place.value, position: position.value },
          characterPresence,
          divergenceLevel: Number(divergenceLevel.value),
          divergenceSummary: divergenceSummary.value
        };
        const errors = await this.callbacks.onApplyManualState(draft);
        this.stateActionError = errors.join('\n');
        if (errors.length > 0) this.render();
      })();
    });
    const footer = element('div', 'psyche-editor-footer');
    footer.append(error, save);
    editor.append(footer);
    return editor;
  }

  private renderStateTab(): HTMLElement {
    const view = element('div', 'psyche-tab-view');
    const projection = this.state.projection;
    if (!projection) return emptyView('当前聊天尚无可用状态。');
    const toolbar = element('div', 'psyche-toolbar');
    toolbar.append(commandButton(
      this.stateEditorOpen ? 'fa-xmark' : 'fa-pen-to-square',
      this.stateEditorOpen ? '关闭编辑' : '编辑当前状态',
      () => {
        this.stateEditorOpen = !this.stateEditorOpen;
        this.stateActionError = '';
        this.render();
      }
    ));
    view.append(toolbar);
    if (this.stateEditorOpen) view.append(this.renderStateEditor(projection));
    view.append(element('pre', 'psyche-projection', projectionSummary(projection)));

    const canonProgress = section('原作进度');
    const currentCanonEvent = (this.state.canonEventDetails ?? []).find(
      event => event.canonicalOrder === projection.canonCursor.eventOrder
    );
    canonProgress.append(dataList([
      ['章节', projection.canonCursor.chapterId || '尚未进入'],
      ['场景', projection.canonCursor.sceneId || '尚未进入'],
      ['原作顺序', String(projection.canonCursor.eventOrder)],
      ['最近原作事件', currentCanonEvent?.summary ?? '尚未开始']
    ]));
    view.append(canonProgress);

    const characters = section('在场人物');
    const characterRows = Object.entries(projection.characters).map(([id, state]) => [
      id,
      [state.present ? '在场' : '离场', state.activity, ...(state.mood ?? [])].filter(Boolean).join(' · ')
    ] as [string, string]);
    characters.append(characterRows.length > 0 ? dataList(characterRows) : emptyView('暂无人物状态。'));
    view.append(characters);

    const threads = section('剧情线索');
    const threadRows = Object.entries(projection.openThreads).map(([id, thread]) => [
      thread.title || id,
      thread.status === 'open' ? '进行中' : thread.status === 'resolved' ? '已解决' : '已放弃'
    ] as [string, string]);
    threads.append(threadRows.length > 0 ? dataList(threadRows) : emptyView('暂无剧情线索。'));
    view.append(threads);

    const locks = section('锁定字段');
    if (projection.lockedPaths.length === 0) locks.append(emptyView('当前没有锁定字段。'));
    for (const path of projection.lockedPaths) {
      const row = element('div', 'psyche-lock-row');
      row.append(element('span', '', path), this.stateLockButton(projection, path, path));
      locks.append(row);
    }
    view.append(locks);
    return view;
  }

  private renderEventsTab(): HTMLElement {
    const view = element('div', 'psyche-tab-view');
    const recent = section('本分支记录');
    const records = [...this.state.records].reverse().slice(0, 16);
    if (records.length === 0) recent.append(emptyView('当前分支尚无回合记录。'));
    for (const record of records) {
      const row = element('div', 'psyche-history-row');
      const header = element('div', 'psyche-history-header');
      header.append(
        element('strong', '', recordOperationSummary(record)),
        element('span', `psyche-audit-badge psyche-audit-${record.audit.status}`, APPLICATION_LABELS[record.application.status])
      );
      row.append(
        header,
        element('div', 'psyche-history-meta', `${formatTimestamp(record.createdAt)} · Swipe ${record.swipeId + 1}`)
      );
      recent.append(row);
    }
    view.append(recent);

    const canon = section('原作事件');
    const projection = this.state.projection;
    const candidatesById = new Map(this.state.candidates.map(candidate => [candidate.event.id, candidate]));
    const detailsById = new Map((this.state.canonEventDetails ?? []).map(event => [event.id, event]));
    const eventIds = new Set([
      ...Object.keys(projection?.canonEvents ?? {}),
      ...this.state.candidates.map(candidate => candidate.event.id)
    ]);
    if (eventIds.size === 0) canon.append(emptyView('当前没有接近触发条件的原作事件。'));
    const orderedEventIds = [...eventIds].sort((left, right) => (
      (detailsById.get(left)?.canonicalOrder ?? Number.MAX_SAFE_INTEGER)
      - (detailsById.get(right)?.canonicalOrder ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right)
    ));
    for (const eventId of orderedEventIds) {
      const candidate = candidatesById.get(eventId);
      const details = detailsById.get(eventId);
      const status = (projection?.canonEvents[eventId] ?? candidate?.state ?? 'locked') as CanonEventStatus;
      const row = element('div', 'psyche-history-row');
      const header = element('div', 'psyche-history-header');
      header.append(element('strong', '', details?.summary ?? candidate?.event.summary ?? eventId));
      const controls = element('div', 'psyche-event-controls');
      controls.append(element('span', 'psyche-canon-badge', CANON_STATUS_LABELS[status] ?? status));
      const adaptation = details?.adaptation ?? candidate?.event.adaptation;
      for (const target of allowedCanonEventTransitions(status)) {
        if (target === 'delayed' && adaptation && !adaptation.allowDelay) continue;
        if (
          target === 'completed_adapted'
          && adaptation
          && !adaptation.allowRelocation
          && !adaptation.allowSubstitution
        ) continue;
        const action = CANON_ACTIONS[target];
        if (!action) continue;
        controls.append(iconButton(action.icon, action.title, () => {
          if (action.dangerous) {
            this.pendingCanonAction = { eventId, target };
            this.canonActionError = null;
            this.render();
            return;
          }
          void this.applyCanonTransition(eventId, target);
        }));
      }
      header.append(controls);
      row.append(header);
      if (candidate?.reasons.length) {
        const reason = element('div', 'psyche-history-meta', candidate.reasons.join('；'));
        reason.title = candidate.reasons.join('\n');
        row.append(reason);
      }
      if (this.pendingCanonAction?.eventId === eventId) {
        const confirmation = element('div', 'psyche-inline-confirm');
        confirmation.append(
          element('span', '', `确认将事件状态改为“${CANON_STATUS_LABELS[this.pendingCanonAction.target]}”？`),
          commandButton('fa-check', '确认事件变更', () => {
            const target = this.pendingCanonAction?.target;
            this.pendingCanonAction = null;
            if (target) void this.applyCanonTransition(eventId, target);
          }),
          iconButton('fa-xmark', '取消事件变更', () => {
            this.pendingCanonAction = null;
            this.render();
          })
        );
        row.append(confirmation);
      }
      if (this.canonActionError?.eventId === eventId) {
        row.append(element('div', 'psyche-editor-error', this.canonActionError.message));
      }
      canon.append(row);
    }
    view.append(canon);
    return view;
  }

  private async applyCanonTransition(eventId: string, target: CanonEventStatus): Promise<void> {
    const errors = await this.callbacks.onTransitionCanonEvent(eventId, target);
    this.canonActionError = errors.length > 0 ? { eventId, message: errors.join('\n') } : null;
    if (errors.length > 0) this.render();
  }

  private showStructuredError(tab: 'knowledge' | 'assets', message: string): void {
    this.structuredActionError = { tab, message };
    this.render();
  }

  private async applyStructuredOperations(
    tab: 'knowledge' | 'assets',
    operations: DomainOperation[],
    description: string
  ): Promise<void> {
    const errors = await this.callbacks.onApplyManualOperations(operations, description);
    this.structuredActionError = errors.length > 0 ? { tab, message: errors.join('\n') } : null;
    if (errors.length > 0) this.render();
  }

  private renderKnowledgeEditor(projection: StoryProjection): HTMLElement {
    const editor = section('手动修正事实与知识');
    editor.classList.add('psyche-manual-editor');
    const factIds = Object.keys(projection.facts);
    const characterIds = [...new Set([
      ...Object.keys(projection.characters),
      ...Object.keys(projection.knowledge)
    ])];

    const factBlock = element('div', 'psyche-manual-block');
    factBlock.append(element('h5', '', '事实'));
    const initialFactId = factIds[0] ?? '';
    const initialFact = projection.facts[initialFactId];
    const factId = textInput(initialFactId, 'fact_id');
    factId.dataset.psycheField = 'fact-id';
    const factSuggestions = addSuggestions(factId, 'psyche-fact-suggestions', factIds);
    const factTruth = textInput(initialFact?.truth ?? '', '事实内容');
    factTruth.dataset.psycheField = 'fact-truth';
    const factStatus = selectInput(initialFact?.status ?? 'unknown', [
      ['true', '成立'],
      ['false', '不成立'],
      ['unknown', '未确定']
    ]);
    factStatus.dataset.psycheField = 'fact-status';
    const loadFact = (): void => {
      const fact = projection.facts[factId.value.trim()];
      if (!fact) return;
      factTruth.value = fact.truth;
      factStatus.value = fact.status;
    };
    factId.addEventListener('change', loadFact);
    const factFields = element('div', 'psyche-manual-grid');
    factFields.append(
      labeledControl('事实 ID', factId),
      labeledControl('事实状态', factStatus),
      labeledControl('事实内容', factTruth)
    );
    const saveFact = commandButton('fa-floppy-disk', '保存事实', () => {
      const id = factId.value.trim();
      const truth = factTruth.value.trim();
      if (!id || !truth) return this.showStructuredError('knowledge', '事实 ID 和事实内容不能为空。');
      const operation: DomainOperation = {
        id: 'manual-fact-1',
        type: 'add_fact',
        confidence: 1,
        evidenceIds: [],
        factId: id,
        fact: {
          truth,
          status: factStatus.value as FactTruthStatus,
          evidenceRefs: []
        }
      };
      void this.applyStructuredOperations('knowledge', [operation], '事实修正已保存。');
    });
    factBlock.append(factFields, saveFact, factSuggestions);

    const knowledgeBlock = element('div', 'psyche-manual-block');
    knowledgeBlock.append(element('h5', '', '人物知识'));
    const knowledgeCharacter = textInput(characterIds[0] ?? '', 'character_id');
    knowledgeCharacter.dataset.psycheField = 'knowledge-character';
    const characterSuggestions = addSuggestions(
      knowledgeCharacter,
      'psyche-character-suggestions',
      characterIds
    );
    const knowledgeFact = textInput(initialFactId, 'fact_id');
    knowledgeFact.dataset.psycheField = 'knowledge-fact';
    const knowledgeFactSuggestions = addSuggestions(
      knowledgeFact,
      'psyche-knowledge-fact-suggestions',
      factIds
    );
    const initialKnowledge = projection.knowledge[knowledgeCharacter.value]?.[knowledgeFact.value];
    const knowledgeState = selectInput(initialKnowledge?.state ?? 'unaware', [
      ['knows', '已知'],
      ['suspects', '怀疑'],
      ['believes_false', '错误认知'],
      ['unaware', '未知'],
      ['hiding', '知情但隐瞒']
    ]);
    knowledgeState.dataset.psycheField = 'knowledge-state';
    const perceivedTruth = textInput(initialKnowledge?.perceivedTruth ?? '', '角色认知中的内容');
    perceivedTruth.dataset.psycheField = 'knowledge-perceived-truth';
    const loadKnowledge = (): void => {
      const entry = projection.knowledge[knowledgeCharacter.value.trim()]?.[knowledgeFact.value.trim()];
      knowledgeState.value = entry?.state ?? 'unaware';
      perceivedTruth.value = entry?.perceivedTruth ?? '';
    };
    knowledgeCharacter.addEventListener('change', loadKnowledge);
    knowledgeFact.addEventListener('change', loadKnowledge);
    const knowledgeFields = element('div', 'psyche-manual-grid');
    knowledgeFields.append(
      labeledControl('人物 ID', knowledgeCharacter),
      labeledControl('事实 ID', knowledgeFact),
      labeledControl('认知状态', knowledgeState),
      labeledControl('认知内容', perceivedTruth)
    );
    const saveKnowledge = commandButton('fa-floppy-disk', '保存人物知识', () => {
      const characterId = knowledgeCharacter.value.trim();
      const factIdValue = knowledgeFact.value.trim();
      if (!characterId || !factIdValue) {
        return this.showStructuredError('knowledge', '人物 ID 和事实 ID 不能为空。');
      }
      const perceived = perceivedTruth.value.trim();
      const operation: DomainOperation = {
        id: 'manual-knowledge-1',
        type: 'set_knowledge',
        confidence: 1,
        evidenceIds: [],
        characterId,
        factId: factIdValue,
        state: knowledgeState.value as KnowledgeState,
        ...(perceived ? { perceivedTruth: perceived } : {})
      };
      void this.applyStructuredOperations('knowledge', [operation], '人物知识修正已保存。');
    });
    knowledgeBlock.append(
      knowledgeFields,
      saveKnowledge,
      characterSuggestions,
      knowledgeFactSuggestions
    );

    const error = this.structuredActionError?.tab === 'knowledge'
      ? this.structuredActionError.message
      : '';
    editor.append(factBlock, knowledgeBlock, element('div', 'psyche-editor-error', error));
    return editor;
  }

  private renderAssetsEditor(projection: StoryProjection): HTMLElement {
    const editor = section('手动修正关系与物品');
    editor.classList.add('psyche-manual-editor');
    const relationshipIds = Object.keys(projection.relationships);
    const characterIds = Object.keys(projection.characters);

    const relationshipBlock = element('div', 'psyche-manual-block');
    relationshipBlock.append(element('h5', '', '关系阶段'));
    const initialPairId = relationshipIds[0] ?? '';
    const pairId = textInput(initialPairId, 'pair_id');
    pairId.dataset.psycheField = 'relationship-pair';
    const pairSuggestions = addSuggestions(pairId, 'psyche-pair-suggestions', relationshipIds);
    const relationshipStage = textInput(projection.relationships[initialPairId]?.stage ?? '', '关系阶段');
    relationshipStage.dataset.psycheField = 'relationship-stage';
    const loadRelationship = (): void => {
      const relationship = projection.relationships[pairId.value.trim()];
      if (relationship) relationshipStage.value = relationship.stage;
    };
    pairId.addEventListener('change', loadRelationship);
    const stageFields = element('div', 'psyche-manual-grid');
    stageFields.append(
      labeledControl('关系 ID', pairId),
      labeledControl('阶段', relationshipStage)
    );
    const saveStage = commandButton('fa-floppy-disk', '保存关系阶段', () => {
      const id = pairId.value.trim();
      const stage = relationshipStage.value.trim();
      if (!id || !stage) return this.showStructuredError('assets', '关系 ID 和阶段不能为空。');
      const operation: DomainOperation = {
        id: 'manual-relationship-stage-1',
        type: 'set_relationship_stage',
        confidence: 1,
        evidenceIds: [],
        pairId: id,
        stage
      };
      void this.applyStructuredOperations('assets', [operation], '关系阶段修正已保存。');
    });
    relationshipBlock.append(stageFields, saveStage, pairSuggestions);

    const axisBlock = element('div', 'psyche-manual-block');
    axisBlock.append(element('h5', '', '关系数值轴'));
    const initialAxis = Object.entries(projection.relationships[initialPairId]?.axes ?? {})[0];
    const axisName = textInput(initialAxis?.[0] ?? '', '例如 trust 或 affinity');
    axisName.dataset.psycheField = 'relationship-axis';
    const axisSuggestions = addSuggestions(
      axisName,
      'psyche-axis-suggestions',
      Object.keys(projection.relationships[initialPairId]?.axes ?? {})
    );
    const axisValue = numberInput(initialAxis?.[1] ?? 0);
    axisValue.step = 'any';
    axisValue.dataset.psycheField = 'relationship-axis-value';
    const loadAxis = (): void => {
      const relationship = projection.relationships[pairId.value.trim()];
      const current = relationship?.axes[axisName.value.trim()];
      axisValue.value = String(current ?? 0);
    };
    pairId.addEventListener('change', loadAxis);
    axisName.addEventListener('change', loadAxis);
    const axisFields = element('div', 'psyche-manual-grid');
    axisFields.append(
      labeledControl('数值轴 ID', axisName),
      labeledControl('目标值', axisValue)
    );
    const saveAxis = commandButton('fa-floppy-disk', '保存关系数值', () => {
      const relationshipId = pairId.value.trim();
      const axis = axisName.value.trim();
      const target = Number(axisValue.value);
      if (!relationshipId || !axis) return this.showStructuredError('assets', '关系 ID 和数值轴 ID 不能为空。');
      if (!Number.isFinite(target)) return this.showStructuredError('assets', '关系数值必须是有限数字。');
      const current = projection.relationships[relationshipId]?.axes[axis] ?? 0;
      const delta = target - current;
      if (delta === 0) return this.showStructuredError('assets', '关系数值没有变化。');
      const operation: DomainOperation = {
        id: 'manual-relationship-axis-1',
        type: 'change_relationship_axis',
        confidence: 1,
        evidenceIds: [],
        pairId: relationshipId,
        axis,
        delta
      };
      void this.applyStructuredOperations('assets', [operation], '关系数值修正已保存。');
    });
    axisBlock.append(axisFields, saveAxis, axisSuggestions);

    const attitudeBlock = element('div', 'psyche-manual-block');
    attitudeBlock.append(element('h5', '', '关系方向'));
    const initialDirection = Object.entries(projection.relationships[initialPairId]?.directions ?? {})[0];
    const fromCharacter = textInput(initialDirection?.[0] ?? characterIds[0] ?? '', 'from_character_id');
    fromCharacter.dataset.psycheField = 'relationship-from';
    const fromSuggestions = addSuggestions(fromCharacter, 'psyche-from-suggestions', characterIds);
    const towardCharacter = textInput(initialDirection?.[1].toward ?? characterIds[1] ?? characterIds[0] ?? '', 'toward_character_id');
    towardCharacter.dataset.psycheField = 'relationship-toward';
    const towardSuggestions = addSuggestions(towardCharacter, 'psyche-toward-suggestions', characterIds);
    const stance = textInput(initialDirection?.[1].stance.join('、') ?? '', '态度，使用逗号分隔');
    stance.dataset.psycheField = 'relationship-stance';
    const wants = textInput(initialDirection?.[1].wants.join('、') ?? '', '诉求，使用逗号分隔');
    wants.dataset.psycheField = 'relationship-wants';
    const secrets = textInput(initialDirection?.[1].secrets.join('、') ?? '', '隐瞒，使用逗号分隔');
    secrets.dataset.psycheField = 'relationship-secrets';
    const loadDirection = (): void => {
      const direction = projection.relationships[pairId.value.trim()]?.directions[fromCharacter.value.trim()];
      if (!direction) return;
      towardCharacter.value = direction.toward;
      stance.value = direction.stance.join('、');
      wants.value = direction.wants.join('、');
      secrets.value = direction.secrets.join('、');
    };
    pairId.addEventListener('change', loadDirection);
    fromCharacter.addEventListener('change', loadDirection);
    const attitudeFields = element('div', 'psyche-manual-grid');
    attitudeFields.append(
      labeledControl('来源人物', fromCharacter),
      labeledControl('指向人物', towardCharacter),
      labeledControl('态度', stance),
      labeledControl('诉求', wants),
      labeledControl('隐瞒', secrets)
    );
    const saveAttitude = commandButton('fa-floppy-disk', '保存关系方向', () => {
      const relationshipId = pairId.value.trim();
      const fromCharacterId = fromCharacter.value.trim();
      const towardCharacterId = towardCharacter.value.trim();
      if (!relationshipId || !fromCharacterId || !towardCharacterId) {
        return this.showStructuredError('assets', '关系 ID、来源人物和指向人物不能为空。');
      }
      const operation: DomainOperation = {
        id: 'manual-relationship-attitude-1',
        type: 'set_relationship_attitude',
        confidence: 1,
        evidenceIds: [],
        pairId: relationshipId,
        fromCharacterId,
        towardCharacterId,
        stance: splitList(stance.value),
        wants: splitList(wants.value),
        secrets: splitList(secrets.value)
      };
      void this.applyStructuredOperations('assets', [operation], '关系方向修正已保存。');
    });
    attitudeBlock.append(
      attitudeFields,
      saveAttitude,
      fromSuggestions,
      towardSuggestions
    );

    const inventoryBlock = element('div', 'psyche-manual-block');
    inventoryBlock.append(element('h5', '', '物品'));
    const inventoryIds = Object.keys(projection.inventory);
    const initialItemId = inventoryIds[0] ?? '';
    const itemId = textInput(initialItemId, 'item_id');
    itemId.dataset.psycheField = 'inventory-item';
    const itemSuggestions = addSuggestions(itemId, 'psyche-item-suggestions', inventoryIds);
    const inventoryDelta = numberInput(0);
    inventoryDelta.dataset.psycheField = 'inventory-delta';
    const inventoryDescription = textInput(projection.inventory[initialItemId]?.description ?? '', '物品名称或说明');
    inventoryDescription.dataset.psycheField = 'inventory-description';
    const inventoryOwner = textInput(projection.inventory[initialItemId]?.ownerId ?? '', 'owner_id');
    inventoryOwner.dataset.psycheField = 'inventory-owner';
    const ownerSuggestions = addSuggestions(inventoryOwner, 'psyche-owner-suggestions', characterIds);
    const loadInventory = (): void => {
      const item = projection.inventory[itemId.value.trim()];
      if (!item) return;
      inventoryDelta.value = '0';
      inventoryDescription.value = item.description ?? '';
      inventoryOwner.value = item.ownerId ?? '';
    };
    itemId.addEventListener('change', loadInventory);
    const inventoryFields = element('div', 'psyche-manual-grid');
    inventoryFields.append(
      labeledControl('物品 ID', itemId),
      labeledControl('数量变化', inventoryDelta),
      labeledControl('名称或说明', inventoryDescription),
      labeledControl('持有者', inventoryOwner)
    );
    const saveInventory = commandButton('fa-floppy-disk', '保存物品变化', () => {
      const id = itemId.value.trim();
      const delta = Number(inventoryDelta.value);
      if (!id) return this.showStructuredError('assets', '物品 ID 不能为空。');
      if (!Number.isInteger(delta)) return this.showStructuredError('assets', '数量变化必须是整数。');
      const description = inventoryDescription.value.trim();
      const ownerId = inventoryOwner.value.trim();
      const operation: DomainOperation = {
        id: 'manual-inventory-1',
        type: 'change_inventory',
        confidence: 1,
        evidenceIds: [],
        itemId: id,
        delta,
        ...(description ? { description } : {}),
        ...(ownerId ? { ownerId } : {})
      };
      void this.applyStructuredOperations('assets', [operation], '物品变化已保存。');
    });
    inventoryBlock.append(inventoryFields, saveInventory, itemSuggestions, ownerSuggestions);

    const error = this.structuredActionError?.tab === 'assets'
      ? this.structuredActionError.message
      : '';
    editor.append(
      relationshipBlock,
      axisBlock,
      attitudeBlock,
      inventoryBlock,
      element('div', 'psyche-editor-error', error)
    );
    return editor;
  }

  private renderKnowledgeTab(): HTMLElement {
    const view = element('div', 'psyche-tab-view');
    const projection = this.state.projection;
    if (!projection) return emptyView('当前聊天尚无可用知识状态。');
    const toolbar = element('div', 'psyche-toolbar');
    toolbar.append(commandButton(
      this.knowledgeEditorOpen ? 'fa-xmark' : 'fa-pen-to-square',
      this.knowledgeEditorOpen ? '关闭事实与知识编辑' : '编辑事实与知识',
      () => {
        this.knowledgeEditorOpen = !this.knowledgeEditorOpen;
        this.structuredActionError = null;
        this.render();
      }
    ));
    view.append(toolbar);
    if (this.knowledgeEditorOpen) view.append(this.renderKnowledgeEditor(projection));
    const facts = section('事实表');
    const factRows = Object.entries(projection.facts).map(([id, fact]) => [
      fact.truth || id,
      fact.status === 'true' ? '成立' : fact.status === 'false' ? '不成立' : '未确定'
    ] as [string, string]);
    facts.append(factRows.length > 0 ? dataList(factRows) : emptyView('暂无已提取事实。'));
    view.append(facts);

    const knowledgeEntries = Object.entries(projection.knowledge);
    if (knowledgeEntries.length === 0) view.append(emptyView('暂无人物知识记录。'));
    for (const [characterId, entries] of knowledgeEntries) {
      const character = section(characterId);
      const rows = Object.entries(entries).map(([factId, entry]) => {
        const fact = projection.facts[factId]?.truth ?? factId;
        const perceived = entry.perceivedTruth ? ` · 认知：${entry.perceivedTruth}` : '';
        return [fact, `${KNOWLEDGE_LABELS[entry.state] ?? entry.state}${perceived}`] as [string, string];
      });
      character.append(rows.length > 0 ? dataList(rows) : emptyView('暂无知识记录。'));
      view.append(character);
    }
    return view;
  }

  private renderAssetsTab(): HTMLElement {
    const view = element('div', 'psyche-tab-view');
    const projection = this.state.projection;
    if (!projection) return emptyView('当前聊天尚无可用关系或物品状态。');
    const toolbar = element('div', 'psyche-toolbar');
    toolbar.append(commandButton(
      this.assetsEditorOpen ? 'fa-xmark' : 'fa-pen-to-square',
      this.assetsEditorOpen ? '关闭关系与物品编辑' : '编辑关系与物品',
      () => {
        this.assetsEditorOpen = !this.assetsEditorOpen;
        this.structuredActionError = null;
        this.render();
      }
    ));
    view.append(toolbar);
    if (this.assetsEditorOpen) view.append(this.renderAssetsEditor(projection));
    const relationships = section('人物关系');
    const relationshipEntries = Object.values(projection.relationships);
    if (relationshipEntries.length === 0) relationships.append(emptyView('暂无关系记录。'));
    for (const relationship of relationshipEntries) {
      const row = element('div', 'psyche-history-row');
      row.append(element('strong', '', `${relationship.pairId} · ${relationship.stage || '未定阶段'}`));
      for (const [fromId, direction] of Object.entries(relationship.directions)) {
        const value = [
          direction.stance.length ? `态度：${direction.stance.join('、')}` : '',
          direction.wants.length ? `诉求：${direction.wants.join('、')}` : '',
          direction.secrets.length ? `隐瞒：${direction.secrets.join('、')}` : ''
        ].filter(Boolean).join('；');
        row.append(element('div', 'psyche-history-meta', `${fromId} → ${direction.toward}：${value || '未记录'}`));
      }
      const axes = Object.entries(relationship.axes).map(([key, value]) => `${key} ${value}`).join(' · ');
      if (axes) row.append(element('div', 'psyche-history-meta', axes));
      relationships.append(row);
    }
    view.append(relationships);

    const inventory = section('物品栏');
    const inventoryRows = Object.entries(projection.inventory).map(([id, item]) => [
      item.description || id,
      `数量 ${item.count}${item.ownerId ? ` · 持有者 ${item.ownerId}` : ''}`
    ] as [string, string]);
    inventory.append(inventoryRows.length > 0 ? dataList(inventoryRows) : emptyView('暂无物品记录。'));
    view.append(inventory);
    return view;
  }

  private requestRollback(recordId: string | null): void {
    this.pendingRollbackTarget = recordId;
    this.render();
  }

  private renderRollbackConfirmation(recordId: string | null): HTMLElement | null {
    if (this.pendingRollbackTarget !== recordId) return null;
    const target = recordId ? '所选检查点' : '故事起点';
    const confirmation = element('div', 'psyche-inline-confirm');
    confirmation.append(
      element('span', '', `将当前活动 Swipe 的状态回溯到${target}？聊天消息不会删除，之后的状态记录会标记为过期。`),
      commandButton('fa-check', '确认回溯', () => {
        const pendingTarget = this.pendingRollbackTarget;
        this.pendingRollbackTarget = undefined;
        if (pendingTarget !== undefined) this.callbacks.onRollbackToCheckpoint(pendingTarget);
      }),
      iconButton('fa-xmark', '取消回溯', () => {
        this.pendingRollbackTarget = undefined;
        this.render();
      })
    );
    return confirmation;
  }

  private renderCheckpointsTab(): HTMLElement {
    const view = element('div', 'psyche-tab-view');
    const toolbar = element('div', 'psyche-toolbar');
    const create = commandButton('fa-bookmark', '创建当前检查点', this.callbacks.onCreateCheckpoint);
    create.disabled = !this.state.records.some(record => record.application.status === 'applied');
    toolbar.append(create);
    view.append(toolbar);

    const checkpoints = section('可回溯位置');
    const initial = element('div', 'psyche-history-row');
    const initialHeader = element('div', 'psyche-history-header');
    initialHeader.append(element('strong', '', '故事起点'));
    const initialRollback = iconButton('fa-clock-rotate-left', '回溯到故事起点', () => this.requestRollback(null));
    initialRollback.disabled = this.state.records.length === 0;
    initialHeader.append(initialRollback);
    initial.append(initialHeader, element('div', 'psyche-history-meta', '初始 Projection'));
    const initialConfirmation = this.renderRollbackConfirmation(null);
    if (initialConfirmation) initial.append(initialConfirmation);
    checkpoints.append(initial);

    const records = this.state.records.filter(record => record.checkpoint && record.application.status === 'applied').reverse();
    for (const record of records) {
      const row = element('div', 'psyche-history-row');
      const header = element('div', 'psyche-history-header');
      header.append(
        element('strong', '', `回合 ${record.checkpoint?.turn ?? '?'} · ${recordOperationSummary(record)}`),
        iconButton('fa-clock-rotate-left', '回溯到此检查点', () => this.requestRollback(record.recordId))
      );
      row.append(header, element('div', 'psyche-history-meta', formatTimestamp(record.application.appliedAt)));
      const confirmation = this.renderRollbackConfirmation(record.recordId);
      if (confirmation) row.append(confirmation);
      checkpoints.append(row);
    }
    if (records.length === 0) checkpoints.append(emptyView('尚未创建回合检查点。'));
    view.append(checkpoints);
    return view;
  }

  private renderAuditTab(): HTMLElement {
    const view = element('div', 'psyche-tab-view');
    const audit = section('回合审计');
    const records = [...this.state.records].reverse();
    if (records.length === 0) audit.append(emptyView('暂无审计记录。'));
    for (const record of records) {
      const row = element('div', 'psyche-history-row');
      const header = element('div', 'psyche-history-header');
      header.append(
        element('strong', '', recordOperationSummary(record)),
        element('span', `psyche-audit-badge psyche-audit-${record.audit.status}`, AUDIT_LABELS[record.audit.status])
      );
      row.append(
        header,
        element('div', 'psyche-history-meta', `${record.audit.mode === 'strict' ? '双层严格' : record.audit.mode === 'standard' ? '标准' : '未启用'} · ${APPLICATION_LABELS[record.application.status]} · ${formatTimestamp(record.createdAt)}`)
      );
      for (const violation of record.audit.violations) {
        row.append(element('div', `psyche-violation psyche-violation-${violation.severity}`, violation.message));
      }
      audit.append(row);
    }
    view.append(audit);
    return view;
  }

  private renderStoryTab(): HTMLElement {
    const view = element('div', 'psyche-tab-view');
    const details = this.state.storyDetails;
    const issue = this.state.bindingIssue;
    if (issue) {
      const warning = section('故事包异常');
      warning.classList.add('psyche-package-warning');
      warning.append(dataList([
        ['状态', issue.message],
        ['故事 ID', issue.storyId ?? '无法识别'],
        ['故事包摘要', issue.packageDigest ?? '未记录']
      ]));
      view.append(warning);
    }
    if (!details) {
      if (issue) return view;
      return emptyView('当前聊天未绑定故事。');
    }
    const identity = section('绑定信息');
    identity.append(dataList([
      ['故事 ID', details.storyId],
      ['来源', this.state.source ?? '未记录'],
      ['故事包状态', details.packageStatus === 'verified' ? '摘要已验证' : '角色卡内联'],
      ['故事包版本', details.packageVersion ?? '不适用'],
      ['原作事件数', String(details.eventCount)],
      ['入口章节', details.entryPoint.chapterId],
      ['入口场景', details.entryPoint.sceneId],
      ['入口事件', details.entryPoint.eventId ?? '未指定'],
      ['故事包摘要', details.packageDigest ?? '角色卡内联']
    ]));
    view.append(identity);
    const progress = this.state.sourceProgress;
    if (progress) {
      const modeLabel = progress.preparationMode === 'quick'
        ? '快速'
        : progress.preparationMode === 'balanced' ? '均衡' : '完整';
      const sourceSection = section('渐进原文库');
      sourceSection.append(dataList([
        ['准备模式', modeLabel],
        ['原文游标', `${progress.cursorOrder + 1}/${progress.retrievalChunkCount}`],
        ['检索片段', String(progress.retrievalChunkCount)],
        ['分析单元', String(progress.analysisUnitCount)],
        ['L2 顺序骨架', `${progress.l2Count}/${progress.analysisUnitCount}`],
        ['L3 独立审计', `${progress.l3Count}/${progress.analysisUnitCount}`],
        ['L4 可执行事件', `${progress.l4Count}/${progress.analysisUnitCount}`],
        ['证据声明', String(progress.claimCount)],
        ['失败单元', String(progress.failedCount)],
        ['酒馆向量', progress.vector
          ? `${progress.vector.indexed}/${progress.vector.total} · ${progress.vector.source}${progress.vector.complete ? ' · 已完成' : ' · 渐进建立中'}`
          : '不可用，使用顺序与关键词检索']
      ]));
      for (const warning of progress.warnings) {
        sourceSection.append(element('div', 'psyche-package-warning', warning));
      }
      view.append(sourceSection);
    }
    const compilation = this.state.sourceCompilation;
    if (compilation) {
      const sourceSection = section('渐进原文编译');
      sourceSection.append(dataList([
        ['当前单元', compilation.sourceUnitId],
        ['成熟层级', `L${compilation.level}`],
        ['深编译状态', compilation.status],
        ['缓存事件', String(compilation.eventCount)],
        ['连续尝试', compilation.maxAttempts
          ? `${compilation.attemptCount ?? 0}/${compilation.maxAttempts}`
          : String(compilation.attemptCount ?? 0)],
        ['最近错误', compilation.error ?? '无']
      ]));
      if (compilation.status === 'failed') {
        const exhausted = Boolean(compilation.maxAttempts
          && (compilation.attemptCount ?? 0) >= compilation.maxAttempts);
        sourceSection.append(commandButton(
          'fa-rotate-right',
          exhausted ? '重置计数并重新排队' : '重试当前原文窗口',
          () => exhausted
            ? this.callbacks.onResetSourceCompilationAttempts(compilation.sourceUnitId)
            : this.callbacks.onRetrySourceCompilation(compilation.sourceUnitId)
        ));
      }
      view.append(sourceSection);
    }
    return view;
  }

  private renderPendingTab(): HTMLElement {
    const pending = element('div', 'psyche-pending');
    pending.append(element('strong', '', `待确认变更 (${this.state.pendingRecords.length})`));
    if (this.state.pendingRecords.length === 0) pending.append(emptyView('当前没有待确认变更。'));
    for (const record of this.state.pendingRecords) {
      const item = element('div', 'psyche-pending-item');
      const header = element('div', 'psyche-pending-header');
      const descriptionView = element('div', 'psyche-pending-description');
      descriptionView.append(
        element('span', '', recordOperationSummary(record)),
        element('span', `psyche-audit-badge psyche-audit-${record.audit.status}`, AUDIT_LABELS[record.audit.status])
      );
      header.append(descriptionView);
      const actions = element('div', 'psyche-pending-actions');
      const apply = iconButton('fa-check', '应用变更', () => this.callbacks.onApplyRecord(record.recordId));
      apply.disabled = record.audit.status === 'failed';
      actions.append(apply, iconButton('fa-xmark', '拒绝变更', () => this.callbacks.onRejectRecord(record.recordId)));
      header.append(actions);
      item.append(header);

      const editor = element('details', 'psyche-operation-editor');
      editor.append(element('summary', '', `${record.operations.length} 项变更`));
      const editorRows: Array<{ enabled: HTMLInputElement; textarea: HTMLTextAreaElement }> = [];
      for (const operation of record.operations) {
        const row = element('div', 'psyche-operation-row');
        const rowHeader = element('div', 'psyche-operation-header');
        const enabledLabel = element('label', 'checkbox_label psyche-operation-enabled');
        const enabled = element('input') as HTMLInputElement;
        enabled.type = 'checkbox';
        enabled.checked = true;
        enabled.addEventListener('click', event => event.stopPropagation());
        enabledLabel.append(enabled, element('span', '', operationLabel(operation.type)));
        rowHeader.append(enabledLabel, element('span', 'psyche-confidence', `${Math.round(operation.confidence * 100)}%`));
        const textarea = element('textarea', 'text_pole psyche-operation-json') as HTMLTextAreaElement;
        textarea.value = JSON.stringify(operation, null, 2);
        textarea.spellcheck = false;
        row.append(rowHeader, textarea);
        const evidence = record.evidence.filter(candidate => operation.evidenceIds.includes(candidate.id));
        for (const evidenceItem of evidence) {
          const evidenceView = element('div', 'psyche-evidence-item');
          evidenceView.append(element('q', '', evidenceItem.quote), element('span', '', evidenceItem.claim));
          row.append(evidenceView);
        }
        editor.append(row);
        editorRows.push({ enabled, textarea });
      }

      const editorError = element('div', 'psyche-editor-error');
      const saveEdits = commandButton('fa-floppy-disk', '保存修改', () => {
        void (async () => {
          const operations: unknown[] = [];
          const parseErrors: string[] = [];
          editorRows.forEach(({ enabled, textarea }, index) => {
            textarea.classList.remove('psyche-invalid');
            if (!enabled.checked) return;
            try {
              operations.push(JSON.parse(textarea.value));
            } catch {
              textarea.classList.add('psyche-invalid');
              parseErrors.push(`第 ${index + 1} 项不是有效 JSON。`);
            }
          });
          const errors = parseErrors.length > 0
            ? parseErrors
            : await this.callbacks.onUpdateRecordOperations(record.recordId, operations);
          editorError.textContent = errors.join('\n');
        })();
      });
      const editorFooter = element('div', 'psyche-editor-footer');
      editorFooter.append(editorError, saveEdits);
      editor.append(editorFooter);
      item.append(editor);
      pending.append(item);
    }
    return pending;
  }

  private renderBackupConfirmation(): HTMLElement | null {
    if (this.backupInspecting) return element('div', 'psyche-backup-status', '正在检查时间线备份…');
    const preview = this.pendingBackupPreview;
    const file = this.pendingBackupFile;
    if (!preview || !file) {
      return this.backupActionError ? element('div', 'psyche-editor-error', this.backupActionError) : null;
    }
    const sectionView = section('准备恢复备份');
    sectionView.classList.add('psyche-backup-confirm');
    sectionView.append(dataList([
      ['文件', file.name],
      ['故事 ID', preview.storyId],
      ['导出时间', formatTimestamp(Date.parse(preview.exportedAt))],
      ['消息数', String(preview.messageCount)],
      ['状态记录数', String(preview.recordCount)],
      ['故事包摘要', preview.packageDigest ?? '角色卡内联']
    ]));
    sectionView.append(element(
      'div',
      'psyche-backup-warning',
      '确认后将替换当前分支的故事绑定、手动记录和全部 Swipe 时间线记录。'
    ));
    const actions = element('div', 'psyche-inline-confirm');
    const confirm = commandButton('fa-clock-rotate-left', this.backupRestoring ? '正在恢复' : '确认恢复时间线', () => {
      if (this.backupRestoring) return;
      this.backupRestoring = true;
      this.backupActionError = '';
      this.render();
      void (async () => {
        const errors = await this.callbacks.onRestoreBackup(file);
        this.backupRestoring = false;
        if (errors.length > 0) {
          this.backupActionError = errors.join('\n');
        } else {
          this.pendingBackupFile = null;
          this.pendingBackupPreview = null;
          this.backupActionError = '';
        }
        this.render();
      })();
    });
    confirm.disabled = this.backupRestoring;
    const cancel = iconButton('fa-xmark', '取消恢复时间线', () => {
      this.pendingBackupFile = null;
      this.pendingBackupPreview = null;
      this.backupActionError = '';
      this.render();
    });
    actions.append(confirm, cancel);
    sectionView.append(actions);
    if (this.backupActionError) sectionView.append(element('div', 'psyche-editor-error', this.backupActionError));
    return sectionView;
  }

  private renderTabs(): HTMLElement {
    const wrapper = element('div', 'psyche-tabs');
    const tabList = element('div', 'psyche-tab-list');
    tabList.setAttribute('role', 'tablist');
    for (const [id, baseLabel] of PANEL_TABS) {
      const label = id === 'pending' && this.state.pendingRecords.length > 0
        ? `${baseLabel} ${this.state.pendingRecords.length}`
        : baseLabel;
      const button = element('button', `menu_button psyche-tab${this.activeTab === id ? ' psyche-tab-active' : ''}`, label) as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(this.activeTab === id));
      button.addEventListener('click', () => {
        this.activeTab = id;
        this.render();
      });
      tabList.append(button);
    }
    const tabPanel = element('div', 'psyche-tab-panel');
    tabPanel.setAttribute('role', 'tabpanel');
    const content = this.activeTab === 'state' ? this.renderStateTab()
      : this.activeTab === 'events' ? this.renderEventsTab()
        : this.activeTab === 'pending' ? this.renderPendingTab()
          : this.activeTab === 'knowledge' ? this.renderKnowledgeTab()
            : this.activeTab === 'assets' ? this.renderAssetsTab()
              : this.activeTab === 'checkpoints' ? this.renderCheckpointsTab()
                : this.activeTab === 'audit' ? this.renderAuditTab()
                  : this.renderStoryTab();
    tabPanel.append(content);
    wrapper.append(tabList, tabPanel);
    return wrapper;
  }

  private render(): void {
    if (!this.root) return;
    this.root.replaceChildren();

    const drawer = element('div', 'inline-drawer');
    const toggle = element('div', 'inline-drawer-toggle inline-drawer-header');
    const title = element('b', '', '剧情时间线');
    const status = element('span', `psyche-status psyche-status-${this.state.status}`, this.state.statusText);
    const icon = element('i', 'fa-solid inline-drawer-icon');
    const content = element('div', 'inline-drawer-content psyche-timeline-content');
    const syncExpandedState = () => {
      content.style.display = this.expanded ? 'block' : 'none';
      icon.className = `fa-solid inline-drawer-icon ${this.expanded ? 'fa-circle-chevron-up up' : 'fa-circle-chevron-down down'}`;
      toggle.setAttribute('aria-expanded', String(this.expanded));
    };
    toggle.addEventListener('click', event => {
      event.stopPropagation();
      this.expanded = !this.expanded;
      syncExpandedState();
    });
    toggle.append(title, status, icon);
    syncExpandedState();

    content.append(checkbox('启用', this.state.settings.enabled, enabled => this.updateSettings({ enabled })));
    const grid = element('div', 'psyche-settings-grid');
    grid.append(
      selectControl('参与模式', this.state.settings.participationMode, [
        ['follow', '跟随原作'], ['adaptive', '自适应'], ['parallel', '平行线'], ['free', '自由剧情']
      ], participationMode => this.updateSettings({ participationMode: participationMode as PsycheTimelineSettings['participationMode'] })),
      selectControl('审计模式', this.state.settings.auditMode, [
        ['off', '关闭'], ['standard', '标准'], ['strict', '双层严格']
      ], auditMode => this.updateSettings({ auditMode: auditMode as PsycheTimelineSettings['auditMode'] }))
    );
    content.append(grid);
    const modelGrid = element('div', 'psyche-settings-grid');
    modelGrid.append(
      selectControl(
        '提取模型',
        this.state.settings.extractorProfileId,
        profileOptions(this.state.connectionProfiles, this.state.settings.extractorProfileId, '当前 API 连接'),
        extractorProfileId => this.updateSettings({ extractorProfileId })
      ),
      selectControl(
        '原文窗口规划模型',
        this.state.settings.sourceCompilerProfileId,
        profileOptions(this.state.connectionProfiles, this.state.settings.sourceCompilerProfileId, '跟随提取模型'),
        sourceCompilerProfileId => this.updateSettings({ sourceCompilerProfileId })
      ),
      selectControl(
        '审计模型',
        this.state.settings.auditorProfileId,
        profileOptions(this.state.connectionProfiles, this.state.settings.auditorProfileId, '跟随提取模型'),
        auditorProfileId => this.updateSettings({ auditorProfileId })
      )
    );
    content.append(modelGrid);
    content.append(
      checkbox('回复后提取状态', this.state.settings.extractionEnabled, extractionEnabled => this.updateSettings({ extractionEnabled })),
      checkbox('高置信度自动应用', this.state.settings.autoApply, autoApply => this.updateSettings({ autoApply })),
      checkbox('配置不可用时回退当前连接', this.state.settings.profileFallback, profileFallback => this.updateSettings({ profileFallback }))
    );
    content.append(this.renderPromptControls());

    const toolbar = element('div', 'psyche-toolbar');
    const fileInput = element('input') as HTMLInputElement;
    fileInput.type = 'file';
    fileInput.accept = '.psychebook,.json,application/json,application/zip';
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) this.callbacks.onImport(file);
      fileInput.value = '';
    });
    const backupInput = element('input') as HTMLInputElement;
    backupInput.type = 'file';
    backupInput.accept = '.psychetimeline,.json,application/json';
    backupInput.hidden = true;
    backupInput.addEventListener('change', () => {
      const file = backupInput.files?.[0];
      backupInput.value = '';
      if (!file) return;
      this.pendingBackupFile = null;
      this.pendingBackupPreview = null;
      this.backupActionError = '';
      this.backupInspecting = true;
      this.render();
      void (async () => {
        const result = await this.callbacks.onInspectBackup(file);
        this.backupInspecting = false;
        if (result.preview && result.errors.length === 0) {
          this.pendingBackupFile = file;
          this.pendingBackupPreview = result.preview;
        } else {
          this.backupActionError = result.errors.join('\n') || '无法读取时间线备份。';
        }
        this.render();
      })();
    });
    toolbar.append(
      commandButton('fa-file-import', '导入故事包', () => fileInput.click()),
      commandButton('fa-box-archive', '恢复时间线备份', () => backupInput.click()),
      commandButton('fa-plus', '创建当前角色时间线', this.callbacks.onCreate),
      iconButton('fa-link-slash', '解除当前聊天绑定', this.callbacks.onUnbind),
      iconButton('fa-rotate', '重建当前分支状态', this.callbacks.onRebuild),
      iconButton('fa-wand-magic-sparkles', '重新提取当前回复', this.callbacks.onRetryExtraction),
      iconButton('fa-file-export', '导出时间线备份', this.callbacks.onExport),
      fileInput,
      backupInput
    );
    content.append(toolbar);
    const backupConfirmation = this.renderBackupConfirmation();
    if (backupConfirmation) content.append(backupConfirmation);

    if (this.state.storyTitle) {
      const identity = element('div', 'psyche-story-identity');
      identity.append(element('strong', '', this.state.storyTitle), element('span', '', this.state.source ?? ''));
      content.append(identity);
    }
    if (this.state.error) content.append(element('div', 'psyche-error', this.state.error));
    content.append(this.renderTabs());

    drawer.append(toggle, content);
    this.root.append(drawer);
  }
}
