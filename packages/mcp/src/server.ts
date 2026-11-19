import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GraphCache } from './cache.js';
import {
  codeflowExecute,
  codeflowSearch,
  explainFunction,
  getCallees,
  getCallers,
  impactOf,
  pathBetween,
  refreshGraph,
  type ToolResult,
} from './tools.js';

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const name = z.string().optional().describe('Function or method name.');
const filePath = z.string().optional().describe('Repository-relative path, or part of one.');
const id = z.string().optional().describe('Symbol id from an earlier result.');
const hops = z
  .number()
  .int()
  .min(1)
  .max(8)
  .optional()
  .describe('Call steps. Defaults to 1. The ceiling is 8.');

export function createServer(cache: GraphCache): McpServer {
  const server = new McpServer({ name: 'codeflow', version: '1.1.0' });
  // The SDK's tool generics recurse on Zod schemas until tsc gives up.
  // The schemas are still Zod, so clients receive real JSON Schema.
  const register = server.registerTool.bind(server) as (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema?: Record<string, z.ZodType>;
      annotations: typeof readOnly;
    },
    cb: (args: Record<string, unknown>) => Promise<ReturnType<typeof reply>>,
  ) => void;

  register(
    'codeflow_search',
    {
      title: 'Search the call graph',
      description:
        'Find functions, files, routes, or entry points by name, path, or kind. Also returns the query API used by codeflow_execute.',
      inputSchema: {
        query: z.string().optional().describe('Substring matched against name, path, and kind.'),
        name: z.string().optional().describe('Exact function or method name.'),
        path: filePath,
        kind: z
          .enum(['function', 'method', 'route', 'file', 'entry'])
          .optional()
          .describe('function, method, route, file, or entry.'),
      },
      annotations: readOnly,
    },
    async (args) => reply(await codeflowSearch(cache, strings(args))),
  );

  register(
    'codeflow_execute',
    {
      title: 'Query the call graph',
      description:
        'Run a short JavaScript or TypeScript snippet against a read-only graph API. Return JSON. require, process, fs, import, and the network are not available. A snippet that loops is stopped after 2 seconds.',
      inputSchema: {
        code: z
          .string()
          .describe(
            'Snippet body. `graph` is in scope. Example: return graph.find({ name: "greet" })[0].callers(1)',
          ),
      },
      annotations: readOnly,
    },
    async (args) => reply(await codeflowExecute(cache, { code: stringOf(args.code) })),
  );

  const located = { name, path: filePath, id, hops };
  register(
    'get_callers',
    {
      title: 'Get callers',
      description: 'Functions that call this one, directly or within hops.',
      inputSchema: located,
      annotations: readOnly,
    },
    async (args) => reply(await getCallers(cache, locatedArgs(args))),
  );
  register(
    'get_callees',
    {
      title: 'Get callees',
      description: 'Functions this one calls, directly or within hops.',
      inputSchema: { ...located },
      annotations: readOnly,
    },
    async (args) => reply(await getCallees(cache, locatedArgs(args))),
  );
  register(
    'impact_of',
    {
      title: 'Impact of a function',
      description:
        'Transitive callers, the routes and entry points that reach this function, and tests in that set. No model call.',
      inputSchema: { name, path: filePath, id },
      annotations: readOnly,
    },
    async (args) => reply(await impactOf(cache, locatedArgs(args))),
  );
  register(
    'path_between',
    {
      title: 'Path between two functions',
      description: 'Shortest chain of calls from one function to another.',
      inputSchema: {
        from: z.string().describe('Caller-side function name.'),
        to: z.string().describe('Callee-side function name.'),
        fromPath: z.string().optional().describe('Path hint for from.'),
        toPath: z.string().optional().describe('Path hint for to.'),
      },
      annotations: readOnly,
    },
    async (args) =>
      reply(
        await pathBetween(cache, {
          from: stringOf(args.from),
          to: stringOf(args.to),
          fromPath: stringOf(args.fromPath),
          toPath: stringOf(args.toPath),
        }),
      ),
  );
  register(
    'explain_function',
    {
      title: 'Explain a function',
      description:
        'Signature, file, line, and the direct callers and callees. This does not call a language model.',
      inputSchema: { name, path: filePath, id },
      annotations: readOnly,
    },
    async (args) => reply(await explainFunction(cache, locatedArgs(args))),
  );
  register(
    'refresh',
    {
      title: 'Refresh the call graph',
      description:
        'Read the workspace again. TypeScript, JavaScript, Rust, and Python are parsed locally. The previous graph is served until this finishes.',
      annotations: readOnly,
    },
    async () => reply(await refreshGraph(cache)),
  );

  return server;
}

function strings(args: Record<string, unknown>): {
  query?: string;
  name?: string;
  path?: string;
  kind?: string;
} {
  return {
    query: stringOf(args.query),
    name: stringOf(args.name),
    path: stringOf(args.path),
    kind: stringOf(args.kind),
  };
}

function locatedArgs(args: Record<string, unknown>): {
  name?: string;
  path?: string;
  id?: string;
  hops?: number;
} {
  return {
    name: stringOf(args.name),
    path: stringOf(args.path),
    id: stringOf(args.id),
    ...(typeof args.hops === 'number' ? { hops: args.hops } : {}),
  };
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reply(result: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: result.text }],
    ...(result.isError ? { isError: true } : {}),
  };
}
