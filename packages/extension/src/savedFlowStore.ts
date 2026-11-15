/**
 * Saved-flow persistence. The repository is storage-agnostic so a test can
 * reopen it from the same bytes a restarted extension host would read.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseSavedFlowDocument, serializeSavedFlowDocument } from '@codeflow/shared';
import type { SavedFlow, SavedFlowDocument, SavedFlowRoot } from '@codeflow/shared';
import { fileUriToPath, pathToFileUri } from './analyzers/typescript/uri';

export interface SavedFlowBackend {
  read(): unknown;
  write(value: SavedFlowDocument): void | Promise<void>;
}

export class SavedFlowRepository {
  readonly readError: string | undefined;
  private document: SavedFlowDocument;

  public constructor(private readonly backend: SavedFlowBackend) {
    const parsed = parseSavedFlowDocument(backend.read() ?? emptyDocument());
    if (parsed.ok) {
      this.document = parsed.value;
      return;
    }
    this.document = emptyDocument();
    this.readError = parsed.error;
  }

  public list(): readonly SavedFlow[] {
    return this.document.flows;
  }

  public get(id: string): SavedFlow | undefined {
    return this.document.flows.find((flow) => flow.id === id);
  }

  public async upsert(flow: SavedFlow): Promise<void> {
    this.assertWritable();
    const flows = this.document.flows.some((item) => item.id === flow.id)
      ? this.document.flows.map((item) => (item.id === flow.id ? flow : item))
      : [...this.document.flows, flow];
    await this.replace(flows);
  }

  public async rename(id: string, name: string, updatedAt: string): Promise<SavedFlow | undefined> {
    this.assertWritable();
    const current = this.get(id);
    if (!current) {
      return undefined;
    }
    const next = { ...current, name, updatedAt };
    await this.replace(this.document.flows.map((item) => (item.id === id ? next : item)));
    return this.get(id);
  }

  public async remove(id: string): Promise<boolean> {
    this.assertWritable();
    if (!this.get(id)) {
      return false;
    }
    await this.replace(this.document.flows.filter((item) => item.id !== id));
    return true;
  }

  private assertWritable(): void {
    if (this.readError) {
      throw new Error(this.readError);
    }
  }

  private async replace(flows: readonly SavedFlow[]): Promise<void> {
    const parsed = parseSavedFlowDocument({ version: 1, flows });
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    this.document = parsed.value;
    await this.backend.write(parsed.value);
  }
}

export function memoryBackend(initial?: unknown): SavedFlowBackend & {
  snapshot(): unknown;
} {
  let value = initial ?? emptyDocument();
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
    snapshot: () => value,
  };
}

/**
 * `.codeflow/flows.json`. Root paths inside the workspace are stored relative
 * to `workspace` so the file can be committed. Snapshots keep the URIs they
 * were captured with.
 */
export function workspaceFileBackend(filePath: string, workspace: string): SavedFlowBackend {
  return {
    read: () => readWorkspaceFile(filePath, workspace),
    write: (document) => {
      const portable = {
        version: document.version,
        flows: document.flows.map((flow) => ({
          ...flow,
          root: portableRoot(flow.root, workspace),
        })),
      };
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, serializeSavedFlowDocument(portable), 'utf8');
    },
  };
}

export function portableRoot(root: SavedFlowRoot, workspace: string): SavedFlowRoot {
  return {
    ...root,
    ...(root.uri ? { uri: toPortable(root.uri, workspace) } : {}),
    ...(root.folderPath ? { folderPath: toPortable(root.folderPath, workspace) } : {}),
  };
}

export function restoreRoot(root: SavedFlowRoot, workspace: string): SavedFlowRoot {
  return {
    ...root,
    ...(root.uri ? { uri: fromPortableUri(root.uri, workspace) } : {}),
    ...(root.folderPath ? { folderPath: fromPortablePath(root.folderPath, workspace) } : {}),
  };
}

function readWorkspaceFile(filePath: string, workspace: string): unknown {
  if (!existsSync(filePath)) {
    return emptyDocument();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { version: 1, flows: null };
  }
  const parsed = parseSavedFlowDocument(raw);
  if (!parsed.ok) {
    return raw;
  }
  return {
    version: parsed.value.version,
    flows: parsed.value.flows.map((flow) => ({
      ...flow,
      root: restoreRoot(flow.root, workspace),
    })),
  };
}

function toPortable(value: string, workspace: string): string {
  const fsPath = value.startsWith('file:') ? fileUriToPath(value) : path.resolve(workspace, value);
  if (!fsPath) {
    return value;
  }
  const relative = path.relative(workspace, fsPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return value;
  }
  return relative.split(path.sep).join('/');
}

function fromPortableUri(value: string, workspace: string): string {
  if (value.includes(':')) {
    return value;
  }
  return pathToFileUri(path.resolve(workspace, value));
}

function fromPortablePath(value: string, workspace: string): string {
  if (value.startsWith('file:') || path.isAbsolute(value)) {
    return value.startsWith('file:') ? (fileUriToPath(value) ?? value) : value;
  }
  return path.resolve(workspace, value);
}

function emptyDocument(): SavedFlowDocument {
  return { version: 1, flows: [] };
}
