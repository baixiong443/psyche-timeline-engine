import { createEmptyProjection } from '../src/model/defaults';
import type { InstalledPsycheBook } from '../src/model/package';
import type { CardTimelineExtension, StoryPlan } from '../src/model/types';
import {
  bindStoryToChat,
  inspectPackageBinding,
  readChatModeSettings,
  resolveGenerationCharacterId,
  resolveMessageCharacterId,
  writeChatModeSettings,
  type ActiveStory,
  type ChatStoryBinding
} from '../src/runtime/story';
import { applyStoryModeDefaults, DEFAULT_SETTINGS } from '../src/runtime/settings';
import type { SillyTavernContext } from '../src/runtime/context';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function packageFixture(): { binding: ChatStoryBinding; book: InstalledPsycheBook } {
  const initialState = createEmptyProjection('story-1');
  const plan: StoryPlan = {
    schemaVersion: 1,
    storyId: 'story-1',
    title: '测试故事',
    initialState,
    events: []
  };
  const card: CardTimelineExtension = {
    schema_version: '1.0',
    story_id: 'story-1',
    package_digest: DIGEST,
    entry_point: { chapter_id: 'chapter-1', scene_id: 'scene-1' },
    bindings: { character_id: 'hero' }
  };
  return {
    binding: {
      schema_version: 1,
      source: 'psychebook',
      card,
      package_digest: DIGEST
    },
    book: {
      digest: DIGEST,
      installedAt: 1,
      manifest: {
        schema_version: '1.0',
        format: 'psychebook',
        story_id: 'story-1',
        title: '测试故事',
        version: '1.2.0'
      },
      card,
      plan,
      files: {}
    }
  };
}

describe('story package binding diagnostics', () => {
  it('accepts a matching installed package', () => {
    const { binding, book } = packageFixture();
    expect(inspectPackageBinding(binding, book)).toBeNull();
  });

  it('reports a missing digest and a missing installed package', () => {
    const { binding } = packageFixture();
    const withoutDigest: ChatStoryBinding = {
      ...binding,
      card: { ...binding.card, package_digest: undefined },
      package_digest: undefined
    };
    expect(inspectPackageBinding(withoutDigest, undefined)?.code).toBe('missing_digest');
    expect(inspectPackageBinding(binding, undefined)?.code).toBe('missing_package');
  });

  it('rejects conflicting digests and story identities', () => {
    const { binding, book } = packageFixture();
    const conflicting: ChatStoryBinding = {
      ...binding,
      package_digest: `sha256:${'b'.repeat(64)}`
    };
    expect(inspectPackageBinding(conflicting, book)?.code).toBe('digest_mismatch');
    const wrongStory = structuredClone(book);
    wrongStory.manifest.story_id = 'story-2';
    expect(inspectPackageBinding(binding, wrongStory)?.code).toBe('story_mismatch');
  });

  it('reports an unsupported stored package schema', () => {
    const { binding, book } = packageFixture();
    const unsupported = structuredClone(book);
    unsupported.manifest.schema_version = '2.0' as '1.0';
    expect(inspectPackageBinding(binding, unsupported)?.code).toBe('unsupported_version');
  });

  it('resolves the drafted and rendered group member through same-story card bindings', () => {
    const { book } = packageFixture();
    const bobCard: CardTimelineExtension = {
      ...book.card,
      bindings: { character_id: 'bob' }
    };
    const story: ActiveStory = {
      source: 'psychebook',
      card: book.card,
      plan: book.plan,
      packageStatus: 'verified',
      packageVersion: '1.2.0'
    };
    const context = {
      groupId: 'group-1',
      characterId: 1,
      characters: [
        { name: 'Alice', avatar: 'alice.png' },
        { name: 'Bob', avatar: 'bob.png', data: { extensions: { psyche_timeline: bobCard } } }
      ]
    } as unknown as SillyTavernContext;

    expect(resolveGenerationCharacterId(context, story, book.plan.initialState)).toBe('bob');
    context.characterId = 0;
    expect(resolveGenerationCharacterId(context, story, book.plan.initialState, 1)).toBe('bob');
    expect(resolveMessageCharacterId(
      context,
      story,
      book.plan.initialState,
      { name: 'Bob', original_avatar: 'bob.png' }
    )).toBe('bob');
    context.characterId = undefined;
    expect(resolveGenerationCharacterId(context, story, book.plan.initialState)).toBeNull();
  });

  it('initializes card mode defaults once and then keeps chat-specific overrides', () => {
    const { book } = packageFixture();
    book.card.mode_defaults = {
      participation: 'parallel',
      audit: 'strict',
      auto_apply: true
    };
    const story: ActiveStory = {
      source: 'psychebook',
      card: book.card,
      plan: book.plan,
      packageStatus: 'verified',
      packageVersion: '1.2.0'
    };
    const context = { chatMetadata: {} } as unknown as SillyTavernContext;

    const initial = applyStoryModeDefaults(DEFAULT_SETTINGS, story.card, readChatModeSettings(context));
    expect(initial).toMatchObject({ participationMode: 'parallel', auditMode: 'strict', autoApply: true });
    writeChatModeSettings(context, story, {
      participationMode: 'free',
      auditMode: 'off',
      autoApply: false
    });
    expect(readChatModeSettings(context)).toEqual({
      participationMode: 'free',
      auditMode: 'off',
      autoApply: false
    });
    expect(applyStoryModeDefaults(DEFAULT_SETTINGS, story.card, readChatModeSettings(context))).toMatchObject({
      participationMode: 'free',
      auditMode: 'off',
      autoApply: false
    });
    expect((context.chatMetadata.psyche_timeline as ChatStoryBinding).card.story_id).toBe('story-1');

    bindStoryToChat(context, story);
    expect(readChatModeSettings(context)).toBeNull();
  });
});
