import { describe, expect, it } from 'vitest';
import { mergeMcpConfig } from './mcpConfig';

describe('MCP config merge', () => {
  it('creates a Cursor server without dropping another server', () => {
    const merged = mergeMcpConfig(
      JSON.stringify({ mcpServers: { other: { command: 'echo', args: ['hi'] } } }),
      'cursor',
    );
    expect(merged.ok).toBe(true);
    if (!merged.ok) {
      return;
    }
    const parsed = JSON.parse(merged.text) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    expect(parsed.mcpServers.other).toEqual({ command: 'echo', args: ['hi'] });
    expect(parsed.mcpServers.codeflow).toEqual({ command: 'npx', args: ['codeflow', 'mcp'] });
  });

  it('creates a VS Code server and keeps extra fields on the CodeFlow entry', () => {
    const merged = mergeMcpConfig(
      JSON.stringify({ servers: { codeflow: { env: { FOO: '1' } }, docs: { command: 'docs' } } }),
      'vscode',
    );
    expect(merged.ok).toBe(true);
    if (!merged.ok) {
      return;
    }
    const parsed = JSON.parse(merged.text) as {
      servers: Record<string, { command?: string; type?: string; args?: string[]; env?: unknown }>;
    };
    expect(parsed.servers.docs).toEqual({ command: 'docs' });
    expect(parsed.servers.codeflow).toEqual({
      env: { FOO: '1' },
      type: 'stdio',
      command: 'npx',
      args: ['codeflow', 'mcp'],
    });
  });

  it('refuses a file that is not JSON', () => {
    const merged = mergeMcpConfig('{', 'cursor');
    expect(merged).toEqual({
      ok: false,
      error: 'The MCP config is not JSON, so CodeFlow left it unchanged.',
    });
  });
});
