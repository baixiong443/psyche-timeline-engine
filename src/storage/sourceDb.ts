import { deleteDB, openDB, type DBSchema, type IDBPTransaction } from 'idb';
import {
  SOURCE_COMPILATION_MAX_ATTEMPTS,
  SOURCE_COMPILATION_STALE_MS,
  SOURCE_DB_NAME,
  SOURCE_DB_VERSION
} from '../constants';
import type {
  StoryEvidenceClaim,
  StorySourceAnalysisUnit,
  StorySourceCompilationRecord,
  StorySourceCorpus,
  StorySourceEmbeddingRecord,
  StorySourceIndex,
  StorySourceRetrievalChunk
} from '../model/source';
import type { StoryEvent } from '../model/types';

type StoredChunk = StorySourceRetrievalChunk & { corpusId: string };
type StoredAnalysis = StorySourceAnalysisUnit & { corpusId: string };
type StoredEmbedding = StorySourceEmbeddingRecord & { corpusId: string };
type StoredClaim = StoryEvidenceClaim & { corpusId: string };
type StoredCompilation = StorySourceCompilationRecord & { corpusId: string };
type StoredCompiledEvent = StoryEvent & { corpusId: string; sourceUnitId: string };

interface SourceDatabase extends DBSchema {
  bindings: {
    key: string;
    value: { digest: string; corpusId: string };
    indexes: { 'by-corpus': string };
  };
  indexes: { key: string; value: StorySourceIndex };
  chunks: {
    key: [string, number];
    value: StoredChunk;
    indexes: { 'by-corpus': string };
  };
  analysis: {
    key: [string, number];
    value: StoredAnalysis;
    indexes: { 'by-corpus': string };
  };
  embeddings: {
    key: [string, string, string];
    value: StoredEmbedding;
    indexes: { 'by-corpus': string };
  };
  claims: {
    key: [string, string];
    value: StoredClaim;
    indexes: { 'by-corpus': string };
  };
  compilation: {
    key: [string, string];
    value: StoredCompilation;
    indexes: { 'by-corpus': string };
  };
  compiledEvents: {
    key: [string, string];
    value: StoredCompiledEvent;
    indexes: { 'by-corpus': string; 'by-unit': [string, string] };
  };
}

let databasePromise: ReturnType<typeof openDB<SourceDatabase>> | null = null;

function sourceDb() {
  databasePromise ??= openDB<SourceDatabase>(SOURCE_DB_NAME, SOURCE_DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('bindings')) {
        const store = db.createObjectStore('bindings', { keyPath: 'digest' });
        store.createIndex('by-corpus', 'corpusId');
      }
      if (!db.objectStoreNames.contains('indexes')) db.createObjectStore('indexes', { keyPath: 'corpusId' });
      if (!db.objectStoreNames.contains('chunks')) {
        const store = db.createObjectStore('chunks', { keyPath: ['corpusId', 'chunkOrder'] });
        store.createIndex('by-corpus', 'corpusId');
      }
      if (!db.objectStoreNames.contains('analysis')) {
        const store = db.createObjectStore('analysis', { keyPath: ['corpusId', 'unitOrder'] });
        store.createIndex('by-corpus', 'corpusId');
      }
      if (!db.objectStoreNames.contains('embeddings')) {
        const store = db.createObjectStore('embeddings', { keyPath: ['corpusId', 'modelKey', 'chunkId'] });
        store.createIndex('by-corpus', 'corpusId');
      }
      if (!db.objectStoreNames.contains('claims')) {
        const store = db.createObjectStore('claims', { keyPath: ['corpusId', 'id'] });
        store.createIndex('by-corpus', 'corpusId');
      }
      if (!db.objectStoreNames.contains('compilation')) {
        const store = db.createObjectStore('compilation', { keyPath: ['corpusId', 'sourceUnitId'] });
        store.createIndex('by-corpus', 'corpusId');
      }
      if (!db.objectStoreNames.contains('compiledEvents')) {
        const store = db.createObjectStore('compiledEvents', { keyPath: ['corpusId', 'id'] });
        store.createIndex('by-corpus', 'corpusId');
        store.createIndex('by-unit', ['corpusId', 'sourceUnitId']);
      }
    }
  });
  return databasePromise;
}

