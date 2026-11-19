/**
 * `codeflow mcp` speaks MCP on stdio. Logs stay on stderr so they are not
 * mistaken for protocol messages.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GraphCache } from './cache.js';
import { createServer } from './server.js';

const DEFAULT_MAX_FILES = 2_000;

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(help());
    return 0;
  }
  let root = process.cwd();
  let maxFiles = DEFAULT_MAX_FILES;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--root' && next) {
      root = path.resolve(next);
      index += 1;
    } else if (arg === '--max-files' && next) {
      const parsed = Number(next);
      maxFiles =
        Number.isFinite(parsed) && parsed >= 1
          ? Math.min(Math.floor(parsed), DEFAULT_MAX_FILES)
          : DEFAULT_MAX_FILES;
      index += 1;
    } else if (arg !== undefined) {
      console.error(`Unknown argument ${arg}.\n${help()}`);
      return 1;
    }
  }
  const cache = new GraphCache(root, maxFiles);
  cache.watch();
  const server = createServer(cache);
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    cache.dispose();
  };
  await server.connect(transport);
  console.error(`CodeFlow MCP is reading ${root}`);
  return await new Promise(() => {
    // The stdio transport keeps the process alive until the client closes it.
  });
}

function help(): string {
  return [
    'codeflow mcp [--root dir] [--max-files n]',
    '',
    'Start the CodeFlow MCP server on stdio for the workspace at --root',
    '(default: the current directory). The graph is built once, then refreshed',
    'when a source file changes or when the refresh tool is called.',
  ].join('\n');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'codeflow mcp failed');
      process.exitCode = 1;
    });
}
