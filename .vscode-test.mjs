import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

const baseTestDataDir = join(
  process.platform === 'win32' ? (process.env.RUNNER_TEMP ?? process.env.TEMP ?? tmpdir()) : '/tmp',
  'freeocd-vscode-test'
);
const userDataDir = join(baseTestDataDir, 'user-data');
const extensionsDir = join(baseTestDataDir, 'extensions');

mkdirSync(userDataDir, { recursive: true });
mkdirSync(extensionsDir, { recursive: true });

export default defineConfig({
  files: 'out/test/**/*.test.js',
  extensionDevelopmentPath: import.meta.dirname,
  launchArgs: [
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`
  ],
  mocha: {
    timeout: 20000
  }
});
