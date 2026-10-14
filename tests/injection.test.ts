import { buildRuntimeInjection } from '../src/engine/injection';
import { createEmptyProjection } from '../src/model/defaults';
import type { CardTimelineExtension } from '../src/model/types';

describe('runtime injection', () => {
  it('does not expose facts the active character does not know', () => {
    const projection = createEmptyProjection('story-1');
    projection.facts.secret = { truth: 'The steward poisoned the cup.', status: 'true', evidenceRefs: [] };
    projection.facts.falseBelief = { truth: 'The northern road is safe.', status: 'false', evidenceRefs: [] };
    projection.knowledge.hero = {
      secret: { state: 'unaware' },
      falseBelief: { state: 'believes_false', perceivedTruth: 'The northern road is blocked by snow.' }
    };
    const card: CardTimelineExtension = {
      schema_version: '1.0',
      story_id: 'story-1',
      entry_point: { chapter_id: 'chapter-1', scene_id: 'scene-1' },
      bindings: { character_id: 'hero' }
    };

    const text = buildRuntimeInjection({ projection, candidates: [], card, maxChars: 4000 });
    expect(text).not.toContain('steward poisoned');
    expect(text).not.toContain('northern road is safe');
    expect(text).toContain('northern road is blocked by snow');
  });

  it('uses the drafted group member knowledge view instead of the binding owner', () => {
    const projection = createEmptyProjection('story-1');
    projection.facts.aliceSecret = { truth: 'Alice knows the cellar key is silver.', status: 'true', evidenceRefs: [] };
    projection.facts.bobSecret = { truth: 'Bob knows the north gate is open.', status: 'true', evidenceRefs: [] };
    projection.knowledge.alice = { aliceSecret: { state: 'knows' } };
    projection.knowledge.bob = { bobSecret: { state: 'knows' } };
    const card: CardTimelineExtension = {
      schema_version: '1.0',
      story_id: 'story-1',
      entry_point: { chapter_id: 'chapter-1', scene_id: 'scene-1' },
      bindings: { character_id: 'alice', user_role_id: 'traveler' }
    };

    const text = buildRuntimeInjection({
      projection,
      candidates: [],
      card,
      maxChars: 4000,
      responderCharacterId: 'bob'
    });
    expect(text).toContain('Knowledge available to bob');
    expect(text).toContain('north gate is open');
    expect(text).not.toContain('cellar key is silver');

    const unknown = buildRuntimeInjection({
      projection,
      candidates: [],
      card,
      maxChars: 4000,
      responderCharacterId: null
    });
    expect(unknown).not.toContain('Knowledge available to');
    expect(unknown).not.toContain('north gate is open');
    expect(unknown).not.toContain('cellar key is silver');
  });

  it('injects responder-scoped state without exposing another character private state', () => {
    const projection = createEmptyProjection('story-1');
    projection.characters.alice = {
      present: true,
      mood: ['guarded'],
      activity: 'checking the river ledger',
      custom: { fatigue: 2 }
    };
    projection.characters.bob = {
      present: true,
      mood: ['secretly afraid'],
      activity: 'hiding the silver key'
    };
    projection.relationships.alice_bob = {
      pairId: 'alice_bob',
      stage: 'uneasy allies',
      directions: {
        alice: {
          toward: 'bob',
          stance: ['cautious'],
          wants: ['verify his story'],
          secrets: ['will not reveal the old route']
        },
        bob: {
          toward: 'alice',
          stance: ['deceptive'],
          wants: ['take the ledger'],
          secrets: ['already opened the floodgate']
        }
      },
      axes: { trust: 12 }
    };
    projection.inventory.sharedLamp = { count: 1, description: 'an oil lamp' };
    projection.inventory.aliceKnife = { count: 1, ownerId: 'alice' };
    projection.inventory.bobKey = { count: 1, ownerId: 'bob', description: 'the hidden silver key' };
    projection.openThreads.ferryman = { title: 'Find the missing ferryman', status: 'open', evidenceRefs: [] };
    projection.divergence = { structuralLevel: 0.65, summary: 'The east gate was closed early.' };
    const card: CardTimelineExtension = {
      schema_version: '1.0',
      story_id: 'story-1',
      entry_point: { chapter_id: 'chapter-1', scene_id: 'scene-1' },
      bindings: { character_id: 'alice', user_role_id: 'traveler' }
    };

    const text = buildRuntimeInjection({ projection, candidates: [], card, maxChars: 8000 });
    expect(text).toContain('mood: guarded');
    expect(text).toContain('User story role ID: traveler');
    expect(text).toContain('checking the river ledger');
    expect(text).toContain('stage=uneasy allies');
    expect(text).toContain('will not reveal the old route');
    expect(text).toContain('sharedLamp');
    expect(text).toContain('aliceKnife');
    expect(text).toContain('Find the missing ferryman');
    expect(text).toContain('The east gate was closed early');
    expect(text).not.toContain('secretly afraid');
    expect(text).not.toContain('hiding the silver key');
    expect(text).not.toContain('already opened the floodgate');
    expect(text).not.toContain('bobKey');
  });

  it('truncates only at line boundaries and always closes the control block', () => {
    const projection = createEmptyProjection('story-1');
    projection.characters.hero = { present: true, activity: 'x'.repeat(800) };
    const card: CardTimelineExtension = {
      schema_version: '1.0',
      story_id: 'story-1',
      entry_point: { chapter_id: 'chapter-1', scene_id: 'scene-1' },
      bindings: { character_id: 'hero' }
    };

    const text = buildRuntimeInjection({ projection, candidates: [], card, maxChars: 500 });
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).toContain('[truncated]');
    expect(text.endsWith('[/Psyche Timeline]')).toBe(true);
    expect(text).not.toMatch(/activity: x{1,799}\n\[truncated\]/);
  });

  it('customizes narrative guidance without removing the dynamic state payload', () => {
    const projection = createEmptyProjection('story-1');
    projection.location = { area: '雾港', place: '旧码头', position: '候船棚' };
    const card: CardTimelineExtension = {
      schema_version: '1.0',
      story_id: 'story-1',
      entry_point: { chapter_id: 'chapter-1', scene_id: 'scene-1' },
      bindings: { character_id: 'hero' }
    };

    const appended = buildRuntimeInjection({
      projection,
      candidates: [],
      card,
      maxChars: 4000,
      promptOverride: { mode: 'append', text: '保持简洁的第一人称叙述。' }
    });
    expect(appended).toContain('The actual branch state overrides canon');
    expect(appended).toContain('保持简洁的第一人称叙述');

    const replaced = buildRuntimeInjection({
      projection,
      candidates: [],
      card,
      maxChars: 4000,
      promptOverride: { mode: 'replace', text: '只使用当前分支，不主动推进事件。' }
    });
    expect(replaced).not.toContain('The actual branch state overrides canon');
    expect(replaced).toContain('只使用当前分支，不主动推进事件');
    expect(replaced).toContain('Location: 雾港 / 旧码头 / 候船棚');
    expect(replaced).toContain('Turn: 0');
  });

  it('injects cited past source evidence but never exposes the controller-only future window', () => {
    const projection = createEmptyProjection('story-1');
    const card: CardTimelineExtension = {
      schema_version: '1.0',
      story_id: 'story-1',
      entry_point: { chapter_id: 'chapter-1', scene_id: 'scene-1' },
      bindings: { character_id: 'hero' }
    };
    const past = {
      schemaVersion: 1 as const,
      id: 'R000001', chapterId: 'C0001', chapterOrder: 0, chunkOrder: 0, title: '第一章',
      startOffset: 0, endOffset: 10, text: '林砚已经把铜钥匙收进口袋。', contentHash: 'past', keywordTokens: []
    };
    const future = {
      ...past,
      id: 'R000002', chunkOrder: 1, startOffset: 10, endOffset: 20,
      text: '未来才揭晓的幕后身份。', contentHash: 'future'
    };
    const text = buildRuntimeInjection({
      projection,
      candidates: [],
      card,
      maxChars: 8000,
      sourceContext: {
        corpusId: 'story-1:fp', cursorOrder: 0, sequential: [past], related: [], style: [past],
        futureController: [future], compileUnit: null, warnings: []
      }
    });
    expect(text).toContain('[R000001]');
    expect(text).toContain('铜钥匙');
    expect(text).not.toContain('幕后身份');
    expect(text).not.toContain('R000002');
  });
});
