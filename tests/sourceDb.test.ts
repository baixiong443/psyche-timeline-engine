import 'fake-indexeddb/auto';
import { createEmptyProjection } from '../src/model/defaults';
import type { InstalledPsycheBook } from '../src/model/package';
import type { StorySourceCorpus } from '../src/model/source';
import {
  getInstalledPsycheBook,
  installPsycheBook,
  resetPackageDatabaseForTests
} from '../src/storage/packageDb';
import {
  beginSourceCompilationAttempt,
  getInstalledStorySource,
  getCompiledSourceEvents,
  getSourceCompilationRecord,
  installStorySource,
  markSourceCompilationFailed,
  putCompiledSourceWindow,
  resetSourceCompilationAttempts,
  retrySourceCompilation,
  resetStorySourceDatabaseForTests
} from '../src/storage/sourceDb';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function source(): StorySourceCorpus {
  return {
    index: {
      schemaVersion: 1,
      storyId: 'story-1',
      corpusId: 'story-1:fp-1',
      sourceFingerprint: 'fp-1',
      sourceLength: 20,
      preparationMode: 'balanced',
      chapters: [{ id: 'C0001', order: 0, title: '第一章', startOffset: 0, endOffset: 20, firstRetrievalOrder: 0, lastRetrievalOrder: 0, firstAnalysisOrder: 0, lastAnalysisOrder: 0 }],
      retrievalChunkCount: 1,
      analysisUnitCount: 1,
      embedding: null,
      retrievalDefaults: { sequentialBefore: 1, sequentialAfter: 2, semanticTopK: 6, keywordTopK: 6, maxContextChars: 16000 },
      createdAt: '2026-07-15T00:00:00.000Z'
    },
    retrievalChunks: [{ schemaVersion: 1, id: 'R000001', chapterId: 'C0001', chapterOrder: 0, chunkOrder: 0, title: '第一章', startOffset: 0, endOffset: 20, text: '雾港的信标仍未出现。', contentHash: 'hash-1', keywordTokens: ['雾港'] }],
    analysisUnits: [{ schemaVersion: 1, id: 'A000001', chapterId: 'C0001', chapterOrder: 0, unitOrder: 0, title: '第一章', startOffset: 0, endOffset: 20, text: '雾港的信标仍未出现。', retrievalChunkIds: ['R000001'] }],
    embeddings: [],
    claims: [],
    compilation: []
  };
}

function book(storySource: StorySourceCorpus): InstalledPsycheBook {
  const projection = createEmptyProjection('story-1');
  return {
    digest: DIGEST,
    installedAt: 1,
    manifest: { schema_version: '1.0', format: 'psychebook', story_id: 'story-1', title: '雾港', version: '1.0.0' },
    card: { schema_version: '1.0', story_id: 'story-1', entry_point: { chapter_id: 'chapter-1', scene_id: 'start' }, bindings: { character_id: 'hero' }, package_digest: DIGEST },
    plan: { schemaVersion: 1, storyId: 'story-1', title: '雾港', initialState: projection, events: [] },
    source: storySource,
    files: { 'manifest.json': '{}', 'story.json': '{}', 'source/index.json': '{}', 'source/chunks.jsonl': '{}' }
  };
}

function lazyEvent(id: string, canonicalOrder: number) {
  return {
    id, chapterId: 'chapter-1', sceneId: 'dock', canonicalOrder,
    kind: 'soft_anchor' as const, rigidity: 'soft' as const, summary: `事件 ${id}`,
    participants: [], effects: [], narrativePurposes: [], evidenceRefs: ['R000001'],
    revealPolicy: 'eligible_only' as const,
    adaptation: { allowDelay: true, allowRelocation: true, allowSubstitution: false }
  };
}

afterEach(async () => {
  await resetPackageDatabaseForTests();
  await resetStorySourceDatabaseForTests();
});

describe('installed progressive source storage', () => {
  it('reconstructs a normalized source corpus by package digest', async () => {
    const input = source();
    await installStorySource(DIGEST, input);
    expect(await getInstalledStorySource(DIGEST)).toEqual(input);
  });

  it('removes duplicated source payloads from the package record during installation', async () => {
    const input = source();
    await installPsycheBook(book(input));
    const storedBook = await getInstalledPsycheBook(DIGEST);
    expect(storedBook?.source).toBeUndefined();
    expect(storedBook?.files['source/index.json']).toBeUndefined();
    expect((await getInstalledStorySource(DIGEST))?.retrievalChunks[0]?.id).toBe('R000001');
  });

  it('persists audited L4 events separately from the immutable package plan', async () => {
    await installStorySource(DIGEST, source());
    const event = lazyEvent('event-lazy', 1);
    await putCompiledSourceWindow(DIGEST, 'A000001', [event]);
    expect(await getCompiledSourceEvents(DIGEST)).toEqual([event]);
    expect(await getSourceCompilationRecord(DIGEST, 'A000001')).toMatchObject({
      level: 4,
      deepCompilationStatus: 'completed',
      eventIds: ['event-lazy']
    });
  });

  it('rejects duplicate event orders across independently compiled windows', async () => {
    await installStorySource(DIGEST, source());
    const first = lazyEvent('event-first', 1);
    await putCompiledSourceWindow(DIGEST, 'A000001', [first]);

    await expect(putCompiledSourceWindow(DIGEST, 'A000002', [
      lazyEvent('event-second', 1)
    ])).rejects.toThrow('事件顺序冲突：1');
    expect(await getCompiledSourceEvents(DIGEST)).toEqual([first]);
  });

  it('never merges events whose compilation record is failed', async () => {
    await installStorySource(DIGEST, source());
    await putCompiledSourceWindow(DIGEST, 'A000001', [lazyEvent('event-failed', 1)]);
    await markSourceCompilationFailed(DIGEST, 'A000001', '独立审计未通过');

    expect(await getCompiledSourceEvents(DIGEST)).toEqual([]);
    expect(await getSourceCompilationRecord(DIGEST, 'A000001')).toMatchObject({
      deepCompilationStatus: 'failed',
      error: '独立审计未通过'
    });
  });

  it('limits consecutive AI attempts and requires an explicit diagnostic reset', async () => {
    await installStorySource(DIGEST, source());
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await beginSourceCompilationAttempt(DIGEST, 'A000001', attempt * 1000)).toBe('started');
      await markSourceCompilationFailed(DIGEST, 'A000001', `失败 ${attempt}`);
      if (attempt < 3) await retrySourceCompilation(DIGEST, 'A000001');
    }

    await expect(retrySourceCompilation(DIGEST, 'A000001')).rejects.toThrow('连续编译上限（3/3）');
    expect(await getSourceCompilationRecord(DIGEST, 'A000001')).toMatchObject({
      attemptCount: 3,
      maxAttempts: 3,
      deepCompilationStatus: 'failed'
    });

    await resetSourceCompilationAttempts(DIGEST, 'A000001');
    expect(await getSourceCompilationRecord(DIGEST, 'A000001')).toMatchObject({
      attemptCount: 0,
      maxAttempts: 3,
      deepCompilationStatus: 'pending'
    });
  });
});
