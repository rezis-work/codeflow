import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverProjects } from './discover';
import { openAnalysisSession } from './analyzer';

const FILE_COUNT = 80;

describe('TypeScript analyzer performance', () => {
  it('analyzes a generated project of many files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codeflow-perf-'));
    try {
      mkdirSync(path.join(root, 'src'));
      writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            noEmit: true,
            types: [],
            lib: ['ES2022'],
            skipLibCheck: true,
          },
          include: ['src'],
        }),
      );
      for (let index = 0; index < FILE_COUNT; index += 1) {
        const previous =
          index === 0 ? '' : `import { ping as previous } from './file${index - 1}';\n`;
        const call = index === 0 ? 'return value + 1;' : 'return previous(value + 1);';
        writeFileSync(
          path.join(root, 'src', `file${index}.ts`),
          `${previous}export function ping(value: number): number {\n  ${call}\n}\nexport function local(value: number): number {\n  return ping(value);\n}\nexport class Box${index} {\n  constructor(readonly value: number) {}\n  get(): number {\n    return this.value;\n  }\n}\n`,
        );
      }

      const discovered = discoverProjects(root, { maxFiles: 1_000 });
      const project = discovered.projects[0];
      if (!project) {
        throw new Error('Perf fixture did not discover a project.');
      }
      const session = openAnalysisSession(project);
      const started = performance.now();
      const fragments = session.analyze();
      const analyzeMs = Math.round(performance.now() - started);
      const nodes = fragments.reduce((sum, file) => sum + file.nodes.length, 0);
      const edges = fragments.reduce((sum, file) => sum + file.edges.length, 0);

      const edited = path.join(root, 'src', 'file10.ts');
      const reanalyzeStarted = performance.now();
      const updated = session.upsert({
        filePath: edited,
        content:
          "import { ping as previous } from './file9';\nexport function ping(value: number): number {\n  return previous(value + 2);\n}\nexport function local(value: number): number {\n  return ping(value);\n}\n",
        version: 2,
      });
      const reanalyzeMs = Math.round(performance.now() - reanalyzeStarted);
      session.dispose();

      console.info(
        `codeflow-ts-perf files=${fragments.length} nodes=${nodes} edges=${edges} analyzeMs=${analyzeMs} reanalyzeMs=${reanalyzeMs}`,
      );
      expect(fragments.length).toBe(FILE_COUNT);
      expect(updated?.nodes.some((node) => node.qualifiedName === 'ping')).toBe(true);
      expect(analyzeMs).toBeLessThan(45_000);
      expect(reanalyzeMs).toBeLessThan(45_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
