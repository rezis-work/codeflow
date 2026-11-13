/**
 * File URIs for node ids. On Unix this matches `vscode.Uri.file(path).toString()`.
 * The extension host still compares files by their filesystem path, so a
 * platform difference in percent-encoding does not hide a symbol.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function pathToFileUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

export function fileUriToPath(uri: string): string | undefined {
  if (!uri.startsWith('file:')) {
    return undefined;
  }
  try {
    return path.resolve(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

export function sameFilePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}
