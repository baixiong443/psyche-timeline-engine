import { buildExtractionPrompt, extractAndAuditTurn, normalizeExtractionWire, normalizeStrictAuditWire } from '../src/ai/extractor';
import { createEmptyProjection } from '../src/model/defaults';
import type { SillyTavernContext } from '../src/runtime/context';
import { validateExtractionResponse } from '../src/schema/validators';

describe('extraction wire normalization', () => {
  it('requires explicit evidence for relationship axes and respects locked paths', () => {
    const projection = createEmptyProjection('story-1');
    projection.lockedPaths = ['relationships.hero_user.axes.trust'];
    const prompt = buildExtractionPrompt({
      userText: '我向她点头。',
      assistantText: '她也点了点头。',
      userRoleId: 'traveler',
      responderCharacterId: 'hero',
      projection,
      candidates: [],
      auditMode: 'standard',
      responseTokens: 1000,
      extractorProfileId: '',
      auditorProfileId: '',
      profileFallback: true
    });

    expect(prompt).toContain('projection.lockedPaths 中的字段不可修改');
    expect(prompt).toContain('不得仅凭语气、动作或主观印象猜测好感度');
    expect(prompt).toContain('change_relationship_axis');
    expect(prompt).toContain('0.5=故事弧明显分叉');
    expect(prompt).toContain('set_divergence');
    expect(prompt).toContain('当前用户故事角色 ID：traveler');
    expect(prompt).toContain('PTE 会自动应用 StoryEvent.effects');
    expect(prompt).toContain('completed_adapted 不会自动应用原作效果');
    expect(prompt).toContain('自动履行该事件仍为 pending 的 narrativePurposes');
    expect(prompt).toContain('allowDelay=false 时不得标记 delayed');
    expect(prompt).toContain('不得因为出现一轮回复就默认推进 1 分钟');
    expect(prompt).toContain('未来动作都不是已完成的状态变化');
    expect(prompt).toContain('不得把计划、准备事项或下一步行动写入 activity');
    expect(prompt).toContain('输入可能包含成熟题材、成人关系、暴力、身体或亲密场景');
  });

  it('customizes extraction guidance while preserving state, text and JSON protocol', () => {
    const projection = createEmptyProjection('story-1');
    const base = {
      userText: '我留在门边。',
      assistantText: '她点头，没有移动。',
      projection,
      candidates: [],
      auditMode: 'strict' as const,
      responseTokens: 1000,
      extractorProfileId: '',
      auditorProfileId: '',
      profileFallback: true
    };
    const appended = buildExtractionPrompt({
      ...base,
      extractionPromptOverride: { mode: 'append', text: '额外检查门锁状态。' }
    });
    expect(appended).toContain('你是叙事状态提取器');
    expect(appended).toContain('额外检查门锁状态');

    const replaced = buildExtractionPrompt({
      ...base,
      extractionPromptOverride: { mode: 'replace', text: '只提取地点变化。' }
    });
    expect(replaced).not.toContain('你是叙事状态提取器');
    expect(replaced).toContain('只提取地点变化');
    expect(replaced).toContain('当前分支状态');
    expect(replaced).toContain('我留在门边');
    expect(replaced).toContain('"schemaVersion":1');
  });

  it('converts compact type-and-args operations into strict domain operations', () => {
    const wire = {
      schemaVersion: 1,
      summary: '时间向前推进。',
      confidence: 0.95,
      evidence: [{ id: 'ev1', source: 'assistant', quote: '十分钟后', claim: '经过十分钟' }],
      operations: [{
        id: 'op1',
        type: 'advance_time',
        confidence: 0.95,
        evidenceIds: ['ev1'],
        args: { minutes: 10 }
      }],
      violations: []
    };

    const normalized = normalizeExtractionWire(wire);
    expect(validateExtractionResponse(normalized).valid).toBe(true);
    expect((normalized as { operations: Array<Record<string, unknown>> }).operations[0]).toMatchObject({
      type: 'advance_time',
      minutes: 10
    });
    expect((normalized as { operations: Array<Record<string, unknown>> }).operations[0]?.args).toBeUndefined();
  });

  it('normalizes relationship axis changes as first-class domain operations', () => {
    const wire = {
      schemaVersion: 1,
      summary: '角色明确增加了信任。',
      confidence: 0.9,
      evidence: [{ id: 'ev-axis', source: 'assistant', quote: '这次我信你。', claim: '信任提高' }],
      operations: [{
        id: 'op-axis',
        type: 'change_relationship_axis',
        confidence: 0.9,
        evidenceIds: ['ev-axis'],
        args: { pairId: 'hero_user', axis: 'trust', delta: 3 }
      }],
      violations: []
    };

    const normalized = normalizeExtractionWire(wire);
    expect(validateExtractionResponse(normalized).valid).toBe(true);
    expect((normalized as { operations: Array<Record<string, unknown>> }).operations[0]).toMatchObject({
      type: 'change_relationship_axis',
      pairId: 'hero_user',
      axis: 'trust',
      delta: 3
    });
  });

  it('normalizes common string values in relationship attitude operations', () => {
    const wire = {
      schemaVersion: 1,
      summary: '敏明结束交流并离开。',
      confidence: 0.8,
      evidence: [{ id: 'ev1', source: 'assistant', quote: '我要离开了', claim: '敏明拒绝继续交流' }],
      operations: [{
        id: 'op1',
        type: 'set_relationship_attitude',
        confidence: 0.8,
        evidenceIds: ['ev1'],
        args: {
          pairId: '白熊_敏明',
          fromCharacterId: '敏明',
          towardCharacterId: '白熊',
          stance: '敌对',
          wants: '拒绝交流并离开',
          secrets: ''
        }
      }],
      violations: []
    };

    const normalized = normalizeExtractionWire(wire);
    expect(validateExtractionResponse(normalized).valid).toBe(true);
    expect((normalized as { operations: Array<Record<string, unknown>> }).operations[0]).toMatchObject({
      stance: ['敌对'],
      wants: ['拒绝交流并离开'],
      secrets: []
    });
  });

  it('expands a compact fact string into the strict fact state', () => {
    const wire = {
      schemaVersion: 1,
      summary: '敏明说明了雀翎步舞的用途。',
      confidence: 0.9,
      evidence: [{ id: 'ev1', source: 'assistant', quote: '只是热身子的雀翎步儿舞', claim: '该舞用于热身' }],
      operations: [{
        id: 'op1',
        type: 'add_fact',
        confidence: 0.9,
        evidenceIds: ['ev1'],
        args: {
          factId: 'fact_peacock_dance',
          fact: '雀翎步儿舞在法轮学校用于热身。'
        }
      }],
      violations: []
    };

    const normalized = normalizeExtractionWire(wire);
    expect(validateExtractionResponse(normalized).valid).toBe(true);
    expect((normalized as { operations: Array<Record<string, unknown>> }).operations[0]).toMatchObject({
      fact: {
        truth: '雀翎步儿舞在法轮学校用于热身。',
        status: 'true',
        evidenceRefs: ['ev1']
      }
    });
  });

  it('converts a common Chinese absolute time into ISO 8601', () => {
    const wire = {
      schemaVersion: 1,
      summary: '时间被明确记录。',
      confidence: 0.9,
      evidence: [{ id: 'ev1', source: 'assistant', quote: '1922年2月10日 星期四 20:21', claim: '明确当前时间' }],
      operations: [{
        id: 'op1',
        type: 'set_time',
        confidence: 0.9,
        evidenceIds: ['ev1'],
        args: { absolute: '1922年2月10日 星期四 20:21' }
      }],
      violations: []
    };

    const normalized = normalizeExtractionWire(wire);
    expect(validateExtractionResponse(normalized).valid).toBe(true);
    expect((normalized as { operations: Array<Record<string, unknown>> }).operations[0]).toMatchObject({
      absolute: '1922-02-10T20:21:00Z'
    });
  });
});

