export interface RepositoryRef {
  readonly server: string;
  readonly name: string;
  readonly headSha: string;
  readonly baseSha: string;
}

export function blobUrl(
  repository: RepositoryRef,
  sha: string,
  filePath: string,
  line: number,
): string {
  const server = repository.server.replace(/\/$/, '');
  const encoded = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${server}/${repository.name}/blob/${sha}/${encoded}#L${line}`;
}