type SourceStoreName = 'chunks' | 'analysis' | 'embeddings' | 'claims' | 'compilation' | 'compiledEvents';

async function clearCorpusRows(
  transaction: IDBPTransaction<SourceDatabase, Array<'indexes' | SourceStoreName>, 'readwrite'>,
  storeName: SourceStoreName,
  corpusId: string
): Promise<void> {
  const store = transaction.objectStore(storeName);
  let cursor = await store.index('by-corpus').openKeyCursor(IDBKeyRange.only(corpusId));
  while (cursor) {
    await store.delete(cursor.primaryKey as never);
    cursor = await cursor.continue();
  }
}

export async function installStorySource(digest: string, source: StorySourceCorpus): Promise<void> {
  const db = await sourceDb();
  const stores: Array<'indexes' | SourceStoreName> = ['indexes', 'chunks', 'analysis', 'embeddings', 'claims', 'compilation', 'compiledEvents'];
  const transaction = db.transaction(['bindings', ...stores], 'readwrite');
  const corpusId = source.index.corpusId;
  for (const storeName of stores.slice(1) as SourceStoreName[]) {
    await clearCorpusRows(transaction as IDBPTransaction<SourceDatabase, Array<'indexes' | SourceStoreName>, 'readwrite'>, storeName, corpusId);
  }
  await transaction.objectStore('indexes').put(structuredClone(source.index));
  for (const chunk of source.retrievalChunks) await transaction.objectStore('chunks').put({ ...structuredClone(chunk), corpusId });
  for (const unit of source.analysisUnits) await transaction.objectStore('analysis').put({ ...structuredClone(unit), corpusId });
  for (const embedding of source.embeddings) await transaction.objectStore('embeddings').put({ ...structuredClone(embedding), corpusId });
  for (const claim of source.claims) await transaction.objectStore('claims').put({ ...structuredClone(claim), corpusId });
  for (const record of source.compilation) await transaction.objectStore('compilation').put({ ...structuredClone(record), corpusId });
  await transaction.objectStore('bindings').put({ digest, corpusId });
  await transaction.done;
}

export async function getInstalledStorySource(digest: string): Promise<StorySourceCorpus | undefined> {
  const db = await sourceDb();
  const binding = await db.get('bindings', digest);
  if (!binding) return undefined;
  const index = await db.get('indexes', binding.corpusId);
  if (!index) return undefined;
  const [chunks, analysis, embeddings, claims, compilation] = await Promise.all([
    db.getAllFromIndex('chunks', 'by-corpus', binding.corpusId),
    db.getAllFromIndex('analysis', 'by-corpus', binding.corpusId),
    db.getAllFromIndex('embeddings', 'by-corpus', binding.corpusId),
    db.getAllFromIndex('claims', 'by-corpus', binding.corpusId),
    db.getAllFromIndex('compilation', 'by-corpus', binding.corpusId)
  ]);
  return {
    index,
    retrievalChunks: chunks.sort((left, right) => left.chunkOrder - right.chunkOrder).map(({ corpusId: _, ...value }) => value),
    analysisUnits: analysis.sort((left, right) => left.unitOrder - right.unitOrder).map(({ corpusId: _, ...value }) => value),
    embeddings: embeddings.map(({ corpusId: _, ...value }) => value),
    claims: claims.map(({ corpusId: _, ...value }) => value),
    compilation: compilation.map(({ corpusId: _, ...value }) => value)
  };
}

async function boundCorpusId(digest: string): Promise<string | null> {
  const db = await sourceDb();
  return (await db.get('bindings', digest))?.corpusId ?? null;
}

export async function getCompiledSourceEvents(digest: string): Promise<StoryEvent[]> {
  if (typeof indexedDB === 'undefined') return [];
  const db = await sourceDb();
  const corpusId = await boundCorpusId(digest);
  if (!corpusId) return [];
  const [events, compilation] = await Promise.all([
    db.getAllFromIndex('compiledEvents', 'by-corpus', corpusId),
    db.getAllFromIndex('compilation', 'by-corpus', corpusId)
  ]);
  const completedByUnit = new Map(compilation
    .filter(record => record.level === 4 && record.deepCompilationStatus === 'completed')
    .map(record => [record.sourceUnitId, new Set(record.eventIds)]));
  return events
    .filter(event => completedByUnit.get(event.sourceUnitId)?.has(event.id))
    .sort((left, right) => left.canonicalOrder - right.canonicalOrder)
    .map(({ corpusId: _, sourceUnitId: __, ...event }) => event);
}