describe('connection profile generation', () => {
  it('normalizes common strict-audit aliases and empty values', () => {
    expect(normalizeStrictAuditWire({
      audit: {
        status: 'PASS',
        accepted_operation_ids: 'op1',
        rejected_operation_ids: null,
        violations: null
      }
    })).toEqual({
      status: 'passed',
      acceptedOperationIds: ['op1'],
      rejectedOperationIds: [],
      violations: []
    });

    expect(normalizeStrictAuditWire({
      status: 'rejected',
      accepted: ['op1'],
      rejected: 'op2',
      violations: { op2: '证据不足。' }
    })).toEqual({
      status: 'failed',
      acceptedOperationIds: ['op1'],
      rejectedOperationIds: ['op2'],
      violations: [{
        code: 'op2',
        severity: 'error',
        message: '证据不足。',
        evidenceIds: []
      }]
    });
  });

  it('retries the same profile without a schema when structured decoding fails', async () => {
    const extraction = JSON.stringify({
      schemaVersion: 1,
      summary: '没有状态变化。',
      confidence: 0.95,
      evidence: [],
      operations: [],
      violations: []
    });
    const sendRequest = vi.fn()
      .mockRejectedValueOnce(new Error('structured content was fenced'))
      .mockResolvedValueOnce({ content: `\`\`\`json\n${extraction}\n\`\`\`` });
    const generateRaw = vi.fn(async () => extraction);
    const context = {
      eventSource: { on: vi.fn() },
      eventTypes: {},
      generateRaw,
      CONNECT_API_MAP: { custom: { selected: 'openai' } },
      ConnectionManagerRequestService: {
        getSupportedProfiles: () => [],
        getProfile: () => ({ id: 'profile-1', api: 'custom', model: 'model-1' }),
        sendRequest
      }
    } as unknown as SillyTavernContext;

    const result = await extractAndAuditTurn(context, {
      userText: '无变化。',
      assistantText: '无变化。',
      projection: createEmptyProjection('story-1'),
      candidates: [],
      auditMode: 'standard',
      responseTokens: 1000,
      extractorProfileId: 'profile-1',
      auditorProfileId: '',
      profileFallback: false
    });

    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(sendRequest.mock.calls[0]?.[4]).toHaveProperty('json_schema');
    expect(sendRequest.mock.calls[1]?.[4]).not.toHaveProperty('json_schema');
    expect(generateRaw).not.toHaveBeenCalled();
    expect(result.auditStatus).toBe('passed');
  });

  it('retries the same profile without a schema when structured decoding returns an empty object', async () => {
    const extraction = JSON.stringify({
      schemaVersion: 1,
      summary: '没有状态变化。',
      confidence: 0.95,
      evidence: [],
      operations: [],
      violations: []
    });
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({ content: {} })
      .mockResolvedValueOnce({ content: extraction });
    const context = {
      eventSource: { on: vi.fn() },
      eventTypes: {},
      generateRaw: vi.fn(),
      CONNECT_API_MAP: { custom: { selected: 'openai' } },
      ConnectionManagerRequestService: {
        getSupportedProfiles: () => [],
        getProfile: () => ({ id: 'profile-1', api: 'custom', model: 'model-1' }),
        sendRequest
      }
    } as unknown as SillyTavernContext;

    const result = await extractAndAuditTurn(context, {
      userText: '无变化。',
      assistantText: '无变化。',
      projection: createEmptyProjection('story-1'),
      candidates: [],
      auditMode: 'standard',
      responseTokens: 1000,
      extractorProfileId: 'profile-1',
      auditorProfileId: '',
      profileFallback: false
    });

    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(sendRequest.mock.calls[0]?.[4]).toHaveProperty('json_schema');
    expect(sendRequest.mock.calls[1]?.[4]).not.toHaveProperty('json_schema');
    expect(result.auditStatus).toBe('passed');
  });

  it('uses independent extractor and auditor profiles in strict mode', async () => {
    const extraction = JSON.stringify({
      schemaVersion: 1,
      summary: '没有状态变化。',
      confidence: 0.95,
      evidence: [],
      operations: [],
      violations: []
    });
    const audit = JSON.stringify({
      status: 'passed',
      acceptedOperationIds: [],
      rejectedOperationIds: [],
      violations: []
    });
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({ content: extraction })
      .mockResolvedValueOnce({ content: audit });
    const generateRaw = vi.fn(async () => extraction);
    const context = {
      eventSource: { on: vi.fn() },
      eventTypes: {},
      generateRaw,
      CONNECT_API_MAP: { custom: { selected: 'openai' } },
      ConnectionManagerRequestService: {
        getSupportedProfiles: () => [],
        getProfile: (id: string) => ({ id, api: 'custom', model: id }),
        sendRequest
      }
    } as unknown as SillyTavernContext;

    const result = await extractAndAuditTurn(context, {
      userText: '我没有行动。',
      assistantText: '她没有回应。',
      projection: createEmptyProjection('story-1'),
      candidates: [],
      auditMode: 'strict',
      responseTokens: 1000,
      extractorProfileId: 'extractor-profile',
      auditorProfileId: 'auditor-profile',
      profileFallback: false
    });

    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(sendRequest.mock.calls.map(call => call[0])).toEqual(['extractor-profile', 'auditor-profile']);
    expect(generateRaw).not.toHaveBeenCalled();
    expect(result.auditStatus).toBe('passed');
    expect(result.model).toBe('auditor-profile');
  });

  it('drops a planned activity and invented one-minute advance before strict audit', async () => {
    const assistantText = '我接下来会先确认水位的上涨速度，评估这个候船棚还能支撑多久。';
    const extraction = JSON.stringify({
      schemaVersion: 1,
      summary: '角色说明了下一步计划。',
      confidence: 0.9,
      evidence: [{ id: 'ev-plan', source: 'assistant', quote: assistantText, claim: '这是尚未执行的计划' }],
      operations: [
        {
          id: 'op-time',
          type: 'advance_time',
          confidence: 0.8,
          evidenceIds: ['ev-plan'],
          minutes: 1
        },
        {
          id: 'op-activity',
          type: 'set_character_state',
          confidence: 0.9,
          evidenceIds: ['ev-plan'],
          characterId: 'lin-yan',
          field: 'activity',
          value: '计划评估水位上涨速度'
        }
      ],
      violations: []
    });
    const audit = JSON.stringify({
      status: 'passed',
      acceptedOperationIds: [],
      rejectedOperationIds: [],
      violations: []
    });
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({ content: extraction })
      .mockResolvedValueOnce({ content: audit });
    const context = {
      eventSource: { on: vi.fn() },
      eventTypes: {},
      CONNECT_API_MAP: { custom: { selected: 'openai' } },
      ConnectionManagerRequestService: {
        getSupportedProfiles: () => [],
        getProfile: (id: string) => ({ id, api: 'custom', model: id }),
        sendRequest
      }
    } as unknown as SillyTavernContext;

    const result = await extractAndAuditTurn(context, {
      userText: '你接下来准备做什么？',
      assistantText,
      responderCharacterId: 'lin-yan',
      projection: createEmptyProjection('story-1'),
      candidates: [],
      auditMode: 'strict',
      responseTokens: 1000,
      extractorProfileId: 'extractor-profile',
      auditorProfileId: 'auditor-profile',
      profileFallback: false
    });

    expect(result.response.operations).toEqual([]);
    expect(result.response.violations.filter(item => item.code === 'local_semantic_guard_dropped_operation')).toHaveLength(2);
    expect(result.auditStatus).toBe('passed');
    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(sendRequest.mock.calls[1]?.[1]?.[1]?.content).toContain('绝不能默认每轮推进 1 分钟');
  });

  it('drops knowledge changes that reference an unknown fact before strict audit', async () => {
    const assistantText = '第一章页边唯一明确不同的是校准编号。';
    const extraction = JSON.stringify({
      schemaVersion: 1,
      summary: '角色复述了当前记录。',
      confidence: 0.9,
      evidence: [{ id: 'ev-static', source: 'assistant', quote: assistantText, claim: '复述当前可见事实' }],
      operations: [{
        id: 'op-knowledge',
        type: 'set_knowledge',
        confidence: 0.9,
        evidenceIds: ['ev-static'],
        characterId: 'user_role',
        factId: 'model_invented_fact',
        state: 'knows',
        perceivedTruth: assistantText
      }],
      violations: []
    });
    const audit = JSON.stringify({
      status: 'passed',
      acceptedOperationIds: [],
      rejectedOperationIds: [],
      violations: []
    });
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({ content: extraction })
      .mockResolvedValueOnce({ content: audit });
    const context = {
      eventSource: { on: vi.fn() },
      eventTypes: {},
      CONNECT_API_MAP: { custom: { selected: 'openai' } },
      ConnectionManagerRequestService: {
        getSupportedProfiles: () => [],
        getProfile: (id: string) => ({ id, api: 'custom', model: id }),
        sendRequest
      }
    } as unknown as SillyTavernContext;

    const result = await extractAndAuditTurn(context, {
      userText: '再确认一次。',
      assistantText,
      userRoleId: 'user_role',
      projection: createEmptyProjection('story-1'),
      candidates: [],
      auditMode: 'strict',
      responseTokens: 1000,
      extractorProfileId: 'extractor-profile',
      auditorProfileId: 'auditor-profile',
      profileFallback: false
    });

    expect(result.response.operations).toEqual([]);
    expect(result.response.violations).toContainEqual(expect.objectContaining({
      code: 'local_semantic_guard_dropped_operation',
      message: expect.stringContaining('知识变化不能引用尚未登记的事实')
    }));
    expect(result.auditStatus).toBe('passed');
    expect(sendRequest).toHaveBeenCalledTimes(2);
    const auditPrompt = String(sendRequest.mock.calls[1]?.[1]?.[1]?.content ?? '');
    expect(auditPrompt).toContain('A static answer that only restates currently visible source material');
    expect(auditPrompt).not.toContain('local_semantic_guard_dropped_operation');
  });

  it('treats a numbered-chapter source verification as a no-change turn', async () => {
    const assistantText = '页边不一致的是校准编号。';
    const extraction = JSON.stringify({
      schemaVersion: 1,
      summary: '复核第一章当前可见记录。',
      confidence: 0.95,
      evidence: [{ id: 'ev1', source: 'assistant', quote: assistantText, claim: '页边不一致的是校准编号' }],
      operations: [
        {
          id: 'op1',
          type: 'add_fact',
          confidence: 0.95,
          evidenceIds: ['ev1'],
          factId: 'margin_inconsistency_is_calibration_number',
          fact: { truth: assistantText, status: 'true', evidenceRefs: ['ev1'] }
        },
        {
          id: 'op2',
          type: 'set_knowledge',
          confidence: 0.95,
          evidenceIds: ['ev1'],
          characterId: 'user_role',
          factId: 'margin_inconsistency_is_calibration_number',
          state: 'knows',
          perceivedTruth: assistantText
        }
      ],
      violations: []
    });
    const audit = JSON.stringify({
      status: 'passed',
      acceptedOperationIds: [],
      rejectedOperationIds: [],
      violations: []
    });
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({ content: extraction })
      .mockResolvedValueOnce({ content: audit });
    const context = {
      eventSource: { on: vi.fn() },
      eventTypes: {},
      CONNECT_API_MAP: { custom: { selected: 'openai' } },
      ConnectionManagerRequestService: {
        getSupportedProfiles: () => [],
        getProfile: (id: string) => ({ id, api: 'custom', model: id }),
        sendRequest
      }
    } as unknown as SillyTavernContext;

    const result = await extractAndAuditTurn(context, {
      userText: '正式验收：只根据第一章当前记录回答，不提第二章。',
      assistantText,
      userRoleId: 'user_role',
      projection: createEmptyProjection('story-1'),
      candidates: [],
      auditMode: 'strict',
      responseTokens: 1000,
      extractorProfileId: 'extractor-profile',
      auditorProfileId: 'auditor-profile',
      profileFallback: false
    });

    expect(result.response.operations).toEqual([]);
    expect(result.response.violations.filter(item => item.code === 'local_semantic_guard_dropped_operation')).toHaveLength(2);
    expect(result.response.violations.every(item => item.severity === 'info')).toBe(true);
    expect(result.auditStatus).toBe('passed');
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it('does not advance time for a static description with no elapsed duration', async () => {
    const assistantText = '眼下最直接的危险是外江暴流导致水位正在快速上涨，随时会淹没我们的立足点。';
    const extraction = JSON.stringify({
      schemaVersion: 1,
      summary: '角色描述了当前危险。',
      confidence: 0.9,
      evidence: [{ id: 'ev-static', source: 'assistant', quote: assistantText, claim: '描述当前水位危险' }],
      operations: [{
        id: 'op-time',
        type: 'advance_time',
        confidence: 0.8,
        evidenceIds: ['ev-static'],
        minutes: 1
      }],
      violations: []
    });
    const audit = JSON.stringify({
      status: 'passed',
      acceptedOperationIds: [],
      rejectedOperationIds: [],
      violations: []
    });
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({ content: extraction })
      .mockResolvedValueOnce({ content: audit });
    const context = {
      eventSource: { on: vi.fn() },
      eventTypes: {},
      CONNECT_API_MAP: { custom: { selected: 'openai' } },
      ConnectionManagerRequestService: {
        getSupportedProfiles: () => [],
        getProfile: (id: string) => ({ id, api: 'custom', model: id }),
        sendRequest
      }
    } as unknown as SillyTavernContext;

    const result = await extractAndAuditTurn(context, {
      userText: '眼下最直接的危险是什么？',
      assistantText,
      responderCharacterId: 'lin-yan',
      projection: createEmptyProjection('story-1'),
      candidates: [],
      auditMode: 'strict',
      responseTokens: 1000,
      extractorProfileId: 'extractor-profile',
      auditorProfileId: 'auditor-profile',
      profileFallback: false
    });

    expect(result.response.operations).toEqual([]);
    expect(result.response.violations).toContainEqual(expect.objectContaining({
      code: 'local_semantic_guard_dropped_operation',
      evidenceIds: ['ev-static']
    }));
    expect(result.auditStatus).toBe('passed');
  });

  it('keeps a matching explicit duration after a completed action', async () => {
    const assistantText = '我已经检查了十分钟，水位还在上涨。';
    const extraction = JSON.stringify({
      schemaVersion: 1,
      summary: '检查持续了十分钟。',
      confidence: 0.95,
      evidence: [{ id: 'ev-time', source: 'assistant', quote: '已经检查了十分钟', claim: '检查已持续十分钟' }],
      operations: [{
        id: 'op-time',
        type: 'advance_time',
        confidence: 0.95,
        evidenceIds: ['ev-time'],
        minutes: 10
      }],
      violations: []
    });
    const context = {
      eventSource: { on: vi.fn() },
      eventTypes: {},
      generateRaw: vi.fn(async () => extraction)
    } as unknown as SillyTavernContext;

    const result = await extractAndAuditTurn(context, {
      userText: '检查得怎么样？',
      assistantText,
      projection: createEmptyProjection('story-1'),
      candidates: [],
      auditMode: 'standard',
      responseTokens: 1000,
      extractorProfileId: '',
      auditorProfileId: '',
      profileFallback: true
    });

    expect(result.response.operations).toEqual([expect.objectContaining({ type: 'advance_time', minutes: 10 })]);
    expect(result.auditStatus).toBe('passed');
  });

  it('falls back to the current API connection when a profile fails', async () => {
    const extraction = JSON.stringify({
      schemaVersion: 1,
      summary: '没有状态变化。',
      confidence: 0.9,
      evidence: [],
      operations: [],
      violations: []
    });
    const generateRaw = vi.fn(async () => extraction);
    const context = {
      eventSource: { on: vi.fn() },
      eventTypes: {},
      generateRaw,
      ConnectionManagerRequestService: {
        getSupportedProfiles: () => [],
        getProfile: () => ({ id: 'missing', api: 'custom' }),
        sendRequest: vi.fn(async () => { throw new Error('offline'); })
      }
    } as unknown as SillyTavernContext;

    const result = await extractAndAuditTurn(context, {
      userText: '无变化。',
      assistantText: '无变化。',
      projection: createEmptyProjection('story-1'),
      candidates: [],
      auditMode: 'standard',
      responseTokens: 1000,
      extractorProfileId: 'missing',
      auditorProfileId: '',
      profileFallback: true
    });

    expect(generateRaw).toHaveBeenCalledTimes(1);
    expect(result.auditStatus).toBe('passed');
  });

  it('does not use the current connection when profile fallback is disabled', async () => {
    const generateRaw = vi.fn(async () => '{"schemaVersion":1}');
    const context = {
      eventSource: { on: vi.fn() },
      eventTypes: {},
      generateRaw,
      ConnectionManagerRequestService: {
        getSupportedProfiles: () => [],
        getProfile: () => null,
        sendRequest: vi.fn()
      }
    } as unknown as SillyTavernContext;

    await expect(extractAndAuditTurn(context, {
      userText: '无变化。',
      assistantText: '无变化。',
      projection: createEmptyProjection('story-1'),
      candidates: [],
      auditMode: 'standard',
      responseTokens: 1000,
      extractorProfileId: 'missing-profile',
      auditorProfileId: '',
      profileFallback: false
    })).rejects.toThrow('Connection Profile 不存在：missing-profile');

    expect(generateRaw).not.toHaveBeenCalled();
  });

  it('marks successful extraction as unreviewed when audit is disabled', async () => {
    const extraction = JSON.stringify({
      schemaVersion: 1,
      summary: '没有状态变化。',
      confidence: 0.9,
      evidence: [],
      operations: [],
      violations: []
    });
    const context = {
      eventSource: { on: vi.fn() },
      eventTypes: {},
      generateRaw: vi.fn(async () => extraction)
    } as unknown as SillyTavernContext;

    const result = await extractAndAuditTurn(context, {
      userText: '无变化。',
      assistantText: '无变化。',
      projection: createEmptyProjection('story-1'),
      candidates: [],
      auditMode: 'off',
      responseTokens: 1000,
      extractorProfileId: '',
      auditorProfileId: '',
      profileFallback: true
    });

    expect(result.auditStatus).toBe('unreviewed');
  });

  it('quarantines an invalid operation after retries instead of discarding the whole turn', async () => {
    const invalidExtraction = JSON.stringify({
      schemaVersion: 1,
      summary: '模型识别到一项无法安全落库的变化。',
      confidence: 0.7,
      evidence: [{ id: 'ev1', source: 'assistant', quote: '她后退了一步', claim: '人物位置有所变化' }],
      operations: [{
        id: 'bad-op',
        type: 'move_character',
        confidence: 0.7,
        evidenceIds: ['ev1'],
        characterId: 'hero'
      }],
      violations: []
    });
    const generateRaw = vi.fn(async () => invalidExtraction);
    const context = {
      eventSource: { on: vi.fn() },
      eventTypes: {},
      generateRaw
    } as unknown as SillyTavernContext;

    const result = await extractAndAuditTurn(context, {
      userText: '你要去哪里？',
      assistantText: '她后退了一步。',
      projection: createEmptyProjection('story-1'),
      candidates: [],
      auditMode: 'standard',
      responseTokens: 1000,
      extractorProfileId: '',
      auditorProfileId: '',
      profileFallback: true
    });

    expect(generateRaw).toHaveBeenCalledTimes(3);
    expect(result.response.operations).toEqual([]);
    expect(result.response.violations[0]?.code).toBe('invalid_extractor_operation_dropped');
    expect(result.response.violations[0]?.severity).toBe('info');
    expect(result.auditStatus).toBe('passed');
  });

  it('keeps a valid extraction as failed when the independent auditor cannot return valid JSON', async () => {
    const extraction = JSON.stringify({
      schemaVersion: 1,
      summary: '没有状态变化。',
      confidence: 0.95,
      evidence: [],
      operations: [],
      violations: []
    });
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({ content: extraction })
      .mockResolvedValue({ content: 'not json' });
    const context = {
      eventSource: { on: vi.fn() },
      eventTypes: {},
      CONNECT_API_MAP: { custom: { selected: 'openai' } },
      ConnectionManagerRequestService: {
        getSupportedProfiles: () => [],
        getProfile: (id: string) => ({ id, api: 'custom', model: id }),
        sendRequest
      }
    } as unknown as SillyTavernContext;

    const result = await extractAndAuditTurn(context, {
      userText: '我没有行动。',
      assistantText: '她没有回应。',
      projection: createEmptyProjection('story-1'),
      candidates: [],
      auditMode: 'strict',
      responseTokens: 1000,
      extractorProfileId: 'extractor-profile',
      auditorProfileId: 'auditor-profile',
      profileFallback: false
    });

    expect(sendRequest).toHaveBeenCalledTimes(4);
    expect(result.response.violations[0]?.code).toBe('strict_audit_unavailable');
    expect(result.auditStatus).toBe('failed');
  });
});
