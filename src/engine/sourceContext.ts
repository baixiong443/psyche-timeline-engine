import type { StorySourceAnalysisUnit, StorySourceCorpus, StorySourceRetrievalChunk } from '../model/source';
import type { StoryPlan, StoryProjection } from '../model/types';
import type { SillyTavernContext } from '../runtime/context';
import type { ActiveStory } from '../runtime/story';
import { getInstalledStorySource } from '../storage/sourceDb';
import {
  querySillyTavernSourceVectorsWithProgress,
  type SillyTavernVectorProgress
} from './sillyTavernVectors';
import { retrieveStorySource, sourceSequentialWindow, type SourceRetrievalResult } from './sourceRetrieval';

export interface RuntimeStorySourceContext {
  corpusId: string;
  cursorOrder: number;
  sequential: StorySourceRetrievalChunk[];
  related: SourceRetrievalResult[];
  style: StorySourceRetrievalChunk[];
  futureController: StorySourceRetrievalChunk[];
  compileUnit: StorySourceAnalysisUnit | null;
  progress?: RuntimeStorySourceProgress;
  warnings: string[];
}

export interface RuntimeStorySourceProgress {
  preparationMode: StorySourceCorpus['index']['preparationMode'];
  cursorOrder: number;
  retrievalChunkCount: number;
  analysisUnitCount: number;
  claimCount: number;
  l2Count: number;
  l3Count: number;
  l4Count: number;
  failedCount: number;
  vector: SillyTavernVectorProgress | null;
}

function sourceProgress(
  corpus: StorySourceCorpus,
  cursorOrder: number,
  vector: SillyTavernVectorProgress | null
): RuntimeStorySourceProgress {
  return {
    preparationMode: corpus.index.preparationMode,
    cursorOrder,
    retrievalChunkCount: corpus.retrievalChunks.length,
    analysisUnitCount: corpus.analysisUnits.length,
    claimCount: corpus.claims.length,
    l2Count: corpus.compilation.filter(record => record.level >= 2).length,
    l3Count: corpus.compilation.filter(record => record.level >= 3).length,
    l4Count: corpus.compilation.filter(record => record.level >= 4 && record.deepCompilationStatus === 'completed').length,
    failedCount: corpus.compilation.filter(record => (
      record.deepCompilationStatus === 'failed' || record.auditStatus === 'failed'
    )).length,
    vector
  };
}

function normalizedLabel(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/[^a-z0-9\p{Script=Han}]+/gu, '');
}

function numericOrder(value: string): number | null {
  const match = value.match(/\d+/)?.[0];
  if (!match) return null;
  const parsed = Number(match);
  return Number.isInteger(parsed) && parsed > 0 ? parsed - 1 : null;
}

export function resolveSourceCursorOrder(
  corpus: StorySourceCorpus,
  projection: StoryProjection,
  plan: StoryPlan
): number {
  const completedEvent = [...plan.events]
    .filter(event => event.canonicalOrder <= projection.canonCursor.eventOrder)
    .sort((left, right) => right.canonicalOrder - left.canonicalOrder)[0];
  const labels = [projection.canonCursor.chapterId, completedEvent?.chapterId]
    .filter((value): value is string => Boolean(value));
  let chapter = corpus.index.chapters.find(item => labels.some(label => item.id === label));
  chapter ??= corpus.index.chapters.find(item => labels.some(label => normalizedLabel(item.title) === normalizedLabel(label)));
  if (!chapter) {
    const order = labels.map(numericOrder).find(value => value !== null);
    if (order !== undefined && order !== null) chapter = corpus.index.chapters.find(item => item.order === order);
  }
  if (!chapter) return corpus.retrievalChunks[0]?.chunkOrder ?? 0;

  const chapterLabel = completedEvent?.chapterId ?? projection.canonCursor.chapterId;
  const chapterEvents = plan.events
    .filter(event => normalizedLabel(event.chapterId) === normalizedLabel(chapterLabel))
    .sort((left, right) => left.canonicalOrder - right.canonicalOrder);
  const reached = chapterEvents.filter(event => event.canonicalOrder <= projection.canonCursor.eventOrder).length;
  const span = Math.max(0, chapter.lastRetrievalOrder - chapter.firstRetrievalOrder);
  const offset = chapterEvents.length > 0
    ? Math.min(span, Math.floor(span * reached / Math.max(1, chapterEvents.length)))
    : 0;
  return chapter.firstRetrievalOrder + offset;
}

