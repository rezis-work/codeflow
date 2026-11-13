import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function hasWebviewBundle(extensionPath: string): boolean {
  const directory = join(extensionPath, 'media', 'webview');
  return existsSync(join(directory, 'index.js')) && existsSync(join(directory, 'index.css'));
}
