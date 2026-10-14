import { ensureMessageTimeline, setSwipeRecord, type SillyTavernMessage } from '../src/storage/messages';
import { renderTurnBadges, turnBadgePresentation } from '../src/ui/turnBadge';
import { turnRecord } from './fixtures';

describe('message turn badges', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="chat">
        <div class="mes" mesid="0"><div class="mes_block"></div></div>
        <div class="mes" mesid="1"><div class="mes_block"><div class="mes_text"></div></div></div>
      </div>`;
  });

  it('renders the active Swipe status below assistant messages and opens the panel', () => {
    const open = vi.fn();
    const user: SillyTavernMessage = { is_user: true, mes: '用户消息' };
    const assistant: SillyTavernMessage = { is_user: false, mes: '角色回复', swipe_id: 0 };
    ensureMessageTimeline(assistant, () => 'assistant-1');
    setSwipeRecord(assistant, turnRecord({ application: { status: 'pending_user', appliedAt: null } }));

    renderTurnBadges([user, assistant], open);
    const badge = document.querySelector<HTMLButtonElement>('.mes[mesid="1"] .psyche-turn-badge');
    badge?.click();

    expect(document.querySelector('.mes[mesid="0"] .psyche-turn-badge')).toBeNull();
    expect(badge?.textContent).toContain('待确认');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('uses stale and failed states ahead of ordinary application state', () => {
    expect(turnBadgePresentation(turnRecord({ audit: {
      mode: 'strict', status: 'failed', violations: [], model: 'auditor'
    } })).label).toBe('错误');
    expect(turnBadgePresentation(turnRecord({
      audit: { mode: 'strict', status: 'stale', violations: [], model: 'auditor' },
      application: { status: 'stale', appliedAt: null }
    })).label).toBe('已过期');
  });
});
