/**
 * A named diagram the user can open again.
 *
 * The definition is the view kind, the root symbol or entry point, and the
 * options that built it. Opening a flow analyzes the current code. The
 * snapshot is only the last picture, shown when that root no longer resolves.
 *
 * {@link SAVED_FLOW_VERSION} is the document the editor stores. Version 0 is
 * the earlier shape without a snapshot or a nested root. A parser that does
 * not know a version rejects the document.
 */

import { isLanguage, isNonEmptyString, isNonNegativeInteger, isRecord } from './ids';
import type { Language } from './ids';
import { parseControlFlowGraph } from './controlFlow';
import type { ControlFlowGraph } from './controlFlow';
import { isEdgeKind, parseCodeGraph, parsed, rejected } from './graph';
import type { CodeGraph, EdgeKind, ParseResult, Position } from './graph';
import { isSequenceGranularity, parseSequenceDiagram } from './sequence';
import type { SequenceDiagram, SequenceGranularity } from './sequence';

const VIEW_MODES = ['focus', 'workspace', 'traits', 'request'] as const;
type SavedViewMode = (typeof VIEW_MODES)[number];

export const SAVED_FLOW_VERSION = 1 as const;

/** Earlier documents stored a flat flow and no snapshot. */
export const SAVED_FLOW_VERSION_V0 = 0 as const;

export const SAVED_FLOW_KINDS = [
  'callGraph',
  'callers',
  'callees',
  'fileDeps',
  'controlFlow',
  'traitMap',
  'requestFlow',
  'sequence',
] as const;
export type SavedFlowKind = (typeof SAVED_FLOW_KINDS)[number];

const NAME_LIMIT = 80;
const ID_LIMIT = 80;
const LABEL_LIMIT = 200;
const PATH_LIMIT = 2_000;
const FLOW_LIMIT = 100;
const COLLAPSED_LIMIT = 400;
const MIGRATION_TIME = '1970-01-01T00:00:00.000Z';

/** Identity used to find the symbol or entry point again. */
export interface SavedFlowRoot {
  readonly label: string;
  readonly language?: Language;
  /** File URI, or a workspace-relative path in `.codeflow/flows.json`. */
  readonly uri?: string;
  readonly qualifiedName?: string;
  /** Last resolved node id. Reopen prefers the URI and qualified name. */
  readonly nodeId?: string;
  /** Request-flow or request-sequence entry. */
  readonly entryId?: string;
  /** Control-flow cursor, or the function start. */
  readonly position?: Position;
  /** Folder dependency view. A path, relative in the workspace file. */
  readonly folderPath?: string;
}

export interface SavedFlowViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface SavedFlowOptions {
  readonly depth?: number;
  readonly granularity?: SequenceGranularity;
  readonly showUncertain?: boolean;
  readonly showInferred?: boolean;
  readonly direction?: 'callers' | 'callees';
  readonly viewMode?: SavedViewMode;
  readonly sequenceSource?: 'call' | 'request';
  readonly hiddenEdgeKinds?: readonly EdgeKind[];
}

export type SavedFlowSnapshot =
  | { readonly kind: 'graph'; readonly capturedAt: string; readonly graph: CodeGraph }
  | {
      readonly kind: 'controlFlow';
      readonly capturedAt: string;
      readonly graph: ControlFlowGraph;
    }
  | { readonly kind: 'sequence'; readonly capturedAt: string; readonly diagram: SequenceDiagram };

