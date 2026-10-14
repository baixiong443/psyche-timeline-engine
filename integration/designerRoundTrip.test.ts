import 'fake-indexeddb/auto';
import {
  buildPsycheBookBytes,
  type PsycheTimelineProjectState
} from '../../character-card-designer/app/lib/psycheTimeline';
import { buildStorySourceCorpus } from '../../character-card-designer/app/lib/storySource';
import { ensureLazySourceCompilation, mergeCompiledEventsIntoPlan } from '../src/ai/sourceCompiler';
import { buildRuntimeInjection } from '../src/engine/injection';
import { buildSourceContextFromCorpus } from '../src/engine/sourceContext';
import { createEmptyProjection } from '../src/model/defaults';
import type { StoryEvent } from '../src/model/types';
import type { SillyTavernContext } from '../src/runtime/context';
import { DEFAULT_SETTINGS } from '../src/runtime/settings';
import type { ActiveStory } from '../src/runtime/story';
import {
  getInstalledPsycheBook,
  installPsycheBook,
  parsePsycheBookBytes,
  resetPackageDatabaseForTests
} from '../src/storage/packageDb';
import {
  getCompiledSourceEvents,
  getInstalledStorySource,
  resetStorySourceDatabaseForTests
} from '../src/storage/sourceDb';

function designerState(): PsycheTimelineProjectState {
  const initialState = createEmptyProjection('roundtrip-story');
  initialState.canonCursor = { chapterId: 'chapter-1', sceneId: 'station', eventOrder: 0 };
  initialState.location = { area: '云岬', place: '旧观测站', position: '大厅' };
  initialState.characters.guide = { present: true };
  initialState.characters.user_role = { present: true };
  return {
    schemaVersion: 1,
    card: {
      schema_version: '1.0',
      story_id: 'roundtrip-story',
      entry_point: { chapter_id: 'chapter-1', scene_id: 'station' },
      bindings: { character_id: 'guide', user_role_id: 'user_role' },
      mode_defaults: { participation: 'adaptive', audit: 'strict', auto_apply: false }
    },
    plan: {
      schemaVersion: 1,
      storyId: 'roundtrip-story',
      title: '云岬观测站',
      initialState,
      events: []
    },
    trajectoryNotes: '',
    sourceFingerprint: 'roundtrip-source-v1',
    createdAt: '2026-07-15T00:00:00.000Z'
  };
}

afterEach(async () => {
  await resetPackageDatabaseForTests();
  await resetStorySourceDatabaseForTests();
});

describe('Character Card Designer to PTE progressive source round trip', () => {
  it('exports, installs, retrieves and reuses an audited lazy compilation without future leakage', async () => {
    const state = designerState();
    const stationPages = Array.from(
      { length: 260 },
      (_, index) => `第${String(index + 1).padStart(3, '0')}页：顾遥核对昨夜的气压记录，页边留有不同的校准编号。`
    ).join('');
    const stormPages = Array.from(
      { length: 260 },
      (_, index) => `第${String(index + 1).padStart(3, '0')}号云图：远方雷暴的移动方向仍只供剧情控制器判断。`
    ).join('');
    const text = [
      '第一章 旧观测站',
      stationPages,
      '第二章 云层背后',
      stormPages
    ].join('\n');
    const corpus = buildStorySourceCorpus(
      text,
      state.plan!.storyId,
      state.sourceFingerprint!,
      'balanced',
      '2026-07-15T00:00:00.000Z'
    );
    const bytes = buildPsycheBookBytes(state, '1.1.0', corpus);

    const parsed = await parsePsycheBookBytes(bytes);
    expect(parsed.source?.index.corpusId).toBe(corpus.index.corpusId);
    expect(parsed.source?.retrievalChunks.length).toBe(corpus.retrievalChunks.length);
    await installPsycheBook(parsed);

    expect((await getInstalledPsycheBook(parsed.digest))?.source).toBeUndefined();
    const installed = await getInstalledStorySource(parsed.digest);
    expect(installed?.analysisUnits.length).toBe(corpus.analysisUnits.length);
    expect(installed?.retrievalChunks.map(chunk => chunk.id)).toEqual(
      corpus.retrievalChunks.map(chunk => chunk.id)
    );

    const story: ActiveStory = {
      source: 'psychebook',
      card: parsed.card,
      plan: parsed.plan,
      packageStatus: 'verified',
      packageVersion: parsed.manifest.version
    };
    const projection = structuredClone(parsed.plan.initialState);
    const sourceContext = buildSourceContextFromCorpus(installed!, projection, parsed.plan, '气压记录');
    expect(sourceContext.sequential.every(chunk => chunk.chunkOrder <= sourceContext.cursorOrder)).toBe(true);
    expect(sourceContext.related.every(result => result.chunk.chunkOrder <= sourceContext.cursorOrder)).toBe(true);
    expect(sourceContext.futureController.every(chunk => chunk.chunkOrder > sourceContext.cursorOrder)).toBe(true);
    expect(sourceContext.futureController.length).toBeGreaterThan(0);

    const injection = buildRuntimeInjection({
      projection,
      candidates: [],
      card: parsed.card,
      sourceContext,
      maxChars: 20_000
    });
    const futureTail = sourceContext.futureController[0]!.text.replace(/\s+/g, ' ').trim().slice(-100);
    expect(injection).not.toContain(futureTail);
    expect(injection).not.toContain('FutureController');

    const unit = sourceContext.compileUnit!;
    const event: StoryEvent = {
      id: 'lazy-weather-shift',
      chapterId: 'chapter-1',
      sceneId: 'station',
      canonicalOrder: 1,
      kind: 'soft_anchor',
      rigidity: 'soft',
      summary: '气压记录显示天气即将变化。',
      participants: [],
      effects: [],
      narrativePurposes: [],
      evidenceRefs: [unit.retrievalChunkIds[0]!],
      revealPolicy: 'eligible_only',
      adaptation: { allowDelay: true, allowRelocation: true, allowSubstitution: false }
    };
    const response = `<<<PTE_SOURCE_WINDOW_JSON>>>\n${JSON.stringify({
      schemaVersion: 1,
      sourceUnitId: unit.id,
      events: [event]
    })}\n<<<END_PTE_SOURCE_WINDOW_JSON>>>`;
    const generateRaw = vi.fn().mockResolvedValue(response);
    const context = {
      generateRaw,
      eventTypes: {},
      eventSource: { on: vi.fn() }
    } as unknown as SillyTavernContext;

    expect(await ensureLazySourceCompilation(
      context, story, projection, sourceContext, DEFAULT_SETTINGS
    )).toEqual([event]);
    expect(generateRaw).toHaveBeenCalledTimes(2);
    expect(await getCompiledSourceEvents(parsed.digest)).toEqual([event]);

    const reloadedPlan = mergeCompiledEventsIntoPlan(parsed.plan, await getCompiledSourceEvents(parsed.digest));
    expect(reloadedPlan.events.map(item => item.id)).toEqual(['lazy-weather-shift']);
    expect(reloadedPlan.initialState.canonEvents['lazy-weather-shift']).toBe('locked');

    expect(await ensureLazySourceCompilation(
      context, { ...story, plan: reloadedPlan }, projection, sourceContext, DEFAULT_SETTINGS
    )).toEqual([event]);
    expect(generateRaw).toHaveBeenCalledTimes(2);
  });
});
