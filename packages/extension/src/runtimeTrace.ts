/**
 * Records debugger stops and turns them into a runtime-trace message.
 *
 * The Node debugger, CodeLLDB, and debugpy speak DAP. A stop does not include a
 * location; the stackTrace that follows does. This module does not talk to
 * VS Code. The host asks for the stack, then calls {@link RuntimeTraceController.recordStack}.
 * Recording is opt-in. Stops before Start, and stops after Stop, are ignored.
 * Clear drops the path and stops recording.
 */

import type {
  RuntimeTraceCall,
  RuntimeTraceFrame,
  RuntimeTraceMessage,
  RuntimeTraceSymbol,
} from '@codeflow/shared';
import { RUNTIME_TRACE_STEP_LIMIT, buildRuntimeTrace } from '@codeflow/shared';

/** Debug adapter `type` values that can feed a runtime trace. */
export const RUNTIME_TRACE_DEBUG_TYPES = [
  'node',
  'node2',
  'pwa-node',
  'node-terminal',
  'lldb',
  'codelldb',
  'debugpy',
  'python',
] as const;

const USER_SOURCE = /\.(?:tsx?|jsx?|mjs|cjs|rs|py)$/i;
const SKIPPED_TRACE_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  'site-packages',
  'dist-packages',
  'venv',
  '.venv',
  '__pycache__',
]);

export function isRuntimeTraceDebugType(type: string): boolean {
  return (RUNTIME_TRACE_DEBUG_TYPES as readonly string[]).includes(type);
}

/** Source the trace will keep. Library and generated frames are left out. */
export function isUserTracePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  if (normalized.split('/').some((segment) => SKIPPED_TRACE_SEGMENTS.has(segment))) {
    return false;
  }
  return USER_SOURCE.test(normalized);
}

export interface DapFrame {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly name?: string;
}

/** Thread id from a DAP `stopped` event, or undefined for any other message. */
export function stoppedThreadId(message: unknown): number | undefined {
  if (!isRecord(message) || message.type !== 'event' || message.event !== 'stopped') {
    return undefined;
  }
  if (!isRecord(message.body) || !Number.isInteger(message.body.threadId)) {
    return undefined;
  }
  const threadId = message.body.threadId;
  return typeof threadId === 'number' && threadId >= 0 ? threadId : undefined;
}

/**
 * Frames from a stackTrace response body, a full DAP response, or an array.
 * Lines and columns stay 1-based, matching DAP.
 */
export function parseDapFrames(value: unknown): readonly DapFrame[] {
  const list = frameList(value);
  if (!list) {
    return [];
  }
  const frames: DapFrame[] = [];
  for (const item of list) {
    const frame = readFrame(item);
    if (frame) {
      frames.push(frame);
    }
  }
  return frames;
}

/** First user frame outside node_modules, a virtualenv, or site-packages. */
export function selectUserFrame(frames: readonly DapFrame[]): DapFrame | undefined {
  return frames.find((frame) => isUserTracePath(frame.path));
}

export interface RuntimeTraceController {
  recording(): boolean;
  start(): void;
  stop(): void;
  toggle(): void;
  clear(): void;
  /** One debugger stop. Returns whether a new step was stored. */
  recordStack(frames: unknown): boolean;
  republish(): void;
}

export function createRuntimeTraceController(options: {
  toUri(filePath: string): string | undefined;
  lookup(): {
    readonly symbols: readonly RuntimeTraceSymbol[];
    readonly calls: readonly RuntimeTraceCall[];
  };
  post(message: RuntimeTraceMessage): void;
}): RuntimeTraceController {
  let recording = false;
  let truncated = false;
  let published = false;
  const frames: RuntimeTraceFrame[] = [];

  const publish = (): void => {
    published = true;
    const looked = safeLookup();
    const trace = buildRuntimeTrace({
      recording,
      frames,
      symbols: looked.symbols,
      calls: looked.calls,
      ...(truncated ? { truncated: true } : {}),
    });
    options.post({ type: 'runtimeTrace', ...trace });
  };

  const safeLookup = (): {
    readonly symbols: readonly RuntimeTraceSymbol[];
    readonly calls: readonly RuntimeTraceCall[];
  } => {
    try {
      return options.lookup();
    } catch {
      return { symbols: [], calls: [] };
    }
  };

  return {
    recording: () => recording,
    start() {
      recording = true;
      publish();
    },
    stop() {
      recording = false;
      publish();
    },
    toggle() {
      recording = !recording;
      publish();
    },
    clear() {
      recording = false;
      truncated = false;
      frames.splice(0, frames.length);
      publish();
    },
    recordStack(value: unknown): boolean {
      if (!recording) {
        return false;
      }
      const selected = selectUserFrame(parseDapFrames(value));
      if (!selected) {
        return false;
      }
      const uri = options.toUri(selected.path);
      if (!uri || !isUserTracePath(selected.path)) {
        return false;
      }
      const next: RuntimeTraceFrame = {
        uri,
        line: selected.line - 1,
        character: Math.max(0, selected.column - 1),
        ...(selected.name ? { name: selected.name } : {}),
      };
      const last = frames[frames.length - 1];
      if (
        last &&
        last.uri === next.uri &&
        last.line === next.line &&
        last.character === next.character
      ) {
        return false;
      }
      if (frames.length >= RUNTIME_TRACE_STEP_LIMIT) {
        truncated = true;
        publish();
        return false;
      }
      frames.push(next);
      publish();
      return true;
    },
    republish() {
      if (published) {
        publish();
      }
    },
  };
}

function frameList(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (Array.isArray(value.stackFrames)) {
    return value.stackFrames;
  }
  if (isRecord(value.body) && Array.isArray(value.body.stackFrames)) {
    return value.body.stackFrames;
  }
  return undefined;
}

function readFrame(value: unknown): DapFrame | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const source = isRecord(value.source) ? value.source : undefined;
  const path = typeof value.path === 'string' ? value.path : source?.path;
  if (typeof path !== 'string' || path.length === 0 || !isPositiveInt(value.line)) {
    return undefined;
  }
  const column = isPositiveInt(value.column) ? value.column : 1;
  const name =
    typeof value.name === 'string' && value.name.trim().length > 0 ? value.name : undefined;
  return {
    path,
    line: value.line,
    column,
    ...(name ? { name } : {}),
  };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
