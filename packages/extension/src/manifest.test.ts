import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OPEN_DIAGRAM_COMMAND,
  OPEN_DIAGRAM_WINDOW_COMMAND,
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

interface SettingProperty {
  type?: string;
  default?: unknown;
  description?: string;
  order?: number;
}

interface ConfigurationSection {
  title?: string;
  order?: number;
  properties?: Record<string, SettingProperty>;
}

interface Manifest {
  name?: string;
  displayName?: string;
  publisher?: string;
  version?: string;
  pricing?: string;
  license?: string;
  icon?: string;
  extensionKind?: string[];
  main?: string;
  engines?: { vscode?: string };
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command?: string }>;
    viewsContainers?: { activitybar?: Array<{ id?: string; icon?: string }> };
    views?: Record<string, Array<{ id?: string; type?: string }>>;
    menus?: {
      'editor/context'?: Array<{ command?: string; when?: string }>;
      'editor/title'?: Array<{ command?: string; when?: string }>;
      'explorer/context'?: Array<{ command?: string; when?: string }>;
      commandPalette?: Array<{ command?: string }>;
    };
    keybindings?: Array<{ command?: string; key?: string; mac?: string; when?: string }>;
    configuration?: ConfigurationSection | ConfigurationSection[];
  };
}

function settingsOf(manifest: Manifest): Record<string, SettingProperty> {
  const configuration = manifest.contributes?.configuration;
  const sections = Array.isArray(configuration)
    ? configuration
    : configuration
      ? [configuration]
      : [];
  return Object.assign({}, ...sections.map((section) => section.properties ?? {}));
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
    expect(manifest.engines?.vscode).toBe('^1.90.0');
    expect(manifest.main).toBe('./dist/extension.js');
  });

  it('contributes the CodeFlow activity bar and the open-diagram command', () => {
    expect(manifest.activationEvents).toEqual(['onStartupFinished', 'onLanguage:python']);
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
    const setting = settingsOf(manifest)?.['codeflow.rust.useRustAnalyzer'];
    expect(setting).toMatchObject({ type: 'boolean', default: true });
    const mode = settingsOf(manifest)?.['codeflow.view.defaultMode'];
    expect(mode).toMatchObject({ type: 'string', default: 'focus' });
    const maxNodes = settingsOf(manifest)?.['codeflow.view.maxNodes'];
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
    expect(manifest.activationEvents).toEqual(['onStartupFinished', 'onLanguage:python']);
    const traitWhen = manifest.contributes?.menus?.['editor/context']?.find(
      (item) => item.command === SHOW_TRAIT_MAP_COMMAND,
    )?.when;
    expect(traitWhen).toBe('editorLangId == rust');
    expect(binding?.when).not.toContain('shift+alt+f');
    const follow = settingsOf(manifest)?.['codeflow.editor.followCursor'];
    expect(follow).toMatchObject({ type: 'boolean', default: true });
    const refocus = settingsOf(manifest)?.['codeflow.editor.refocusOnCursor'];
    expect(refocus).toMatchObject({ type: 'boolean', default: false });
    const depth = settingsOf(manifest)?.['codeflow.editor.callDepth'];
    expect(depth).toMatchObject({ type: 'number', default: 2 });
    const fullWindow = settingsOf(manifest)?.['codeflow.diagram.openInFullWindow'];
    expect(fullWindow).toMatchObject({ type: 'boolean', default: false });
    expect(manifest.contributes?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: OPEN_DIAGRAM_WINDOW_COMMAND,
          title: 'CodeFlow: Open Diagram in Full Window',
        }),
      ]),
    );
    expect(manifest.contributes?.menus?.commandPalette).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: OPEN_DIAGRAM_WINDOW_COMMAND })]),
    );
    expect(manifest.contributes?.menus?.['editor/title']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: OPEN_DIAGRAM_WINDOW_COMMAND }),
        expect.objectContaining({ command: 'codeflow.openDiagramBeside' }),
        expect.objectContaining({ command: 'codeflow.openDiagramNewWindow' }),
      ]),
    );
    const codeLens = settingsOf(manifest)?.['codeflow.codeLens.enabled'];
    expect(codeLens).toMatchObject({ type: 'boolean', default: true });
    const cache = settingsOf(manifest)?.['codeflow.cache.enabled'];
    expect(cache).toMatchObject({ type: 'boolean', default: true });
    expect(manifest.contributes?.commands?.map((command) => command.command)).toEqual(
      expect.arrayContaining([
        'codeflow.clearCache',
        'codeflow.toggleRuntimeTrace',
        'codeflow.clearRuntimeTrace',
        'codeflow.explainFlow',
        'codeflow.setAiApiKey',
        'codeflow.clearAiApiKey',
        'codeflow.setupMcp',
        'codeflow.showImpact',
        'codeflow.showImpactDiff',
        'codeflow.updateAgentContext',
        'codeflow.reviewChanges',
        'codeflow.planTask',
        'codeflow.checkDuplicates',
      ]),
    );
  });

  it('publishes as rezis-work.rezis-codeflow with documented settings', () => {
    expect(manifest.name).toBe('rezis-codeflow');
    expect(manifest.displayName).toBe('Rezis CodeFlow');
    expect(manifest.publisher).toBe('rezis-work');
    expect(manifest.version).toBe('1.2.0');
    expect(manifest.pricing).toBe('Free');
    expect(manifest.license).toBe('MIT');
    expect(manifest.icon).toBe('media/codeflow-icon.png');
    expect(manifest.extensionKind).toEqual(['workspace']);
    expect(Array.isArray(manifest.contributes?.configuration)).toBe(true);
    const settings = settingsOf(manifest);
    for (const [key, property] of Object.entries(settings)) {
      expect(property.description && property.description.length > 20, key).toBe(true);
      expect(property, key).toHaveProperty('default');
      expect(typeof property.order, key).toBe('number');
    }
    expect(Object.keys(settings).sort()).toEqual(
      [
        'codeflow.ai.baseUrl',
        'codeflow.ai.enabled',
        'codeflow.ai.model',
        'codeflow.ai.modelFamily',
        'codeflow.ai.provider',
        'codeflow.ai.snippetChars',
        'codeflow.cache.enabled',
        'codeflow.codeLens.enabled',
        'codeflow.context.autoUpdate',
        'codeflow.context.budget',
        'codeflow.context.targets',
        'codeflow.diagram.openInFullWindow',
        'codeflow.duplicates.onSave',
        'codeflow.duplicates.threshold',
        'codeflow.editor.callDepth',
        'codeflow.editor.followCursor',
        'codeflow.editor.refocusOnCursor',
        'codeflow.exclude',
        'codeflow.export.auto',
        'codeflow.export.background',
        'codeflow.export.json',
        'codeflow.export.maxNodes',
        'codeflow.export.path',
        'codeflow.export.pngScale',
        'codeflow.impact.hops',
        'codeflow.maxFiles',
        'codeflow.mcp.enabled',
        'codeflow.pr.baseBranch',
        'codeflow.pr.enabled',
        'codeflow.pr.includeUncommitted',
        'codeflow.rust.useRustAnalyzer',
        'codeflow.savedFlows.storeInWorkspace',
        'codeflow.view.defaultMode',
        'codeflow.view.maxNodes',
      ].sort(),
    );
  });
});