export interface SavedFlow {
  readonly id: string;
  readonly name: string;
  readonly kind: SavedFlowKind;
  readonly root: SavedFlowRoot;
  readonly options: SavedFlowOptions;
  readonly collapsedNodeIds: readonly string[];
  readonly viewport?: SavedFlowViewport;
  readonly snapshot: SavedFlowSnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SavedFlowDocument {
  readonly version: typeof SAVED_FLOW_VERSION;
  readonly flows: readonly SavedFlow[];
}

const KIND_FROM_V0: Record<string, SavedFlowKind> = {
  flow: 'callGraph',
  neighbourhood: 'callGraph',
  callGraph: 'callGraph',
  callers: 'callers',
  callees: 'callees',
  calls: 'callers',
  imports: 'fileDeps',
  file: 'fileDeps',
  fileDeps: 'fileDeps',
  folder: 'fileDeps',
  controlFlow: 'controlFlow',
  flowchart: 'controlFlow',
  traits: 'traitMap',
  traitMap: 'traitMap',
  request: 'requestFlow',
  requestFlow: 'requestFlow',
  sequence: 'sequence',
};

export function isViewMode(value: unknown): value is SavedViewMode {
  return typeof value === 'string' && (VIEW_MODES as readonly string[]).includes(value);
}

export function isSavedFlowKind(value: unknown): value is SavedFlowKind {
  return typeof value === 'string' && (SAVED_FLOW_KINDS as readonly string[]).includes(value);
}

/**
 * Reads a saved-flow document. Version 0 is migrated. A newer version is rejected.
 * Unknown fields on a version this parser understands are ignored.
 */
export function parseSavedFlowDocument(value: unknown): ParseResult<SavedFlowDocument> {
  const migrated = migrateSavedFlowDocument(value);
  if (!migrated.ok) {
    return migrated;
  }
  return parseVersion1(migrated.value);
}

/** Turns version 0, or a document that is already version 1, into version 1 JSON. */
export function migrateSavedFlowDocument(value: unknown): ParseResult<unknown> {
  if (!isRecord(value)) {
    return rejected('A saved-flow document must be an object.');
  }
  if (value.version === SAVED_FLOW_VERSION) {
    return parsed(value);
  }
  if (value.version === undefined || value.version === SAVED_FLOW_VERSION_V0) {
    return parsed(migrateVersion0(value));
  }
  return rejected('Unsupported saved-flow version.');
}

export function serializeSavedFlowDocument(document: SavedFlowDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function migrateVersion0(value: Record<string, unknown>): {
  version: typeof SAVED_FLOW_VERSION;
  flows: unknown[];
} {
  const source = Array.isArray(value.flows) ? value.flows : [];
  return {
    version: SAVED_FLOW_VERSION,
    flows: source.map((item, index) => migrateFlow(item, index)),
  };
}

function migrateFlow(value: unknown, index: number): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const name = firstString(value.name, value.title) ?? `Flow ${index + 1}`;
  const kind = KIND_FROM_V0[firstString(value.kind, value.view) ?? ''] ?? value.kind;
  const root = isRecord(value.root)
    ? value.root
    : {
        label: firstString(value.label, name) ?? name,
        ...(typeof value.language === 'string' ? { language: value.language } : {}),
        ...(typeof value.uri === 'string' ? { uri: value.uri } : {}),
        ...(typeof value.qualifiedName === 'string' ? { qualifiedName: value.qualifiedName } : {}),
        ...(typeof value.nodeId === 'string' ? { nodeId: value.nodeId } : {}),
        ...(typeof value.entryId === 'string' ? { entryId: value.entryId } : {}),
        ...(value.position !== undefined ? { position: value.position } : {}),
        ...(typeof value.folderPath === 'string' ? { folderPath: value.folderPath } : {}),
      };
  const options = isRecord(value.options)
    ? value.options
    : {
        ...(typeof value.depth === 'number' ? { depth: value.depth } : {}),
        ...(typeof value.showUncertain === 'boolean' ? { showUncertain: value.showUncertain } : {}),
        ...(typeof value.granularity === 'string' ? { granularity: value.granularity } : {}),
        ...(value.direction === 'callers' || value.direction === 'callees'
          ? { direction: value.direction }
          : {}),
      };
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : MIGRATION_TIME;
  const snapshot = value.snapshot ?? snapshotFromLegacy(value.graph, createdAt);
  return {
    id: typeof value.id === 'string' ? value.id : `flow-${index + 1}`,
    name,
    kind,
    root,
    options,
    collapsedNodeIds: Array.isArray(value.collapsedNodeIds) ? value.collapsedNodeIds : [],
    ...(value.viewport !== undefined ? { viewport: value.viewport } : {}),
    snapshot,
    createdAt,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : createdAt,
  };
}

function snapshotFromLegacy(graph: unknown, capturedAt: string): unknown {
  if (isRecord(graph) && Array.isArray(graph.nodes)) {
    return { kind: 'graph', capturedAt, graph };
  }
  return {
    kind: 'graph',
    capturedAt,
    graph: { nodes: [], edges: [], pendingEdges: [] },
  };
}

function parseVersion1(value: unknown): ParseResult<SavedFlowDocument> {
  if (!isRecord(value) || value.version !== SAVED_FLOW_VERSION) {
    return rejected('Unsupported saved-flow version.');
  }
  if (!Array.isArray(value.flows) || value.flows.length > FLOW_LIMIT) {
    return rejected('Saved flows must be a list.');
  }
  const flows: SavedFlow[] = [];
  const seen = new Set<string>();
  for (const item of value.flows) {
    const flow = parseFlow(item);
    if (!flow.ok) {
      return flow;
    }
    if (seen.has(flow.value.id)) {
      return rejected('Saved flow ids must be unique.');
    }
    seen.add(flow.value.id);
    flows.push(flow.value);
  }
  return parsed({ version: SAVED_FLOW_VERSION, flows });
}

function parseFlow(value: unknown): ParseResult<SavedFlow> {
  if (!isRecord(value)) {
    return rejected('A saved flow must be an object.');
  }
  if (!isId(value.id)) {
    return rejected('A saved flow needs an id.');
  }
  if (!isName(value.name)) {
    return rejected('A saved flow needs a name.');
  }
  if (!isSavedFlowKind(value.kind)) {
    return rejected('Saved flow kind is not supported.');
  }
  const root = parseRoot(value.root);
  if (!root.ok) {
    return root;
  }
  const options = parseOptions(value.options);
  if (!options.ok) {
    return options;
  }
  const collapsed = parseCollapsed(value.collapsedNodeIds);
  if (!collapsed.ok) {
    return collapsed;
  }
  const viewport = parseViewport(value.viewport);
  if (!viewport.ok) {
    return viewport;
  }
  const snapshot = parseSnapshot(value.snapshot);
  if (!snapshot.ok) {
    return snapshot;
  }
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
    return rejected('A saved flow needs created and updated times.');
  }
  return parsed({
    id: value.id,
    name: value.name.trim(),
    kind: value.kind,
    root: root.value,
    options: options.value,
    collapsedNodeIds: collapsed.value,
    ...(viewport.value ? { viewport: viewport.value } : {}),
    snapshot: snapshot.value,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

function parseRoot(value: unknown): ParseResult<SavedFlowRoot> {
  if (!isRecord(value) || !isLabel(value.label)) {
    return rejected('A saved flow needs a root label.');
  }
  if (value.language !== undefined && !isLanguage(value.language)) {
    return rejected('Saved flow language is not supported.');
  }
  if (!isOptionalPath(value.uri) || !isOptionalPath(value.folderPath)) {
    return rejected('A saved flow path is not valid.');
  }
  if (
    value.qualifiedName !== undefined &&
    (!isNonEmptyString(value.qualifiedName) || value.qualifiedName.length > LABEL_LIMIT)
  ) {
    return rejected('A saved flow qualified name is not valid.');
  }
  if (value.nodeId !== undefined && !isId(value.nodeId) && !isLongId(value.nodeId)) {
    return rejected('A saved flow node id is not valid.');
  }
  if (value.entryId !== undefined && !isLongId(value.entryId)) {
    return rejected('A saved flow entry id is not valid.');
  }
  const position = parsePosition(value.position);
  if (!position.ok) {
    return position;
  }
  return parsed({
    label: value.label.trim(),
    ...(isLanguage(value.language) ? { language: value.language } : {}),
    ...(typeof value.uri === 'string' ? { uri: value.uri } : {}),
    ...(typeof value.qualifiedName === 'string' ? { qualifiedName: value.qualifiedName } : {}),
    ...(typeof value.nodeId === 'string' ? { nodeId: value.nodeId } : {}),
    ...(typeof value.entryId === 'string' ? { entryId: value.entryId } : {}),
    ...(position.value ? { position: position.value } : {}),
    ...(typeof value.folderPath === 'string' ? { folderPath: value.folderPath } : {}),
  });
}

function parseOptions(value: unknown): ParseResult<SavedFlowOptions> {
  if (value === undefined) {
    return parsed({});
  }
  if (!isRecord(value)) {
    return rejected('Saved flow options must be an object.');
  }
  if (value.depth !== undefined && !isDepth(value.depth)) {
    return rejected('Saved flow depth is not valid.');
  }
  if (value.granularity !== undefined && !isSequenceGranularity(value.granularity)) {
    return rejected('Saved flow granularity is not supported.');
  }
  if (value.showUncertain !== undefined && typeof value.showUncertain !== 'boolean') {
    return rejected('showUncertain must be a boolean.');
  }
  if (value.showInferred !== undefined && typeof value.showInferred !== 'boolean') {
    return rejected('showInferred must be a boolean.');
  }
  if (
    value.direction !== undefined &&
    value.direction !== 'callers' &&
    value.direction !== 'callees'
  ) {
    return rejected('Saved flow direction is not supported.');
  }
  if (value.viewMode !== undefined && !isViewMode(value.viewMode)) {
    return rejected('Saved flow view mode is not supported.');
  }
  if (
    value.sequenceSource !== undefined &&
    value.sequenceSource !== 'call' &&
    value.sequenceSource !== 'request'
  ) {
    return rejected('Saved flow sequence source is not supported.');
  }
  const hidden = parseHiddenKinds(value.hiddenEdgeKinds);
  if (!hidden.ok) {
    return hidden;
  }
  const viewMode = isViewMode(value.viewMode) ? value.viewMode : undefined;
  return parsed({
    ...(isDepth(value.depth) ? { depth: value.depth } : {}),
    ...(isSequenceGranularity(value.granularity) ? { granularity: value.granularity } : {}),
    ...(typeof value.showUncertain === 'boolean' ? { showUncertain: value.showUncertain } : {}),
    ...(typeof value.showInferred === 'boolean' ? { showInferred: value.showInferred } : {}),
    ...(value.direction === 'callers' || value.direction === 'callees'
      ? { direction: value.direction }
      : {}),
    ...(viewMode ? { viewMode } : {}),
    ...(value.sequenceSource === 'call' || value.sequenceSource === 'request'
      ? { sequenceSource: value.sequenceSource }
      : {}),
    ...(hidden.value && hidden.value.length > 0 ? { hiddenEdgeKinds: hidden.value } : {}),
  });
}

function parseSnapshot(value: unknown): ParseResult<SavedFlowSnapshot> {
  if (!isRecord(value) || !isTimestamp(value.capturedAt)) {
    return rejected('A saved flow snapshot needs a capture time.');
  }
  if (value.kind === 'graph') {
    const graph = parseCodeGraph(value.graph);
    if (!graph.ok) {
      return rejected(graph.error);
    }
    return parsed({ kind: 'graph', capturedAt: value.capturedAt, graph: graph.value });
  }
  if (value.kind === 'controlFlow') {
    const graph = parseControlFlowGraph(value.graph);
    if (!graph.ok) {
      return rejected(graph.error);
    }
    return parsed({ kind: 'controlFlow', capturedAt: value.capturedAt, graph: graph.value });
  }
  if (value.kind === 'sequence') {
    const diagram = parseSequenceDiagram(value.diagram);
    if (!diagram.ok) {
      return rejected(diagram.error);
    }
    return parsed({ kind: 'sequence', capturedAt: value.capturedAt, diagram: diagram.value });
  }
  return rejected('Saved flow snapshot kind is not supported.');
}

function parseCollapsed(value: unknown): ParseResult<readonly string[]> {
  if (value === undefined) {
    return parsed([]);
  }
  if (!Array.isArray(value) || value.length > COLLAPSED_LIMIT) {
    return rejected('Collapsed nodes must be a list of ids.');
  }
  const ids: string[] = [];
  for (const item of value) {
    if (!isLongId(item)) {
      return rejected('A collapsed node id is not valid.');
    }
    ids.push(item);
  }
  return parsed(ids);
}

function parseViewport(value: unknown): ParseResult<SavedFlowViewport | undefined> {
  if (value === undefined) {
    return parsed(undefined);
  }
  if (!isRecord(value) || !isCoord(value.x) || !isCoord(value.y) || !isZoom(value.zoom)) {
    return rejected('A saved viewport needs x, y, and zoom.');
  }
  return parsed({ x: value.x, y: value.y, zoom: value.zoom });
}

function parsePosition(value: unknown): ParseResult<Position | undefined> {
  if (value === undefined) {
    return parsed(undefined);
  }
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.line) ||
    !isNonNegativeInteger(value.character)
  ) {
    return rejected('A saved position is not valid.');
  }
  return parsed({ line: value.line, character: value.character });
}

function parseHiddenKinds(value: unknown): ParseResult<readonly EdgeKind[] | undefined> {
  if (value === undefined) {
    return parsed(undefined);
  }
  if (!Array.isArray(value)) {
    return rejected('Hidden edge kinds must be a list.');
  }
  const kinds: EdgeKind[] = [];
  for (const item of value) {
    if (!isEdgeKind(item) || kinds.includes(item)) {
      return rejected('A hidden edge kind is not supported.');
    }
    kinds.push(item);
  }
  return parsed(kinds);
}

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= ID_LIMIT && isClean(value)
  );
}

function isLongId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= PATH_LIMIT && isClean(value)
  );
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && isLabel(value) && value.trim().length <= NAME_LIMIT;
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= LABEL_LIMIT;
}

function isOptionalPath(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length > 0 && value.length <= PATH_LIMIT)
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isDepth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 32;
}

function isCoord(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function isZoom(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8;
}

function isClean(value: string): boolean {
  // U+001F is the node-id separator. Other control characters are rejected.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1e || code === 0x7f) {
      return false;
    }
  }
  return true;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (isNonEmptyString(value)) {
      return value;
    }
  }
  return undefined;
}
