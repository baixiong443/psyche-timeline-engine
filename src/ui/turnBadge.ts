import type { TurnRecord } from '../model/types';
import { getSwipeRecord, type SillyTavernMessage } from '../storage/messages';

interface TurnBadgePresentation {
  label: string;
  tone: 'success' | 'attention' | 'danger' | 'neutral';
  icon: string;
}

export function turnBadgePresentation(record: TurnRecord | null): TurnBadgePresentation {
  if (!record) return { label: '未审计', tone: 'neutral', icon: 'fa-circle-question' };
  if (record.application.status === 'stale' || record.audit.status === 'stale') {
    return { label: '已过期', tone: 'danger', icon: 'fa-clock-rotate-left' };
  }
  if (record.audit.status === 'failed') {
    return { label: '错误', tone: 'danger', icon: 'fa-triangle-exclamation' };
  }
  if (record.audit.status === 'pending') {
    return { label: '审计中', tone: 'attention', icon: 'fa-spinner' };
  }
  if (record.audit.status === 'unreviewed') {
    return { label: '未审计', tone: 'neutral', icon: 'fa-circle-question' };
  }
  if (record.application.status === 'pending_user') {
    return { label: '待确认', tone: 'attention', icon: 'fa-circle-exclamation' };
  }
  if (record.audit.status === 'warning') {
    return { label: '需留意', tone: 'attention', icon: 'fa-circle-exclamation' };
  }
  return { label: '已审计', tone: 'success', icon: 'fa-circle-check' };
}

function removeBadge(messageElement: Element): void {
  messageElement.querySelector('.psyche-turn-badge')?.remove();
}

export function clearTurnBadges(): void {
  document.querySelectorAll('#chat .psyche-turn-badge').forEach(badge => badge.remove());
}

export function renderTurnBadges(chat: SillyTavernMessage[], onOpen: () => void): void {
  const renderedMessages = document.querySelectorAll<HTMLElement>('#chat .mes[mesid]');
  for (const messageElement of renderedMessages) {
    const messageIndex = Number(messageElement.getAttribute('mesid'));
    const message = Number.isInteger(messageIndex) ? chat[messageIndex] : undefined;
    if (!message || message.is_user || message.is_system) {
      removeBadge(messageElement);
      continue;
    }
    const host = messageElement.querySelector<HTMLElement>('.mes_block');
    if (!host) continue;
    removeBadge(messageElement);
    const presentation = turnBadgePresentation(getSwipeRecord(message));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `psyche-turn-badge psyche-turn-badge-${presentation.tone}`;
    button.title = `剧情时间线：${presentation.label}`;
    button.setAttribute('aria-label', `剧情时间线：${presentation.label}`);
    const icon = document.createElement('i');
    icon.className = `fa-solid ${presentation.icon}`;
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = presentation.label;
    button.append(icon, label);
    button.addEventListener('click', event => {
      event.stopPropagation();
      onOpen();
    });
    host.append(button);
  }
}
