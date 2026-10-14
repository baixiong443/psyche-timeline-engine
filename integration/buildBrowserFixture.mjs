import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { buildPsycheBookBytes } from '../../character-card-designer/app/lib/psycheTimeline.ts';
import { buildStorySourceCorpus } from '../../character-card-designer/app/lib/storySource.ts';

const storyId = 'pte-visible-progressive-fixture';
const initialState = {
  schemaVersion: 1,
  storyId,
  turn: 0,
  canonCursor: { chapterId: 'chapter-1', sceneId: 'station', eventOrder: 0 },
  time: { absolute: null, relativeMinutes: 0 },
  location: { area: '云岬', place: '旧观测站', position: '大厅' },
  characters: { guide: { present: true }, user_role: { present: true } },
  relationships: {}, inventory: {}, facts: {}, knowledge: {}, flags: {},
  canonEvents: {}, narrativePurposes: {}, openThreads: {}, custom: {}, lockedPaths: [],
  divergence: { structuralLevel: 0, summary: '' },
};
const state = {
  schemaVersion: 1,
  card: {
    schema_version: '1.0',
    story_id: storyId,
    entry_point: { chapter_id: 'chapter-1', scene_id: 'station' },
    bindings: { character_id: 'guide', user_role_id: 'user_role' },
    mode_defaults: { participation: 'adaptive', audit: 'strict', auto_apply: false },
  },
  plan: { schemaVersion: 1, storyId, title: '渐进原文可见验收', initialState, events: [] },
  trajectoryNotes: '',
  sourceFingerprint: 'visible-progressive-source-v1',
  createdAt: '2026-07-15T00:00:00.000Z',
};
const stationPages = Array.from(
  { length: 280 },
  (_, index) => `第${String(index + 1).padStart(3, '0')}页：顾遥核对昨夜的气压记录，页边留有不同的校准编号。`,
).join('');
const stormPages = Array.from(
  { length: 280 },
  (_, index) => `第${String(index + 1).padStart(3, '0')}号云图：远方雷暴的移动方向仍只供剧情控制器判断。`,
).join('');
const corpus = buildStorySourceCorpus(
  `第一章 旧观测站\n${stationPages}\n第二章 云层背后\n${stormPages}`,
  storyId,
  state.sourceFingerprint,
  'balanced',
  state.createdAt,
);
const output = resolve('tmp/progressive-browser-fixture.psychebook');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, buildPsycheBookBytes(state, '1.1.0', corpus));
console.log(output);
