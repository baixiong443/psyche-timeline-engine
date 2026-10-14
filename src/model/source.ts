export const STORY_SOURCE_SCHEMA_VERSION = 1 as const;

export type SourcePreparationMode = 'quick' | 'balanced' | 'complete';
export type SourceCompilationLevel = 0 | 1 | 2 | 3 | 4;
export type SourceTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stale';
export type SourceAuditStatus = 'unreviewed' | 'passed' | 'warning' | 'failed';

export interface StorySourceChapter {
  id: string;
  order: number;
  title: string;
  startOffset: number;
  endOffset: number;
  firstRetrievalOrder: number;
  lastRetrievalOrder: number;
  firstAnalysisOrder: number;
  lastAnalysisOrder: number;
}

export interface StorySourceRetrievalChunk {
  schemaVersion: 1;
  id: string;
  chapterId: string;
  chapterOrder: number;
  chunkOrder: number;
  title: string;
  startOffset: number;
  endOffset: number;
  text: string;
  contentHash: string;
  previousChunkId?: string;
  nextChunkId?: string;
  keywordTokens: string[];
}

export interface StorySourceAnalysisUnit {
  schemaVersion: 1;
  id: string;
  chapterId: string;
  chapterOrder: number;
  unitOrder: number;
  title: string;
  startOffset: number;
  endOffset: number;
  text: string;
  retrievalChunkIds: string[];
}

export interface StorySourceEmbeddingConfig {
  provider: 'openai-compatible' | 'ollama' | 'browser-local' | 'custom';
  model: string;
  dimensions: number;
  normalized: boolean;
  distance: 'cosine';
  indexFingerprint: string;
}

export interface StorySourceEmbeddingRecord {
  schemaVersion: 1;
  chunkId: string;
  modelKey: string;
  vector: number[];
}

export interface StoryEvidenceClaim {
  schemaVersion: 1;
  id: string;
  statement: string;
  category: 'identity' | 'event' | 'relationship' | 'appearance' | 'dialogue' | 'world' | 'knowledge' | 'item' | 'uncertainty';
  truthStatus: 'true' | 'false' | 'unknown' | 'reported' | 'believed';
  subjectIds: string[];
  observerIds: string[];
  sourceChunkIds: string[];
  validFromOrder: number;
  validUntilOrder?: number;
  confidence: number;
  auditStatus: SourceAuditStatus;
}

export interface StorySourceCompilationRecord {
  schemaVersion: 1;
  sourceUnitId: string;
  level: SourceCompilationLevel;
  skeletonStatus: SourceTaskStatus;
  auditStatus: SourceAuditStatus;
  deepCompilationStatus: SourceTaskStatus;
  eventIds: string[];
  updatedAt: number;
  attemptCount?: number;
  maxAttempts?: number;
  lastAttemptAt?: number;
  error?: string;
}

export interface StorySourceIndex {
  schemaVersion: 1;
  storyId: string;
  corpusId: string;
  sourceFingerprint: string;
  sourceLength: number;
  preparationMode: SourcePreparationMode;
  chapters: StorySourceChapter[];
  retrievalChunkCount: number;
  analysisUnitCount: number;
  embedding: StorySourceEmbeddingConfig | null;
  retrievalDefaults: {
    sequentialBefore: number;
    sequentialAfter: number;
    semanticTopK: number;
    keywordTopK: number;
    maxContextChars: number;
  };
  createdAt: string;
}

export interface StorySourceCorpus {
  index: StorySourceIndex;
  retrievalChunks: StorySourceRetrievalChunk[];
  analysisUnits: StorySourceAnalysisUnit[];
  embeddings: StorySourceEmbeddingRecord[];
  claims: StoryEvidenceClaim[];
  compilation: StorySourceCompilationRecord[];
}

