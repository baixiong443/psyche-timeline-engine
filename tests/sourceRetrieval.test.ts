import type { StorySourceEmbeddingRecord, StorySourceRetrievalChunk } from '../src/model/source';
import {
  retrieveStorySource,
  sourceCosineSimilarity,
  sourceSequentialWindow,
} from '../src/engine/sourceRetrieval';

function chunk(order: number, text: string, chapterOrder = Math.floor(order / 2)): StorySourceRetrievalChunk {
  return {
    schemaVersion: 1,
    id: `R${String(order + 1).padStart(6, '0')}`,
    chapterId: `C${String(chapterOrder + 1).padStart(4, '0')}`,
    chapterOrder,
    chunkOrder: order,
    title: `第${chapterOrder + 1}章`,
    startOffset: order * 100,
    endOffset: order * 100 + text.length,
    text,
    contentHash: `hash-${order}`,
    keywordTokens: [],
  };
}

const chunks = [
  chunk(0, '林砚把铜钥匙藏进外套。'),
  chunk(1, '旧港下起了暴雨。'),
  chunk(2, '周宁在灯塔前等待失踪的船。', 1),
  chunk(3, '第三章才出现的密道不能提前泄露。', 2),
] as const;

describe('runtime progressive source retrieval', () => {
  it('keeps the sequential window ordered and blocks future chapters', () => {
    expect(sourceSequentialWindow(
      [chunks[3], chunks[1], chunks[2], chunks[0]],
      2,
      1,
      2,
      { maxChapterOrder: 1 },
    ).map(item => item.chunkOrder)).toEqual([1, 2]);
  });

  it('fuses keyword and semantic candidates with the same metadata boundary', () => {
    const embeddings: StorySourceEmbeddingRecord[] = [
      { schemaVersion: 1, chunkId: chunks[0].id, modelKey: 'test', vector: [0, 1] },
      { schemaVersion: 1, chunkId: chunks[1].id, modelKey: 'test', vector: [1, 0] },
      { schemaVersion: 1, chunkId: chunks[2].id, modelKey: 'test', vector: [1] },
    ];
    const results = retrieveStorySource({
      query: '铜钥匙',
      queryVector: [1, 0],
      chunks,
      embeddings,
      filter: { maxChapterOrder: 1 },
      limit: 8,
    });
    expect(results.find(result => result.chunk.id === chunks[0].id)?.keywordRank).toBeTruthy();
    expect(results.find(result => result.chunk.id === chunks[1].id)?.semanticRank).toBeTruthy();
    expect(results.some(result => result.chunk.id === chunks[2].id)).toBe(false);
    expect(results.some(result => result.chunk.id === chunks[3].id)).toBe(false);
    expect(sourceCosineSimilarity([Number.NaN], [1])).toBe(0);
  });

  it('falls back to keyword retrieval when embeddings are unavailable', () => {
    const results = retrieveStorySource({ query: '灯塔', queryVector: [1, 0], chunks });
    expect(results[0]!.chunk.id).toBe(chunks[2].id);
    expect(results[0]!.reasons).toContain('关键词排名 1');
  });
});
