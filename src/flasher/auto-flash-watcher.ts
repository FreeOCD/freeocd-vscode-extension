/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Watches the currently selected `.hex` file and (optionally) re-flashes on
 * change. Uses `vscode.workspace.createFileSystemWatcher` with a
 * `RelativePattern` so remote / WSL / devcontainer workspaces work.
 */

import * as vscode from 'vscode';
import type { Flasher } from './flasher';
import { log } from '../common/logger';

export class AutoFlashWatcher {
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposed = false;
  private currentUri: vscode.Uri | undefined;

  constructor(private readonly flasher: Flasher) {}

  public dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  public getUri(): vscode.Uri | undefined {
    return this.currentUri;
  }

  /**
   * (Re)configure the watcher. Pass `undefined` to stop watching.
   */
  public async update(uri: vscode.Uri | undefined): Promise<void> {
    this.watcher?.dispose();
    this.watcher = undefined;
    this.currentUri = uri;

    if (this.disposed || !uri) {
      log.info('Auto-flash disabled.');
      return;
    }

    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const pattern = folder
      ? new vscode.RelativePattern(folder, vscode.workspace.asRelativePath(uri, false))
      : new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), basename(uri));

    this.watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, true);
    this.watcher.onDidChange(() => this.onChange(uri));
    this.watcher.onDidCreate(() => this.onChange(uri));
    log.info(`Auto-flash watching ${uri.fsPath}`);
  }

  private async onChange(uri: vscode.Uri): Promise<void> {
    const config = vscode.workspace.getConfiguration('freeocd');
    const confirm = config.get<boolean>('autoFlash.confirmBeforeFlash', true);
    const verify = config.get<boolean>('flash.verifyAfterFlash', true);

    if (confirm) {
      const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t('The file {0} has changed. Flash now?', basename(uri)),
        vscode.l10n.t('Yes'),
        vscode.l10n.t('No')
      );
      if (choice !== vscode.l10n.t('Yes')) {
        return;
      }
    }

    try {
      await this.flasher.flash(uri, { verifyAfterFlash: verify });
    } catch (err) {
      log.error(err as Error);
    }
  }
}

function basename(uri: vscode.Uri): string {
  const segments = uri.path.split('/');
  return segments[segments.length - 1] || uri.path;
}
