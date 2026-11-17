/**
 * Which commit a local diagram should compare against.
 * `auto` prefers an already-authenticated `gh` result when the caller has one,
 * then origin/HEAD, origin/main, origin/master, main, and master.
 */

export const AUTO_BASE = 'auto';

export const BASE_CANDIDATES = [
  'origin/HEAD',
  'origin/main',
  'origin/master',
  'main',
  'master',
] as const;

export type BaseSource = 'setting' | 'pull-request' | 'fallback' | 'none';

export interface ResolvedBase {
  readonly ref: string | undefined;
  readonly sha: string | undefined;
  readonly source: BaseSource;
  readonly branch: string | undefined;
  readonly onBase: boolean;
}

export function chooseBase(input: {
  readonly setting: string;
  readonly branch: string | undefined;
  readonly head: string | undefined;
  /** Branch name from `gh pr view`, when gh was already authenticated. */
  readonly pullRequestBase: string | undefined;
  readonly verify: (ref: string) => string | undefined;
}): ResolvedBase {
  const branch = clean(input.branch);
  const head = clean(input.head);
  const configured = input.setting.trim();
  if (configured.length > 0 && configured !== AUTO_BASE) {
    const sha = input.verify(configured);
    if (sha) {
      return finish(configured, sha, 'setting', branch, head);
    }
  }

  const fromPullRequest = clean(input.pullRequestBase);
  if (fromPullRequest) {
    const remote = fromPullRequest.startsWith('origin/')
      ? fromPullRequest
      : `origin/${fromPullRequest}`;
    const sha = input.verify(remote) ?? input.verify(fromPullRequest);
    const ref = input.verify(remote) ? remote : fromPullRequest;
    if (sha) {
      return finish(ref, sha, 'pull-request', branch, head);
    }
  }

  for (const candidate of BASE_CANDIDATES) {
    const sha = input.verify(candidate);
    if (sha) {
      return finish(candidate, sha, 'fallback', branch, head);
    }
  }
  return { ref: undefined, sha: undefined, source: 'none', branch, onBase: false };
}

function finish(
  ref: string,
  sha: string,
  source: Exclude<BaseSource, 'none'>,
  branch: string | undefined,
  head: string | undefined,
): ResolvedBase {
  return { ref, sha, source, branch, onBase: onBaseBranch(branch, ref, head, sha) };
}

export function onBaseBranch(
  branch: string | undefined,
  baseRef: string,
  head: string | undefined,
  baseSha: string,
): boolean {
  if (branch) {
    const short = baseRef.split('/').pop();
    if (branch === baseRef || branch === short || `origin/${branch}` === baseRef) {
      return true;
    }
    return false;
  }
  return head !== undefined && head === baseSha;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
