/**
 * Merges the CodeFlow MCP server into an editor config. Other servers are left
 * as they are. A file that is not JSON is refused so it is not rewritten.
 */

export type McpEditor = 'cursor' | 'vscode';

const SERVER_KEY = {
  cursor: 'mcpServers',
  vscode: 'servers',
} as const;

export interface MergeOk {
  readonly ok: true;
  readonly text: string;
}

export interface MergeErr {
  readonly ok: false;
  readonly error: string;
}

export function mergeMcpConfig(
  existing: string | undefined,
  editor: McpEditor,
): MergeOk | MergeErr {
  let parsed: unknown = {};
  if (existing !== undefined && existing.trim().length > 0) {
    try {
      parsed = JSON.parse(existing) as unknown;
    } catch {
      return { ok: false, error: 'The MCP config is not JSON, so CodeFlow left it unchanged.' };
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: 'The MCP config is not a JSON object, so CodeFlow left it unchanged.',
    };
  }
  const root = { ...(parsed as Record<string, unknown>) };
  const key = SERVER_KEY[editor];
  const current = root[key];
  if (
    current !== undefined &&
    (typeof current !== 'object' || current === null || Array.isArray(current))
  ) {
    return {
      ok: false,
      error: `The MCP config's ${key} value is not an object, so CodeFlow left it unchanged.`,
    };
  }
  const servers = { ...((current as Record<string, unknown> | undefined) ?? {}) };
  const previous = servers.codeflow;
  const kept =
    previous && typeof previous === 'object' && !Array.isArray(previous)
      ? { ...(previous as Record<string, unknown>) }
      : {};
  servers.codeflow =
    editor === 'cursor'
      ? { ...kept, command: 'npx', args: ['codeflow', 'mcp'] }
      : { ...kept, type: 'stdio', command: 'npx', args: ['codeflow', 'mcp'] };
  root[key] = servers;
  return { ok: true, text: `${JSON.stringify(root, null, 2)}\n` };
}
