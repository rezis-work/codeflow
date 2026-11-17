import { describe, expect, it } from 'vitest';
import { buildAgentFlow, FLOW_SCHEMA_VERSION } from './agentFlow';
import type { AgentCall, AgentSymbol } from './agentFlow';

const greet: AgentSymbol = {
  key: 'greet',
  name: 'greet',
  qualifiedName: 'greet',
  kind: 'function',
  path: 'src/greet.ts',
  line: 1,
  language: 'ts',
};
const format: AgentSymbol = {
  key: 'format',
  name: 'format',
  qualifiedName: 'format',
  kind: 'function',
  path: 'src/greet.ts',
  line: 4,
  language: 'ts',
};
const main: AgentSymbol = {
  key: 'main',
  name: 'main',
  qualifiedName: 'main',
  kind: 'function',
  path: 'src/main.ts',
  line: 1,
  language: 'ts',
};
const other: AgentSymbol = {
  key: 'other',
  name: 'other',
  qualifiedName: 'other',
  kind: 'function',
  path: 'src/other.ts',
  line: 1,
  language: 'ts',
};
const calls: AgentCall[] = [
  { from: 'main', to: 'greet', certainty: 'certain' },
  { from: 'greet', to: 'format', certainty: 'uncertain' },
];

describe('agent flow', () => {
  it('renders the same file when the input order changes', () => {
    const first = buildAgentFlow({
      symbols: [other, format, main, greet],
      calls: [...calls].reverse(),
      maxNodes: 10,
      changes: {
        base: 'origin/main',
        items: [
          { status: 'removed', name: 'old', path: 'src/old.ts', line: 2 },
          { status: 'added', name: 'draft', path: 'src/greet.ts', line: 8 },
        ],
      },
    });
    const second = buildAgentFlow({
      symbols: [greet, main, format, other],
      calls,
      maxNodes: 10,
      changes: {
        base: 'origin/main',
        items: [
          { status: 'added', name: 'draft', path: 'src/greet.ts', line: 8 },
          { status: 'removed', name: 'old', path: 'src/old.ts', line: 2 },
        ],
      },
    });
    expect(second.markdown).toBe(first.markdown);
    expect(second.json).toBe(first.json);
    expect(first.markdown).toContain('main (src/main.ts:1) -> greet (src/greet.ts:1) [certain]');
    expect(first.markdown).toContain(
      'greet (src/greet.ts:1) -> format (src/greet.ts:4) [uncertain]',
    );
    expect(first.markdown).toContain('- added draft (src/greet.ts:8)');
    expect(first.markdown).not.toContain('function body');
    expect(first.json).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    const parsed = JSON.parse(first.json) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(FLOW_SCHEMA_VERSION);
  });

  it('caps the diagram and still lists the other calls', () => {
    const flow = buildAgentFlow({ symbols: [greet, format, main, other], calls, maxNodes: 1 });
    expect(flow.markdown).toContain('Diagram shows 1 of 4 functions.');
    expect(flow.markdown.match(/n\d+\[/g)).toEqual(['n0[']);
    expect(flow.markdown).toContain('main (src/main.ts:1) -> greet (src/greet.ts:1) [certain]');
    expect(flow.markdown).toContain('### main');
    expect(flow.markdown).toContain('### Exported');
  });

  it('keeps one hop around the focused function', () => {
    const flow = buildAgentFlow({
      symbols: [other, greet, format, main],
      calls,
      maxNodes: 10,
      focus: { path: 'src/greet.ts', name: 'greet', hops: 1 },
    });
    expect(flow.markdown).toContain('greet (src/greet.ts:1)');
    expect(flow.markdown).toContain('format (src/greet.ts:4)');
    expect(flow.markdown).toContain('main (src/main.ts:1)');
    expect(flow.markdown).not.toContain('src/other.ts:1');
    const missing = buildAgentFlow({
      symbols: [greet],
      calls: [],
      maxNodes: 10,
      focus: { path: 'src/nope.ts', name: 'missing', hops: 2 },
    });
    expect(missing.markdown).toContain('No function named missing matched src/nope.ts.');
    expect(missing.markdown).toContain('No functions to draw.');
  });
});
