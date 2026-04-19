/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Target manager: loads target definitions from disk, validates them via the
 * Zod schema, and instantiates the appropriate `PlatformHandler`.
 *
 * Built-in targets live in `vendor/freeocd-web/public/targets/**` (the
 * canonical target tree shared with the `freeocd-web` sister project via a
 * git submodule) and are copied to `out/targets/**` during the webpack build.
 * User-defined targets are stored in the workspace storage URI
 * (`context.storageUri/targets/**`) so they follow the repo without polluting
 * the source tree.
 */

import * as vscode from 'vscode';
import { z } from 'zod';
import { targetDefinitionSchema } from './target-schema';
import { PlatformHandler } from './platform-handler';
import { NordicHandler } from './nordic-handler';
import { FreeOcdError, NoTargetError, TargetValidationError } from '../common/errors';
import { log } from '../common/logger';
import type { TargetDefinition } from '../common/types';

/**
 * Top-level files under `out/targets/` (copied from
 * `vendor/freeocd-web/public/targets/`) that are NOT MCU target definitions
 * and must be skipped by the directory walker. `index.json` is the shared
 * target catalogue used by the web front-end; `probe-filters.json` is the
 * central CMSIS-DAP vendor ID list loaded by `initProbeFilters()`.
 *
 * This mirrors `NON_TARGET_FILES` in `scripts/validate-targets.js` so the
 * runtime loader and the CI validator skip exactly the same files.
 */
const NON_TARGET_FILES = new Set(['index.json', 'probe-filters.json']);

/**
 * Registry of platform handlers. Extend this map to add new MCU families.
 */
const PLATFORM_HANDLERS: Record<string, new (target: TargetDefinition) => PlatformHandler> = {
  nordic: NordicHandler
  // stm32: StmHandler,
  // rp2040: Rp2040Handler,
  // esp32s3: Esp32Handler,
  // nxp_rt: NxpRtHandler,
  // silabs: SilabsHandler,
  // renesas: RenesasHandler,
};

export class TargetManager {
  private readonly builtInDir: vscode.Uri;
  private readonly userDir: vscode.Uri;
  private targets: Map<string, TargetDefinition> = new Map();
  private current: TargetDefinition | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<TargetDefinition | undefined>();
  public readonly onDidChangeTarget = this.changeEmitter.event;

  constructor(extensionUri: vscode.Uri, storageUri: vscode.Uri) {
    this.builtInDir = vscode.Uri.joinPath(extensionUri, 'out', 'targets');
    this.userDir = vscode.Uri.joinPath(storageUri, 'targets');
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  public async reload(): Promise<TargetDefinition[]> {
    this.targets.clear();
    await this.ensureUserDir();
    await this.loadFromDir(this.builtInDir, this.builtInDir, 'built-in');
    await this.loadFromDir(this.userDir, this.userDir, 'user');
    return Array.from(this.targets.values());
  }

  public list(): TargetDefinition[] {
    return Array.from(this.targets.values());
  }

  public get(id: string): TargetDefinition | undefined {
    return this.targets.get(id);
  }

  public getCurrent(): TargetDefinition | undefined {
    return this.current;
  }

  public select(id: string): TargetDefinition {
    const target = this.targets.get(id);
    if (!target) {
      throw new NoTargetError(`Unknown target id: ${id}`);
    }
    this.current = target;
    this.changeEmitter.fire(target);
    return target;
  }

  public createHandler(target?: TargetDefinition): PlatformHandler {
    const t = target ?? this.current;
    if (!t) {
      throw new NoTargetError();
    }
    const HandlerClass = PLATFORM_HANDLERS[t.platform];
    if (!HandlerClass) {
      throw new FreeOcdError(`No handler registered for platform: ${t.platform}`, 'NO_PLATFORM');
    }
    return new HandlerClass(t);
  }

  public validate(raw: unknown): TargetDefinition {
    try {
      return targetDefinitionSchema.parse(raw) as TargetDefinition;
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new TargetValidationError(
          err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
          err.issues
        );
      }
      throw err;
    }
  }

  public async save(target: TargetDefinition): Promise<vscode.Uri> {
    const validated = this.validate(target);
    const [namespace, family, name] = validated.id.split('/');
    if (!namespace || !family || !name) {
      throw new TargetValidationError(
        `Target id must be of the form "<namespace>/<family>/<name>": got ${validated.id}`
      );
    }
    const dir = vscode.Uri.joinPath(this.userDir, namespace, family);
    await vscode.workspace.fs.createDirectory(dir);
    const fileUri = vscode.Uri.joinPath(dir, `${name}.json`);
    const buffer = new TextEncoder().encode(JSON.stringify(validated, null, 2) + '\n');
    await vscode.workspace.fs.writeFile(fileUri, buffer);
    this.targets.set(validated.id, validated);
    log.info(`Saved user target: ${validated.id} -> ${fileUri.fsPath}`);
    return fileUri;
  }

  public async delete(id: string): Promise<void> {
    const parts = id.split('/');
    if (parts.length !== 3) {
      throw new TargetValidationError(`Invalid target id: ${id}`);
    }
    const [namespace, family, name] = parts;
    const fileUri = vscode.Uri.joinPath(this.userDir, namespace, family, `${name}.json`);
    await vscode.workspace.fs.delete(fileUri);
    this.targets.delete(id);
    if (this.current?.id === id) {
      this.current = undefined;
      this.changeEmitter.fire(undefined);
    }
  }

  public async import(fileUri: vscode.Uri): Promise<TargetDefinition> {
    const raw = await vscode.workspace.fs.readFile(fileUri);
    const text = new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);
    const validated = this.validate(parsed);
    await this.save(validated);
    return validated;
  }

  private async ensureUserDir(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.userDir);
    } catch {
      // already exists or not writable; ignore
    }
  }

  private async loadFromDir(
    dir: vscode.Uri,
    root: vscode.Uri,
    kind: 'built-in' | 'user'
  ): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    const atRoot = dir.path === root.path;
    for (const [name, type] of entries) {
      const child = vscode.Uri.joinPath(dir, name);
      if (type === vscode.FileType.Directory) {
        await this.loadFromDir(child, root, kind);
      } else if (name.endsWith('.json')) {
        // Skip shared non-target JSONs that live at the top level of the
        // targets tree (mirrors `scripts/validate-targets.js`).
        if (atRoot && NON_TARGET_FILES.has(name)) {
          continue;
        }
        try {
          const raw = await vscode.workspace.fs.readFile(child);
          const parsed = JSON.parse(new TextDecoder().decode(raw));
          // Compute id from relative path (namespace/family/name) if missing.
          if (!parsed.id) {
            const rel = child.path.slice(root.path.length + 1).replace(/\.json$/u, '');
            parsed.id = rel;
          }
          const validated = this.validate(parsed);
          this.targets.set(validated.id, validated);
        } catch (err) {
          log.warn(
            `Failed to load ${kind} target ${child.fsPath}: ${(err as Error).message}`
          );
        }
      }
    }
  }
}
