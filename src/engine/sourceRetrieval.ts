import type {
  StorySourceEmbeddingRecord,
  StorySourceRetrievalChunk
} from '../model/source';

export interface SourceRetrievalFilter {
  minChunkOrder?: number;
  maxChunkOrder?: number;
  minChapterOrder?: number;
  maxChapterOrder?: number;
  allowedChapterIds?: string[];
  excludedChunkIds?: string[];
}

export interface SourceRetrievalResult {
  chunk: StorySourceRetrievalChunk;
  score: number;
  keywordScore: number;
  semanticScore: number;
  keywordRank: number | null;
  semanticRank: number | null;
  reasons: string[];
}

export interface SourceRetrievalOptions {
  query: string;
  queryVector?: number[] | null;
  chunks: readonly StorySourceRetrievalChunk[];
  embeddings?: readonly StorySourceEmbeddingRecord[];
  filter?: SourceRetrievalFilter;
  limit?: number;
  keywordWeight?: number;
  semanticWeight?: number;
  semanticChunkIds?: readonly string[];
  cursorOrder?: number;
  proximityWeight?: number;
}

function tokens(text: string): string[] {
  const normalized = text.toLocaleLowerCase('zh-CN');
  const latin = normalized.match(/[a-z0-9_]{2,}/g) ?? [];
  const runs = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const grams: string[] = [];
  for (const run of runs) {
    for (let index = 0; index < run.length - 1; index += 1) grams.push(run.slice(index, index + 2));
  }
  return [...new Set([...latin, ...grams])];
}

export function sourceCosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    dot += a * b;
    aNorm += a * a;
    bNorm += b * b;
  }
  return aNorm > 0 && bNorm > 0 ? dot / Math.sqrt(aNorm * bNorm) : 0;
}

function allowed(chunk: StorySourceRetrievalChunk, filter: SourceRetrievalFilter): boolean {
  if (filter.minChunkOrder !== undefined && chunk.chunkOrder < filter.minChunkOrder) return false;
  if (filter.maxChunkOrder !== undefined && chunk.chunkOrder > filter.maxChunkOrder) return false;
  if (filter.minChapterOrder !== undefined && chunk.chapterOrder < filter.minChapterOrder) return false;
  if (filter.maxChapterOrder !== undefined && chunk.chapterOrder > filter.maxChapterOrder) return false;
  if (filter.allowedChapterIds?.length && !filter.allowedChapterIds.includes(chunk.chapterId)) return false;
  return !filter.excludedChunkIds?.includes(chunk.id);
}

function rank(values: Array<{ id: string; score: number }>): Map<string, number> {
  return new Map(values.filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((item, index) => [item.id, index + 1]));
}

export function retrieveStorySource(options: SourceRetrievalOptions): SourceRetrievalResult[] {
  const candidates = options.chunks.filter(chunk => allowed(chunk, options.filter ?? {}));
  const queryTokens = tokens(options.query);
  const embeddingById = new Map((options.embeddings ?? []).map(item => [item.chunkId, item.vector]));
  const keyword = candidates.map(chunk => {
    const available = new Set(chunk.keywordTokens.length ? chunk.keywordTokens : tokens(chunk.text));
    const overlap = queryTokens.reduce((count, token) => count + (available.has(token) ? 1 : 0), 0);
    const phrase = options.query.trim() && chunk.text.toLocaleLowerCase('zh-CN').includes(options.query.trim().toLocaleLowerCase('zh-CN')) ? 2 : 0;
    return { id: chunk.id, score: phrase + overlap / Math.sqrt(Math.max(1, queryTokens.length * available.size)) };
  });
  const externalSemanticRank = new Map((options.semanticChunkIds ?? []).map((id, index) => [id, index + 1]));
  const semantic = candidates.map(chunk => ({
    id: chunk.id,
    score: externalSemanticRank.has(chunk.id)
      ? 1 / externalSemanticRank.get(chunk.id)!
      : options.queryVector
        ? sourceCosineSimilarity(options.queryVector, embeddingById.get(chunk.id) ?? [])
        : 0
  }));
  const keywordRanks = rank(keyword);
  const semanticRanks = rank(semantic);
  const keywordById = new Map(keyword.map(item => [item.id, item.score]));
  const semanticById = new Map(semantic.map(item => [item.id, item.score]));
  const keywordWeight = options.keywordWeight ?? 1;
  const semanticWeight = options.semanticWeight ?? 1;
  const proximityWeight = options.proximityWeight ?? 0.15;
  return candidates.map(chunk => {
    const keywordRank = keywordRanks.get(chunk.id) ?? null;
    const semanticRank = semanticRanks.get(chunk.id) ?? null;
    const proximity = options.cursorOrder === undefined ? 0 : 1 / (1 + Math.abs(chunk.chunkOrder - options.cursorOrder));
    const reasons: string[] = [];
    if (keywordRank) reasons.push(`关键词排名 ${keywordRank}`);
    if (semanticRank) reasons.push(`向量排名 ${semanticRank}`);
    if (proximity > 0) reasons.push(`距原作游标 ${Math.abs(chunk.chunkOrder - options.cursorOrder!)}`);
    return {
      chunk,
      score: (keywordRank ? keywordWeight / (60 + keywordRank) : 0)
        + (semanticRank ? semanticWeight / (60 + semanticRank) : 0)
        + proximity * proximityWeight / 60,
      keywordScore: keywordById.get(chunk.id) ?? 0,
      semanticScore: semanticById.get(chunk.id) ?? 0,
      keywordRank,
      semanticRank,
      reasons
    };
  }).filter(result => result.keywordRank !== null || result.semanticRank !== null)
    .sort((left, right) => right.score - left.score || left.chunk.chunkOrder - right.chunk.chunkOrder)
    .slice(0, Math.max(0, options.limit ?? 8));
}

export function sourceSequentialWindow(
  chunks: readonly StorySourceRetrievalChunk[],
  cursorOrder: number,
  before = 1,
  after = 2,
  filter: SourceRetrievalFilter = {}
): StorySourceRetrievalChunk[] {
  const min = Math.max(0, cursorOrder - Math.max(0, before));
  const max = cursorOrder + Math.max(0, after);
  return chunks.filter(chunk => chunk.chunkOrder >= min && chunk.chunkOrder <= max && allowed(chunk, filter))
    .sort((left, right) => left.chunkOrder - right.chunkOrder);
}
