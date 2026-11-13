/**
 * Turns Rust sources into file fragments.
 *
 * Parsing stays in tree-sitter. Reanalyzing one file reparses that file and
 * rebuilds the crate index, then returns only the edited file. Other files
 * keep their fragments until they change or the workspace is indexed again.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hashContent } from '@codeflow/shared';
import type { FileFragment } from '@codeflow/shared';
import { pathToFileUri } from '../typescript/uri';
import type { RustDiscovery } from './discover';
import { isAnalyzableRustFile } from './discover';
import { buildRustFragments } from './emit';
import { parseRustFile } from './parser';
import type { ParsedRustFile } from './syntax';

export interface RustAnalysisSession {
  readonly key: string;
  readonly rootDir: string;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly limitReached: boolean;
  has(filePath: string): boolean;
  analyze(): FileFragment[];
  upsert(input: {
    readonly filePath: string;
    readonly content: string;
    readonly version?: number;
  }): FileFragment | undefined;
  remove(filePath: string): void;
  dispose(): void;
}

interface FileState {
  readonly filePath: string;
  content: string;
  version?: number;
}

interface ParsedState {
  readonly hash: string;
  readonly file: ParsedRustFile;
}

export function openRustSession(discovery: RustDiscovery): RustAnalysisSession {
  return new RustSession(discovery);
}

class RustSession implements RustAnalysisSession {
  public readonly errors: string[] = [];
  public limitReached: boolean;
  private readonly files = new Map<string, FileState>();
  private readonly parsed = new Map<string, ParsedState>();

  public constructor(private readonly discovery: RustDiscovery) {
    this.limitReached = discovery.capped;
    for (const file of discovery.files) {
      this.readFromDisk(path.resolve(file));
    }
  }

  public get key(): string {
    return this.discovery.rootDir;
  }

  public get rootDir(): string {
    return this.discovery.rootDir;
  }

  public get warnings(): readonly string[] {
    return this.discovery.warnings;
  }

  public has(filePath: string): boolean {
    return this.files.has(path.resolve(filePath));
  }

  public analyze(): FileFragment[] {
    this.errors.length = 0;
    try {
      return this.emitAll();
    } catch (error) {
      this.errors.push(error instanceof Error ? error.message : 'Could not analyze Rust.');
      return [];
    }
  }

  public upsert(input: {
    readonly filePath: string;
    readonly content: string;
    readonly version?: number;
  }): FileFragment | undefined {
    this.errors.length = 0;
    const filePath = path.resolve(input.filePath);
    if (!this.allowed(filePath)) {
      this.remove(filePath);
      return undefined;
    }
    const existing = this.files.get(filePath);
    if (!existing && this.files.size >= this.discovery.maxFiles) {
      this.limitReached = true;
      return undefined;
    }
    const state: FileState = {
      filePath,
      content: input.content,
      ...(input.version !== undefined
        ? { version: input.version }
        : existing?.version !== undefined
          ? { version: existing.version }
          : {}),
    };
    this.files.set(filePath, state);
    try {
      const uri = pathToFileUri(filePath);
      return this.emitAll().find((fragment) => fragment.uri === uri);
    } catch (error) {
      this.errors.push(error instanceof Error ? error.message : `Could not analyze ${filePath}.`);
      return undefined;
    }
  }

  public remove(filePath: string): void {
    const resolved = path.resolve(filePath);
    this.files.delete(resolved);
    this.parsed.delete(resolved);
  }

  public dispose(): void {
    this.files.clear();
    this.parsed.clear();
  }

  private readFromDisk(filePath: string): void {
    if (!this.allowed(filePath)) {
      return;
    }
    try {
      this.files.set(filePath, { filePath, content: readFileSync(filePath, 'utf8') });
    } catch {
      // A file that disappears between discovery and reading is skipped.
    }
  }

  private allowed(filePath: string): boolean {
    return isAnalyzableRustFile(filePath, this.discovery.rootDir, this.discovery.excludeGlobs);
  }

  private emitAll(): FileFragment[] {
    const parsed = new Map<string, ParsedRustFile>();
    const texts = new Map<string, { content: string; version?: number }>();
    for (const state of this.files.values()) {
      const hash = hashContent(state.content);
      const cached = this.parsed.get(state.filePath);
      let file = cached?.hash === hash ? cached.file : undefined;
      if (!file) {
        try {
          file = parseRustFile(state.content);
          this.parsed.set(state.filePath, { hash, file });
        } catch (error) {
          this.errors.push(
            error instanceof Error ? error.message : `Could not parse ${state.filePath}.`,
          );
          continue;
        }
      }
      parsed.set(state.filePath, file);
      texts.set(state.filePath, {
        content: state.content,
        ...(state.version !== undefined ? { version: state.version } : {}),
      });
    }
    return buildRustFragments({
      crates: this.discovery.crates,
      parsed,
      files: texts,
      allowed: (filePath) => this.allowed(filePath),
    });
  }
}
