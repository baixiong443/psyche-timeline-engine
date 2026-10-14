import type { SillyTavernMessage } from '../storage/messages';

export interface SillyTavernEventSource {
  on: (event: string, listener: (...args: unknown[]) => unknown) => void;
  once?: (event: string, listener: (...args: unknown[]) => unknown) => void;
  makeLast?: (event: string, listener: (...args: unknown[]) => unknown) => void;
}

export interface SillyTavernCharacter {
  name?: string;
  avatar?: string;
  data?: {
    extensions?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GenerateRawOptions {
  prompt: string | Array<{ role: string; content: string }>;
  systemPrompt?: string;
  responseLength?: number;
  instructOverride?: boolean;
  quietToLoud?: boolean;
  jsonSchema?: {
    name: string;
    value: Record<string, unknown>;
    description?: string;
    strict?: boolean;
    returnInvalid?: boolean;
  } | null;
}

export interface SillyTavernConnectionProfile {
  id: string;
  name?: string;
  model?: string;
  api?: string;
}

export interface ConnectionManagerRequestService {
  getSupportedProfiles: () => SillyTavernConnectionProfile[];
  getProfile: (profileId: string) => SillyTavernConnectionProfile | null;
  sendRequest: (
    profileId: string,
    prompt: string | Array<{ role: string; content: string }>,
    maxTokens: number,
    options?: Record<string, unknown>,
    overridePayload?: Record<string, unknown>
  ) => Promise<{ content?: unknown; reasoning?: string } | (() => AsyncGenerator<unknown>)>;
}

export interface SillyTavernContext {
  chat: SillyTavernMessage[];
  chatMetadata: Record<string, unknown>;
  characters: SillyTavernCharacter[];
  characterId?: number;
  groupId?: string | number | null;
  name1?: string;
  name2?: string;
  eventSource: SillyTavernEventSource;
  eventTypes: Record<string, string>;
  extensionSettings: Record<string, unknown>;
  textCompletionSettings?: Record<string, unknown>;
  CONNECT_API_MAP?: Record<string, { selected?: string }>;
  ConnectionManagerRequestService?: ConnectionManagerRequestService;
  saveSettingsDebounced: () => void;
  saveChat: () => Promise<unknown>;
  getRequestHeaders?: () => Record<string, string>;
  setExtensionPrompt: (
    key: string,
    value: string,
    position: number,
    depth: number,
    scan?: boolean,
    role?: number
  ) => void;
  generateRaw: (options: GenerateRawOptions) => Promise<string>;
}

export function getSillyTavernContext(): SillyTavernContext | null {
  const value = window.SillyTavern?.getContext();
  if (!value || typeof value !== 'object') return null;
  return value as SillyTavernContext;
}