export type SourceCompilationAttemptResult = 'started' | 'completed' | 'running' | 'exhausted';

export async function beginSourceCompilationAttempt(
  digest: string,
  sourceUnitId: string,
  now = Date.now()
): Promise<SourceCompilationAttemptResult> {
  const db = await sourceDb();
  const corpusId = await boundCorpusId(digest);
  if (!corpusId) throw new Error('找不到故事包对应的原文库。');
  const transaction = db.transaction('compilation', 'readwrite');
  const store = transaction.objectStore('compilation');
  const previous = await store.get([corpusId, sourceUnitId]);
  if (previous?.level === 4 && previous.deepCompilationStatus === 'completed') {
    await transaction.done;
    return 'completed';
  }
  if (previous?.deepCompilationStatus === 'running'
    && now - previous.updatedAt < SOURCE_COMPILATION_STALE_MS) {
    await transaction.done;
    return 'running';
  }
  const attemptCount = previous?.attemptCount ?? 0;
  const maxAttempts = previous?.maxAttempts ?? SOURCE_COMPILATION_MAX_ATTEMPTS;
  if (attemptCount >= maxAttempts) {
    await store.put({
      schemaVersion: 1,
      sourceUnitId,
      level: previous?.level ?? 0,
      skeletonStatus: previous?.skeletonStatus ?? 'pending',
      auditStatus: previous?.auditStatus ?? 'unreviewed',
      deepCompilationStatus: 'failed',
      eventIds: previous?.eventIds ?? [],
      attemptCount,
      maxAttempts,
      lastAttemptAt: previous?.lastAttemptAt,
      updatedAt: now,
      error: `已达到连续编译上限（${attemptCount}/${maxAttempts}）。请先检查连接配置或提示词，再重置计数。`,
      corpusId
    });
    await transaction.done;
    return 'exhausted';
  }
  await store.put({
    schemaVersion: 1,
    sourceUnitId,
    level: previous?.level ?? 0,
    skeletonStatus: previous?.skeletonStatus ?? 'pending',
    auditStatus: previous?.auditStatus ?? 'unreviewed',
    deepCompilationStatus: 'running',
    eventIds: previous?.eventIds ?? [],
    attemptCount: attemptCount + 1,
    maxAttempts,
    lastAttemptAt: now,
    updatedAt: now,
    corpusId
  });
  await transaction.done;
  return 'started';
}

export async function getSourceCompilationRecord(
  digest: string,
  sourceUnitId: string
): Promise<StorySourceCompilationRecord | undefined> {
  if (typeof indexedDB === 'undefined') return undefined;
  const db = await sourceDb();
  const corpusId = await boundCorpusId(digest);
  if (!corpusId) return undefined;
  const value = await db.get('compilation', [corpusId, sourceUnitId]);
  if (!value) return undefined;
  const { corpusId: _, ...record } = value;
  return record;
}

