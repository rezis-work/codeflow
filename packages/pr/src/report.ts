import { COMMENT_LIMIT, assessImpact, renderImpactMarkdown } from '@codeflow/shared/impact';
import type { ImpactReport } from '@codeflow/shared/impact';
import { renderReviewMarkdown, reviewGraphs } from '@codeflow/shared/review';
import type { RepositoryRef } from './commentLinks';
import { blobUrl } from './commentLinks';
import { renderComment } from './comment';
import type { CommentFunction } from './comment';
import { graphDataFromIndexed } from './impactGraph';
import { reviewGraphFromIndexed } from './reviewGraph';
import { analyzeHeadAndBase, diagramSymbols, spansIn } from './analyze';
import type { IndexedGraph } from './analyze';
import type { CallSite } from './diagram';
import { selectDiagram } from './diagram';
import { callLines, renderMermaid } from './mermaid';
import { DEFAULT_EXCLUDE_GLOBS } from './paths';
import { isSkippedRelative, isSupportedSource, toPosix } from './paths';
import type { DiffFile } from './diff';
import { mapChangedSymbols } from './symbols';
import type { ChangedSymbol } from './symbols';

export interface PullRequestReport {
  readonly changed: readonly ChangedSymbol[];
  readonly markdown: string;
  readonly mermaid: string;
  readonly filesAnalyzed: number;
  readonly warnings: readonly string[];
}

export async function createPullRequestReport(input: {
  readonly rootDir: string;
  readonly files: readonly DiffFile[];
  /** Base file text keyed by the path on the base commit. */
  readonly baseTexts?: ReadonlyMap<string, string>;
  /** Used when `baseTexts` has no entry. Keeps git reads inside the kept-file cap. */
  readonly readBase?: (filePath: string) => string | undefined;
  readonly maxNodes: number;
  readonly maxFiles: number;
  readonly maxChangedFiles: number;
  readonly excludeGlobs?: readonly string[];
  readonly repository?: RepositoryRef;
  readonly warnings?: readonly string[];
  /** Blast-radius section. Default on. Pass false to leave the comment as a diagram only. */
  readonly impact?: boolean;
  /** Graph-diff section. Default on. Pass false to leave it out. */
  readonly review?: boolean;
}): Promise<PullRequestReport> {
  const warnings = [...(input.warnings ?? [])];
  const supported = input.files.filter((file) => {
    const filePath = file.newPath ?? file.oldPath ?? '';
    return isSupportedSource(filePath) && !isSkippedRelative(filePath);
  });
  const ranked = [...supported].sort((left, right) =>
    displayPath(left).localeCompare(displayPath(right)),
  );
  const kept = ranked.slice(0, input.maxChangedFiles);
  const skippedChangedFiles = ranked.length - kept.length;
  if (skippedChangedFiles > 0) {
    warnings.push(`${skippedChangedFiles} changed source files were left out of the diagram.`);
  }

  const priority: string[] = [];
  const overlays = new Map<string, string>();
  const absentOnBase = new Set<string>();
  const missingBase: string[] = [];
  for (const file of kept) {
    if (file.status === 'deleted') {
      const oldPath = file.oldPath;
      if (!oldPath) {
        continue;
      }
      priority.push(oldPath);
      const text = readBaseText(input, oldPath);
      if (text === undefined) {
        missingBase.push(oldPath);
        continue;
      }
      overlays.set(oldPath, text);
      continue;
    }
    const headPath = file.newPath;
    if (!headPath) {
      continue;
    }
    priority.push(headPath);
    if (file.status === 'added') {
      absentOnBase.add(toPosix(headPath));
      continue;
    }
    const oldPath = file.oldPath ?? headPath;
    const text = readBaseText(input, oldPath);
    if (text === undefined) {
      missingBase.push(oldPath);
      continue;
    }
    overlays.set(headPath, text);
  }
  if (missingBase.length > 0) {
    warnings.push(
      `Base text was missing for ${missingBase.slice(0, 10).join(', ')}${missingBase.length > 10 ? ', …' : ''}.`,
    );
  }

  const analyzed = await analyzeHeadAndBase({
    rootDir: input.rootDir,
    maxFiles: input.maxFiles,
    excludeGlobs: input.excludeGlobs ?? DEFAULT_EXCLUDE_GLOBS,
    priority,
    overlays,
    absentOnBase,
  });
  warnings.push(...analyzed.warnings);

  const changed: ChangedSymbol[] = [];
  for (const file of kept) {
    const headPath = file.status === 'deleted' ? file.oldPath : file.newPath;
    const basePath =
      file.status === 'added'
        ? undefined
        : file.status === 'renamed'
          ? file.newPath
          : (file.oldPath ?? file.newPath);
    if (!headPath || (file.status !== 'added' && !basePath)) {
      continue;
    }
    if (
      file.status !== 'added' &&
      file.status !== 'deleted' &&
      file.oldPath &&
      readBaseText(input, file.oldPath) === undefined
    ) {
      continue;
    }
    const headSpans = file.status === 'deleted' ? [] : spansIn(analyzed.head, headPath);
    const baseSpans = basePath ? spansIn(analyzed.base, basePath) : [];
    changed.push(
      ...mapChangedSymbols({
        status: file.status,
        hunks: file.hunks,
        head: headSpans,
        base: baseSpans,
      }),
    );
  }

  const symbols = diagramSymbols(analyzed.head);
  for (const [key, symbol] of diagramSymbols(analyzed.base)) {
    if (!symbols.has(key)) {
      symbols.set(key, symbol);
    }
  }
  const calls: CallSite[] = [];
  for (const symbol of changed) {
    const graph = symbol.status === 'removed' ? analyzed.base : analyzed.head;
    for (const call of graph.calls) {
      if (call.from === symbol.key || call.to === symbol.key) {
        calls.push(call);
      }
    }
  }
  const diagram = selectDiagram({
    changed,
    calls,
    symbols,
    maxNodes: input.maxNodes,
  });
  const mermaid = renderMermaid(diagram);
  const listed = commentFunctions(changed, kept, input.repository);
  const comment = {
    changed: listed,
    mermaid,
    calls: callLines(diagram),
    filesAnalyzed: Math.max(analyzed.head.filesAnalyzed, analyzed.base.filesAnalyzed),
    omittedChanged: diagram.omittedChanged,
    omittedContext: diagram.omittedContext,
    skippedChangedFiles,
    warnings: unique(warnings),
    maxNodes: input.maxNodes,
  };
  const impact = input.impact === false ? undefined : impactSection(changed, analyzed.head);
  const review = input.review === false ? undefined : reviewSection(analyzed.base, analyzed.head);
  let markdown = renderComment({
    ...comment,
    ...(impact ? { impact } : {}),
    ...(review ? { review } : {}),
  });
  if (review && markdown.length > COMMENT_LIMIT) {
    markdown = renderComment({ ...comment, ...(impact ? { impact } : {}) });
  }
  if (impact && markdown.length > COMMENT_LIMIT) {
    const brief = impactSection(changed, analyzed.head, true);
    markdown = renderComment({ ...comment, ...(brief ? { impact: brief } : {}) });
  }
  if (markdown.length > COMMENT_LIMIT) {
    markdown = renderComment(comment);
  }
  return {
    changed,
    markdown,
    mermaid,
    filesAnalyzed: Math.max(analyzed.head.filesAnalyzed, analyzed.base.filesAnalyzed),
    warnings: unique(warnings),
  };
}

