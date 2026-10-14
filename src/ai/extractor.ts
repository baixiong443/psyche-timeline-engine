import { applyOperations } from '../engine/reducer';
import type {
  AuditMode,
  AuditViolation,
  ExtractionResponse,
  SchedulerCandidate,
  StoryProjection
} from '../model/types';
import {
  applyPromptOverride,
  MATURE_CONTENT_ANALYSIS_RULES,
  type PromptOverride
} from '../model/promptCustomization';
import { validateDomainOperations, validateExtractionResponse } from '../schema/validators';
import { stableJson } from '../utils/hash';
import type { GenerateRawOptions, SillyTavernContext } from '../runtime/context';
import { EXTRACTION_GENERATION_SCHEMA, STRICT_AUDIT_GENERATION_SCHEMA } from './schemas';

export interface ExtractionInput {
  userText: string;
  assistantText: string;
  userRoleId?: string;
  responderCharacterId?: string | null;
  projection: StoryProjection;
  candidates: SchedulerCandidate[];
  auditMode: AuditMode;
  responseTokens: number;
  extractorProfileId: string;
  auditorProfileId: string;
  profileFallback: boolean;
  extractionPromptOverride?: PromptOverride;
  auditPromptOverride?: PromptOverride;
}

export interface ExtractionRunResult {
  response: ExtractionResponse;
  auditStatus: 'unreviewed' | 'passed' | 'warning' | 'failed';
  model: string | null;
}

interface StrictAuditResponse {
  status: 'passed' | 'warning' | 'failed';
  acceptedOperationIds: string[];
  rejectedOperationIds: string[];
  violations: AuditViolation[];
}

