import { strToU8, zipSync } from 'fflate';
import { createEmptyProjection } from '../src/model/defaults';
import { parsePsycheBookBytes } from '../src/storage/packageDb';

function validBook(
  extra: Record<string, Uint8Array> = {},
  manifestExtra: Record<string, unknown> = {}
): Uint8Array {
  const projection = createEmptyProjection('story-1');
  const manifest = {
    schema_version: '1.0',
    format: 'psychebook',
    story_id: 'story-1',
    title: '中文测试故事',
    version: '1.0.0',
    bindings: { character_id: 'hero' },
    ...manifestExtra
  };
  const story = {
    schemaVersion: 1,
    storyId: 'story-1',
    title: '中文测试故事',
    initialState: projection,
    events: []
  };
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'story.json': strToU8(JSON.stringify(story)),
    ...extra
  });
}

describe('.psychebook parser', () => {
  it('loads a valid package and binds its digest', async () => {
    const book = await parsePsycheBookBytes(validBook());

    expect(book.manifest.title).toBe('中文测试故事');
    expect(book.plan.storyId).toBe('story-1');
    expect(book.card.bindings.character_id).toBe('hero');
    expect(book.card.package_digest).toBe(book.digest);
    expect(book.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(book.source).toBeUndefined();
  });

  it('loads an optional progressive source while keeping embeddings rebuildable', async () => {
    const chunks = [
      { schemaVersion: 1, id: 'R000001', chapterId: 'C0001', chapterOrder: 0, chunkOrder: 0, title: '第一章', startOffset: 0, endOffset: 8, text: '雾港仍未亮灯。', contentHash: 'hash-1', keywordTokens: ['雾港'] },
      { schemaVersion: 1, id: 'R000002', chapterId: 'C0001', chapterOrder: 0, chunkOrder: 1, title: '第一章', startOffset: 7, endOffset: 15, text: '林砚收起钥匙。', contentHash: 'hash-2', keywordTokens: ['钥匙'] }
    ];
    const index = {
      schemaVersion: 1,
      storyId: 'story-1',
      corpusId: 'story-1:fp-1',
      sourceFingerprint: 'fp-1',
      sourceLength: 15,
      preparationMode: 'quick',
      chapters: [{ id: 'C0001', order: 0, title: '第一章', startOffset: 0, endOffset: 15, firstRetrievalOrder: 0, lastRetrievalOrder: 1, firstAnalysisOrder: 0, lastAnalysisOrder: 0 }],
      retrievalChunkCount: 2,
      analysisUnitCount: 1,
      embedding: { provider: 'custom', model: 'embed-test', dimensions: 3, normalized: true, distance: 'cosine', indexFingerprint: 'vector-fp' },
      retrievalDefaults: { sequentialBefore: 1, sequentialAfter: 2, semanticTopK: 6, keywordTopK: 6, maxContextChars: 16000 },
      createdAt: '2026-07-15T00:00:00.000Z'
    };
    const sourceDescriptor = {
      schema_version: 1,
      index: 'source/index.json',
      chunks: 'source/chunks.jsonl'
    };
    const book = await parsePsycheBookBytes(validBook({
      'source/index.json': strToU8(JSON.stringify(index)),
      'source/chunks.jsonl': strToU8([...chunks].reverse().map(item => JSON.stringify(item)).join('\n'))
    }, { source: sourceDescriptor }));

    expect(book.source?.retrievalChunks.map(item => item.id)).toEqual(['R000001', 'R000002']);
    expect(book.source?.embeddings).toEqual([]);
    expect(book.source?.index.embedding?.model).toBe('embed-test');
  });

  it('rejects source count drift and invalid embedding dimensions', async () => {
    const index = {
      schemaVersion: 1,
      storyId: 'story-1',
      corpusId: 'story-1:fp-1',
      sourceFingerprint: 'fp-1',
      sourceLength: 10,
      preparationMode: 'balanced',
      chapters: [{ id: 'C0001', order: 0, title: '第一章', startOffset: 0, endOffset: 10, firstRetrievalOrder: 0, lastRetrievalOrder: 0, firstAnalysisOrder: 0, lastAnalysisOrder: 0 }],
      retrievalChunkCount: 2,
      analysisUnitCount: 1,
      embedding: { provider: 'custom', model: 'embed-test', dimensions: 3, normalized: true, distance: 'cosine', indexFingerprint: 'vector-fp' },
      retrievalDefaults: { sequentialBefore: 1, sequentialAfter: 2, semanticTopK: 6, keywordTopK: 6, maxContextChars: 16000 },
      createdAt: '2026-07-15T00:00:00.000Z'
    };
    const chunk = { schemaVersion: 1, id: 'R000001', chapterId: 'C0001', chapterOrder: 0, chunkOrder: 0, title: '第一章', startOffset: 0, endOffset: 10, text: '雾港仍未亮灯。', contentHash: 'hash-1', keywordTokens: ['雾港'] };
    const descriptor = { schema_version: 1, index: 'source/index.json', chunks: 'source/chunks.jsonl' };
    await expect(parsePsycheBookBytes(validBook({
      'source/index.json': strToU8(JSON.stringify(index)),
      'source/chunks.jsonl': strToU8(JSON.stringify(chunk))
    }, { source: descriptor }))).rejects.toThrow('数量 1 与索引声明 2 不一致');

    await expect(parsePsycheBookBytes(validBook({
      'source/index.json': strToU8(JSON.stringify({ ...index, retrievalChunkCount: 1 })),
      'source/chunks.jsonl': strToU8(JSON.stringify(chunk)),
      'source/embeddings.jsonl': strToU8(JSON.stringify({ schemaVersion: 1, chunkId: 'R000001', modelKey: 'custom:embed-test', vector: [0.1] }))
    }, { source: { ...descriptor, embeddings: 'source/embeddings.jsonl' } }))).rejects.toThrow('向量维度与 embedding 配置不一致');
  });

  it('rejects traversal paths and executable content', async () => {
    await expect(parsePsycheBookBytes(validBook({ '../escape.json': strToU8('{}') })))
      .rejects.toThrow('不安全路径');
    await expect(parsePsycheBookBytes(validBook({ 'scripts/run.js': strToU8('alert(1)') })))
      .rejects.toThrow('不安全路径');
  });
});
