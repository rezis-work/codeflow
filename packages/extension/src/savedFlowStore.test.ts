import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNode, parseSavedFlowDocument } from '@codeflow/shared';
import type { SavedFlow } from '@codeflow/shared';
import { describe, expect, it } from 'vitest';
import { SavedFlowRepository, memoryBackend, workspaceFileBackend } from './savedFlowStore';

const range = { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } };

function greet(uri: string): SavedFlow {
  const node = createNode({
    kind: 'function',
    name: 'greet',
    qualifiedName: 'greet',
    language: 'ts',
    uri,
    range,
  });
  const parsed = parseSavedFlowDocument({
    version: 1,
    flows: [
      {
        id: 'flow-1',
        name: 'Greet',
        kind: 'callGraph',
        root: {
          label: 'greet',
          language: 'ts',
          uri,
          qualifiedName: 'greet',
          nodeId: node.id,
        },
        options: { depth: 2, viewMode: 'focus' },
        collapsedNodeIds: [],
        snapshot: {
          kind: 'graph',
          capturedAt: '2026-11-15T00:00:00.000Z',
          graph: { nodes: [node], edges: [], pendingEdges: [] },
        },
        createdAt: '2026-11-15T00:00:00.000Z',
        updatedAt: '2026-11-15T00:00:00.000Z',
      },
    ],
  });
  if (!parsed.ok || !parsed.value.flows[0]) {
    throw new Error(parsed.ok ? 'missing flow' : parsed.error);
  }
  return parsed.value.flows[0];
}

describe('SavedFlowRepository', () => {
  it('reads the same flows after a new repository opens the same bytes', async () => {
    const backend = memoryBackend();
    const first = new SavedFlowRepository(backend);
    await first.upsert(greet('file:///proj/a.ts'));
    await first.rename('flow-1', 'Hello', '2026-11-15T01:00:00.000Z');

    const stored = memoryBackend(backend.snapshot());
    const restarted = new SavedFlowRepository(stored);
    expect(restarted.readError).toBeUndefined();
    expect(restarted.list().map((flow) => flow.name)).toEqual(['Hello']);
    expect(restarted.get('flow-1')?.root.qualifiedName).toBe('greet');

    await restarted.remove('flow-1');
    expect(new SavedFlowRepository(memoryBackend(stored.snapshot())).list()).toEqual([]);
  });

  it('stores a workspace-relative root and restores the file URI', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'codeflow-flows-'));
    const uri = `file://${workspace}/src/a.ts`;
    const file = path.join(workspace, '.codeflow', 'flows.json');
    const backend = workspaceFileBackend(file, workspace);
    await new SavedFlowRepository(backend).upsert(greet(uri));

    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      flows: { root: { uri: string } }[];
    };
    expect(raw.flows[0]?.root.uri).toBe('src/a.ts');

    const restarted = new SavedFlowRepository(workspaceFileBackend(file, workspace));
    expect(restarted.get('flow-1')?.root.uri).toBe(uri);
  });

  it('refuses to overwrite a file it cannot parse', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'codeflow-flows-'));
    const file = path.join(workspace, '.codeflow', 'flows.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{', 'utf8');
    const repository = new SavedFlowRepository(workspaceFileBackend(file, workspace));
    expect(repository.readError).toBeTruthy();
    await expect(repository.upsert(greet('file:///proj/a.ts'))).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{');
  });
});
