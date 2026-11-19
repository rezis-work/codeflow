/**
 * Security model
 * --------------
 * `codeflow_execute` runs a short snippet against a JSON copy of the call
 * graph. The copy holds names, locations, and a capped slice of each
 * function. It does not hold a way to read the rest of the disk.
 *
 * The snippet runs in a fresh `node:vm` context:
 * - `codeGeneration.strings` and `codeGeneration.wasm` are false, so `eval`,
 *   `new Function`, and `globalThis.constructor.constructor("...")` cannot
 *   compile code.
 * - The context is created empty. `require`, `process`, `fs`, and network
 *   APIs are not defined there.
 * - Query functions are created inside that context from this package's
 *   engine source. Host functions are not passed in. A host function's
 *   constructor can reach the host `process`, so passing one would undo the
 *   lock.
 * - The script timeout (2 seconds) interrupts a synchronous loop. The JSON
 *   result is discarded when it is larger than the output cap.
 *
 * `node:vm` is not a kernel sandbox. This process never accepts snippets from
 * the network; the only client is the local MCP stdio session. Do not expose
 * the server on a socket. The snippet still cannot be given a `require` or a
 * file handle, and a failed escape throws instead of touching the workspace.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import type { GraphData } from './queryEngine.js';

export const EXECUTE_TIMEOUT_MS = 2_000;
export const EXECUTE_OUTPUT_CAP = 24_000;
export const EXECUTE_CODE_CAP = 6_000;

export interface ExecuteOk {
  readonly ok: true;
  readonly result: unknown;
}

export interface ExecuteErr {
  readonly ok: false;
  readonly error: string;
}

export function executeSnippet(
  data: GraphData,
  code: string,
  options?: { readonly timeoutMs?: number; readonly outputCap?: number },
): ExecuteOk | ExecuteErr {
  if (code.length > EXECUTE_CODE_CAP) {
    return {
      ok: false,
      error: `Snippet is ${code.length} characters. The cap is ${EXECUTE_CODE_CAP}.`,
    };
  }
  let body: string;
  try {
    body = transpile(code);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not parse the snippet.',
    };
  }
  const timeoutMs = clampTimeout(options?.timeoutMs);
  const outputCap = options?.outputCap ?? EXECUTE_OUTPUT_CAP;
  const script = [
    '"use strict";',
    'const graph = (function () {',
    engineSource(),
    'return createApi(JSON.parse(',
    JSON.stringify(JSON.stringify(data)),
    '));',
    '})();',
    body,
    '__cfUser(graph);',
  ].join('\n');
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  try {
    const compiled = new vm.Script(script, { filename: 'codeflow-execute.js' });
    const value: unknown = compiled.runInContext(context, { timeout: timeoutMs });
    return publish(value, outputCap);
  } catch (error) {
    const message = errorText(error);
    if (message.includes('timed out') || message.includes('Script execution')) {
      return { ok: false, error: `Snippet timed out after ${timeoutMs}ms.` };
    }
    return { ok: false, error: message.split('\n')[0] ?? message };
  }
}

function errorText(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return 'The snippet failed.';
}

function transpile(code: string): string {
  const wrapped = `function __cfUser(graph) {\n${code}\n}\n`;
  const output = ts.transpileModule(wrapped, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: false,
      strict: false,
      ignoreDeprecations: '6.0',
    },
    reportDiagnostics: true,
  });
  const errors = (output.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      first
        ? ts.flattenDiagnosticMessageText(first.messageText, '\n')
        : 'Could not parse the snippet.',
    );
  }
  if (/\bimport\s*\(|\brequire\s*\(/.test(output.outputText)) {
    throw new Error('import and require are not available in a snippet.');
  }
  return output.outputText;
}

function publish(value: unknown, outputCap: number): ExecuteOk | ExecuteErr {
  let text: string;
  try {
    if (value === undefined) {
      return { ok: true, result: null };
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      return { ok: false, error: 'The snippet returned a value that is not JSON.' };
    }
    text = encoded;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The snippet result is not JSON.',
    };
  }
  if (text.length > outputCap) {
    return {
      ok: false,
      error: `Result is ${text.length} characters. The cap is ${outputCap}.`,
    };
  }
  return { ok: true, result: JSON.parse(text) as unknown };
}

function clampTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return EXECUTE_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), EXECUTE_TIMEOUT_MS);
}

function engineSource(): string {
  const engine = readFileSync(fileURLToPath(new URL('./queryEngine.js', import.meta.url)), 'utf8');
  const impact = readFileSync(impactSource(), 'utf8');
  const review = readFileSync(reviewSource(), 'utf8');
  return stripModuleSyntax(`${impact}\n${review}\n${engine}`);
}

function stripModuleSyntax(source: string): string {
  return source
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .split('\n')
    .filter((line) => !line.startsWith('export ') && !line.startsWith('import '))
    .join('\n');
}

function impactSource(): string {
  return bundledSource('impact.js', '../../shared/src/impact.js');
}

function reviewSource(): string {
  return bundledSource('review.js', '../../shared/src/review.js');
}

function bundledSource(name: string, fallback: string): string {
  const beside = fileURLToPath(new URL(`./${name}`, import.meta.url));
  try {
    readFileSync(beside, 'utf8');
    return beside;
  } catch {
    return fileURLToPath(new URL(fallback, import.meta.url));
  }
}