function commentFunctions(
  changed: readonly ChangedSymbol[],
  files: readonly DiffFile[],
  repository: RepositoryRef | undefined,
): CommentFunction[] {
  return changed.map((symbol) => {
    const file = files.find((candidate) => owns(candidate, symbol.path));
    const removed = symbol.status === 'removed';
    const path = removed ? (file?.oldPath ?? symbol.path) : symbol.path;
    const sha = removed ? repository?.baseSha : repository?.headSha;
    return {
      status: symbol.status,
      qualifiedName: symbol.qualifiedName,
      path,
      line: symbol.line,
      ...(repository && sha ? { href: blobUrl(repository, sha, path, symbol.line) } : {}),
    };
  });
}

function reviewSection(before: IndexedGraph, after: IndexedGraph): string {
  const report = reviewGraphs(reviewGraphFromIndexed(before), reviewGraphFromIndexed(after));
  return renderReviewMarkdown(report, { brief: true }).replace('## Review', '### Review');
}

function impactSection(
  changed: readonly ChangedSymbol[],
  head: Parameters<typeof graphDataFromIndexed>[0],
  brief = false,
): string | undefined {
  const live = changed.filter((symbol) => symbol.status !== 'removed');
  const removed = changed.filter((symbol) => symbol.status === 'removed');
  if (live.length === 0) {
    return removed.length > 0
      ? `### Impact\n\n${removed.length} removed ${removed.length === 1 ? 'function is' : 'functions are'} not on the current graph.\n`
      : undefined;
  }
  const report = assessImpact(graphDataFromIndexed(head), {
    targets: live.map((symbol) => ({ name: symbol.qualifiedName, path: symbol.path })),
    hops: 3,
  });
  if (isImpactFailure(report)) {
    return `### Impact\n\n${report.error}\n`;
  }
  return renderImpactMarkdown(report, {
    heading: '### Impact',
    brief,
    removed: removed.map((symbol) => ({ name: symbol.qualifiedName, file: symbol.path })),
    callerCap: 25,
    routeCap: 15,
    testCap: 15,
    uncertainCap: 10,
  });
}

function isImpactFailure(
  report: ImpactReport | { readonly ok: false },
): report is { readonly ok: false } {
  return 'ok' in report && report.ok === false;
}

function owns(file: DiffFile, symbolPath: string): boolean {
  const wanted = toPosix(symbolPath);
  return toPosix(file.newPath ?? '') === wanted || toPosix(file.oldPath ?? '') === wanted;
}

function displayPath(file: DiffFile): string {
  return toPosix(file.newPath ?? file.oldPath ?? '');
}

function readBaseText(
  input: {
    readonly baseTexts?: ReadonlyMap<string, string>;
    readonly readBase?: (filePath: string) => string | undefined;
  },
  filePath: string,
): string | undefined {
  if (input.baseTexts?.has(filePath)) {
    return input.baseTexts.get(filePath);
  }
  return input.readBase?.(filePath);
}

function unique(warnings: readonly string[]): string[] {
  return [
    ...new Set(warnings.map((warning) => warning.trim()).filter((warning) => warning.length > 0)),
  ];
}
