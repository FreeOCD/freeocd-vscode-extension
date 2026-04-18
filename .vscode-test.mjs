import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  extensionDevelopmentPath: import.meta.dirname,
  mocha: {
    timeout: 20000
  }
});