export async function putCompiledSourceWindow(
  digest: string,
  sourceUnitId: string,
  events: StoryEvent[]
): Promise<void> {
  const db = await sourceDb();
  const corpusId = await boundCorpusId(digest);
  if (!corpusId) throw new Error('找不到故事包对应的原文库。');
  const transaction = db.transaction(['compiledEvents', 'compilation'], 'readwrite');
  const compiledStore = transaction.objectStore('compiledEvents');
  const otherEvents = (await compiledStore.index('by-corpus').getAll(corpusId))
    .filter(event => event.sourceUnitId !== sourceUnitId);
  const otherIds = new Set(otherEvents.map(event => event.id));
  const otherOrders = new Map(otherEvents.map(event => [event.canonicalOrder, event.id]));
  const incomingIds = new Set<string>();
  const incomingOrders = new Set<number>();
  for (const event of events) {
    if (incomingIds.has(event.id) || otherIds.has(event.id)) {
      throw new Error(`原文窗口事件 ID 冲突：${event.id}`);
    }
    if (incomingOrders.has(event.canonicalOrder) || otherOrders.has(event.canonicalOrder)) {
      throw new Error(`原文窗口事件顺序冲突：${event.canonicalOrder}`);
    }
    incomingIds.add(event.id);
    incomingOrders.add(event.canonicalOrder);
  }
  let cursor = await transaction.objectStore('compiledEvents').index('by-unit')
    .openKeyCursor(IDBKeyRange.only([corpusId, sourceUnitId]));
  while (cursor) {
    await transaction.objectStore('compiledEvents').delete(cursor.primaryKey);
    cursor = await cursor.continue();
  }
  for (const event of events) {
    await transaction.objectStore('compiledEvents').put({ ...structuredClone(event), corpusId, sourceUnitId });
  }
  const previous = await transaction.objectStore('compilation').get([corpusId, sourceUnitId]);
  await transaction.objectStore('compilation').put({
    schemaVersion: 1,
    sourceUnitId,
    level: 4,
    skeletonStatus: previous?.skeletonStatus ?? 'completed',
    auditStatus: 'passed',
    deepCompilationStatus: 'completed',
    eventIds: events.map(event => event.id),
    attemptCount: previous?.attemptCount ?? 0,
    maxAttempts: previous?.maxAttempts ?? SOURCE_COMPILATION_MAX_ATTEMPTS,
    lastAttemptAt: previous?.lastAttemptAt,
    updatedAt: Date.now(),
    corpusId
  });
  await transaction.done;
}

export async function markSourceCompilationFailed(
  digest: string,
  sourceUnitId: string,
  error: string
): Promise<void> {
  const db = await sourceDb();
  const corpusId = await boundCorpusId(digest);
  if (!corpusId) return;
  const previous = await db.get('compilation', [corpusId, sourceUnitId]);
  await db.put('compilation', {
    schemaVersion: 1,
    sourceUnitId,
    level: previous?.level ?? 0,
    skeletonStatus: previous?.skeletonStatus ?? 'pending',
    auditStatus: previous?.auditStatus ?? 'unreviewed',
    deepCompilationStatus: 'failed',
    eventIds: previous?.eventIds ?? [],
    attemptCount: previous?.attemptCount ?? 0,
    maxAttempts: previous?.maxAttempts ?? SOURCE_COMPILATION_MAX_ATTEMPTS,
    lastAttemptAt: previous?.lastAttemptAt,
    updatedAt: Date.now(),
    error,
    corpusId
  });
}

export async function retrySourceCompilation(digest: string, sourceUnitId: string): Promise<void> {
  const db = await sourceDb();
  const corpusId = await boundCorpusId(digest);
  if (!corpusId) throw new Error('找不到故事包对应的原文库。');
  const previous = await db.get('compilation', [corpusId, sourceUnitId]);
  if (!previous) throw new Error('找不到要重试的原文编译单元。');
  const attemptCount = previous.attemptCount ?? 0;
  const maxAttempts = previous.maxAttempts ?? SOURCE_COMPILATION_MAX_ATTEMPTS;
  if (attemptCount >= maxAttempts) {
    throw new Error(`当前窗口已达到连续编译上限（${attemptCount}/${maxAttempts}），请先重置计数。`);
  }
  await db.put('compilation', {
    ...previous,
    deepCompilationStatus: 'pending',
    updatedAt: Date.now(),
    error: undefined
  });
}

export async function resetSourceCompilationAttempts(digest: string, sourceUnitId: string): Promise<void> {
  const db = await sourceDb();
  const corpusId = await boundCorpusId(digest);
  if (!corpusId) throw new Error('找不到故事包对应的原文库。');
  const previous = await db.get('compilation', [corpusId, sourceUnitId]);
  if (!previous) throw new Error('找不到要重置的原文编译单元。');
  await db.put('compilation', {
    ...previous,
    deepCompilationStatus: 'pending',
    attemptCount: 0,
    maxAttempts: SOURCE_COMPILATION_MAX_ATTEMPTS,
    lastAttemptAt: undefined,
    updatedAt: Date.now(),
    error: undefined
  });
}

export async function resetStorySourceDatabaseForTests(): Promise<void> {
  const db = await databasePromise;
  db?.close();
  databasePromise = null;
  await deleteDB(SOURCE_DB_NAME);
}