function boundedText(value: string, maxChars = 24_000): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[文本因长度限制截断]`;
}

function parseJsonObject(raw: string): unknown {
  const trimmed = String(raw ?? '').trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error('模型没有返回可解析的 JSON 对象。');
  }
}

export function buildExtractionPrompt(input: ExtractionInput): string {
  const anchors = input.candidates.map(candidate => ({
    id: candidate.event.id,
    summary: candidate.event.summary,
    narrativePurposes: candidate.event.narrativePurposes
  }));
  const instructions = applyPromptOverride([
    '你是叙事状态提取器。只分析本轮用户消息和角色回复实际造成的状态变化。',
    '不要续写剧情，不要根据原作预期伪造已经发生的事件，不要把语气或修辞当成客观事实。',
    '计划、意图、预测、假设和尚未执行的未来动作都不是已完成的状态变化；“接下来”“准备”“打算”“将要”“会先”等表述不得产生 operation。',
    '静态说明当前已经知道的事实不会自动消耗时间。advance_time 只能在原文明确说明一段可量化时长已经过去，或明确说明一个已完成动作持续了多久时使用；不得因为出现一轮回复就默认推进 1 分钟。',
    'set_character_state 的 activity 只记录本轮已经开始或已经改变的当前活动，不得把计划、准备事项或下一步行动写入 activity。没有实际变化时必须返回 operations=[]。',
    '每项 operation 必须由 evidence 中的原文短引文支持，confidence 范围为 0 到 1。',
    '知识状态按角色分别记录；角色不知道的事实不能标为 knows。错误认知使用 believes_false，并填写 perceivedTruth。',
    'A meta-level source verification request (for example, asking to check the original text or a numbered chapter) is not an in-world disclosure. If the reply only restates that visible source material, return operations=[] instead of add_fact or set_knowledge.',
    'projection.lockedPaths 中的字段不可修改，不要为这些路径提出 operation。',
    '关系数值轴只有在本轮文本或明确状态栏提供了可核对的数值变化时才能使用 change_relationship_axis；不得仅凭语气、动作或主观印象猜测好感度。',
    '只有本轮实际结果改变了后续原作事件的因果可达性，才能使用 set_divergence。参考尺度：0=仍兼容原作，0.25=局部变化，0.5=故事弧明显分叉，0.75=主要结构改变，1=已无法与原作主线统一。普通措辞差异不算分叉。',
    '只有回复中确实发生了对应事件，才能推进 canon event；候选锚点不是已发生事实。',
    '事件首次进入 completed_canonical 时，PTE 会自动应用 StoryEvent.effects；不要在本轮 operations 中重复输出这些原作效果。completed_adapted 不会自动应用原作效果，必须只记录聊天中真实发生的变化。两种完成状态都会自动履行该事件仍为 pending 的 narrativePurposes。',
    '严格遵守候选事件 adaptation：allowDelay=false 时不得标记 delayed；allowRelocation 与 allowSubstitution 都为 false 时不得标记 completed_adapted。',
    '没有可靠变化时返回空 operations。summary、claim、message 使用中文。',
    ...MATURE_CONTENT_ANALYSIS_RULES,
  ], input.extractionPromptOverride ?? { mode: 'builtin', text: '' });
  return [
    ...instructions,
    '即使服务端不支持结构化输出，也必须只返回下列扁平 JSON 协议，不得使用 apply、turn、message 或其他旧格式字段：',
    '{"schemaVersion":1,"summary":"本轮摘要","confidence":0.9,"evidence":[{"id":"ev1","source":"assistant","quote":"原文短引文","claim":"该引文支持的事实"}],"operations":[{"id":"op1","type":"advance_time","confidence":0.9,"evidenceIds":["ev1"],"args":{"minutes":5}}],"violations":[]}',
    'operation 的业务参数全部放在 args：advance_time=>minutes；set_time=>absolute（必须是 ISO 8601，例如 1922-02-10T20:21:00Z）；move_location=>location；set_character_presence=>characterId,present；set_character_state=>characterId,field,value；add_fact=>factId,fact{truth,status,evidenceRefs}；set_knowledge=>characterId,factId,state,perceivedTruth；set_relationship_stage=>pairId,stage；set_relationship_attitude=>pairId,fromCharacterId,towardCharacterId,stance[],wants[],secrets[]（后三项是字符串数组）；change_relationship_axis=>pairId,axis,delta；change_inventory=>itemId,delta,description,ownerId；set_divergence=>structuralLevel,summary；set_flag=>flag,value；open_thread=>threadId,title；resolve_thread=>threadId,status；transition_canon_event=>eventId,status；set_narrative_purpose=>purposeId,status。',
    '',
    '当前分支状态：',
    boundedText(stableJson(input.projection)),
    '',
    '仍然有效的附近原作锚点（仅供核对，不代表已发生）：',
    stableJson(anchors),
    '',
    '用户消息：',
    boundedText(input.userText),
    '',
    '角色回复：',
    boundedText(input.assistantText),
    '',
    `当前用户故事角色 ID：${input.userRoleId ?? '未绑定'}`,
    `当前回复角色 ID：${input.responderCharacterId ?? '无法可靠识别'}`
  ].join('\n');
}

async function generateWithRetry(
  context: SillyTavernContext,
  options: GenerateRawOptions,
  validate: (value: unknown) => string[],
  attempts = 3,
  normalize: (value: unknown) => unknown = value => value,
  profileId = '',
  profileFallback = true,
  recover?: (value: unknown, errors: string[]) => unknown | null
): Promise<unknown> {
  let lastError = '未知错误';
  let previousRaw = '';
  let previousParsed: unknown = null;
  let previousErrors: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const prompt = attempt === 1
        ? options.prompt
        : `${String(options.prompt)}\n\n上一次输出无效：${lastError}\n上一次输出：${boundedText(previousRaw, 8000)}\n请重新输出完整、严格符合 Schema 的 JSON。`;
      const raw = await generateText(context, {
        ...options,
        prompt,
        jsonSchema: attempt === 1 ? options.jsonSchema : null
      }, profileId, profileFallback);
      previousRaw = raw;
      const parsed = normalize(parseJsonObject(raw));
      const errors = validate(parsed);
      if (errors.length === 0) return parsed;
      previousParsed = parsed;
      previousErrors = errors;
      lastError = errors.join('; ');
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  const recovered = recover?.(previousParsed, previousErrors);
  if (recovered !== null && recovered !== undefined) {
    const errors = validate(recovered);
    if (errors.length === 0) return recovered;
    lastError = errors.join('; ');
  }

  throw new Error(`AI 状态提取连续失败：${lastError}`);
}

export async function generateText(
  context: SillyTavernContext,
  options: GenerateRawOptions,
  profileId: string,
  profileFallback: boolean
): Promise<string> {
  if (profileId) {
    try {
      const service = context.ConnectionManagerRequestService;
      if (!service) throw new Error('SillyTavern Connection Manager 不可用。');
      const profile = service.getProfile(profileId);
      if (!profile) throw new Error(`Connection Profile 不存在：${profileId}`);
      const messages = [
        ...(options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
        ...(Array.isArray(options.prompt) ? options.prompt : [{ role: 'user', content: options.prompt }])
      ];
      const apiKind = profile.api ? context.CONNECT_API_MAP?.[profile.api]?.selected : undefined;
      const schema = options.jsonSchema
        ? apiKind === 'textgenerationwebui' ? options.jsonSchema.value : options.jsonSchema
        : undefined;
      const requestOptions = { extractData: true, includePreset: true, includeInstruct: true, stream: false };
      const deterministicPayload = {
        temperature: 0.1,
        top_p: 0.2,
        presence_penalty: 0,
        frequency_penalty: 0
      };
      let response;
      const retryWithoutSchema = () => service.sendRequest(
        profileId,
        messages,
        options.responseLength ?? 1800,
        requestOptions,
        deterministicPayload
      );
      try {
        response = await service.sendRequest(
          profileId,
          messages,
          options.responseLength ?? 1800,
          requestOptions,
          { ...deterministicPayload, ...(schema ? { json_schema: schema } : {}) }
        );
      } catch (error) {
        if (!schema) throw error;
        console.warn('[Psyche Timeline Engine] Structured profile response could not be decoded; retrying the same profile without a schema.');
        response = await retryWithoutSchema();
      }
      if (typeof response === 'function') throw new Error('Connection Profile 返回了意外的流式响应。');
      if (schema && isEmptyStructuredContent(response?.content)) {
        console.warn('[Psyche Timeline Engine] Structured profile response was empty; retrying the same profile without a schema.');
        response = await retryWithoutSchema();
      }
      if (typeof response === 'function') throw new Error('Connection Profile 返回了意外的流式响应。');
      const content = response?.content;
      if (typeof content === 'string') return content;
      if (content && typeof content === 'object') return JSON.stringify(content);
      throw new Error('Connection Profile 没有返回文本内容。');
    } catch (error) {
      if (!profileFallback) throw error;
      console.warn('[Psyche Timeline Engine] Connection Profile failed; using current API connection.', error);
    }
  }

  prepareDeterministicGeneration(context);
  return context.generateRaw(options);
}

function isEmptyStructuredContent(content: unknown): boolean {
  if (Array.isArray(content)) return content.length === 0;
  if (content && typeof content === 'object') return Object.keys(content).length === 0;
  if (typeof content !== 'string') return false;
  const text = content.trim();
  if (!text) return true;
  try {
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    return (Array.isArray(parsed) && parsed.length === 0)
      || (!!parsed && typeof parsed === 'object' && Object.keys(parsed).length === 0);
  } catch {
    return false;
  }
}

function prepareDeterministicGeneration(context: SillyTavernContext): void {
  const eventName = context.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
  if (!eventName || !context.eventSource.once) return;
  context.eventSource.once(eventName, (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const settings = value as Record<string, unknown>;
    settings.temperature = 0.1;
    settings.top_p = 0.2;
    settings.presence_penalty = 0;
    settings.frequency_penalty = 0;
  });
}

export function normalizeExtractionWire(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const response = structuredClone(value) as Record<string, unknown>;
  if (!Array.isArray(response.operations)) return response;
  response.operations = response.operations.map(candidate => {
    if (!candidate || typeof candidate !== 'object') return candidate;
    const operation = candidate as Record<string, unknown>;
    const args = operation.args;
    const normalized = args && typeof args === 'object' && !Array.isArray(args)
      ? (() => {
          const { args: _discard, ...base } = operation;
          return { ...base, ...args as Record<string, unknown> };
        })()
      : { ...operation };

    if (normalized.type === 'set_relationship_attitude') {
      for (const field of ['stance', 'wants', 'secrets']) {
        const item = normalized[field];
        if (typeof item !== 'string') continue;
        const text = item.trim();
        normalized[field] = text ? [text] : [];
      }
    }

    if (normalized.type === 'set_time' && typeof normalized.absolute === 'string') {
      normalized.absolute = normalizeAbsoluteTime(normalized.absolute);
    }

    if (normalized.type === 'add_fact' && typeof normalized.fact === 'string') {
      normalized.fact = {
        truth: normalized.fact,
        status: 'true',
        evidenceRefs: Array.isArray(normalized.evidenceIds) ? [...normalized.evidenceIds] : []
      };
    }

    return normalized;
  });
  return response;
}

function normalizeAbsoluteTime(value: string): string {
  const trimmed = value.trim();
  if (!Number.isNaN(Date.parse(trimmed))) return trimmed;
  const match = trimmed.match(
    /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*星期[一二三四五六日天])?\s*(?:(上午|下午|晚上|凌晨|中午)\s*)?(\d{1,2})(?::|：|时)(\d{1,2})?(?:分)?/
  );
  if (!match) return trimmed;
  const [, yearText, monthText, dayText, period, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (['下午', '晚上', '中午'].includes(period ?? '') && hour < 12) hour += 12;
  if (period === '凌晨' && hour === 12) hour = 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return trimmed;
  const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  if (
    timestamp.getUTCFullYear() !== year
    || timestamp.getUTCMonth() !== month - 1
    || timestamp.getUTCDate() !== day
  ) return trimmed;
  return timestamp.toISOString().replace('.000Z', 'Z');
}

function extractionValidation(value: unknown): string[] {
  return validateExtractionResponse(value).errors.slice(0, 20);
}

function recoverExtractionResponse(value: unknown, errors: string[]): ExtractionResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = structuredClone(value) as Record<string, unknown>;
  if (!Array.isArray(response.operations) || !Array.isArray(response.violations)) return null;

  const operations: ExtractionResponse['operations'] = [];
  const droppedIds: string[] = [];
  const evidenceIds = new Set<string>();
  for (const candidate of response.operations) {
    const validation = validateDomainOperations([candidate]);
    if (validation.valid && validation.value?.[0]) {
      operations.push(validation.value[0]);
      continue;
    }
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const item = candidate as Record<string, unknown>;
      if (typeof item.id === 'string') droppedIds.push(item.id);
      if (Array.isArray(item.evidenceIds)) {
        for (const id of item.evidenceIds) if (typeof id === 'string') evidenceIds.add(id);
      }
    }
  }
  if (operations.length === response.operations.length) return null;

  response.operations = operations;
  response.violations = [
    ...response.violations,
    {
      code: 'invalid_extractor_operation_dropped',
      severity: 'info',
      message: `提取模型连续返回无效操作，已隔离 ${droppedIds.join('、') || '未命名操作'}。${errors[0] ? ` ${errors[0]}` : ''}`,
      evidenceIds: [...evidenceIds]
    }
  ];
  const validation = validateExtractionResponse(response);
  return validation.valid && validation.value ? validation.value : null;
}

function structuredSchema(name: string, value: Record<string, unknown>) {
  return {
    name,
    value,
    strict: true,
    returnInvalid: true
  };
}

function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function normalizeIdList(value: unknown): unknown {
  if (value === null || value === undefined) return [];
  const candidates = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，\n]/)
      : value;
  if (!Array.isArray(candidates)) return candidates;
  return [...new Set(candidates.map(candidate => {
    if (typeof candidate === 'string') return candidate.trim();
    if (candidate && typeof candidate === 'object') {
      const item = candidate as Record<string, unknown>;
      const id = item.id ?? item.operationId ?? item.operation_id;
      return typeof id === 'string' ? id.trim() : '';
    }
    return '';
  }).filter(Boolean))];
}

function normalizeAuditStatus(value: unknown): StrictAuditResponse['status'] | null {
  const status = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['passed', 'pass', 'approved', 'accepted', 'ok', 'success', 'clean', '通过', '合格'].includes(status)) {
    return 'passed';
  }
  if (['warning', 'warn', 'needs_review', 'review', 'caution', '需留意', '警告'].includes(status)) {
    return 'warning';
  }
  if (['failed', 'fail', 'rejected', 'reject', 'error', 'invalid', '不通过', '失败'].includes(status)) {
    return 'failed';
  }
  return null;
}

function normalizeViolationSeverity(value: unknown, fallback: AuditViolation['severity']): AuditViolation['severity'] {
  const severity = String(value ?? '').trim().toLowerCase();
  if (['error', 'fatal', 'failed', 'high', '错误', '严重'].includes(severity)) return 'error';
  if (['warning', 'warn', 'medium', '警告'].includes(severity)) return 'warning';
  if (['info', 'note', 'low', '提示'].includes(severity)) return 'info';
  return fallback;
}

function normalizeViolation(
  value: unknown,
  fallbackSeverity: AuditViolation['severity'],
  fallbackCode = 'strict_audit_violation'
): AuditViolation | null {
  if (typeof value === 'string') {
    const message = value.trim();
    if (!message || ['none', 'null', '[]', '无', '没有', '无问题', 'no issues', 'no violations'].includes(message.toLowerCase())) {
      return null;
    }
    return { code: fallbackCode, severity: fallbackSeverity, message, evidenceIds: [] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length === 0) return null;
  const messageValue = firstDefined(item, ['message', 'reason', 'description', 'detail', 'claim']);
  const message = typeof messageValue === 'string' && messageValue.trim()
    ? messageValue.trim()
    : '第二层审计发现了需要复核的问题。';
  const codeValue = firstDefined(item, ['code', 'type', 'id']);
  const code = typeof codeValue === 'string' && codeValue.trim() ? codeValue.trim() : fallbackCode;
  const evidenceIds = normalizeIdList(firstDefined(item, ['evidenceIds', 'evidence_ids', 'references']));
  return {
    code,
    severity: normalizeViolationSeverity(item.severity, fallbackSeverity),
    message,
    evidenceIds: Array.isArray(evidenceIds) ? evidenceIds as string[] : []
  };
}

function normalizeViolations(
  value: unknown,
  fallbackSeverity: AuditViolation['severity']
): AuditViolation[] | unknown {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map(item => normalizeViolation(item, fallbackSeverity)).filter((item): item is AuditViolation => item !== null);
  }
  if (typeof value === 'string') {
    const violation = normalizeViolation(value, fallbackSeverity);
    return violation ? [violation] : [];
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 0) return [];
  if (['code', 'severity', 'message', 'reason', 'description', 'detail', 'claim'].some(key => key in record)) {
    const violation = normalizeViolation(record, fallbackSeverity);
    return violation ? [violation] : [];
  }
  return Object.entries(record)
    .map(([code, item]) => normalizeViolation(
      item && typeof item === 'object' && !Array.isArray(item) ? { code, ...item as Record<string, unknown> } : item,
      fallbackSeverity,
      code
    ))
    .filter((item): item is AuditViolation => item !== null);
}

export function normalizeStrictAuditWire(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  let source = structuredClone(value) as Record<string, unknown>;
  if (source.status === undefined) {
    const wrapped = firstDefined(source, ['audit', 'review', 'result', 'data']);
    if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
      source = wrapped as Record<string, unknown>;
    }
  }

  const acceptedOperationIds = normalizeIdList(firstDefined(source, [
    'acceptedOperationIds', 'accepted_operation_ids', 'approvedOperationIds', 'accepted', 'approved'
  ]));
  const rejectedOperationIds = normalizeIdList(firstDefined(source, [
    'rejectedOperationIds', 'rejected_operation_ids', 'deniedOperationIds', 'rejected', 'denied'
  ]));
  let status = normalizeAuditStatus(source.status);
  const fallbackSeverity: AuditViolation['severity'] = status === 'failed' ? 'error' : 'warning';
  const violations = normalizeViolations(firstDefined(source, ['violations', 'issues', 'errors', 'reasons']), fallbackSeverity);

  if (Array.isArray(rejectedOperationIds) && rejectedOperationIds.length > 0) status = 'failed';
  if (Array.isArray(violations)) {
    if (violations.some(item => item.severity === 'error')) status = 'failed';
    else if (status !== 'failed' && violations.some(item => item.severity === 'warning')) status = 'warning';
  }
  if (!status && Array.isArray(acceptedOperationIds) && Array.isArray(rejectedOperationIds) && Array.isArray(violations)) {
    status = rejectedOperationIds.length > 0
      ? 'failed'
      : violations.some(item => item.severity === 'warning') ? 'warning' : 'passed';
  }

  return { status: status ?? source.status, acceptedOperationIds, rejectedOperationIds, violations };
}

function strictAuditValidation(value: unknown, operationIds: string[]): string[] {
  if (!value || typeof value !== 'object') return ['审计结果不是对象'];
  const result = value as Partial<StrictAuditResponse>;
  const errors: string[] = [];
  if (!['passed', 'warning', 'failed'].includes(String(result.status))) errors.push('status 无效');
  if (!Array.isArray(result.acceptedOperationIds)) errors.push('acceptedOperationIds 必须是数组');
  if (!Array.isArray(result.rejectedOperationIds)) errors.push('rejectedOperationIds 必须是数组');
  if (!Array.isArray(result.violations)) errors.push('violations 必须是数组');
  if (Array.isArray(result.violations)) {
    result.violations.forEach((violation, index) => {
      if (!violation || typeof violation !== 'object') errors.push(`violations[${index}] 必须是对象`);
      else {
        if (!violation.code || !violation.message) errors.push(`violations[${index}] 缺少 code 或 message`);
        if (!['info', 'warning', 'error'].includes(String(violation.severity))) errors.push(`violations[${index}] severity 无效`);
        if (!Array.isArray(violation.evidenceIds)) errors.push(`violations[${index}] evidenceIds 必须是数组`);
      }
    });
  }
  if (Array.isArray(result.acceptedOperationIds) && Array.isArray(result.rejectedOperationIds)) {
    const accepted = result.acceptedOperationIds;
    const rejected = result.rejectedOperationIds;
    if (accepted.some(id => typeof id !== 'string' || !id)) errors.push('acceptedOperationIds 含无效 ID');
    if (rejected.some(id => typeof id !== 'string' || !id)) errors.push('rejectedOperationIds 含无效 ID');
    const acceptedSet = new Set(accepted);
    const rejectedSet = new Set(rejected);
    const expected = new Set(operationIds);
    if (accepted.length !== acceptedSet.size) errors.push('acceptedOperationIds 含重复 ID');
    if (rejected.length !== rejectedSet.size) errors.push('rejectedOperationIds 含重复 ID');
    for (const id of acceptedSet) {
      if (rejectedSet.has(id)) errors.push(`operation ${id} 同时被接受和拒绝`);
      if (!expected.has(id)) errors.push(`acceptedOperationIds 含未知 ID ${id}`);
    }
    for (const id of rejectedSet) {
      if (!expected.has(id)) errors.push(`rejectedOperationIds 含未知 ID ${id}`);
    }
    for (const id of expected) {
      if (!acceptedSet.has(id) && !rejectedSet.has(id)) errors.push(`operation ${id} 未被审计`);
    }
  }
  return errors;
}

function localReducerViolations(response: ExtractionResponse, input: ExtractionInput): AuditViolation[] {
  return applyOperations(
    input.projection,
    response.operations,
    input.candidates.map(candidate => candidate.event)
  ).rejected.map(({ operation, error }) => ({
    code: 'reducer_rejected_operation',
    severity: 'error',
    message: `${operation.id}: ${error}`,
    evidenceIds: operation.evidenceIds
  }));
}

function normalizeEvidenceText(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

function directEvidenceQuotes(
  response: ExtractionResponse,
  operation: ExtractionResponse['operations'][number],
  input: ExtractionInput
): string[] {
  const evidenceById = new Map(response.evidence.map(item => [item.id, item]));
  const quotes: string[] = [];
  for (const evidenceId of operation.evidenceIds) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence || (evidence.source !== 'user' && evidence.source !== 'assistant')) continue;
    const quote = normalizeEvidenceText(evidence.quote);
    if (!quote) continue;
    const source = normalizeEvidenceText(evidence.source === 'user' ? input.userText : input.assistantText);
    if (source.includes(quote)) quotes.push(evidence.quote);
  }
  return quotes;
}

function parseChineseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9
  };
  if (![...trimmed].every(character => character in digits || '十百千万'.includes(character))) return null;
  if (![...trimmed].some(character => '十百千万'.includes(character))) {
    return Number([...trimmed].map(character => digits[character]).join(''));
  }

  let total = 0;
  let section = 0;
  let number = 0;
  for (const character of trimmed) {
    if (character in digits) {
      number = digits[character] ?? 0;
      continue;
    }
    const unit = character === '十' ? 10 : character === '百' ? 100 : character === '千' ? 1000 : 10_000;
    if (unit === 10_000) {
      total += (section + number) * unit;
      section = 0;
      number = 0;
    } else {
      section += (number || 1) * unit;
      number = 0;
    }
  }
  return total + section + number;
}

function explicitDurationMinutes(text: string): number[] {
  const values: number[] = [];
  const compact = text.replace(/\s+/g, '');
  const hourAndHalf = /([0-9]+(?:\.[0-9]+)?|[零〇一二两三四五六七八九十百千万]+)个?半(?:个)?(?:小时|钟头)/g;
  for (const match of compact.matchAll(hourAndHalf)) {
    const amount = parseChineseNumber(match[1] ?? '');
    if (amount !== null) values.push(amount * 60 + 30);
  }
  if (/(?:半个?小时|半钟头)/.test(compact)) values.push(30);

  const duration = /([0-9]+(?:\.[0-9]+)?|[零〇一二两三四五六七八九十百千万]+)个?(秒钟?|分钟?|分|小时|钟头|天|日|刻钟)/g;
  for (const match of compact.matchAll(duration)) {
    const amount = parseChineseNumber(match[1] ?? '');
    if (amount === null) continue;
    const unit = match[2] ?? '';
    if (unit.startsWith('秒')) values.push(amount / 60);
    else if (unit === '小时' || unit === '钟头') values.push(amount * 60);
    else if (unit === '天' || unit === '日') values.push(amount * 1440);
    else if (unit === '刻钟') values.push(amount * 15);
    else values.push(amount);
  }
  return values;
}

function containsFuturePlanLanguage(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  return /(?:接下来|下一步|稍后|待会儿?|等会儿?|打算|计划|将要|将会|即将|准备(?:去|要|先|开始|着手)|(?:我|你|他|她|它|我们|你们|他们)?会先|(?:我|你|他|她|它|我们|你们|他们)?要先|之后(?:我|你|他|她|我们|你们|他们)?(?:会|将|要))/.test(compact)
    || /\b(?:will|shall|going\s+to|plans?\s+to|planning\s+to|intends?\s+to|about\s+to)\b/i.test(text);
}

function containsCompletedDurationLanguage(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  const number = '(?:[0-9]+(?:\\.[0-9]+)?|[零〇一二两三四五六七八九十百千万]+)';
  const unit = '(?:个?半(?:个)?(?:小时|钟头)|个?(?:秒钟?|分钟?|分|小时|钟头|天|日|刻钟)|半个?小时|半钟头)';
  const duration = `${number}?${unit}`;
  return new RegExp(`(?:已经|已然|刚刚|刚才|过了|经过了?|过去了|耗时|花了|用了|持续了|等待了|等了|走了|跑了|聊了|检查了|确认了|完成了)[^。！？!?]{0,16}${duration}`).test(compact)
    || new RegExp(`${duration}(?:后|之后|以后)`).test(compact);
}

function supportsElapsedMinutes(quote: string, minutes: number): boolean {
  const durations = explicitDurationMinutes(quote);
  if (!durations.some(value => Math.abs(value - minutes) < 0.001)) return false;
  if (containsFuturePlanLanguage(quote) && !/(?:已经|已然|过了|经过了?|过去了|耗时|花了|用了|持续了)/.test(quote)) {
    return false;
  }
  return containsCompletedDurationLanguage(quote);
}

function isSourceVerificationTurn(input: ExtractionInput): boolean {
  const text = input.userText.replace(/\s+/g, '');
  const explicitlyNamesSource = /(?:原文|原作|source(?:material)?|canon)/i.test(text);
  const namesChapter = /(?:第[0-9一二三四五六七八九十百]+章|chapter\d+)/i.test(text);
  const constrainsAnswer = /(?:只根据|只回答|不要提|不提|复核|验收|核对)/.test(text);
  return explicitlyNamesSource || (namesChapter && constrainsAnswer);
}

function applyLocalSemanticGuards(response: ExtractionResponse, input: ExtractionInput): ExtractionResponse {
  const operations: ExtractionResponse['operations'] = [];
  const violations = [...response.violations];
  const knownFactIds = new Set(Object.keys(input.projection.facts));
  const staticSourceKnowledgeOnly = isSourceVerificationTurn(input)
    && response.operations.length > 0
    && response.operations.every(operation => (
      operation.type === 'add_fact' || operation.type === 'set_knowledge'
    ));

  for (const operation of response.operations) {
    const quotes = directEvidenceQuotes(response, operation, input);
    let reason = '';
    if (staticSourceKnowledgeOnly) {
      reason = '静态原文复核不会创建新的剧情事实或角色知识';
    } else if (operation.type === 'advance_time' && !quotes.some(quote => supportsElapsedMinutes(quote, operation.minutes))) {
      reason = '原文没有证明对应的明确时长已经过去';
    } else if (
      operation.type === 'set_character_state'
      && operation.field === 'activity'
      && (quotes.some(containsFuturePlanLanguage)
        || (typeof operation.value === 'string' && containsFuturePlanLanguage(operation.value)))
    ) {
      reason = '未来计划不能写成已经发生的当前活动';
    } else if (operation.type === 'set_knowledge' && !knownFactIds.has(operation.factId)) {
      reason = '知识变化不能引用尚未登记的事实';
    }

    if (!reason) {
      operations.push(operation);
      if (operation.type === 'add_fact') knownFactIds.add(operation.factId);
      continue;
    }
    violations.push({
      code: 'local_semantic_guard_dropped_operation',
      severity: 'info',
      message: `本地语义校验已忽略操作 ${operation.id}：${reason}。`,
      evidenceIds: operation.evidenceIds
    });
  }

  return { ...response, operations, violations };
}

function determineAuditStatus(violations: AuditViolation[]): 'passed' | 'warning' | 'failed' {
  if (violations.some(item => item.severity === 'error')) return 'failed';
  if (violations.some(item => item.severity === 'warning')) return 'warning';
  return 'passed';
}

async function runStrictAudit(
  context: SillyTavernContext,
  input: ExtractionInput,
  extraction: ExtractionResponse
): Promise<StrictAuditResponse> {
  const instructions = applyPromptOverride([
    '你是第二层独立叙事审计员。检查状态提取是否被原文证据支持。',
    '重点检查：角色知识越界、把计划当事实、物品凭空增减、关系跳变、时间地点冲突、格式或证据引用错误。',
    '计划、意图、预测、假设和未来动作不是已完成变化；由“接下来”“准备”“打算”“将要”“会先”等表述产生的 operation 必须拒绝。',
    '静态回答或复述已经知道的当前事实不会自动推进时间。advance_time 只有在原文明确说明可量化时长已经过去，或已完成动作持续了多久时才能接受；绝不能默认每轮推进 1 分钟。',
    'set_character_state.activity 只能表示已经开始或已经改变的当前活动；计划做、准备做、将要做的事必须拒绝。没有实际状态变化时应当没有 operation。',
    'Local recovery diagnostics describe operations that the runtime already removed. Audit only the remaining operations; do not report those diagnostic operation ids as orphaned references.',
    'A static answer that only restates currently visible source material or an already discussed fact does not by itself create a new timeline fact or character-knowledge change. Do not require add_fact or set_knowledge for such a no-change answer.',
    'Only report a missing knowledge update when the reply performs an in-world disclosure of a fact that already has a fact id in the old projection, or when a valid add_fact and set_knowledge pair remains in the extraction.',
    '不要评价文风好坏，也不要要求回复复刻所谓标准答案。',
    '每个 operation id 必须且只能出现在 acceptedOperationIds 或 rejectedOperationIds 之一。',
    'violations 必须始终是 JSON 数组；没有问题时写 []，不得写 null、字符串或对象。',
    ...MATURE_CONTENT_ANALYSIS_RULES,
  ], input.auditPromptOverride ?? { mode: 'builtin', text: '' });
  const prompt = [
    ...instructions,
    '只返回扁平对象，例如：{"status":"passed","acceptedOperationIds":["op1"],"rejectedOperationIds":[],"violations":[]}。',
    '',
    `旧状态：${boundedText(stableJson(input.projection))}`,
    `当前用户故事角色 ID：${input.userRoleId ?? '未绑定'}`,
    `当前回复角色 ID：${input.responderCharacterId ?? '无法可靠识别'}`,
    `用户消息：${boundedText(input.userText)}`,
    `角色回复：${boundedText(input.assistantText)}`,
    `待审计提取：${boundedText(stableJson(extraction))}`
  ].join('\n\n');
  return await generateWithRetry(context, {
    prompt,
    systemPrompt: '只输出符合 JSON Schema 的审计对象。',
    responseLength: Math.max(800, Math.min(2400, input.responseTokens)),
    instructOverride: false,
    quietToLoud: false,
    jsonSchema: structuredSchema(
      'psyche_timeline_strict_audit',
      STRICT_AUDIT_GENERATION_SCHEMA as unknown as Record<string, unknown>
    )
  }, value => strictAuditValidation(value, extraction.operations.map(operation => operation.id)), 3,
  normalizeStrictAuditWire, input.auditorProfileId || input.extractorProfileId, input.profileFallback) as StrictAuditResponse;
}

export async function extractAndAuditTurn(
  context: SillyTavernContext,
  input: ExtractionInput
): Promise<ExtractionRunResult> {
  const generated = await generateWithRetry(context, {
    prompt: buildExtractionPrompt(input),
    systemPrompt: '只输出符合 JSON Schema 的对象，不要输出 Markdown 或解释。',
    responseLength: input.responseTokens,
    instructOverride: false,
    quietToLoud: false,
    jsonSchema: structuredSchema('psyche_timeline_extraction', EXTRACTION_GENERATION_SCHEMA)
  }, extractionValidation, 3, normalizeExtractionWire, input.extractorProfileId, input.profileFallback,
  recoverExtractionResponse) as ExtractionResponse;
  const parsed = applyLocalSemanticGuards(generated, input);

  const reducerViolations = localReducerViolations(parsed, input);
  let violations = [...parsed.violations, ...reducerViolations];

  if (input.auditMode === 'strict') {
    try {
      const review = await runStrictAudit(context, input, {
        ...parsed,
        violations: parsed.violations.filter(violation => (
          violation.code !== 'invalid_extractor_operation_dropped'
          && violation.code !== 'local_semantic_guard_dropped_operation'
        ))
      });
      const knownIds = new Set(parsed.operations.map(operation => operation.id));
      for (const rejectedId of review.rejectedOperationIds.filter(id => knownIds.has(id))) {
        violations.push({
          code: 'strict_audit_rejected_operation',
          severity: 'error',
          message: `第二层审计拒绝了操作 ${rejectedId}。`,
          evidenceIds: parsed.operations.find(operation => operation.id === rejectedId)?.evidenceIds ?? []
        });
      }
      violations = [...violations, ...review.violations];
    } catch (error) {
      violations.push({
        code: 'strict_audit_unavailable',
        severity: 'error',
        message: `第二层审计未能返回有效结构：${error instanceof Error ? error.message : String(error)}`,
        evidenceIds: []
      });
    }
  }

  if (input.auditMode === 'off') violations = reducerViolations;
  parsed.violations = violations;
  return {
    response: parsed,
    auditStatus: input.auditMode === 'off' && violations.length === 0
      ? 'unreviewed'
      : determineAuditStatus(violations),
    model: input.auditMode === 'strict'
      ? input.auditorProfileId || input.extractorProfileId || null
      : input.extractorProfileId || null
  };
}
