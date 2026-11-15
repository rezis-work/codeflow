import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OPEN_DIAGRAM_COMMAND,
  SHOW_CALLEES_COMMAND,
  SHOW_CALLERS_COMMAND,
  SHOW_DEPENDENCIES_COMMAND,
  SHOW_FILE_DEPENDENCIES_COMMAND,
  SHOW_CONTROL_FLOW_COMMAND,
  SHOW_FLOW_COMMAND,
  SHOW_TRAIT_MAP_COMMAND,
  SHOW_REQUEST_FLOW_COMMAND,
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
    menus?: {
      'editor/context'?: Array<{ command?: string; when?: string }>;
      'explorer/context'?: Array<{ command?: string; when?: string }>;
      commandPalette?: Array<{ command?: string }>;
    };
    keybindings?: Array<{ command?: string; key?: string; mac?: string; when?: string }>;
    configuration?: {
      properties?: Record<string, { type?: string; default?: unknown }>;
    };
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
    expect(commands).toEqual(
      expect.arrayContaining([
        OPEN_DIAGRAM_COMMAND,
        SHOW_FLOW_COMMAND,
        SHOW_CALLERS_COMMAND,
        SHOW_CALLEES_COMMAND,
        SHOW_FILE_DEPENDENCIES_COMMAND,
        SHOW_DEPENDENCIES_COMMAND,
        SHOW_CONTROL_FLOW_COMMAND,
        SHOW_TRAIT_MAP_COMMAND,
        SHOW_REQUEST_FLOW_COMMAND,
      ]),
    );
    const palette = manifest.contributes?.menus?.commandPalette?.map((item) => item.command) ?? [];
    expect(palette).toEqual(
      expect.arrayContaining([
        SHOW_FLOW_COMMAND,
        SHOW_CALLERS_COMMAND,
        SHOW_CALLEES_COMMAND,
        SHOW_FILE_DEPENDENCIES_COMMAND,
        SHOW_DEPENDENCIES_COMMAND,
        SHOW_CONTROL_FLOW_COMMAND,
        SHOW_TRAIT_MAP_COMMAND,
        SHOW_REQUEST_FLOW_COMMAND,
      ]),
    );
    const containers = manifest.contributes?.viewsContainers?.activitybar ?? [];
    expect(containers.map((container) => container.id)).toContain(VIEW_CONTAINER_ID);
    expect(containers.some((container) => container.icon === 'media/codeflow.svg')).toBe(true);
    const views = manifest.contributes?.views?.[VIEW_CONTAINER_ID] ?? [];
    expect(views).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: SIDEBAR_VIEW_ID, type: 'webview' })]),
    );
  });

  it('offers Show Flow for Rust and the rust-analyzer setting', () => {
    const when = manifest.contributes?.menus?.['editor/context']?.find(
      (item) => item.command === SHOW_FLOW_COMMAND,
    )?.when;
    expect(when).toContain('editorLangId == rust');
    const setting =
      manifest.contributes?.configuration?.properties?.['codeflow.rust.useRustAnalyzer'];
    expect(setting).toMatchObject({ type: 'boolean', default: true });
    const mode = manifest.contributes?.configuration?.properties?.['codeflow.view.defaultMode'];
    expect(mode).toMatchObject({ type: 'string', default: 'focus' });
    const maxNodes = manifest.contributes?.configuration?.properties?.['codeflow.view.maxNodes'];
    expect(maxNodes).toMatchObject({ type: 'number', default: 300 });
    const editorWhen = manifest.contributes?.menus?.['editor/context']?.map((item) => item.command);
    expect(editorWhen).toEqual(
      expect.arrayContaining([
        SHOW_FLOW_COMMAND,
        SHOW_CALLERS_COMMAND,
        SHOW_CALLEES_COMMAND,
        SHOW_FILE_DEPENDENCIES_COMMAND,
      ]),
    );
    const explorer = manifest.contributes?.menus?.['explorer/context']?.find(
      (item) => item.command === SHOW_DEPENDENCIES_COMMAND,
    );
    expect(explorer?.when).toContain('explorerResourceIsFolder');
    expect(explorer?.when).toContain('resourceLangId == rust');
    const binding = manifest.contributes?.keybindings?.find(
      (item) => item.command === SHOW_FLOW_COMMAND,
    );
    expect(binding).toMatchObject({ key: 'ctrl+alt+f', mac: 'cmd+alt+f' });
    expect(binding?.when).toContain('editorLangId == typescript');
    const flowWhen = manifest.contributes?.menus?.['editor/context']?.find(
      (item) => item.command === SHOW_CONTROL_FLOW_COMMAND,
    )?.when;
    expect(flowWhen).toContain('editorLangId == typescript');
    expect(flowWhen).toContain('editorLangId == rust');
    expect(manifest.activationEvents).toContain(`onCommand:${SHOW_CONTROL_FLOW_COMMAND}`);
    expect(manifest.activationEvents).toContain(`onCommand:${SHOW_TRAIT_MAP_COMMAND}`);
    expect(manifest.activationEvents).toContain(`onCommand:${SHOW_REQUEST_FLOW_COMMAND}`);
    const traitWhen = manifest.contributes?.menus?.['editor/context']?.find(
      (item) => item.command === SHOW_TRAIT_MAP_COMMAND,
    )?.when;
    expect(traitWhen).toBe('editorLangId == rust');
    expect(binding?.when).not.toContain('shift+alt+f');
    const follow =
      manifest.contributes?.configuration?.properties?.['codeflow.editor.followCursor'];
    expect(follow).toMatchObject({ type: 'boolean', default: true });
    const refocus =
      manifest.contributes?.configuration?.properties?.['codeflow.editor.refocusOnCursor'];
    expect(refocus).toMatchObject({ type: 'boolean', default: false });
    const depth = manifest.contributes?.configuration?.properties?.['codeflow.editor.callDepth'];
    expect(depth).toMatchObject({ type: 'number', default: 2 });
    const codeLens = manifest.contributes?.configuration?.properties?.['codeflow.codeLens.enabled'];
    expect(codeLens).toMatchObject({ type: 'boolean', default: true });
  });
});
