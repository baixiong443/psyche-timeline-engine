import type { StorySourceCorpus } from '../model/source';
import type { SillyTavernContext } from '../runtime/context';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const completedCollections = new Map<string, SillyTavernVectorProgress>();

export interface SillyTavernVectorConfig {
  source: string;
  request: Record<string, unknown>;
}

export interface SillyTavernVectorProgress {
  source: string;
  collectionId: string;
  indexed: number;
  total: number;
  insertedThisRun: number;
  complete: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function resolveSillyTavernVectorConfig(context: SillyTavernContext): SillyTavernVectorConfig {
  const settings = record(context.extensionSettings.vectors);
  const source = typeof settings.source === 'string' && settings.source.trim() ? settings.source.trim() : 'transformers';
  if (source === 'webllm' || source === 'koboldcpp') {
    throw new Error(`酒馆向量来源 ${source} 需要客户端直接生成向量，PTE 不会自动切换来源`);
  }
  const request: Record<string, unknown> = {};
  const modelFields: Record<string, string> = {
    openai: 'openai_model',
    electronhub: 'electronhub_model',
    openrouter: 'openrouter_model',
    togetherai: 'togetherai_model',
    cohere: 'cohere_model',
    ollama: 'ollama_model',
    vllm: 'vllm_model',
    palm: 'google_model',
    vertexai: 'google_model',
    chutes: 'chutes_model',
    nanogpt: 'nanogpt_model',
    siliconflow: 'siliconflow_model',
    workers_ai: 'workers_ai_model'
  };
  const modelField = modelFields[source];
  if (modelField && typeof settings[modelField] === 'string') request.model = settings[modelField];
  if (source === 'ollama' || source === 'vllm' || source === 'llamacpp') {
    const completion = record(context.textCompletionSettings);
    const serverUrls = record(completion.server_urls);
    const sourceKey = source === 'llamacpp' ? 'llamacpp' : source;
    const apiUrl = settings.use_alt_endpoint && typeof settings.alt_endpoint_url === 'string'
      ? settings.alt_endpoint_url
      : serverUrls[sourceKey];
    if (typeof apiUrl !== 'string' || !apiUrl.trim()) throw new Error(`酒馆向量来源 ${source} 缺少 API 地址`);
    request.apiUrl = apiUrl;
    if (source === 'ollama') request.keep = Boolean(settings.ollama_keep);
  }
  if (source === 'extras') {
    const extras = record(context.extensionSettings);
    request.extrasUrl = extras.apiUrl;
    request.extrasKey = extras.apiKey;
  }
  return { source, request };
}

export function sillyTavernStringHash(value: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function sourceVectorCollectionId(digest: string, corpusId: string): string {
  const digestPart = digest.replace(/^sha256:/, '').slice(0, 24).replace(/[^a-zA-Z0-9_-]/g, '_');
  const corpusPart = sillyTavernStringHash(corpusId).toString(36);
  return `pte_${digestPart}_${corpusPart}`;
}

function indexedText(id: string, text: string): string {
  return `[PTE ${id}]\n${text}`;
}

function headers(context: SillyTavernContext): Record<string, string> {
  return context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };
}

async function jsonResponse(response: Response, action: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${action}失败：${response.status} ${response.statusText}`.trim());
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${action}返回了无效 JSON`);
  }
}

async function post(
  context: SillyTavernContext,
  path: string,
  body: Record<string, unknown>,
  action: string,
  fetcher: Fetcher
): Promise<unknown> {
  const response = await fetcher(path, {
    method: 'POST',
    headers: headers(context),
    body: JSON.stringify(body)
  });
  return jsonResponse(response, action);
}

export async function ensureSillyTavernSourceVectors(
  context: SillyTavernContext,
  digest: string,
  corpus: StorySourceCorpus,
  options: { fetcher?: Fetcher; source?: string; request?: Record<string, unknown>; maxInsertItems?: number; priorityChunkOrders?: readonly number[] } = {}
): Promise<string> {
  return (await ensureSillyTavernSourceVectorsWithProgress(context, digest, corpus, options)).collectionId;
}

