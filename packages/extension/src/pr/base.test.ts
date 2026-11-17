import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseBase } from './base';

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function verify(root: string, ref: string): string | undefined {
  try {
    const sha = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

function branchOf(root: string): string | undefined {
  const name = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  return name === 'HEAD' ? undefined : name;
}

function initRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'codeflow-pr-base-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'codeflow@example.com']);
  git(root, ['config', 'user.name', 'CodeFlow']);
  writeFileSync(path.join(root, 'readme.txt'), 'base\n');
  git(root, ['add', 'readme.txt']);
  git(root, ['commit', '-m', 'base']);
  return root;
}

describe('pull request base', () => {
  it('uses main when no remote exists, and stays quiet on that branch', () => {
    const root = initRepo();
    const onMain = chooseBase({
      setting: 'auto',
      branch: branchOf(root),
      head: verify(root, 'HEAD'),
      pullRequestBase: undefined,
      verify: (ref) => verify(root, ref),
    });
    expect(onMain).toMatchObject({ ref: 'main', source: 'fallback', onBase: true });

    git(root, ['checkout', '-b', 'feature']);
    const onFeature = chooseBase({
      setting: 'auto',
      branch: branchOf(root),
      head: verify(root, 'HEAD'),
      pullRequestBase: undefined,
      verify: (ref) => verify(root, ref),
    });
    expect(onFeature).toMatchObject({ ref: 'main', source: 'fallback', onBase: false });
  });

  it('prefers origin/HEAD, then a gh base, then a configured ref', () => {
    const root = initRepo();
    git(root, ['branch', 'develop']);
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    git(root, ['checkout', '-b', 'feature']);
    const remote = chooseBase({
      setting: 'auto',
      branch: 'feature',
      head: verify(root, 'HEAD'),
      pullRequestBase: undefined,
      verify: (ref) => verify(root, ref),
    });
    expect(remote).toMatchObject({ ref: 'origin/HEAD', source: 'fallback', onBase: false });

    const fromGh = chooseBase({
      setting: 'auto',
      branch: 'feature',
      head: verify(root, 'HEAD'),
      pullRequestBase: 'develop',
      verify: (ref) => verify(root, ref),
    });
    expect(fromGh).toMatchObject({ ref: 'develop', source: 'pull-request', onBase: false });

    const configured = chooseBase({
      setting: 'develop',
      branch: 'feature',
      head: verify(root, 'HEAD'),
      pullRequestBase: 'main',
      verify: (ref) => verify(root, ref),
    });
    expect(configured).toMatchObject({ ref: 'develop', source: 'setting', onBase: false });

    const missing = chooseBase({
      setting: 'missing-base',
      branch: 'feature',
      head: verify(root, 'HEAD'),
      pullRequestBase: undefined,
      verify: (ref) => verify(root, ref),
    });
    expect(missing.ref).toBe('origin/HEAD');
    expect(missing.source).toBe('fallback');
  });

  it('treats a detached checkout of the base commit as the base branch', () => {
    const root = initRepo();
    git(root, ['checkout', '--detach', 'main']);
    const detached = chooseBase({
      setting: 'auto',
      branch: branchOf(root),
      head: verify(root, 'HEAD'),
      pullRequestBase: undefined,
      verify: (ref) => verify(root, ref),
    });
    expect(detached.branch).toBeUndefined();
    expect(detached.onBase).toBe(true);
    expect(detached.ref).toBe('main');
  });
});
