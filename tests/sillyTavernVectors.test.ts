import {
  ensureSillyTavernSourceVectors,
  ensureSillyTavernSourceVectorsWithProgress,
  querySillyTavernSourceVectors,
  resolveSillyTavernVectorConfig,
  resetSillyTavernVectorCacheForTests,
  sillyTavernStringHash,
  sourceVectorCollectionId
} from '../src/engine/sillyTavernVectors';
import type { StorySourceCorpus } from '../src/model/source';
import type { SillyTavernContext } from '../src/runtime/context';

function corpus(): StorySourceCorpus {
  const chunks = ['雾港仍未亮灯。', '林砚把铜钥匙藏进外套。'].map((text, index) => ({
    schemaVersion: 1 as const, id: `R00000${index + 1}`, chapterId: 'C0001', chapterOrder: 0,
    chunkOrder: index, title: '第一章', startOffset: index * 10, endOffset: index * 10 + text.length,
    text, contentHash: `hash-${index}`, keywordTokens: []
  }));
  return {
    index: {
      schemaVersion: 1, storyId: 'story-1', corpusId: 'story-1:fp', sourceFingerprint: 'fp', sourceLength: 30,
      preparationMode: 'balanced', chapters: [], retrievalChunkCount: 2, analysisUnitCount: 0, embedding: null,
      retrievalDefaults: { sequentialBefore: 1, sequentialAfter: 2, semanticTopK: 6, keywordTopK: 6, maxContextChars: 16000 },
      createdAt: '2026-07-15T00:00:00.000Z'
    },
    retrievalChunks: chunks,
    analysisUnits: [], embeddings: [], claims: [], compilation: []
  };
}

const context = {
  extensionSettings: { vectors: { source: 'transformers' } },
  getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' })
} as unknown as SillyTavernContext;

afterEach(() => resetSillyTavernVectorCacheForTests());

describe('SillyTavern vector bridge', () => {
  it('matches SillyTavern string hashing and builds stable collection IDs', () => {
    expect(sillyTavernStringHash('雾港 test')).toBe(8590743181775307);
    expect(sourceVectorCollectionId(`sha256:${'a'.repeat(64)}`, 'story-1:fp')).toBe(sourceVectorCollectionId(`sha256:${'a'.repeat(64)}`, 'story-1:fp'));
  });

  it('reuses the active SillyTavern vector source without silent provider fallback', () => {
    const ollama = {
      extensionSettings: { vectors: { source: 'ollama', ollama_model: 'bge-m3' } },
      textCompletionSettings: { server_urls: { ollama: 'http://localhost:11434' } }
    } as unknown as SillyTavernContext;
    expect(resolveSillyTavernVectorConfig(ollama)).toEqual({
      source: 'ollama',
      request: { model: 'bge-m3', apiUrl: 'http://localhost:11434', keep: false }
    });
    const webllm = { extensionSettings: { vectors: { source: 'webllm' } } } as unknown as SillyTavernContext;
    expect(() => resolveSillyTavernVectorConfig(webllm)).toThrow('不会自动切换来源');
  });

  it('inserts only missing chunks and maps query metadata back to stable chunk IDs', async () => {
    const source = corpus();
    const requests: Array<{ path: string; body: Record<string, unknown>; headers: HeadersInit | undefined }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path, body, headers: init?.headers });
      if (path.endsWith('/list')) return new Response(JSON.stringify([]));
      if (path.endsWith('/query')) return new Response(JSON.stringify({ metadata: [{ index: 1 }, { index: 0 }] }));
      return new Response('', { status: 200 });
    };
    const digest = `sha256:${'b'.repeat(64)}`;
    await ensureSillyTavernSourceVectors(context, digest, source, { fetcher });
    const result = await querySillyTavernSourceVectors(context, digest, source, '钥匙', 2, { fetcher });

    expect(requests.filter(item => item.path.endsWith('/insert'))).toHaveLength(1);
    expect(requests.filter(item => item.path.endsWith('/list'))).toHaveLength(1);
    expect(requests[0]?.headers).toMatchObject({ 'X-CSRF-Token': 'token' });
    expect(result).toEqual(['R000002', 'R000001']);
  });

  it('reports partial progressive indexing without treating it as complete', async () => {
    const requests: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      if (path.endsWith('/list')) return new Response(JSON.stringify([]));
      return new Response('', { status: 200 });
    };
    const progress = await ensureSillyTavernSourceVectorsWithProgress(
      context,
      `sha256:${'c'.repeat(64)}`,
      corpus(),
      { fetcher, maxInsertItems: 1 }
    );

    expect(progress).toMatchObject({
      source: 'transformers',
      indexed: 1,
      total: 2,
      insertedThisRun: 1,
      complete: false
    });
    expect(requests.filter(path => path.endsWith('/insert'))).toHaveLength(1);
  });
});