export async function ensureSillyTavernSourceVectorsWithProgress(
  context: SillyTavernContext,
  digest: string,
  corpus: StorySourceCorpus,
  options: { fetcher?: Fetcher; source?: string; request?: Record<string, unknown>; maxInsertItems?: number; priorityChunkOrders?: readonly number[] } = {}
): Promise<SillyTavernVectorProgress> {
  const fetcher = options.fetcher ?? fetch;
  const resolved = options.source ? { source: options.source, request: options.request ?? {} } : resolveSillyTavernVectorConfig(context);
  const source = resolved.source;
  const request = resolved.request;
  const collectionId = sourceVectorCollectionId(digest, corpus.index.corpusId);
  const cacheKey = `${source}:${collectionId}:${corpus.index.sourceFingerprint}`;
  const completed = completedCollections.get(cacheKey);
  if (completed) return completed;
  const items = corpus.retrievalChunks.map(chunk => {
    const text = indexedText(chunk.id, chunk.text);
    return { hash: sillyTavernStringHash(text), text, index: chunk.chunkOrder };
  });
  const expectedHashes = new Set(items.map(item => item.hash));
  const listed = await post(context, '/api/vector/list', { collectionId, source, ...request }, '读取酒馆向量索引', fetcher);
  const savedHashes = Array.isArray(listed) ? listed.filter(value => typeof value === 'number') as number[] : [];
  const staleHashes = savedHashes.filter(hash => !expectedHashes.has(hash));
  if (staleHashes.length > 0) {
    await post(context, '/api/vector/delete', { collectionId, source, ...request, hashes: staleHashes }, '清理过期原文向量', fetcher);
  }
  const saved = new Set(savedHashes);
  const priorities = new Map((options.priorityChunkOrders ?? []).map((order, index) => [order, index]));
  const missing = items.filter(item => !saved.has(item.hash)).sort((left, right) => {
    const leftPriority = priorities.get(left.index) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = priorities.get(right.index) ?? Number.MAX_SAFE_INTEGER;
    return leftPriority - rightPriority || left.index - right.index;
  });
  const maxInsertItems = Math.max(1, Math.min(256, Math.floor(options.maxInsertItems ?? 64)));
  const selectedMissing = missing.slice(0, maxInsertItems);
  for (let index = 0; index < selectedMissing.length; index += 32) {
    await post(context, '/api/vector/insert', {
      collectionId,
      source,
      ...request,
      items: selectedMissing.slice(index, index + 32)
    }, '建立原文向量索引', fetcher);
  }
  const indexed = items.length - missing.length + selectedMissing.length;
  const progress: SillyTavernVectorProgress = {
    source,
    collectionId,
    indexed,
    total: items.length,
    insertedThisRun: selectedMissing.length,
    complete: indexed >= items.length
  };
  if (progress.complete) completedCollections.set(cacheKey, progress);
  return progress;
}

export interface SillyTavernVectorQueryResult {
  chunkIds: string[];
  progress: SillyTavernVectorProgress;
}

export async function querySillyTavernSourceVectors(
  context: SillyTavernContext,
  digest: string,
  corpus: StorySourceCorpus,
  query: string,
  limit: number,
  options: { fetcher?: Fetcher; source?: string; request?: Record<string, unknown>; maxInsertItems?: number; priorityChunkOrders?: readonly number[] } = {}
): Promise<string[]> {
  return (await querySillyTavernSourceVectorsWithProgress(
    context, digest, corpus, query, limit, options
  )).chunkIds;
}

export async function querySillyTavernSourceVectorsWithProgress(
  context: SillyTavernContext,
  digest: string,
  corpus: StorySourceCorpus,
  query: string,
  limit: number,
  options: { fetcher?: Fetcher; source?: string; request?: Record<string, unknown>; maxInsertItems?: number; priorityChunkOrders?: readonly number[] } = {}
): Promise<SillyTavernVectorQueryResult> {
  const fetcher = options.fetcher ?? fetch;
  const resolved = options.source ? { source: options.source, request: options.request ?? {} } : resolveSillyTavernVectorConfig(context);
  const source = resolved.source;
  const progress = await ensureSillyTavernSourceVectorsWithProgress(context, digest, corpus, {
    fetcher,
    source,
    request: resolved.request,
    maxInsertItems: options.maxInsertItems,
    priorityChunkOrders: options.priorityChunkOrders
  });
  if (!query.trim()) return { chunkIds: [], progress };
  const result = await post(context, '/api/vector/query', {
    collectionId: progress.collectionId,
    source,
    ...resolved.request,
    searchText: query,
    topK: Math.max(1, Math.min(50, Math.floor(limit) || 8)),
    threshold: 0
  }, '查询原文向量', fetcher) as { metadata?: unknown } | null;
  if (!Array.isArray(result?.metadata)) return { chunkIds: [], progress };
  const byOrder = new Map(corpus.retrievalChunks.map(chunk => [chunk.chunkOrder, chunk.id]));
  const chunkIds = [...new Set(result.metadata.map(item => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return Number.isInteger(record.index) ? byOrder.get(Number(record.index)) : undefined;
  }).filter((id): id is string => Boolean(id)))];
  return { chunkIds, progress };
}

export function resetSillyTavernVectorCacheForTests(): void {
  completedCollections.clear();
}
