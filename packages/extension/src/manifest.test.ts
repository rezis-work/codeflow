import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OPEN_DIAGRAM_COMMAND,
  SHOW_FLOW_COMMAND,
  SIDEBAR_VIEW_ID,
  VIEW_CONTAINER_ID,
} from './constants';

interface Manifest {
  main?: string;
  engines?: { vscode?: string };
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command?: string }>;
    viewsContainers?: { activitybar?: Array<{ id?: string; icon?: string }> };
    views?: Record<string, Array<{ id?: string; type?: string }>>;
  };
}

function readManifest(): Manifest {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('package.json is not an object');
  }
  return parsed as Manifest;
}

describe('extension manifest', () => {
  const manifest = readManifest();

  it('targets the conservative VS Code engine and the bundled entry', () => {
    expect(manifest.engines?.vscode).toBe('^1.85.0');
    expect(manifest.main).toBe('./dist/extension.js');
  });

  it('contributes the CodeFlow activity bar and the open-diagram command', () => {
    expect(manifest.activationEvents).toEqual(
      expect.arrayContaining([
        'onStartupFinished',
        `onCommand:${OPEN_DIAGRAM_COMMAND}`,
        `onCommand:${SHOW_FLOW_COMMAND}`,
        `onView:${SIDEBAR_VIEW_ID}`,
      ]),
    );
    const commands = manifest.contributes?.commands?.map((command) => command.command) ?? [];
    expect(commands).toContain(OPEN_DIAGRAM_COMMAND);
    expect(commands).toContain(SHOW_FLOW_COMMAND);
    const containers = manifest.contributes?.viewsContainers?.activitybar ?? [];
    expect(containers.map((container) => container.id)).toContain(VIEW_CONTAINER_ID);
    expect(containers.some((container) => container.icon === 'media/codeflow.svg')).toBe(true);
    const views = manifest.contributes?.views?.[VIEW_CONTAINER_ID] ?? [];
    expect(views).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: SIDEBAR_VIEW_ID, type: 'webview' })]),
    );
  });
});