export interface StorySourceLibraryRef {
  schemaVersion: 1;
  corpusId: string;
  sourceFingerprint: string;
  preparationMode: SourcePreparationMode;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validateStorySourceIndex(value: unknown): { valid: boolean; errors: string[]; value?: StorySourceIndex } {
  const errors: string[] = [];
  const source = record(value);
  if (!source) return { valid: false, errors: ['source/index.json 必须是对象'] };
  if (source.schemaVersion !== 1) errors.push('source index schemaVersion 必须为 1');
  for (const field of ['storyId', 'corpusId', 'sourceFingerprint', 'createdAt']) {
    if (!stringValue(source[field])) errors.push(`${field} 必须是非空字符串`);
  }
  if (!Number.isInteger(source.sourceLength) || Number(source.sourceLength) <= 0) errors.push('sourceLength 必须是正整数');
  if (!['quick', 'balanced', 'complete'].includes(String(source.preparationMode))) errors.push('preparationMode 无效');
  if (!Number.isInteger(source.retrievalChunkCount) || Number(source.retrievalChunkCount) < 1) errors.push('retrievalChunkCount 必须是正整数');
  if (!Number.isInteger(source.analysisUnitCount) || Number(source.analysisUnitCount) < 1) errors.push('analysisUnitCount 必须是正整数');
  if (!Array.isArray(source.chapters) || source.chapters.length === 0) errors.push('chapters 必须是非空数组');
  if (!record(source.retrievalDefaults)) errors.push('retrievalDefaults 必须是对象');
  const embedding = source.embedding;
  if (embedding !== null && embedding !== undefined) {
    const config = record(embedding);
    if (!config) errors.push('embedding 必须是对象或 null');
    else {
      if (!stringValue(config.model)) errors.push('embedding.model 必须是非空字符串');
      if (!Number.isInteger(config.dimensions) || Number(config.dimensions) <= 0 || Number(config.dimensions) > 65_536) errors.push('embedding.dimensions 无效');
      if (config.distance !== 'cosine') errors.push('embedding.distance 必须为 cosine');
    }
  }
  return errors.length === 0
    ? { valid: true, errors: [], value: value as StorySourceIndex }
    : { valid: false, errors };
}

export function validateStorySourceChunk(value: unknown): { valid: boolean; errors: string[]; value?: StorySourceRetrievalChunk } {
  const errors: string[] = [];
  const source = record(value);
  if (!source) return { valid: false, errors: ['检索片段必须是对象'] };
  if (source.schemaVersion !== 1) errors.push('检索片段 schemaVersion 必须为 1');
  for (const field of ['id', 'chapterId', 'title', 'text', 'contentHash']) {
    if (!stringValue(source[field])) errors.push(`${field} 必须是非空字符串`);
  }
  for (const field of ['chapterOrder', 'chunkOrder', 'startOffset', 'endOffset']) {
    if (!Number.isInteger(source[field]) || Number(source[field]) < 0) errors.push(`${field} 必须是非负整数`);
  }
  if (Number(source.endOffset) <= Number(source.startOffset)) errors.push('endOffset 必须大于 startOffset');
  if (!Array.isArray(source.keywordTokens) || source.keywordTokens.some(token => typeof token !== 'string')) errors.push('keywordTokens 必须是字符串数组');
  return errors.length === 0
    ? { valid: true, errors: [], value: value as StorySourceRetrievalChunk }
    : { valid: false, errors };
}

export function validateStorySourceAnalysisUnit(value: unknown): { valid: boolean; errors: string[]; value?: StorySourceAnalysisUnit } {
  const errors: string[] = [];
  const source = record(value);
  if (!source) return { valid: false, errors: ['分析单元必须是对象'] };
  if (source.schemaVersion !== 1) errors.push('分析单元 schemaVersion 必须为 1');
  for (const field of ['id', 'chapterId', 'title', 'text']) {
    if (!stringValue(source[field])) errors.push(`${field} 必须是非空字符串`);
  }
  for (const field of ['chapterOrder', 'unitOrder', 'startOffset', 'endOffset']) {
    if (!Number.isInteger(source[field]) || Number(source[field]) < 0) errors.push(`${field} 必须是非负整数`);
  }
  if (Number(source.endOffset) <= Number(source.startOffset)) errors.push('endOffset 必须大于 startOffset');
  if (!Array.isArray(source.retrievalChunkIds) || source.retrievalChunkIds.length === 0
    || source.retrievalChunkIds.some(id => !stringValue(id))) {
    errors.push('retrievalChunkIds 必须是非空字符串数组');
  }
  return errors.length === 0
    ? { valid: true, errors: [], value: value as StorySourceAnalysisUnit }
    : { valid: false, errors };
}

export function validateStoryEvidenceClaim(value: unknown): { valid: boolean; errors: string[]; value?: StoryEvidenceClaim } {
  const errors: string[] = [];
  const source = record(value);
  const categories = ['identity', 'event', 'relationship', 'appearance', 'dialogue', 'world', 'knowledge', 'item', 'uncertainty'];
  const truthStatuses = ['true', 'false', 'unknown', 'reported', 'believed'];
  const auditStatuses = ['unreviewed', 'passed', 'warning', 'failed'];
  if (!source) return { valid: false, errors: ['证据声明必须是对象'] };
  if (source.schemaVersion !== 1) errors.push('证据声明 schemaVersion 必须为 1');
  if (!stringValue(source.id)) errors.push('id 必须是非空字符串');
  if (!stringValue(source.statement)) errors.push('statement 必须是非空字符串');
  if (!categories.includes(String(source.category))) errors.push('category 无效');
  if (!truthStatuses.includes(String(source.truthStatus))) errors.push('truthStatus 无效');
  for (const field of ['subjectIds', 'observerIds', 'sourceChunkIds']) {
    if (!Array.isArray(source[field]) || source[field].some(id => !stringValue(id))) errors.push(`${field} 必须是字符串数组`);
  }
  if (!Number.isInteger(source.validFromOrder) || Number(source.validFromOrder) < 0) errors.push('validFromOrder 必须是非负整数');
  if (source.validUntilOrder !== undefined
    && (!Number.isInteger(source.validUntilOrder) || Number(source.validUntilOrder) < Number(source.validFromOrder))) {
    errors.push('validUntilOrder 必须不早于 validFromOrder');
  }
  if (typeof source.confidence !== 'number' || !Number.isFinite(source.confidence)
    || source.confidence < 0 || source.confidence > 1) errors.push('confidence 必须在 0 到 1 之间');
  if (!auditStatuses.includes(String(source.auditStatus))) errors.push('auditStatus 无效');
  return errors.length === 0
    ? { valid: true, errors: [], value: value as StoryEvidenceClaim }
    : { valid: false, errors };
}

export function validateStorySourceCompilationRecord(value: unknown): { valid: boolean; errors: string[]; value?: StorySourceCompilationRecord } {
  const errors: string[] = [];
  const source = record(value);
  const taskStatuses = ['pending', 'running', 'completed', 'failed', 'stale'];
  const auditStatuses = ['unreviewed', 'passed', 'warning', 'failed'];
  if (!source) return { valid: false, errors: ['编译记录必须是对象'] };
  if (source.schemaVersion !== 1) errors.push('编译记录 schemaVersion 必须为 1');
  if (!stringValue(source.sourceUnitId)) errors.push('sourceUnitId 必须是非空字符串');
  if (!Number.isInteger(source.level) || Number(source.level) < 0 || Number(source.level) > 4) errors.push('level 必须在 0 到 4 之间');
  if (!taskStatuses.includes(String(source.skeletonStatus))) errors.push('skeletonStatus 无效');
  if (!auditStatuses.includes(String(source.auditStatus))) errors.push('auditStatus 无效');
  if (!taskStatuses.includes(String(source.deepCompilationStatus))) errors.push('deepCompilationStatus 无效');
  if (!Array.isArray(source.eventIds) || source.eventIds.some(id => !stringValue(id))) errors.push('eventIds 必须是字符串数组');
  if (typeof source.updatedAt !== 'number' || !Number.isFinite(source.updatedAt) || source.updatedAt < 0) errors.push('updatedAt 必须是非负数');
  if (source.attemptCount !== undefined
    && (!Number.isInteger(source.attemptCount) || Number(source.attemptCount) < 0)) errors.push('attemptCount 必须是非负整数');
  if (source.maxAttempts !== undefined
    && (!Number.isInteger(source.maxAttempts) || Number(source.maxAttempts) < 1)) errors.push('maxAttempts 必须是正整数');
  if (source.lastAttemptAt !== undefined
    && (typeof source.lastAttemptAt !== 'number' || !Number.isFinite(source.lastAttemptAt) || source.lastAttemptAt < 0)) {
    errors.push('lastAttemptAt 必须是非负数');
  }
  if (source.error !== undefined && typeof source.error !== 'string') errors.push('error 必须是字符串');
  return errors.length === 0
    ? { valid: true, errors: [], value: value as StorySourceCompilationRecord }
    : { valid: false, errors };
}

export function validateStorySourceEmbedding(
  value: unknown,
  config: StorySourceEmbeddingConfig,
  knownChunkIds: Set<string>
): { valid: boolean; errors: string[]; value?: StorySourceEmbeddingRecord } {
  const errors: string[] = [];
  const source = record(value);
  if (!source) return { valid: false, errors: ['嵌入记录必须是对象'] };
  if (source.schemaVersion !== 1) errors.push('嵌入记录 schemaVersion 必须为 1');
  if (!stringValue(source.chunkId) || !knownChunkIds.has(String(source.chunkId))) errors.push('嵌入记录引用了未知片段');
  if (!stringValue(source.modelKey)) errors.push('modelKey 必须是非空字符串');
  if (!Array.isArray(source.vector) || source.vector.length !== config.dimensions) errors.push('向量维度与 embedding 配置不一致');
  else if (source.vector.some(item => typeof item !== 'number' || !Number.isFinite(item))) errors.push('向量必须只包含有限数字');
  return errors.length === 0
    ? { valid: true, errors: [], value: value as StorySourceEmbeddingRecord }
    : { valid: false, errors };
}
