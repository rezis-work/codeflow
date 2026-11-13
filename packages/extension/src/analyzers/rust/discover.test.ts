import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CARGO_FAILED_WARNING,
  CARGO_MISSING_WARNING,
  discoverRustWorkspace,
  parseCargoManifest,
} from './discover';
import type { CargoRunner } from './discover';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test-fixtures',
);
const rustRoot = path.join(fixtures, 'rust-workspace');

const missingCargo: CargoRunner = () => ({
  ok: false,
  missing: true,
  message: 'cargo is not installed',
});

function relativeFiles(files: readonly string[]): string[] {
  return files.map((file) => path.relative(rustRoot, file).split(path.sep).join('/')).sort();
}

describe('Rust discovery', () => {
  it('reads package names, members, and targets from Cargo.toml', () => {
    const manifest = parseCargoManifest(`
      [package]
      name = "flow-core"
      version = "0.1.0"

      [lib]
      name = "flow_core"
      path = "src/lib.rs"

      [[bin]]
      name = "flow-cli"
      path = "src/main.rs"
    `);
    expect(manifest.packageName).toBe('flow-core');
    expect(manifest.lib).toEqual({ name: 'flow_core', path: 'src/lib.rs' });
    expect(manifest.bins).toEqual([{ name: 'flow-cli', path: 'src/main.rs' }]);
    expect(manifest.hasExplicitBins).toBe(true);
  });

  it('falls back to Cargo.toml when cargo is not installed', () => {
    const discovered = discoverRustWorkspace(rustRoot, { maxFiles: 100 }, missingCargo);
    expect(discovered.cargo).toBe('fallback');
    expect(discovered.warnings).toEqual([CARGO_MISSING_WARNING]);
    expect(discovered.capped).toBe(false);
    expect(discovered.files.every((file) => !file.split(path.sep).includes('target'))).toBe(true);
    expect(relativeFiles(discovered.files)).toEqual(
      expect.arrayContaining([
        'crates/core/src/lib.rs',
        'crates/core/src/models.rs',
        'crates/core/src/generated.rs',
        'crates/core/src/extra/mod.rs',
        'crates/core/src/broken.rs',
        'crates/core/build.rs',
        'crates/app/src/lib.rs',
      ]),
    );
    expect(relativeFiles(discovered.files)).not.toContain('target/skipped.rs');
    expect(relativeFiles(discovered.files)).not.toContain('crates/core/target/debug/skipped.rs');
    const names = discovered.crates.map((crate) => `${crate.kind}:${crate.crateName}`).sort();
    expect(names).toEqual(['build:build_script_build', 'lib:app', 'lib:core']);
    const core = discovered.crates.find((crate) => crate.crateName === 'core');
    expect(core?.externName).toBe('core');
    expect(discovered.crates.find((crate) => crate.kind === 'build')?.externName).toBeUndefined();
  });

  it('accepts cargo metadata when a runner returns it', () => {
    const coreManifest = path.join(rustRoot, 'crates/core/Cargo.toml');
    const appManifest = path.join(rustRoot, 'crates/app/Cargo.toml');
    const coreId = `path+file://${coreManifest}#0.1.0`;
    const appId = `path+file://${appManifest}#0.1.0`;
    const metadata = JSON.stringify({
      workspace_root: rustRoot,
      workspace_members: [coreId, appId],
      packages: [
        {
          name: 'core',
          id: coreId,
          manifest_path: coreManifest,
          targets: [
            {
              name: 'core',
              kind: ['lib'],
              src_path: path.join(rustRoot, 'crates/core/src/lib.rs'),
            },
            {
              name: 'build-script-build',
              kind: ['custom-build'],
              src_path: path.join(rustRoot, 'crates/core/build.rs'),
            },
          ],
        },
        {
          name: 'app',
          id: appId,
          manifest_path: appManifest,
          targets: [
            {
              name: 'app',
              kind: ['lib'],
              src_path: path.join(rustRoot, 'crates/app/src/lib.rs'),
            },
          ],
        },
      ],
    });
    const runner: CargoRunner = () => ({ ok: true, stdout: metadata });
    const discovered = discoverRustWorkspace(rustRoot, { maxFiles: 100 }, runner);
    const fallback = discoverRustWorkspace(rustRoot, { maxFiles: 100 }, missingCargo);
    expect(discovered.cargo).toBe('metadata');
    expect(discovered.warnings).toEqual([]);
    expect(relativeFiles(discovered.files)).toEqual(relativeFiles(fallback.files));
    expect(discovered.crates.map((crate) => `${crate.kind}:${crate.crateName}`).sort()).toEqual(
      fallback.crates.map((crate) => `${crate.kind}:${crate.crateName}`).sort(),
    );
    expect(discovered.files.every((file) => !file.split(path.sep).includes('target'))).toBe(true);
  });

  it('warns once when cargo metadata fails and still scans the manifests', () => {
    let calls = 0;
    const runner: CargoRunner = () => {
      calls += 1;
      return { ok: false, missing: false, message: 'metadata failed' };
    };
    const discovered = discoverRustWorkspace(rustRoot, { maxFiles: 100 }, runner);
    expect(calls).toBeGreaterThan(0);
    expect(discovered.cargo).toBe('fallback');
    expect(discovered.warnings).toEqual([CARGO_FAILED_WARNING]);
    expect(discovered.files.some((file) => file.endsWith(`${path.sep}lib.rs`))).toBe(true);
  });

  it('matches real cargo metadata when cargo is installed', () => {
    const real = discoverRustWorkspace(rustRoot, { maxFiles: 100 });
    const fallback = discoverRustWorkspace(rustRoot, { maxFiles: 100 }, missingCargo);
    if (real.cargo === 'fallback') {
      expect(real.warnings).toContain(CARGO_MISSING_WARNING);
      return;
    }
    expect(real.warnings).toEqual([]);
    expect(relativeFiles(real.files)).toEqual(relativeFiles(fallback.files));
    expect(real.crates.map((crate) => `${crate.kind}:${crate.crateName}`).sort()).toEqual(
      fallback.crates.map((crate) => `${crate.kind}:${crate.crateName}`).sort(),
    );
  });

  it('expands workspace member globs and skips target directories', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-rust-members-'));
    try {
      mkdirSync(path.join(root, 'crates', 'left', 'src'), { recursive: true });
      mkdirSync(path.join(root, 'crates', 'right', 'src'), { recursive: true });
      mkdirSync(path.join(root, 'crates', 'left', 'target', 'debug'), { recursive: true });
      writeFileSync(
        path.join(root, 'Cargo.toml'),
        '[workspace]\nresolver = "2"\nmembers = ["crates/*"]\n',
      );
      writeFileSync(
        path.join(root, 'crates', 'left', 'Cargo.toml'),
        '[package]\nname = "left"\nversion = "0.1.0"\nedition = "2021"\n',
      );
      writeFileSync(
        path.join(root, 'crates', 'right', 'Cargo.toml'),
        '[package]\nname = "right-crate"\nversion = "0.1.0"\nedition = "2021"\n',
      );
      writeFileSync(path.join(root, 'crates', 'left', 'src', 'lib.rs'), 'pub fn left() {}\n');
      writeFileSync(path.join(root, 'crates', 'right', 'src', 'lib.rs'), 'pub fn right() {}\n');
      writeFileSync(
        path.join(root, 'crates', 'left', 'target', 'debug', 'skipped.rs'),
        'fn skipped() {}\n',
      );
      const discovered = discoverRustWorkspace(root, { maxFiles: 100 }, missingCargo);
      const names = discovered.crates.map((crate) => crate.crateName).sort();
      expect(names).toEqual(['left', 'right_crate']);
      expect(discovered.files.every((file) => !file.split(path.sep).includes('target'))).toBe(true);
      expect(discovered.files).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps files and honours exclude globs', () => {
    const capped = discoverRustWorkspace(rustRoot, { maxFiles: 1 }, missingCargo);
    expect(capped.capped).toBe(true);
    expect(capped.files).toHaveLength(1);
    const excluded = discoverRustWorkspace(
      rustRoot,
      { maxFiles: 100, excludeGlobs: ['**/generated.rs'] },
      missingCargo,
    );
    expect(excluded.files.some((file) => file.endsWith('generated.rs'))).toBe(false);
    expect(excluded.files.some((file) => file.endsWith(`${path.sep}models.rs`))).toBe(true);
  });

  it('stays quiet when the folder has no Cargo.toml', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-rust-empty-'));
    try {
      const discovered = discoverRustWorkspace(root, {}, missingCargo);
      expect(discovered.crates).toEqual([]);
      expect(discovered.files).toEqual([]);
      expect(discovered.warnings).toEqual([]);
      expect(discovered.cargo).toBe('metadata');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
