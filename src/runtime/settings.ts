import { DEFAULT_INJECTION_TOKEN_BUDGET, EXTENSION_KEY } from '../constants';
import type { AuditMode, CardTimelineExtension, ParticipationMode } from '../model/types';
import {
  DEFAULT_PROMPT_OVERRIDES,
  normalizePromptOverrides,
  type PtePromptOverrides
} from '../model/promptCustomization';
import type { SillyTavernContext } from './context';

export interface StoryModeSettings {
  participationMode: ParticipationMode;
  auditMode: AuditMode;
  autoApply: boolean;
}

export interface PsycheTimelineSettings {
  enabled: boolean;
  participationMode: ParticipationMode;
  auditMode: AuditMode;
  extractionEnabled: boolean;
  autoApply: boolean;
  autoApplyThreshold: number;
  injectionMaxChars: number;
  extractionResponseTokens: number;
  extractorProfileId: string;
  sourceCompilerProfileId: string;
  auditorProfileId: string;
  profileFallback: boolean;
  promptOverrides: PtePromptOverrides;
}

export const DEFAULT_SETTINGS: PsycheTimelineSettings = {
  enabled: true,
  participationMode: 'adaptive',
  auditMode: 'standard',
  extractionEnabled: true,
  autoApply: false,
  autoApplyThreshold: 0.9,
  injectionMaxChars: DEFAULT_INJECTION_TOKEN_BUDGET * 4,
  extractionResponseTokens: 1800,
  extractorProfileId: '',
  sourceCompilerProfileId: '',
  auditorProfileId: '',
  profileFallback: true,
  promptOverrides: structuredClone(DEFAULT_PROMPT_OVERRIDES)
};

export function storyModeSettingsFrom(settings: PsycheTimelineSettings): StoryModeSettings {
  return {
    participationMode: settings.participationMode,
    auditMode: settings.auditMode,
    autoApply: settings.autoApply
  };
}

export function applyStoryModeDefaults(
  base: PsycheTimelineSettings,
  card: CardTimelineExtension,
  stored: StoryModeSettings | null
): PsycheTimelineSettings {
  const defaults = card.mode_defaults;
  return {
    ...base,
    participationMode: stored?.participationMode ?? defaults?.participation ?? base.participationMode,
    auditMode: stored?.auditMode ?? defaults?.audit ?? base.auditMode,
    autoApply: stored?.autoApply ?? defaults?.auto_apply ?? base.autoApply
  };
}

function isParticipationMode(value: unknown): value is ParticipationMode {
  return ['follow', 'adaptive', 'parallel', 'free'].includes(String(value));
}

function isAuditMode(value: unknown): value is AuditMode {
  return ['off', 'standard', 'strict'].includes(String(value));
}

export function loadSettings(context: SillyTavernContext): PsycheTimelineSettings {
  const stored = context.extensionSettings[EXTENSION_KEY];
  const value = stored && typeof stored === 'object' ? stored as Partial<PsycheTimelineSettings> : {};
  const settings: PsycheTimelineSettings = {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_SETTINGS.enabled,
    participationMode: isParticipationMode(value.participationMode) ? value.participationMode : DEFAULT_SETTINGS.participationMode,
    auditMode: isAuditMode(value.auditMode) ? value.auditMode : DEFAULT_SETTINGS.auditMode,
    extractionEnabled: typeof value.extractionEnabled === 'boolean' ? value.extractionEnabled : DEFAULT_SETTINGS.extractionEnabled,
    autoApply: typeof value.autoApply === 'boolean' ? value.autoApply : DEFAULT_SETTINGS.autoApply,
    autoApplyThreshold: Number.isFinite(value.autoApplyThreshold)
      ? Math.min(1, Math.max(0, Number(value.autoApplyThreshold)))
      : DEFAULT_SETTINGS.autoApplyThreshold,
    injectionMaxChars: Number.isFinite(value.injectionMaxChars)
      ? Math.min(20_000, Math.max(500, Math.trunc(Number(value.injectionMaxChars))))
      : DEFAULT_SETTINGS.injectionMaxChars,
    extractionResponseTokens: Number.isFinite(value.extractionResponseTokens)
      ? Math.min(8000, Math.max(500, Math.trunc(Number(value.extractionResponseTokens))))
      : DEFAULT_SETTINGS.extractionResponseTokens,
    extractorProfileId: typeof value.extractorProfileId === 'string' ? value.extractorProfileId : '',
    sourceCompilerProfileId: typeof value.sourceCompilerProfileId === 'string' ? value.sourceCompilerProfileId : '',
    auditorProfileId: typeof value.auditorProfileId === 'string' ? value.auditorProfileId : '',
    profileFallback: typeof value.profileFallback === 'boolean' ? value.profileFallback : true,
    promptOverrides: normalizePromptOverrides(value.promptOverrides)
  };
  context.extensionSettings[EXTENSION_KEY] = settings;
  return settings;
}

export function saveSettings(context: SillyTavernContext, settings: PsycheTimelineSettings): void {
  context.extensionSettings[EXTENSION_KEY] = settings;
  context.saveSettingsDebounced();
}
