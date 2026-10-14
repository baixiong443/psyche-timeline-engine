import type { StoryProjection } from './types';

export function createEmptyProjection(storyId: string): StoryProjection {
  return {
    schemaVersion: 1,
    storyId,
    turn: 0,
    canonCursor: { chapterId: '', sceneId: '', eventOrder: 0 },
    time: { absolute: null, relativeMinutes: 0 },
    location: { area: '', place: '', position: '' },
    characters: {},
    relationships: {},
    inventory: {},
    facts: {},
    knowledge: {},
    flags: {},
    canonEvents: {},
    narrativePurposes: {},
    openThreads: {},
    custom: {},
    lockedPaths: [],
    divergence: { structuralLevel: 0, summary: '' }
  };
}
