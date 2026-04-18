#!/usr/bin/env node
/**
 * Build the bundled DAPjs submodule (vendor/dapjs) without polluting its
 * working tree.
 *
 * Problem
 * -------
 * vendor/dapjs/tsconfig.json does not set `typeRoots`, so the TypeScript
 * compiler walks up the directory tree and pulls in the root
 * freeocd-vscode-extension `node_modules/@types/*` packages. webpack depends
 * on `@types/eslint-scope@3.7.7`, which conflicts with `eslint@10.x` bundled
 * at the root and fails the dapjs build with TS2416 errors.
 *
 * Fix
 * ---
 * We shallow-copy a tsconfig.override.json next to the submodule's
 * tsconfig.json, temporarily swap the files, run `npm install && npm run
 * build`, then unconditionally restore the original. This keeps the submodule
 * working tree clean (`git status` shows no changes) while allowing the
 * freeocd-vscode-extension root to depend on any packages it needs.
 *
 * The override adds `typeRoots: ["./node_modules/@types"]` so only the
 * submodule's own @types packages are picked up during compilation.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const dapjsRoot = path.join(repoRoot, 'vendor', 'dapjs');
const tsconfigPath = path.join(dapjsRoot, 'tsconfig.json');
const backupPath = path.join(dapjsRoot, 'tsconfig.json.freeocd-backup');

/**
 * Run a command in a directory, inheriting stdio. Exits the parent process
 * if the command fails.
 */
function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(' ')} (cwd=${cwd})`);
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${result.status}`);
  }
}

function main() {
  if (!fs.existsSync(dapjsRoot)) {
    console.error(`vendor/dapjs not found at ${dapjsRoot}`);
    console.error('Run `git submodule update --init --recursive` first.');
    process.exit(1);
  }
  if (!fs.existsSync(tsconfigPath)) {
    console.error(`${tsconfigPath} not found`);
    process.exit(1);
  }

  const originalTsconfig = fs.readFileSync(tsconfigPath, 'utf8');
  // Guard against interrupted previous runs: if a backup already exists, the
  // submodule is in an unknown state — prefer the backup as the source of
  // truth.
  const sourceTsconfig = fs.existsSync(backupPath)
    ? fs.readFileSync(backupPath, 'utf8')
    : originalTsconfig;

  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, sourceTsconfig, 'utf8');
  }

  // Parse and patch the tsconfig (it may contain comments, but the stock
  // dapjs tsconfig.json is strict JSON).
  const parsed = JSON.parse(sourceTsconfig);
  parsed.compilerOptions = parsed.compilerOptions || {};
  parsed.compilerOptions.typeRoots = ['./node_modules/@types'];
  const patched = JSON.stringify(parsed, null, 4) + '\n';

  let thrown;
  try {
    fs.writeFileSync(tsconfigPath, patched, 'utf8');
    console.log(`Patched ${tsconfigPath} (typeRoots: ["./node_modules/@types"])`);

    // npm install for dapjs own devDependencies (rollup, typescript, etc.)
    const nodeModulesPath = path.join(dapjsRoot, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
      run('npm', ['install'], dapjsRoot);
    } else {
      console.log('vendor/dapjs/node_modules already exists — skipping npm install');
    }

    run('npm', ['run', 'build'], dapjsRoot);
  } catch (err) {
    thrown = err;
  } finally {
    // Always restore the original tsconfig so `git status` stays clean.
    fs.writeFileSync(tsconfigPath, sourceTsconfig, 'utf8');
    fs.unlinkSync(backupPath);
    console.log(`Restored ${tsconfigPath} from backup`);
  }

  if (thrown) {
    console.error(thrown.message);
    process.exit(1);
  }

  const artifact = path.join(dapjsRoot, 'dist', 'dap.umd.js');
  if (!fs.existsSync(artifact)) {
    console.error(`Expected artifact missing: ${artifact}`);
    process.exit(1);
  }
  const { size } = fs.statSync(artifact);
  console.log(`\n✓ vendor/dapjs/dist/dap.umd.js (${size} bytes)`);
}

main();
