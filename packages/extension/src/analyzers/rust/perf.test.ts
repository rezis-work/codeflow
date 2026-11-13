import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openRustSession } from './analyzer';
import { discoverRustWorkspace } from './discover';
import type { CargoRunner } from './discover';
import { ensureRustParser } from './ensureParser';

const FILE_COUNT = 80;
const missingCargo: CargoRunner = () => ({
  ok: false,
  missing: true,
  message: 'cargo is not installed',
});

beforeAll(async () => {
  await ensureRustParser();
});

describe('Rust analyzer performance', () => {
  it('analyzes a generated crate of many files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-rust-perf-'));
    try {
      mkdirSync(path.join(root, 'src'));
      const mods = Array.from({ length: FILE_COUNT }, (_, index) => `pub mod file${index};`).join(
        '\n',
      );
      writeFileSync(
        path.join(root, 'Cargo.toml'),
        '[package]\nname = "perf"\nversion = "0.1.0"\nedition = "2021"\n',
      );
      writeFileSync(
        path.join(root, 'src', 'lib.rs'),
        `${mods}\npub fn start(value: i32) -> i32 {\n    file0::ping(value)\n}\n`,
      );
      for (let index = 0; index < FILE_COUNT; index += 1) {
        const call = index === 0 ? 'value + 1' : `crate::file${index - 1}::ping(value + 1)`;
        writeFileSync(
          path.join(root, 'src', `file${index}.rs`),
          `pub struct Box${index} {\n    pub value: i32,\n}\nimpl Box${index} {\n    pub fn get(&self) -> i32 {\n        self.value\n    }\n}\npub fn ping(value: i32) -> i32 {\n    ${call}\n}\n`,
        );
      }

      const discovered = discoverRustWorkspace(root, { maxFiles: 1_000 }, missingCargo);
      const session = openRustSession(discovered);
      const started = performance.now();
      const fragments = session.analyze();
      const analyzeMs = Math.round(performance.now() - started);
      const nodes = fragments.reduce((sum, file) => sum + file.nodes.length, 0);
      const edges = fragments.reduce((sum, file) => sum + file.edges.length, 0);

      const edited = path.join(root, 'src', 'file10.rs');
      const reanalyzeStarted = performance.now();
      const updated = session.upsert({
        filePath: edited,
        content: 'pub fn ping(value: i32) -> i32 {\n    crate::file9::ping(value + 2)\n}\n',
        version: 2,
      });
      const reanalyzeMs = Math.round(performance.now() - reanalyzeStarted);
      session.dispose();

      console.info(
        `codeflow-rust-perf files=${fragments.length} nodes=${nodes} edges=${edges} analyzeMs=${analyzeMs} reanalyzeMs=${reanalyzeMs}`,
      );
      expect(fragments.length).toBe(FILE_COUNT + 1);
      expect(updated?.nodes.some((node) => node.qualifiedName === 'perf::file10::ping')).toBe(true);
      expect(analyzeMs).toBeLessThan(45_000);
      expect(reanalyzeMs).toBeLessThan(45_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
