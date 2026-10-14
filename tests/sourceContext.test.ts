import { buildSourceContextFromCorpus, resolveSourceCursorOrder } from '../src/engine/sourceContext';
import { createEmptyProjection } from '../src/model/defaults';
import type { StorySourceCorpus } from '../src/model/source';
import type { StoryPlan } from '../src/model/types';

function fixture(): { corpus: StorySourceCorpus; plan: StoryPlan } {
  const chunks = Array.from({ length: 6 }, (_, order) => ({
    schemaVersion: 1 as const,
    id: `R${String(order + 1).padStart(6, '0')}`,
    chapterId: order < 3 ? 'C0001' : 'C0002',
    chapterOrder: order < 3 ? 0 : 1,
    chunkOrder: order,
    title: order < 3 ? '第一章 雾港' : '第二章 灯塔',
    startOffset: order * 100,
    endOffset: order * 100 + 20,
    text: order === 0 ? '铜钥匙藏在外套里。' : `原文片段 ${order}`,
    contentHash: `hash-${order}`,
    keywordTokens: []
  }));
  const corpus: StorySourceCorpus = {
    index: {
      schemaVersion: 1, storyId: 'story-1', corpusId: 'story-1:fp', sourceFingerprint: 'fp', sourceLength: 600,
      preparationMode: 'balanced',
      chapters: [
        { id: 'C0001', order: 0, title: '第一章 雾港', startOffset: 0, endOffset: 300, firstRetrievalOrder: 0, lastRetrievalOrder: 2, firstAnalysisOrder: 0, lastAnalysisOrder: 0 },
        { id: 'C0002', order: 1, title: '第二章 灯塔', startOffset: 300, endOffset: 600, firstRetrievalOrder: 3, lastRetrievalOrder: 5, firstAnalysisOrder: 1, lastAnalysisOrder: 1 }
      ],
      retrievalChunkCount: 6, analysisUnitCount: 2, embedding: null,
      retrievalDefaults: { sequentialBefore: 1, sequentialAfter: 2, semanticTopK: 4, keywordTopK: 4, maxContextChars: 16000 },
      createdAt: '2026-07-15T00:00:00.000Z'
    },
    retrievalChunks: chunks,
    analysisUnits: [
      { schemaVersion: 1, id: 'A000001', chapterId: 'C0001', chapterOrder: 0, unitOrder: 0, title: '第一章 雾港', startOffset: 0, endOffset: 300, text: '第一章原文', retrievalChunkIds: ['R000001', 'R000002', 'R000003'] },
      { schemaVersion: 1, id: 'A000002', chapterId: 'C0002', chapterOrder: 1, unitOrder: 1, title: '第二章 灯塔', startOffset: 300, endOffset: 600, text: '第二章原文', retrievalChunkIds: ['R000004', 'R000005', 'R000006'] }
    ],
    embeddings: [], claims: [], compilation: []
  };
  const projection = createEmptyProjection('story-1');
  const plan: StoryPlan = {
    schemaVersion: 1, storyId: 'story-1', title: '雾港', initialState: projection,
    events: [
      { id: 'e0', chapterId: 'chapter-1', sceneId: 's0', canonicalOrder: 0, kind: 'soft_anchor', rigidity: 'soft', summary: '起点', participants: [], effects: [], narrativePurposes: [], evidenceRefs: [], revealPolicy: 'eligible_only', adaptation: { allowDelay: true, allowRelocation: true, allowSubstitution: true } },
      { id: 'e1', chapterId: 'chapter-2', sceneId: 's1', canonicalOrder: 1, kind: 'soft_anchor', rigidity: 'soft', summary: '灯塔', participants: [], effects: [], narrativePurposes: [], evidenceRefs: [], revealPolicy: 'eligible_only', adaptation: { allowDelay: true, allowRelocation: true, allowSubstitution: true } }
    ]
  };
  return { corpus, plan };
}

describe('runtime story source channels', () => {
  it('maps canon chapter labels to source order and never places future chunks in narrator channels', () => {
    const { corpus, plan } = fixture();
    const projection = createEmptyProjection('story-1');
    projection.canonCursor = { chapterId: 'chapter-2', sceneId: 's1', eventOrder: 1 };
    const cursor = resolveSourceCursorOrder(corpus, projection, plan);
    expect(cursor).toBeGreaterThanOrEqual(3);
    const context = buildSourceContextFromCorpus(corpus, projection, plan, '铜钥匙', ['R000001', 'R000006']);
    expect(context.sequential.every(chunk => chunk.chunkOrder <= cursor)).toBe(true);
    expect(context.related.every(result => result.chunk.chunkOrder <= cursor)).toBe(true);
    expect(context.futureController.every(chunk => chunk.chunkOrder > cursor)).toBe(true);
    expect(context.compileUnit?.id).toBeTruthy();
    expect(context.progress).toMatchObject({
      preparationMode: 'balanced',
      cursorOrder: cursor,
      retrievalChunkCount: 6,
      analysisUnitCount: 2,
      l3Count: 0,
      l4Count: 0,
      vector: null
    });
  });

  it('removes future controller source after a high-divergence branch', () => {
    const { corpus, plan } = fixture();
    const projection = createEmptyProjection('story-1');
    projection.canonCursor = { chapterId: 'chapter-1', sceneId: 's0', eventOrder: 0 };
    projection.divergence = { structuralLevel: 0.8, summary: '主线通道已经被毁。' };
    const context = buildSourceContextFromCorpus(corpus, projection, plan, '钥匙');
    expect(context.futureController).toEqual([]);
    expect(context.related.length).toBeLessThanOrEqual(2);
  });
});
