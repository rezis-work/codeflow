import * as vscode from 'vscode';
import { parseAiSettings } from './settings';
import type { AiSettings } from './settings';

/** Integration tests flip this so they do not write settings and reindex the workspace. */
let enabledOverride: boolean | undefined;

export function setAiEnabledOverride(enabled: boolean | undefined): void {
  enabledOverride = enabled;
}

export function readAiSettings(): AiSettings {
  const config = vscode.workspace.getConfiguration('codeflow');
  const settings = parseAiSettings({
    enabled: config.get('ai.enabled'),
    provider: config.get('ai.provider'),
    modelFamily: config.get('ai.modelFamily'),
    model: config.get('ai.model'),
    baseUrl: config.get('ai.baseUrl'),
    snippetChars: config.get('ai.snippetChars'),
  });
  if (enabledOverride === undefined) {
    return settings;
  }
  return { ...settings, enabled: enabledOverride };
}
