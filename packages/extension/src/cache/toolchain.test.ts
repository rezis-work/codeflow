import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rustToolchainFingerprint } from './rustToolchain';
import { typescriptToolchainFingerprint } from './toolchain';

describe('toolchain fingerprints', () => {
  it('changes when Cargo.lock changes and ignores an untouched lockfile', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-cargo-'));
    writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\n');
    writeFileSync(path.join(root, 'Cargo.lock'), 'version = 3\n');
    const first = rustToolchainFingerprint(root);
    expect(rustToolchainFingerprint(root)).toBe(first);
    writeFileSync(path.join(root, 'Cargo.lock'), 'version = 3\n\n[[package]]\nname = "demo"\n');
    expect(rustToolchainFingerprint(root)).not.toBe(first);
  });

  it('changes when tsconfig text changes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-tsconfig-'));
    const config = path.join(root, 'tsconfig.json');
    writeFileSync(config, '{ "compilerOptions": { "strict": true } }\n');
    const first = typescriptToolchainFingerprint(root, config);
    writeFileSync(config, '{ "compilerOptions": { "strict": false } }\n');
    expect(typescriptToolchainFingerprint(root, config)).not.toBe(first);
  });
});
