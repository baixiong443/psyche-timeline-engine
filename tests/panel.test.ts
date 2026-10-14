import { createEmptyProjection } from '../src/model/defaults';
import type { TurnRecord } from '../src/model/types';
import { DEFAULT_SETTINGS } from '../src/runtime/settings';
import { PsycheTimelinePanel } from '../src/ui/panel';
import { storyEvent } from './fixtures';

function callbacks() {
  return {
    onSettingsChanged: vi.fn(),
    onApplyRecord: vi.fn(),
    onRejectRecord: vi.fn(),
    onUpdateRecordOperations: vi.fn(async () => []),
    onRebuild: vi.fn(),
    onRetryExtraction: vi.fn(),
    onRetrySourceCompilation: vi.fn(),
    onResetSourceCompilationAttempts: vi.fn(),
    onCreateCheckpoint: vi.fn(),
    onRollbackToCheckpoint: vi.fn(),
    onApplyManualState: vi.fn(async () => []),
    onApplyManualOperations: vi.fn(async () => []),
    onSetPathLocked: vi.fn(async () => []),
    onTransitionCanonEvent: vi.fn(async () => []),
    onCreate: vi.fn(),
    onUnbind: vi.fn(),
    onImport: vi.fn(),
    onInspectBackup: vi.fn(async () => ({ preview: null, errors: [] })),
    onRestoreBackup: vi.fn(async () => []),
    onExport: vi.fn()
  };
}

function pendingRecord(): TurnRecord {
  return {
    schemaVersion: 1,
    recordId: 'record-1',
    userMessageId: 'message-user-1',
    assistantMessageId: 'message-assistant-1',
    swipeId: 1,
    parentRecordId: null,
    inputHash: 'sha256:user',
    outputHash: 'sha256:assistant',
    baseProjectionHash: 'sha256:base',
    operations: [{
      id: 'op-1',
      type: 'advance_time',
      minutes: 6,
      confidence: 0.9,
      evidenceIds: ['ev-1']
    }],
    evidence: [{ id: 'ev-1', source: 'assistant', quote: '六分钟后', claim: '时间推进六分钟' }],
    application: { status: 'pending_user', appliedAt: null },
    audit: { mode: 'standard', status: 'passed', violations: [], model: null },
    checkpoint: null,
    projectionHash: 'sha256:result',
    createdAt: Date.parse('2026-07-13T00:00:00.000Z')
  };
}

