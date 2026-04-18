/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Contributes a `freeocd` task type so CMake / Make / any build task can be
 * chained to a flash / verify / recover operation via `tasks.json`.
 *
 * Example user task:
 *
 *   {
 *     "label": "Flash firmware",
 *     "type": "freeocd",
 *     "action": "flash",
 *     "file": "build/firmware.hex",
 *     "verify": true,
 *     "dependsOn": ["Build"]
 *   }
 */

import * as vscode from 'vscode';
import type { Flasher } from '../flasher/flasher';
import type { TargetManager } from '../target/target-manager';
import { FreeOcdError } from '../common/errors';
import { log } from '../common/logger';

interface FreeocdTaskDefinition extends vscode.TaskDefinition {
  type: 'freeocd';
  action: 'flash' | 'verify' | 'recover';
  file?: string;
  /**
   * Optional target MCU id to temporarily select for this task run. If
   * omitted, the currently selected target is used. The previous target is
   * restored after the task completes.
   */
  target?: string;
  verify?: boolean;
}

type TaskScope = vscode.WorkspaceFolder | vscode.TaskScope;

export class FreeocdTaskProvider implements vscode.TaskProvider {
  public static readonly taskType = 'freeocd';

  constructor(
    private readonly flasher: Flasher,
    private readonly targets: TargetManager
  ) {}

  public provideTasks(): vscode.ProviderResult<vscode.Task[]> {
    const scope: TaskScope =
      vscode.workspace.workspaceFolders?.[0] ?? vscode.TaskScope.Workspace;
    return [
      this.buildTask({ type: 'freeocd', action: 'flash' }, scope),
      this.buildTask({ type: 'freeocd', action: 'verify' }, scope),
      this.buildTask({ type: 'freeocd', action: 'recover' }, scope)
    ];
  }

  public resolveTask(task: vscode.Task): vscode.Task | undefined {
    const definition = task.definition as FreeocdTaskDefinition;
    if (definition.type !== 'freeocd') {
      return undefined;
    }
    // Preserve the user-declared scope (which may be a non-first workspace
    // folder in a multi-root workspace) so relative paths resolve against
    // the correct folder.
    const scope: TaskScope =
      (task.scope as TaskScope | undefined) ??
      vscode.workspace.workspaceFolders?.[0] ??
      vscode.TaskScope.Workspace;
    return this.buildTask(definition, scope);
  }

  private buildTask(def: FreeocdTaskDefinition, scope: TaskScope): vscode.Task {
    const task = new vscode.Task(
      def,
      scope,
      `${def.action}${def.file ? ` ${def.file}` : ''}`,
      FreeocdTaskProvider.taskType,
      new vscode.CustomExecution(async () =>
        new FreeocdTaskTerminal(def, scope, this.flasher, this.targets)
      )
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Silent,
      panel: vscode.TaskPanelKind.Shared,
      clear: false
    };
    return task;
  }
}

class FreeocdTaskTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  public readonly onDidWrite = this.writeEmitter.event;
  public readonly onDidClose = this.closeEmitter.event;

  constructor(
    private readonly def: FreeocdTaskDefinition,
    private readonly scope: TaskScope,
    private readonly flasher: Flasher,
    private readonly targets: TargetManager
  ) {}

  public open(): void {
    void this.run();
  }

  public close(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private async run(): Promise<void> {
    // If the task specifies a target, temporarily select it for the task
    // duration and restore the previous selection afterwards.
    const previousTarget = this.targets.getCurrent();
    let targetOverridden = false;
    try {
      if (this.def.target && this.def.target !== previousTarget?.id) {
        this.targets.select(this.def.target);
        targetOverridden = true;
      }
      switch (this.def.action) {
        case 'flash':
          await this.flasher.flash(this.resolveFile(), {
            verifyAfterFlash: Boolean(this.def.verify)
          });
          break;
        case 'verify':
          await this.flasher.verify(this.resolveFile());
          break;
        case 'recover':
          await this.flasher.recover();
          break;
        default:
          this.writeLine(`Unknown action: ${this.def.action}`);
          this.closeEmitter.fire(1);
          return;
      }
      this.writeLine('Done.');
      this.closeEmitter.fire(0);
    } catch (err) {
      const message = (err as Error).message;
      this.writeLine(`Error: ${message}`);
      log.error(err as Error);
      this.closeEmitter.fire(1);
    } finally {
      if (targetOverridden && previousTarget) {
        try {
          this.targets.select(previousTarget.id);
        } catch (restoreErr) {
          log.warn(
            `Failed to restore previous target after task: ${(restoreErr as Error).message}`
          );
        }
      }
    }
  }

  private resolveFile(): vscode.Uri {
    const file = this.def.file;
    if (!file) {
      throw new FreeOcdError(
        `freeocd task requires "file" for action ${this.def.action}`,
        'MISSING_FILE'
      );
    }
    // Absolute paths bypass the scope lookup.
    if (file.startsWith('/') || /^[a-zA-Z]:[\\/]/u.test(file)) {
      return vscode.Uri.file(file);
    }
    const folder = this.scopeFolder();
    if (folder) {
      return vscode.Uri.joinPath(folder.uri, file);
    }
    return vscode.Uri.file(file);
  }

  /**
   * Resolve the workspace folder associated with this task's scope. In a
   * multi-root workspace this is the folder that declared the task, which
   * is the correct anchor for relative paths.
   */
  private scopeFolder(): vscode.WorkspaceFolder | undefined {
    if (typeof this.scope === 'object') {
      return this.scope;
    }
    return vscode.workspace.workspaceFolders?.[0];
  }

  private writeLine(text: string): void {
    this.writeEmitter.fire(`${text}\r\n`);
  }
}
