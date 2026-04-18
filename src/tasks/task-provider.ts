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
import { FreeOcdError } from '../common/errors';
import { log } from '../common/logger';

interface FreeocdTaskDefinition extends vscode.TaskDefinition {
  type: 'freeocd';
  action: 'flash' | 'verify' | 'recover';
  file?: string;
  verify?: boolean;
}

export class FreeocdTaskProvider implements vscode.TaskProvider {
  public static readonly taskType = 'freeocd';

  constructor(private readonly flasher: Flasher) {}

  public provideTasks(): vscode.ProviderResult<vscode.Task[]> {
    return [
      this.buildTask({ type: 'freeocd', action: 'flash' }),
      this.buildTask({ type: 'freeocd', action: 'verify' }),
      this.buildTask({ type: 'freeocd', action: 'recover' })
    ];
  }

  public resolveTask(task: vscode.Task): vscode.Task | undefined {
    const definition = task.definition as FreeocdTaskDefinition;
    if (definition.type !== 'freeocd') {
      return undefined;
    }
    return this.buildTask(definition);
  }

  private buildTask(def: FreeocdTaskDefinition): vscode.Task {
    const scope = vscode.workspace.workspaceFolders?.[0] ?? vscode.TaskScope.Workspace;
    const task = new vscode.Task(
      def,
      scope,
      `${def.action}${def.file ? ` ${def.file}` : ''}`,
      FreeocdTaskProvider.taskType,
      new vscode.CustomExecution(async () => this.createTerminal(def))
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Silent,
      panel: vscode.TaskPanelKind.Shared,
      clear: false
    };
    return task;
  }

  private async createTerminal(def: FreeocdTaskDefinition): Promise<vscode.Pseudoterminal> {
    return new FreeocdTaskTerminal(def, this.flasher);
  }
}

class FreeocdTaskTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  public readonly onDidWrite = this.writeEmitter.event;
  public readonly onDidClose = this.closeEmitter.event;

  constructor(private readonly def: FreeocdTaskDefinition, private readonly flasher: Flasher) {}

  public open(): void {
    void this.run();
  }

  public close(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private async run(): Promise<void> {
    try {
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
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder && !file.startsWith('/') && !/^[a-zA-Z]:[\\/]/u.test(file)) {
      return vscode.Uri.joinPath(folder.uri, file);
    }
    return vscode.Uri.file(file);
  }

  private writeLine(text: string): void {
    this.writeEmitter.fire(`${text}\r\n`);
  }
}
