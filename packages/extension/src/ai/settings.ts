/**
 * AI settings as plain data. Reading them from VS Code lives next to the command.
 */

export const AI_PROVIDERS = ['editor', 'openai-compatible', 'anthropic'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiSettings {
  readonly enabled: boolean;
  readonly provider: AiProvider;
  /** Editor model family. Empty lets the editor pick. */
  readonly modelFamily: string;
  /** Own-key model id. Empty uses the provider default. */
  readonly model: string;
  /** Own-key base URL. Empty uses the provider default. Must be http(s) when set. */
  readonly baseUrl: string;
  readonly snippetChars: number;
}

export const DEFAULT_SNIPPET_CHARS = 240;
export const MAX_SNIPPET_CHARS = 2_000;

const FAMILY_LIMIT = 100;
const MODEL_LIMIT = 200;
const URL_LIMIT = 500;

export function parseAiSettings(raw: {
  readonly enabled?: unknown;
  readonly provider?: unknown;
  readonly modelFamily?: unknown;
  readonly model?: unknown;
  readonly baseUrl?: unknown;
  readonly snippetChars?: unknown;
}): AiSettings {
  return {
    enabled: raw.enabled === true,
    provider: isProvider(raw.provider) ? raw.provider : 'editor',
    modelFamily: clipSetting(raw.modelFamily, FAMILY_LIMIT),
    model: clipSetting(raw.model, MODEL_LIMIT),
    baseUrl: cleanBaseUrl(raw.baseUrl),
    snippetChars: snippetChars(raw.snippetChars),
  };
}

function isProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);
}

function clipSetting(value: unknown, limit: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, limit);
}

function cleanBaseUrl(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return '';
  }
  return trimmed.slice(0, URL_LIMIT);
}

function snippetChars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SNIPPET_CHARS;
  }
  return Math.min(MAX_SNIPPET_CHARS, Math.max(0, Math.floor(value)));
}
