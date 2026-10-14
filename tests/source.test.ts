import {
  validateStorySourceChunk,
  validateStorySourceEmbedding,
  validateStorySourceIndex,
  type StorySourceEmbeddingConfig
} from '../src/model/source';

describe('progressive story source contract', () => {
  const index = {
    schemaVersion: 1,
    storyId: 'story-1',
    corpusId: 'story-1:fp-1',
    sourceFingerprint: 'fp-1',
    sourceLength: 1200,
    preparationMode: 'balanced',
    chapters: [{
      id: 'C0001', order: 0, title: '第一章', startOffset: 0, endOffset: 1200,
      firstRetrievalOrder: 0, lastRetrievalOrder: 0, firstAnalysisOrder: 0, lastAnalysisOrder: 0
    }],
    retrievalChunkCount: 1,
    analysisUnitCount: 1,
    embedding: null,
    retrievalDefaults: {
      sequentialBefore: 1, sequentialAfter: 2, semanticTopK: 6, keywordTopK: 6, maxContextChars: 16000
    },
    createdAt: '2026-07-15T00:00:00.000Z'
  };

  it('accepts a valid progressive source index and rejects incompatible dimensions', () => {
    expect(validateStorySourceIndex(index)).toMatchObject({ valid: true, errors: [] });
    expect(validateStorySourceIndex({
      ...index,
      embedding: { provider: 'custom', model: 'test', dimensions: 0, normalized: true, distance: 'cosine', indexFingerprint: 'x' }
    }).errors).toContain('embedding.dimensions 无效');
  });

  it('validates retrieval chunks and embedding records independently', () => {
    const chunk = {
      schemaVersion: 1,
      id: 'R000001',
      chapterId: 'C0001',
      chapterOrder: 0,
      chunkOrder: 0,
      title: '第一章',
      startOffset: 0,
      endOffset: 20,
      text: '雾港的信标仍未出现。',
      contentHash: 'fnv1a:12345678',
      keywordTokens: ['雾港', '信标']
    };
    expect(validateStorySourceChunk(chunk)).toMatchObject({ valid: true, errors: [] });
    const config: StorySourceEmbeddingConfig = {
      provider: 'custom', model: 'embed-test', dimensions: 3, normalized: true,
      distance: 'cosine', indexFingerprint: 'fp-vector'
    };
    expect(validateStorySourceEmbedding({
      schemaVersion: 1,
      chunkId: 'R000001',
      modelKey: 'custom:embed-test',
      vector: [0.1, 0.2, 0.3]
    }, config, new Set(['R000001']))).toMatchObject({ valid: true, errors: [] });
    expect(validateStorySourceEmbedding({
      schemaVersion: 1,
      chunkId: 'R000001',
      modelKey: 'custom:embed-test',
      vector: [0.1]
    }, config, new Set(['R000001'])).errors).toContain('向量维度与 embedding 配置不一致');
  });
});
