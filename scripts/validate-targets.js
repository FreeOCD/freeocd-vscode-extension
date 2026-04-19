#!/usr/bin/env node
/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 *
 * CI-side target JSON validator. Walks `vendor/freeocd-web/public/targets/**`,
 * parses each MCU `.json`, and checks it against the FreeOCD target schema.
 * Exits non-zero on any validation failure so `npm run lint:targets` can be
 * wired up as a GitHub Actions step.
 *
 * The canonical target tree lives in the `freeocd-web` sister project and is
 * vendored in as a git submodule. Top-level `index.json` and
 * `probe-filters.json` are not target definitions and are skipped here;
 * `freeocd-web`'s own `scripts/validate-json.js` is the authoritative
 * validator for those.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HEX_RE = /^0x[0-9a-fA-F]+$/;

function fail(file, message) {
  process.stderr.write(`[validate-targets] FAIL ${file}: ${message}\n`);
  process.exitCode = 1;
}

function validateMemoryRegion(file, name, region) {
  if (!region || typeof region !== 'object') {
    return fail(file, `${name}: expected object, got ${typeof region}`);
  }
  if (!HEX_RE.test(region.address)) {
    return fail(file, `${name}.address must be a hex string, got ${region.address}`);
  }
  for (const key of ['size', 'workAreaSize', 'pageSize']) {
    if (region[key] !== undefined && !HEX_RE.test(region[key])) {
      fail(file, `${name}.${key} must be a hex string, got ${region[key]}`);
    }
  }
}

function validateTarget(file, data) {
  for (const required of ['id', 'name', 'platform', 'cpu', 'cputapid', 'flashController', 'flash', 'sram', 'capabilities']) {
    if (!(required in data)) {
      return fail(file, `missing required field: ${required}`);
    }
  }
  if (!HEX_RE.test(data.cputapid)) {
    fail(file, `cputapid must be a hex string`);
  }
  if (data.ctrlAp) {
    if (typeof data.ctrlAp.num !== 'number') {
      fail(file, `ctrlAp.num must be a number`);
    }
    if (!HEX_RE.test(data.ctrlAp.idr)) {
      fail(file, `ctrlAp.idr must be a hex string`);
    }
  }
  if (data.accessPort) {
    if (!['mem-ap', 'ctrl-ap', 'apb-ap'].includes(data.accessPort.type)) {
      fail(file, `accessPort.type must be one of mem-ap / ctrl-ap / apb-ap`);
    }
  }
  if (!data.flashController || typeof data.flashController !== 'object') {
    fail(file, `flashController must be an object`);
  } else {
    if (typeof data.flashController.type !== 'string') {
      fail(file, `flashController.type must be a string`);
    }
    if (!HEX_RE.test(data.flashController.base)) {
      fail(file, `flashController.base must be a hex string`);
    }
    for (const [k, reg] of Object.entries(data.flashController.registers ?? {})) {
      if (!reg || !HEX_RE.test(reg.offset)) {
        fail(file, `flashController.registers.${k}.offset must be a hex string`);
      }
      if (reg.enableValue !== undefined && !HEX_RE.test(reg.enableValue)) {
        fail(file, `flashController.registers.${k}.enableValue must be a hex string`);
      }
    }
  }
  validateMemoryRegion(file, 'flash', data.flash);
  validateMemoryRegion(file, 'sram', data.sram);
  if (!Array.isArray(data.capabilities) || data.capabilities.length === 0) {
    fail(file, `capabilities must be a non-empty array`);
  }
  // Probe USB filters are managed centrally in
  // vendor/freeocd-web/public/targets/probe-filters.json; target JSONs must
  // not carry their own `usbFilters` field. This mirrors the rule enforced
  // by freeocd-web's own `scripts/validate-json.js`.
  if (Object.prototype.hasOwnProperty.call(data, 'usbFilters')) {
    fail(
      file,
      '`usbFilters` is no longer allowed in target definitions — add the ' +
        'vendor ID to vendor/freeocd-web/public/targets/probe-filters.json instead'
    );
  }
}

// Top-level files under `public/targets/` that are not MCU target definitions
// and must be skipped by this validator.
const NON_TARGET_FILES = new Set(['index.json', 'probe-filters.json']);

function walk(dir, root, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, root, out);
    } else if (entry.name.endsWith('.json')) {
      const rel = path.relative(root, full);
      // Skip non-target JSONs that live at the top level of the targets tree.
      if (!rel.includes(path.sep) && NON_TARGET_FILES.has(entry.name)) {
        continue;
      }
      out.push(full);
    }
  }
}

function main() {
  const root = path.resolve(
    __dirname,
    '..',
    'vendor',
    'freeocd-web',
    'public',
    'targets'
  );
  if (!fs.existsSync(root)) {
    process.stderr.write(
      `[validate-targets] directory not found: ${root}\n` +
        '[validate-targets] did you forget to run `git submodule update --init --recursive`?\n'
    );
    process.exit(1);
  }
  const files = [];
  walk(root, root, files);
  if (files.length === 0) {
    process.stderr.write(`[validate-targets] no target JSON files found under ${root}\n`);
    process.exit(1);
  }
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      fail(file, `JSON parse error: ${err.message}`);
      continue;
    }
    validateTarget(file, data);
    process.stdout.write(`[validate-targets] OK ${path.relative(process.cwd(), file)}\n`);
  }
  if (process.exitCode && process.exitCode !== 0) {
    process.stderr.write(`[validate-targets] validation failures detected.\n`);
  } else {
    process.stdout.write(`[validate-targets] all ${files.length} target JSON files passed.\n`);
  }
}

main();
