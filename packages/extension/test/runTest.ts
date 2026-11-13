import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index');
  const workspacePath = path.resolve(extensionDevelopmentPath, 'test-fixtures/workspace');
  const bundle = path.join(extensionDevelopmentPath, 'dist', 'extension.js');

  if (!existsSync(bundle)) {
    console.error('Missing dist/extension.js. Run npm run build before npm run test:integration.');
    process.exit(1);
  }

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspacePath, '--disable-extensions', '--disable-gpu', '--no-sandbox'],
    version: 'stable',
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