describe('timeline settings panel', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="extensions-settings-button">
        <div class="drawer-toggle"><div class="drawer-icon"></div></div>
        <div id="rm_extensions_block" class="drawer-content closedDrawer"></div>
      </div>
      <div id="extensionsMenu"></div>
      <div id="extensions_settings2"></div>`;
    document.querySelector<HTMLElement>('#extensions-settings-button .drawer-icon')?.addEventListener('click', () => {
      document.getElementById('rm_extensions_block')?.classList.remove('closedDrawer');
    });
  });

  it('preserves its expanded state when runtime state is re-rendered', () => {
    const panel = new PsycheTimelinePanel(callbacks(), {
      settings: DEFAULT_SETTINGS,
      status: 'ready',
      statusText: '运行中',
      storyTitle: '测试故事',
      source: '角色卡',
      projection: createEmptyProjection('story-1'),
      pendingRecords: [],
      records: [],
      candidates: [],
      storyDetails: null,
      connectionProfiles: [],
      error: null
    });
    panel.mount();

    const toggle = document.querySelector<HTMLElement>('#psyche-timeline-settings .inline-drawer-toggle');
    toggle?.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-tab')).find(button => button.textContent?.startsWith('待确认'))?.click();
    panel.update({ pendingRecords: [pendingRecord()] });

    const content = document.querySelector<HTMLElement>('#psyche-timeline-settings .psyche-timeline-content');
    const apply = document.querySelector<HTMLButtonElement>('#psyche-timeline-settings button[title="应用变更"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(content?.style.display).toBe('block');
    expect(apply?.disabled).toBe(false);
  });

  it('shows per-layer prompt editors, persists changes and displays the risk notice', () => {
    const handlers = callbacks();
    const panel = new PsycheTimelinePanel(handlers, {
      settings: DEFAULT_SETTINGS,
      status: 'ready',
      statusText: '运行中',
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
    panel.mount();

    expect(document.querySelector('.psyche-prompt-warning')?.textContent).toContain('开发者不承担由此产生的责任');
    expect(document.querySelectorAll('.psyche-prompt-textarea')).toHaveLength(3);

    const mode = document.querySelector<HTMLSelectElement>('select[aria-label="回复后状态提取提示词模式"]');
    mode!.value = 'append';
    mode!.dispatchEvent(new Event('change'));
    const textarea = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.psyche-prompt-textarea'))[1]!;
    textarea.value = '检查自定义状态字段。';
    textarea.dispatchEvent(new Event('input'));

    const lastSettings = handlers.onSettingsChanged.mock.calls.at(-1)?.[0];
    expect(lastSettings.promptOverrides.extraction).toEqual({
      mode: 'append',
      text: '检查自定义状态字段。'
    });
  });

  it('shows evidence and saves edited pending operations', async () => {
    const handlers = callbacks();
    const record = pendingRecord();
    const panel = new PsycheTimelinePanel(handlers, {
      settings: DEFAULT_SETTINGS,
      status: 'ready',
      statusText: '运行中',
      storyTitle: '测试故事',
      source: '角色卡',
      projection: createEmptyProjection('story-1'),
      pendingRecords: [record],
      records: [record],
      candidates: [],
      storyDetails: null,
      connectionProfiles: [],
      error: null
    });
    panel.mount();
    document.querySelector<HTMLElement>('#psyche-timeline-settings .inline-drawer-toggle')?.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-tab')).find(button => button.textContent?.startsWith('待确认'))?.click();

    const textarea = document.querySelector<HTMLTextAreaElement>('.psyche-operation-json');
    const edited = { ...record.operations[0], minutes: 12 };
    if (textarea) textarea.value = JSON.stringify(edited);
    document.querySelector<HTMLButtonElement>('.psyche-editor-footer .psyche-command-button')?.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(document.querySelector('.psyche-evidence-item')?.textContent).toContain('六分钟后');
    expect(handlers.onUpdateRecordOperations).toHaveBeenCalledWith('record-1', [edited]);
  });

  it('adds a wand-menu shortcut that opens and expands the panel', async () => {
    const panel = new PsycheTimelinePanel(callbacks(), {
      settings: DEFAULT_SETTINGS,
      status: 'ready',
      statusText: '运行中',
      storyTitle: '测试故事',
      source: '角色卡',
      projection: createEmptyProjection('story-1'),
      pendingRecords: [],
      records: [],
      candidates: [],
      storyDetails: null,
      connectionProfiles: [],
      error: null
    });
    panel.mount();

    document.querySelector<HTMLButtonElement>('#psyche-timeline-wand-button')?.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(document.getElementById('rm_extensions_block')?.classList.contains('closedDrawer')).toBe(false);
    expect(document.querySelector('#psyche-timeline-settings .inline-drawer-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector<HTMLElement>('#psyche-timeline-settings .psyche-timeline-content')?.style.display).toBe('block');
  });

  it('renders the eight required state workspace tabs', () => {
    const projection = createEmptyProjection('story-1');
    projection.canonCursor = { chapterId: 'chapter-2', sceneId: 'scene-3', eventOrder: 12 };
    const panel = new PsycheTimelinePanel(callbacks(), {
      settings: DEFAULT_SETTINGS,
      status: 'ready',
      statusText: '运行中',
      storyTitle: '测试故事',
      source: '角色卡',
      projection,
      pendingRecords: [],
      records: [pendingRecord()],
      candidates: [],
      canonEventDetails: [{
        id: 'event-12',
        summary: '潮前打开铜匣',
        canonicalOrder: 12,
        kind: 'hard_anchor',
        rigidity: 'hard',
        adaptation: { allowDelay: true, allowRelocation: true, allowSubstitution: true }
      }],
      storyDetails: {
        storyId: 'story-1',
        packageDigest: null,
        packageStatus: 'verified',
        packageVersion: '1.2.0',
        entryPoint: { chapterId: 'chapter-1', sceneId: 'scene-1', eventId: null },
        eventCount: 3
      },
      sourceProgress: {
        preparationMode: 'balanced',
        cursorOrder: 3,
        retrievalChunkCount: 18,
        analysisUnitCount: 4,
        claimCount: 12,
        l2Count: 4,
        l3Count: 3,
        l4Count: 1,
        failedCount: 0,
        vector: { source: 'transformers', indexed: 12, total: 18, complete: false },
        warnings: []
      },
      connectionProfiles: [],
      error: null
    });
    panel.mount();

    expect(Array.from(document.querySelectorAll('.psyche-tab')).map(tab => tab.textContent)).toEqual([
      '当前状态', '近期事件', '待确认', '人物知识', '关系与物品', '检查点与回溯', '审计记录', '故事包'
    ]);
    expect(document.querySelector('.psyche-tab-panel')?.textContent).toContain('原作进度');
    expect(document.querySelector('.psyche-tab-panel')?.textContent).toContain('chapter-2');
    expect(document.querySelector('.psyche-tab-panel')?.textContent).toContain('潮前打开铜匣');
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-tab')).find(button => button.textContent === '故事包')?.click();
    expect(document.querySelector('.psyche-tab-panel')?.textContent).toContain('story-1');
    expect(document.querySelector('.psyche-tab-panel')?.textContent).toContain('原作事件数');
    expect(document.querySelector('.psyche-tab-panel')?.textContent).toContain('摘要已验证');
    expect(document.querySelector('.psyche-tab-panel')?.textContent).toContain('1.2.0');
    expect(document.querySelector('.psyche-tab-panel')?.textContent).toContain('均衡');
    expect(document.querySelector('.psyche-tab-panel')?.textContent).toContain('L3 独立审计');
    expect(document.querySelector('.psyche-tab-panel')?.textContent).toContain('12/18 · transformers · 渐进建立中');
  });

  it('shows an explicit story package binding failure', () => {
    const panel = new PsycheTimelinePanel(callbacks(), {
      settings: DEFAULT_SETTINGS,
      status: 'error',
      statusText: '故事包异常',
      storyTitle: 'story-1',
      source: '故事包',
      projection: null,
      pendingRecords: [],
      records: [],
      candidates: [],
      storyDetails: null,
      bindingIssue: {
        code: 'missing_package',
        message: '当前设备缺少此聊天绑定的故事包，请重新导入摘要匹配的原文件。',
        storyId: 'story-1',
        packageDigest: 'sha256:missing'
      },
      connectionProfiles: [],
      error: null
    });
    panel.mount();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-tab'))
      .find(button => button.textContent === '故事包')?.click();

    expect(document.querySelector('.psyche-package-warning')?.textContent).toContain('故事包异常');
    expect(document.querySelector('.psyche-package-warning')?.textContent).toContain('重新导入摘要匹配的原文件');
    expect(document.querySelector('.psyche-package-warning')?.textContent).toContain('sha256:missing');
  });

  it('shows a failed source compilation and retries the current source unit', () => {
    const handlers = callbacks();
    const panel = new PsycheTimelinePanel(handlers, {
      settings: DEFAULT_SETTINGS,
      status: 'ready',
      statusText: '运行中',
      storyTitle: '测试故事',
      source: '故事包',
      projection: createEmptyProjection('story-1'),
      pendingRecords: [],
      records: [],
      candidates: [],
      storyDetails: {
        storyId: 'story-1',
        packageDigest: 'sha256:source',
        packageStatus: 'verified',
        packageVersion: '1.2.0',
        entryPoint: { chapterId: 'chapter-1', sceneId: 'scene-1', eventId: null },
        eventCount: 3
      },
      sourceCompilation: {
        sourceUnitId: 'A000002',
        level: 3,
        status: 'failed',
        eventCount: 0,
        attemptCount: 1,
        maxAttempts: 3,
        error: '审计输出缺少 JSON 边界标记'
      },
      connectionProfiles: [],
      error: null
    });
    panel.mount();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-tab'))
      .find(button => button.textContent === '故事包')?.click();

    const sourceSection = Array.from(document.querySelectorAll<HTMLElement>('.psyche-section'))
      .find(candidate => candidate.textContent?.includes('渐进原文编译'));
    expect(sourceSection?.textContent).toContain('A000002');
    expect(sourceSection?.textContent).toContain('审计输出缺少 JSON 边界标记');
    const retry = Array.from(sourceSection?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find(button => button.textContent?.includes('重试当前原文窗口'));
    expect(retry).toBeTruthy();

    retry?.click();
    expect(handlers.onRetrySourceCompilation).toHaveBeenCalledWith('A000002');
  });

  it('requires an explicit attempt reset after a source window reaches its limit', () => {
    const handlers = callbacks();
    const panel = new PsycheTimelinePanel(handlers, {
      settings: DEFAULT_SETTINGS,
      status: 'ready',
      statusText: '运行中',
      storyTitle: '测试故事',
      source: '故事包',
      projection: createEmptyProjection('story-1'),
      pendingRecords: [],
      records: [],
      candidates: [],
      storyDetails: {
        storyId: 'story-1',
        packageDigest: 'sha256:source',
        packageStatus: 'verified',
        packageVersion: '1.2.0',
        entryPoint: { chapterId: 'chapter-1', sceneId: 'scene-1', eventId: null },
        eventCount: 3
      },
      sourceCompilation: {
        sourceUnitId: 'A000003',
        level: 3,
        status: 'failed',
        eventCount: 0,
        attemptCount: 3,
        maxAttempts: 3,
        error: '已达到连续编译上限（3/3）'
      },
      connectionProfiles: [],
      error: null
    });
    panel.mount();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-tab'))
      .find(button => button.textContent === '故事包')?.click();

    const reset = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('重置计数并重新排队'));
    expect(reset).toBeTruthy();
    reset?.click();
    expect(handlers.onResetSourceCompilationAttempts).toHaveBeenCalledWith('A000003');
    expect(handlers.onRetrySourceCompilation).not.toHaveBeenCalled();
  });

  it('submits deterministic manual state fields and exposes lock controls', async () => {
    const handlers = callbacks();
    const projection = createEmptyProjection('story-1');
    projection.time.absolute = '1922-02-10T20:21:00.000Z';
    projection.location = { area: '绿绮湖', place: '近坡岸', position: '湖滩边' };
    projection.characters['敏明'] = { present: true };
    const panel = new PsycheTimelinePanel(handlers, {
      settings: DEFAULT_SETTINGS,
      status: 'ready',
      statusText: '运行中',
      storyTitle: '测试故事',
      source: '角色卡',
      projection,
      pendingRecords: [],
      records: [],
      candidates: [],
      storyDetails: null,
      connectionProfiles: [],
      error: null
    });
    panel.mount();
    document.querySelector<HTMLElement>('#psyche-timeline-settings .inline-drawer-toggle')?.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-command-button'))
      .find(button => button.textContent?.includes('编辑当前状态'))?.click();

    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('.psyche-state-field input'));
    inputs[1]!.value = '12';
    inputs[3]!.value = '湖岸';
    inputs[5]!.value = '0.5';
    inputs[6]!.value = '湖岸路线已被提前封闭。';
    document.querySelector<HTMLButtonElement>('button[title="锁定绝对时间"]')?.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-command-button'))
      .find(button => button.textContent?.includes('保存状态修正'))?.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(handlers.onSetPathLocked).toHaveBeenCalledWith('time.absolute', true);
    expect(handlers.onApplyManualState).toHaveBeenCalledWith({
      absoluteTime: '1922-02-10T20:21:00.000Z',
      relativeMinutes: 12,
      location: { area: '绿绮湖', place: '湖岸', position: '湖滩边' },
      characterPresence: { 敏明: true },
      divergenceLevel: 0.5,
      divergenceSummary: '湖岸路线已被提前封闭。'
    });
  });

  it('submits structured fact and character knowledge corrections', async () => {
    const handlers = callbacks();
    const projection = createEmptyProjection('story-1');
    projection.characters.lin_yan = { present: true };
    projection.facts.ferryman_missing = {
      truth: '摆渡人已经失踪三天',
      status: 'true',
      evidenceRefs: []
    };
    const panel = new PsycheTimelinePanel(handlers, {
      settings: DEFAULT_SETTINGS,
      status: 'ready',
      statusText: '运行中',
      storyTitle: '测试故事',
      source: '故事包',
      projection,
      pendingRecords: [],
      records: [],
      candidates: [],
      storyDetails: null,
      connectionProfiles: [],
      error: null
    });
    panel.mount();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-tab'))
      .find(button => button.textContent === '人物知识')?.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-command-button'))
      .find(button => button.textContent?.includes('编辑事实与知识'))?.click();

    const factId = document.querySelector<HTMLInputElement>('[data-psyche-field="fact-id"]')!;
    const factTruth = document.querySelector<HTMLInputElement>('[data-psyche-field="fact-truth"]')!;
    const factStatus = document.querySelector<HTMLSelectElement>('[data-psyche-field="fact-status"]')!;
    factId.value = 'case_contains_map';
    factTruth.value = '铜匣夹层里藏着旧河道图';
    factStatus.value = 'true';
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-command-button'))
      .find(button => button.textContent?.includes('保存事实'))?.click();

    const characterId = document.querySelector<HTMLInputElement>('[data-psyche-field="knowledge-character"]')!;
    const knowledgeFact = document.querySelector<HTMLInputElement>('[data-psyche-field="knowledge-fact"]')!;
    const knowledgeState = document.querySelector<HTMLSelectElement>('[data-psyche-field="knowledge-state"]')!;
    const perceivedTruth = document.querySelector<HTMLInputElement>('[data-psyche-field="knowledge-perceived-truth"]')!;
    characterId.value = 'lin_yan';
    knowledgeFact.value = 'ferryman_missing';
    knowledgeState.value = 'hiding';
    perceivedTruth.value = '摆渡人的失踪与铜匣有关';
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-command-button'))
      .find(button => button.textContent?.includes('保存人物知识'))?.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(handlers.onApplyManualOperations).toHaveBeenNthCalledWith(1, [{
      id: 'manual-fact-1',
      type: 'add_fact',
      confidence: 1,
      evidenceIds: [],
      factId: 'case_contains_map',
      fact: {
        truth: '铜匣夹层里藏着旧河道图',
        status: 'true',
        evidenceRefs: []
      }
    }], '事实修正已保存。');
    expect(handlers.onApplyManualOperations).toHaveBeenNthCalledWith(2, [{
      id: 'manual-knowledge-1',
      type: 'set_knowledge',
      confidence: 1,
      evidenceIds: [],
      characterId: 'lin_yan',
      factId: 'ferryman_missing',
      state: 'hiding',
      perceivedTruth: '摆渡人的失踪与铜匣有关'
    }], '人物知识修正已保存。');
  });

  it('submits structured relationship and inventory corrections', async () => {
    const handlers = callbacks();
    const projection = createEmptyProjection('story-1');
    projection.characters.lin_yan = { present: true };
    projection.characters.traveler = { present: true };
    projection.relationships.lin_yan_traveler = {
      pairId: 'lin_yan_traveler',
      stage: '试探',
      directions: {
        lin_yan: {
          toward: 'traveler',
          stance: ['谨慎'],
          wants: ['确认来意'],
          secrets: []
        }
      },
      axes: { trust: 0 }
    };
    projection.inventory.copper_key = { count: 1, description: '铜钥匙', ownerId: 'lin_yan' };
    const panel = new PsycheTimelinePanel(handlers, {
      settings: DEFAULT_SETTINGS,
      status: 'ready',
      statusText: '运行中',
      storyTitle: '测试故事',
      source: '故事包',
      projection,
      pendingRecords: [],
      records: [],
      candidates: [],
      storyDetails: null,
      connectionProfiles: [],
      error: null
    });
    panel.mount();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-tab'))
      .find(button => button.textContent === '关系与物品')?.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-command-button'))
      .find(button => button.textContent?.includes('编辑关系与物品'))?.click();

    document.querySelector<HTMLInputElement>('[data-psyche-field="relationship-stage"]')!.value = '暂时互信';
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-command-button'))
      .find(button => button.textContent?.includes('保存关系阶段'))?.click();

    document.querySelector<HTMLInputElement>('[data-psyche-field="relationship-axis-value"]')!.value = '7.5';
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-command-button'))
      .find(button => button.textContent?.includes('保存关系数值'))?.click();

    document.querySelector<HTMLInputElement>('[data-psyche-field="relationship-stance"]')!.value = '信任、警惕';
    document.querySelector<HTMLInputElement>('[data-psyche-field="relationship-wants"]')!.value = '共同解开铜匣';
    document.querySelector<HTMLInputElement>('[data-psyche-field="relationship-secrets"]')!.value = '隐瞒摆渡人线索';
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-command-button'))
      .find(button => button.textContent?.includes('保存关系方向'))?.click();

    document.querySelector<HTMLInputElement>('[data-psyche-field="inventory-delta"]')!.value = '2';
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-command-button'))
      .find(button => button.textContent?.includes('保存物品变化'))?.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(handlers.onApplyManualOperations).toHaveBeenNthCalledWith(1, [{
      id: 'manual-relationship-stage-1',
      type: 'set_relationship_stage',
      confidence: 1,
      evidenceIds: [],
      pairId: 'lin_yan_traveler',
      stage: '暂时互信'
    }], '关系阶段修正已保存。');
    expect(handlers.onApplyManualOperations).toHaveBeenNthCalledWith(2, [{
      id: 'manual-relationship-axis-1',
      type: 'change_relationship_axis',
      confidence: 1,
      evidenceIds: [],
      pairId: 'lin_yan_traveler',
      axis: 'trust',
      delta: 7.5
    }], '关系数值修正已保存。');
    expect(handlers.onApplyManualOperations).toHaveBeenNthCalledWith(3, [{
      id: 'manual-relationship-attitude-1',
      type: 'set_relationship_attitude',
      confidence: 1,
      evidenceIds: [],
      pairId: 'lin_yan_traveler',
      fromCharacterId: 'lin_yan',
      towardCharacterId: 'traveler',
      stance: ['信任', '警惕'],
      wants: ['共同解开铜匣'],
      secrets: ['隐瞒摆渡人线索']
    }], '关系方向修正已保存。');
    expect(handlers.onApplyManualOperations).toHaveBeenNthCalledWith(4, [{
      id: 'manual-inventory-1',
      type: 'change_inventory',
      confidence: 1,
      evidenceIds: [],
      itemId: 'copper_key',
      delta: 2,
      description: '铜钥匙',
      ownerId: 'lin_yan'
    }], '物品变化已保存。');
  });

  it('shows legal canon controls and confirms destructive transitions inline', async () => {
    const handlers = callbacks();
    const projection = createEmptyProjection('story-1');
    const event = storyEvent({
      id: 'event-1',
      summary: '渡船在暴雨前靠岸',
      adaptation: { allowDelay: false, allowRelocation: false, allowSubstitution: false }
    });
    const panel = new PsycheTimelinePanel(handlers, {
      settings: DEFAULT_SETTINGS,
      status: 'ready',
      statusText: '运行中',
      storyTitle: '测试故事',
      source: '故事包',
      projection,
      pendingRecords: [],
      records: [],
      candidates: [{ event, score: 100, state: 'eligible', reasons: ['条件满足'] }],
      canonEventDetails: [{
        id: event.id,
        summary: event.summary,
        canonicalOrder: event.canonicalOrder,
        kind: event.kind,
        rigidity: event.rigidity,
        adaptation: event.adaptation
      }],
      storyDetails: null,
      connectionProfiles: [],
      error: null
    });
    panel.mount();
    document.querySelector<HTMLElement>('#psyche-timeline-settings .inline-drawer-toggle')?.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-tab'))
      .find(button => button.textContent === '近期事件')?.click();

    expect(document.querySelector('.psyche-tab-panel')?.textContent).toContain('渡船在暴雨前靠岸');
    expect(document.querySelector('button[title="延迟事件"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('button[title="跳过事件"]')?.click();
    expect(handlers.onTransitionCanonEvent).not.toHaveBeenCalled();
    expect(document.querySelector('.psyche-inline-confirm')?.textContent).toContain('已跳过');
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-command-button'))
      .find(button => button.textContent?.includes('确认事件变更'))?.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(handlers.onTransitionCanonEvent).toHaveBeenCalledWith('event-1', 'skipped');
  });

  it('confirms checkpoint rollback inline without opening a native dialog', () => {
    const handlers = callbacks();
    const record = pendingRecord();
    record.application = { status: 'applied', appliedAt: record.createdAt };
    record.checkpoint = createEmptyProjection('story-1');
    const nativeConfirm = vi.spyOn(window, 'confirm');
    const panel = new PsycheTimelinePanel(handlers, {
      settings: DEFAULT_SETTINGS,
      status: 'ready',
      statusText: '运行中',
      storyTitle: '测试故事',
      source: '角色卡',
      projection: createEmptyProjection('story-1'),
      pendingRecords: [],
      records: [record],
      candidates: [],
      storyDetails: null,
      connectionProfiles: [],
      error: null
    });
    panel.mount();
    document.querySelector<HTMLElement>('#psyche-timeline-settings .inline-drawer-toggle')?.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-tab'))
      .find(button => button.textContent === '检查点与回溯')?.click();

    document.querySelector<HTMLButtonElement>('button[title="回溯到此检查点"]')?.click();

    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(handlers.onRollbackToCheckpoint).not.toHaveBeenCalled();
    expect(document.querySelector('.psyche-inline-confirm')?.textContent).toContain('所选检查点');

    Array.from(document.querySelectorAll<HTMLButtonElement>('.psyche-command-button'))
      .find(button => button.textContent?.includes('确认回溯'))?.click();

    expect(handlers.onRollbackToCheckpoint).toHaveBeenCalledWith('record-1');
  });
});
