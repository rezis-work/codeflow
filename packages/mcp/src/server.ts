import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GraphCache } from './cache.js';
import {
  codeflowExecute,
  codeflowSearch,
  explainFunction,
  findDuplicates,
  getCallees,
  getCallers,
  getContext,
  impactOf,
  pathBetween,
  planTask,
  reviewChanges,
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
        'Transitive callers (default 3 hops), affected routes and entry points, likely tests, uncertain edges, and a low/medium/high risk score. Pass name/path/id, targets, files, or diff:true for the working tree. A single name still works. No model call.',
      inputSchema: {
        name,
        path: filePath,
        id,
        hops: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe('Caller hops. Defaults to 3. The ceiling is 8.'),
        targets: z
          .array(z.string())
          .optional()
          .describe('Function names, ids, or path#function values.'),
        files: z
          .array(z.string())
          .optional()
          .describe('Repository-relative files. Every function in each file is a target.'),
        diff: z
          .boolean()
          .optional()
          .describe('Score functions changed in the working tree versus the base branch.'),
        base: z
          .string()
          .optional()
          .describe('Base git ref for diff. Empty tries origin/main, then main.'),
      },
      annotations: readOnly,
    },
    async (args) =>
      reply(
        await impactOf(cache, {
          ...locatedArgs(args),
          ...(Array.isArray(args.targets)
            ? { targets: args.targets.filter((item): item is string => typeof item === 'string') }
            : {}),
          ...(Array.isArray(args.files)
            ? { files: args.files.filter((item): item is string => typeof item === 'string') }
            : {}),
          ...(args.diff === true ? { diff: true } : {}),
          ...(typeof args.base === 'string' && args.base.length > 0 ? { base: args.base } : {}),
        }),
      ),
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
    'get_context',
    {
      title: 'Architecture map',
      description:
        'A compact architecture map of the repo: languages, packages, modules, entry points and routes, hub functions, high fan-in helpers, and cycles. focus limits it to a folder, file, or path#function. This does not write AGENTS.md.',
      inputSchema: {
        focus: z
          .string()
          .optional()
          .describe('Folder, file, or path#function. Empty maps the whole workspace.'),
        budget: z
          .number()
          .int()
          .min(40)
          .max(8000)
          .optional()
          .describe('Token budget. Defaults to 1500. Estimated as characters divided by 4.'),
      },
      annotations: readOnly,
    },
    async (args) =>
      reply(
        await getContext(cache, {
          ...(typeof args.focus === 'string' && args.focus.length > 0 ? { focus: args.focus } : {}),
          ...(typeof args.budget === 'number' ? { budget: args.budget } : {}),
        }),
      ),
  );
  register(
    'plan_task',
    {
      title: 'Plan a task',
      description:
        'Rank the smallest set of functions to read first for a natural-language task. focus is a file or path#function. budget is how many items to return, from 1 to 40, default 12. Each item has a one-line reason, an edit or read action, and a token estimate. This does not call a language model.',
      inputSchema: {
        task: z.string().min(1).describe('What the agent should do, in plain language.'),
        focus: z
          .string()
          .optional()
          .describe(
            'File or path#function to keep in the set even when the task does not name it.',
          ),
        budget: z
          .number()
          .int()
          .min(1)
          .max(40)
          .optional()
          .describe('How many functions to return. Defaults to 12.'),
      },
      annotations: readOnly,
    },
    async (args) =>
      reply(
        await planTask(cache, {
          ...(typeof args.task === 'string' ? { task: args.task } : {}),
          ...(typeof args.focus === 'string' && args.focus.length > 0 ? { focus: args.focus } : {}),
          ...(typeof args.budget === 'number' ? { budget: args.budget } : {}),
        }),
      ),
  );
  register(
    'find_duplicates',
    {
      title: 'Find duplicate helpers',
      description:
        'Find new or changed functions that reimplement an existing helper. With no base, compare the working tree with HEAD. base uses the merge base of that ref. threshold is the similarity required, from 0.5 to 0.95, default 0.8. The result includes a fix prompt. This does not call a language model.',
      inputSchema: {
        base: z.string().optional().describe('Git ref. Empty compares the working tree with HEAD.'),
        threshold: z
          .number()
          .min(0.5)
          .max(0.95)
          .optional()
          .describe('Similarity required before a finding is reported. Defaults to 0.8.'),
      },
      annotations: readOnly,
    },
    async (args) =>
      reply(
        await findDuplicates(cache, {
          ...(typeof args.base === 'string' && args.base.length > 0 ? { base: args.base } : {}),
          ...(typeof args.threshold === 'number' ? { threshold: args.threshold } : {}),
        }),
      ),
  );
  register(
    'review_changes',
    {
      title: 'Review agent changes',
      description:
        'Diff the call and import graph. With no base, compare the working tree with HEAD. base uses the merge base of that ref. format is json (default) or markdown. Flags cover new cycles, newly dead code, route and entry-point changes, and high fan-in signature changes.',
      inputSchema: {
        base: z.string().optional().describe('Git ref. Empty compares the working tree with HEAD.'),
        format: z
          .enum(['json', 'markdown', 'md'])
          .optional()
          .describe('json returns the report. markdown returns the review text.'),
      },
      annotations: readOnly,
    },
    async (args) =>
      reply(
        await reviewChanges(cache, {
          ...(typeof args.base === 'string' && args.base.length > 0 ? { base: args.base } : {}),
          ...(typeof args.format === 'string' ? { format: args.format } : {}),
        }),
      ),
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
