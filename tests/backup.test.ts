import { EXTENSION_KEY, MESSAGE_FIELD } from '../src/constants';
import { createEmptyProjection } from '../src/model/defaults';
import type { MessageTimelineData } from '../src/model/types';
import {
  applyTimelineBackup,
  captureTimelineState,
  createTimelineBackup,
  inspectTimelineBackupTarget,
  parseTimelineBackupText,
  restoreTimelineState,
  timelineBackupPreview
} from '../src/runtime/backup';
import type { SillyTavernContext } from '../src/runtime/context';
import type { ChatStoryBinding } from '../src/runtime/story';
import { mirrorAllSwipes, type SillyTavernMessage } from '../src/storage/messages';
import { storyPlan, turnRecord } from './fixtures';

function timeline(messageId: string, records: MessageTimelineData['records_by_swipe'] = {}): MessageTimelineData {
  return { schema_version: 1, message_id: messageId, records_by_swipe: records };
}

function contextFixture(): { context: SillyTavernContext; projection: ReturnType<typeof createEmptyProjection> } {
  const record = turnRecord({
    recordId: 'record-1',
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    projectionHash: `sha256:${'4'.repeat(64)}`
  });
  const manual = turnRecord({
    kind: 'manual',
    recordId: 'manual-1',
    parentRecordId: 'record-1',
    userMessageId: 'manual-user-1',
    assistantMessageId: 'manual-state-1',
    audit: { mode: 'off', status: 'unreviewed', violations: [], model: null }
  });
  const plan = storyPlan([]);
  const binding: ChatStoryBinding = {
    schema_version: 1,
    source: 'card',
    card: {
      schema_version: '1.0',
      story_id: 'story-1',
      entry_point: { chapter_id: 'chapter-1', scene_id: 'scene-1' },
      bindings: { character_id: 'hero' },
      inline_plan: plan
    },
    inline_plan: plan,
    manual_records: [manual],
    mode_settings: {
      participationMode: 'parallel',
      auditMode: 'strict',
      autoApply: false
    }
  };
  const chat: SillyTavernMessage[] = [
    { is_user: true, mes: '继续', [MESSAGE_FIELD]: timeline('user-1') },
    {
      is_user: false,
      mes: '故事继续。',
      swipe_id: 0,
      swipes: ['故事继续。', '另一条回复。'],
      [MESSAGE_FIELD]: timeline('assistant-1', { '0': record })
    }
  ];
  const projection = createEmptyProjection('story-1');
  projection.facts.lantern = { truth: '风灯仍可使用', status: 'true', evidenceRefs: [] };
  return {
    context: { chat, chatMetadata: { [EXTENSION_KEY]: binding } } as unknown as SillyTavernContext,
    projection
  };
}

describe('timeline backup and restore', () => {
  it('creates a self-validating backup with binding, messages, Swipe records and manual records', async () => {
    const { context, projection } = contextFixture();
    mirrorAllSwipes(context.chat[1]!);
    delete context.chat[1]![MESSAGE_FIELD];
    const backup = await createTimelineBackup(context, projection);
    const parsed = await parseTimelineBackupText(JSON.stringify(backup));

    expect(parsed.story_id).toBe('story-1');
    expect(parsed.messages.map(message => message.message_id)).toEqual(['user-1', 'assistant-1']);
    expect(parsed.messages[1]?.timeline.records_by_swipe['0']?.recordId).toBe('record-1');
    expect(parsed.binding.manual_records?.[0]?.recordId).toBe('manual-1');
    expect(parsed.binding.mode_settings).toEqual({
      participationMode: 'parallel',
      auditMode: 'strict',
      autoApply: false
    });
    expect(timelineBackupPreview(parsed)).toMatchObject({ messageCount: 2, recordCount: 2 });
  });

  it('rejects tampering and a different target chat UUID sequence', async () => {
    const { context, projection } = contextFixture();
    const backup = await createTimelineBackup(context, projection);
    const tampered = structuredClone(backup);
    tampered.projection.facts.lantern!.truth = '内容被篡改';

    await expect(parseTimelineBackupText(JSON.stringify(tampered))).rejects.toThrow('完整性摘要不匹配');
    context.chat[1]![MESSAGE_FIELD]!.message_id = 'different-assistant';
    expect(inspectTimelineBackupTarget(context, backup)[0]).toContain('UUID 不一致');
  });

  it('restores the complete timeline state and can roll back to the pre-restore snapshot', async () => {
    const { context, projection } = contextFixture();
    const backup = await createTimelineBackup(context, projection);
    const beforeMutation = captureTimelineState(context);
    const binding = context.chatMetadata[EXTENSION_KEY] as ChatStoryBinding;
    binding.manual_records = [];
    context.chat[1]![MESSAGE_FIELD]!.records_by_swipe = {};
    const mutated = captureTimelineState(context);

    applyTimelineBackup(context, backup);
    expect((context.chatMetadata[EXTENSION_KEY] as ChatStoryBinding).manual_records?.[0]?.recordId).toBe('manual-1');
    expect((context.chatMetadata[EXTENSION_KEY] as ChatStoryBinding).mode_settings?.auditMode).toBe('strict');
    expect(context.chat[1]![MESSAGE_FIELD]!.records_by_swipe['0']?.recordId).toBe('record-1');

    restoreTimelineState(context, mutated);
    expect((context.chatMetadata[EXTENSION_KEY] as ChatStoryBinding).manual_records).toEqual([]);
    expect(context.chat[1]![MESSAGE_FIELD]!.records_by_swipe).toEqual({});

    restoreTimelineState(context, beforeMutation);
    expect((context.chatMetadata[EXTENSION_KEY] as ChatStoryBinding).manual_records?.[0]?.recordId).toBe('manual-1');
  });
});
