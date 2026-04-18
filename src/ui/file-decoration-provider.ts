/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Decorates `.hex` files in the Explorer:
 *   - A "F" badge on any `.hex` so users can tell at a glance they're
 *     flashable.
 *   - A colored badge on the currently selected `.hex` file.
 */

import * as vscode from 'vscode';

const BADGE_SELECTED = 'F*';
const BADGE_DEFAULT = 'F';

export class HexFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  public readonly onDidChangeFileDecorations = this.emitter.event;
  private selected: vscode.Uri | undefined;

  public dispose(): void {
    this.emitter.dispose();
  }

  public setSelected(uri: vscode.Uri | undefined): void {
    const previous = this.selected;
    this.selected = uri;
    const affected: vscode.Uri[] = [];
    if (previous) {
      affected.push(previous);
    }
    if (uri) {
      affected.push(uri);
    }
    if (affected.length > 0) {
      this.emitter.fire(affected);
    }
  }

  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!uri.path.endsWith('.hex')) {
      return undefined;
    }
    if (this.selected && uri.toString() === this.selected.toString()) {
      return {
        badge: BADGE_SELECTED,
        tooltip: vscode.l10n.t('Selected FreeOCD flash target'),
        color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
        propagate: false
      };
    }
    return {
      badge: BADGE_DEFAULT,
      tooltip: vscode.l10n.t('Flashable via FreeOCD'),
      propagate: false
    };
  }
}
