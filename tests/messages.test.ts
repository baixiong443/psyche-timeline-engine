import type { DomainOperation, SwipeTimelineMirror } from '../src/model/types';
import {
  collectActiveTurnRecords,
  ensureChatMessageIds,
  ensureMessageTimeline,
  findPrecedingUserMessage,
  getSwipeRecord,
  invalidateRecordsWithChangedContent,
  markRecordsStaleFromMessage,
  mirrorActiveSwipe,
  reindexRecordsAfterSwipeDeletion,
  setSwipeRecord,
  type SillyTavernMessage
} from '../src/storage/messages';
import { operation, turnRecord } from './fixtures';
import { sha256Text } from '../src/utils/hash';

describe('SillyTavern message persistence', () => {
  it('assigns stable IDs without replacing an existing timeline', () => {
    const chat: SillyTavernMessage[] = [{ is_user: true }, { is_user: false }, { is_system: true }];
    let sequence = 0;
    const createId = () => `message-${++sequence}`;

    expect(ensureChatMessageIds(chat, createId)).toBe(2);
    expect(ensureChatMessageIds(chat, createId)).toBe(0);
    expect(chat[0]?.psyche_timeline?.message_id).toBe('message-1');
    expect(chat[2]?.psyche_timeline).toBeUndefined();
  });

  it('stores all records at top level and persists full active and per-Swipe mirrors', () => {
    const message: SillyTavernMessage = {
      swipe_id: 0,
      swipes: ['a', 'b'],
      swipe_info: [{ extra: {} }, { extra: {} }]
    };
    ensureMessageTimeline(message, () => 'message-1');
    setSwipeRecord(message, turnRecord({ recordId: 'record-0', swipeId: 0 }));
    message.swipe_id = 1;
    setSwipeRecord(message, turnRecord({ recordId: 'record-1', swipeId: 1 }));

    const mirror = mirrorActiveSwipe(message);
    const activeMirror = message.extra?.psyche_timeline as SwipeTimelineMirror;
    const firstSwipeMirror = message.swipe_info?.[0]?.extra?.psyche_timeline as SwipeTimelineMirror;
    const secondSwipeMirror = message.swipe_info?.[1]?.extra?.psyche_timeline as SwipeTimelineMirror;
    expect(mirror.record_id).toBe('record-1');
    expect(activeMirror.record?.recordId).toBe('record-1');
    expect(activeMirror.timeline?.records_by_swipe['0']?.recordId).toBe('record-0');
    expect(firstSwipeMirror.record?.recordId).toBe('record-0');
    expect(secondSwipeMirror.record?.recordId).toBe('record-1');
    expect(Object.keys(message.psyche_timeline?.records_by_swipe ?? {})).toEqual(['0', '1']);
  });

  it('returns the persisted record so later application updates the stored timeline', () => {
    const message: SillyTavernMessage = { swipe_id: 0, swipe_info: [{ extra: {} }] };
    const source = turnRecord({ recordId: 'record-0', application: { status: 'pending_user', appliedAt: null } });
    const persisted = setSwipeRecord(message, source, () => 'message-1');

    expect(persisted).not.toBe(source);
    expect(getSwipeRecord(message)).toBe(persisted);
    persisted.application = { status: 'applied', appliedAt: 1234 };
    mirrorActiveSwipe(message);

    expect(getSwipeRecord(message)?.application).toEqual({ status: 'applied', appliedAt: 1234 });
    expect((message.extra?.psyche_timeline as SwipeTimelineMirror).application_status).toBe('applied');
  });

  it('rehydrates full Swipe timelines after SillyTavern branch copying strips the top-level field', () => {
    const message: SillyTavernMessage = {
      swipe_id: 0,
      swipes: ['a', 'b'],
      swipe_info: [{ extra: {} }, { extra: {} }]
    };
    ensureMessageTimeline(message, () => 'message-1');
    setSwipeRecord(message, turnRecord({ recordId: 'record-0', swipeId: 0 }));
    message.swipe_id = 1;
    setSwipeRecord(message, turnRecord({ recordId: 'record-1', swipeId: 1 }));

    const branched = structuredClone(message);
    delete branched.psyche_timeline;
    const timeline = ensureMessageTimeline(branched, () => 'replacement-id');

    expect(timeline.message_id).toBe('message-1');
    expect(timeline.records_by_swipe['0']?.recordId).toBe('record-0');
    expect(timeline.records_by_swipe['1']?.recordId).toBe('record-1');
  });

  it('reindexes records after SillyTavern deletes a swipe', () => {
    const message: SillyTavernMessage = { swipe_id: 1 };
    ensureMessageTimeline(message, () => 'message-1');
    setSwipeRecord(message, turnRecord({ recordId: 'zero', swipeId: 0 }));
    setSwipeRecord(message, turnRecord({ recordId: 'one', swipeId: 1 }));
    setSwipeRecord(message, turnRecord({ recordId: 'two', swipeId: 2 }));

    reindexRecordsAfterSwipeDeletion(message, 1);
    expect(getSwipeRecord(message, 1)?.recordId).toBe('two');
    expect(getSwipeRecord(message, 1)?.swipeId).toBe(1);
    expect(Object.keys(message.psyche_timeline?.records_by_swipe ?? {})).toEqual(['0', '1']);
  });

  it('collects the selected branch and propagates stale state after edits', () => {
    const user: SillyTavernMessage = { is_user: true };
    const first: SillyTavernMessage = { is_user: false, swipe_id: 0 };
    const second: SillyTavernMessage = { is_user: false, swipe_id: 0 };
    setSwipeRecord(first, turnRecord({
      recordId: 'first',
      operations: [operation<DomainOperation>({ type: 'advance_time', minutes: 5 })]
    }), () => 'message-1');
    setSwipeRecord(second, turnRecord({ recordId: 'second', parentRecordId: 'first' }), () => 'message-2');
    const chat = [user, first, second];

    expect(collectActiveTurnRecords(chat).map(record => record.recordId)).toEqual(['first', 'second']);
    expect(markRecordsStaleFromMessage(chat, 1)).toBe(2);
    expect(getSwipeRecord(second)?.application.status).toBe('stale');
  });

  it('finds the user message immediately preceding an assistant response', () => {
    const chat: SillyTavernMessage[] = [
      { is_user: true, mes: 'old' },
      { is_user: false, mes: 'reply' },
      { is_user: true, mes: 'current' },
      { is_user: false, mes: 'current reply' }
    ];

    const found = findPrecedingUserMessage(chat, 3);
    expect(found?.index).toBe(2);
    expect(found?.message.mes).toBe('current');
  });

  it('invalidates changed content and every dependent record during reload scanning', async () => {
    const firstUser: SillyTavernMessage = { is_user: true, mes: 'first input' };
    const firstAssistant: SillyTavernMessage = { is_user: false, mes: 'first reply', swipe_id: 0, swipes: ['first reply'] };
    const secondUser: SillyTavernMessage = { is_user: true, mes: 'second input' };
    const secondAssistant: SillyTavernMessage = { is_user: false, mes: 'second reply', swipe_id: 0, swipes: ['second reply'] };
    ensureMessageTimeline(firstUser, () => 'user-1');
    ensureMessageTimeline(firstAssistant, () => 'assistant-1');
    ensureMessageTimeline(secondUser, () => 'user-2');
    ensureMessageTimeline(secondAssistant, () => 'assistant-2');
    setSwipeRecord(firstAssistant, turnRecord({
      recordId: 'record-1',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      inputHash: await sha256Text('first input'),
      outputHash: await sha256Text('first reply')
    }));
    setSwipeRecord(secondAssistant, turnRecord({
      recordId: 'record-2',
      parentRecordId: 'record-1',
      userMessageId: 'user-2',
      assistantMessageId: 'assistant-2',
      inputHash: await sha256Text('second input'),
      outputHash: await sha256Text('second reply')
    }));
    const chat = [firstUser, firstAssistant, secondUser, secondAssistant];

    expect(await invalidateRecordsWithChangedContent(chat)).toBe(0);
    firstUser.mes = 'edited first input';
    expect(await invalidateRecordsWithChangedContent(chat)).toBe(2);
    expect(getSwipeRecord(firstAssistant)?.application.status).toBe('stale');
    expect(getSwipeRecord(secondAssistant)?.audit.status).toBe('stale');
  });
});
