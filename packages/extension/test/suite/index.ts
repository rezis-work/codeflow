import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20_000 });
  const testsRoot = __dirname;
  const files = readdirSync(testsRoot).filter((file) => file.endsWith('.test.js'));
  if (files.length === 0) {
    return Promise.reject(new Error(`No integration tests found in ${testsRoot}`));
  }
  for (const file of files) {
    mocha.addFile(path.join(testsRoot, file));
  }

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} integration test(s) failed.`));
        return;
      }
      resolve();
    });
  });
}
