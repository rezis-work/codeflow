import { COMMENT_MARKER } from './comment';

export interface CommentResult {
  readonly action: 'created' | 'updated' | 'forbidden';
  readonly url?: string;
  readonly message?: string;
}

interface GitHubComment {
  readonly id?: number;
  readonly body?: string;
  readonly html_url?: string;
}

export async function upsertPullRequestComment(input: {
  readonly api: string;
  readonly repository: string;
  readonly pr: number;
  readonly token: string;
  readonly body: string;
}): Promise<CommentResult> {
  const api = input.api.replace(/\/$/, '');
  const existing = await listComments(api, input.repository, input.pr, input.token);
  if (existing.forbidden) {
    return { action: 'forbidden', message: existing.message };
  }
  const match = existing.comments.find((comment) => comment.body?.includes(COMMENT_MARKER));
  if (match?.id) {
    const updated = await request(
      `${api}/repos/${input.repository}/issues/comments/${match.id}`,
      input.token,
      'PATCH',
      { body: input.body },
    );
    return finish(updated, 'updated');
  }
  const created = await request(
    `${api}/repos/${input.repository}/issues/${input.pr}/comments`,
    input.token,
    'POST',
    { body: input.body },
  );
  return finish(created, 'created');
}

async function listComments(
  api: string,
  repository: string,
  pr: number,
  token: string,
): Promise<{ comments: GitHubComment[]; forbidden: boolean; message?: string }> {
  const comments: GitHubComment[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await request(
      `${api}/repos/${repository}/issues/${pr}/comments?per_page=100&page=${page}`,
      token,
      'GET',
    );
    if (response.status === 401 || response.status === 403) {
      return { comments, forbidden: true, message: response.message };
    }
    if (!response.ok || !Array.isArray(response.value)) {
      throw new Error(
        response.message || `Could not list pull request comments (${response.status}).`,
      );
    }
    const pageComments = response.value.filter(isComment);
    comments.push(...pageComments);
    if (pageComments.length < 100) {
      break;
    }
  }
  return { comments, forbidden: false };
}

function finish(
  response: { ok: boolean; status: number; value: unknown; message: string },
  action: 'created' | 'updated',
): CommentResult {
  if (response.status === 401 || response.status === 403) {
    return { action: 'forbidden', message: response.message };
  }
  if (!response.ok) {
    throw new Error(
      response.message ||
        `Could not ${action === 'created' ? 'create' : 'update'} the comment (${response.status}).`,
    );
  }
  const url = isComment(response.value) ? response.value.html_url : undefined;
  return { action, ...(url ? { url } : {}) };
}

function isComment(value: unknown): value is GitHubComment {
  return typeof value === 'object' && value !== null;
}

async function request(
  url: string,
  token: string,
  method: 'GET' | 'POST' | 'PATCH',
  body?: { body: string },
): Promise<{ ok: boolean; status: number; value: unknown; message: string }> {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'codeflow-pr',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let value: unknown = text;
  if (text.length > 0) {
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      value = text;
    }
  }
  const message =
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
      ? value.message
      : response.statusText;
  return { ok: response.ok, status: response.status, value, message };
}