export function buildSourceContextFromCorpus(
  corpus: StorySourceCorpus,
  projection: StoryProjection,
  plan: StoryPlan,
  query: string,
  semanticChunkIds: readonly string[] = [],
  warnings: string[] = [],
  vectorProgress: SillyTavernVectorProgress | null = null
): RuntimeStorySourceContext {
  const cursorOrder = resolveSourceCursorOrder(corpus, projection, plan);
  const defaults = corpus.index.retrievalDefaults;
  const allowedThroughCursor = { maxChunkOrder: cursorOrder };
  const sequential = sourceSequentialWindow(
    corpus.retrievalChunks,
    cursorOrder,
    defaults.sequentialBefore,
    0,
    allowedThroughCursor
  );
  const sequentialIds = sequential.map(chunk => chunk.id);
  const relatedLimit = projection.divergence.structuralLevel >= 0.75
    ? Math.min(2, defaults.semanticTopK)
    : defaults.semanticTopK;
  const related = retrieveStorySource({
    query,
    chunks: corpus.retrievalChunks,
    embeddings: corpus.embeddings,
    semanticChunkIds,
    cursorOrder,
    filter: { maxChunkOrder: cursorOrder, excludedChunkIds: sequentialIds },
    limit: relatedLimit
  });
  const styleCandidate = related.find(result => result.chunk.chapterOrder === sequential.at(-1)?.chapterOrder)?.chunk
    ?? sequential.at(-1);
  const futureController = projection.divergence.structuralLevel >= 0.75
    ? []
    : sourceSequentialWindow(
        corpus.retrievalChunks,
        cursorOrder,
        0,
        defaults.sequentialAfter,
        { minChunkOrder: cursorOrder + 1 }
      );
  const compileTargetChunkId = futureController[0]?.id ?? sequential.at(-1)?.id;
  const compileUnit = compileTargetChunkId
    ? corpus.analysisUnits.find(unit => unit.retrievalChunkIds.includes(compileTargetChunkId)) ?? null
    : null;
  return {
    corpusId: corpus.index.corpusId,
    cursorOrder,
    sequential,
    related,
    style: styleCandidate ? [styleCandidate] : [],
    futureController,
    compileUnit,
    progress: sourceProgress(corpus, cursorOrder, vectorProgress),
    warnings
  };
}

function sourceQuery(context: SillyTavernContext, projection: StoryProjection): string {
  const recent = context.chat
    .filter(message => !message.is_system && typeof message.mes === 'string' && message.mes.trim())
    .slice(-4)
    .map(message => message.mes!.trim())
    .join('\n');
  const threads = Object.values(projection.openThreads)
    .filter(thread => thread.status === 'open')
    .map(thread => thread.title)
    .join('；');
  return `${recent}\n${projection.location.area} ${projection.location.place} ${threads}`.trim().slice(-6000);
}

export async function loadRuntimeStorySourceContext(
  context: SillyTavernContext,
  story: ActiveStory,
  projection: StoryProjection
): Promise<RuntimeStorySourceContext | null> {
  const digest = story.card.package_digest;
  if (story.source !== 'psychebook' || !digest) return null;
  const corpus = await getInstalledStorySource(digest);
  if (!corpus) return null;
  const query = sourceQuery(context, projection);
  const cursorOrder = resolveSourceCursorOrder(corpus, projection, story.plan);
  const priority = sourceSequentialWindow(corpus.retrievalChunks, cursorOrder, 2, 2).map(chunk => chunk.chunkOrder);
  const warnings: string[] = [];
  let semanticChunkIds: string[] = [];
  let vectorProgress: SillyTavernVectorProgress | null = null;
  try {
    const vectorResult = await querySillyTavernSourceVectorsWithProgress(
      context,
      digest,
      corpus,
      query,
      corpus.index.retrievalDefaults.semanticTopK,
      { maxInsertItems: 64, priorityChunkOrders: priority }
    );
    semanticChunkIds = vectorResult.chunkIds;
    vectorProgress = vectorResult.progress;
  } catch (error) {
    warnings.push(`酒馆向量检索不可用，已保留顺序与关键词检索：${error instanceof Error ? error.message : String(error)}`);
  }
  return buildSourceContextFromCorpus(
    corpus, projection, story.plan, query, semanticChunkIds, warnings, vectorProgress
  );
}
