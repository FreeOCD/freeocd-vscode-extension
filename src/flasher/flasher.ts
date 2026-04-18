/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * High-level flash / verify / recover orchestrator.
 *
 * Accepts a `PlatformHandler` (created by `TargetManager`) and a DAP handle
 * from `ConnectionManager`, then drives flash/verify/recover with a
 * `vscode.Progress` UI and `CancellationToken` hookup.
 */

import * as vscode from 'vscode';
import type { Cancellable, PlatformHandler } from '../target/platform-handler';
import { parseIntelHex, type ParsedHex } from './hex-parser';
import { FreeOcdError, CancelledError } from '../common/errors';
import { log } from '../common/logger';
import type { FlashProgress } from '../common/types';

export interface FlasherDeps {
  /** Return the currently connected DAP handle (throws if not connected). */
  getDap(): unknown;
  /** Return the platform handler for the selected target. */
  getHandler(): PlatformHandler;
}

export class Flasher {
  private readonly progressEmitter = new vscode.EventEmitter<FlashProgress>();
  public readonly onDidReportProgress = this.progressEmitter.event;

  constructor(private readonly deps: FlasherDeps) {}

  public dispose(): void {
    this.progressEmitter.dispose();
  }

  public async loadHex(uri: vscode.Uri): Promise<ParsedHex> {
    const raw = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(raw);
    return parseIntelHex(text);
  }

  /**
   * Flash a .hex file with progress UI and cancellation support.
   */
  public async flash(
    uri: vscode.Uri,
    options: { verifyAfterFlash?: boolean; requestId?: string } = {}
  ): Promise<void> {
    const requestId = options.requestId ?? genId();
    const hex = await this.loadHex(uri);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Flashing {0} ({1} bytes)...', basename(uri), hex.size),
        cancellable: true
      },
      async (progress, vsToken) => {
        const token = toCancellable(vsToken);
        const handler = this.deps.getHandler();
        const dap = this.deps.getDap();
        const started = Date.now();

        this.emit({ requestId, phase: 'preparing', percent: 0 });
        let lastPct = 0;
        const onProgress = (pct: number, message?: string): void => {
          const delta = pct - lastPct;
          if (delta > 0) {
            progress.report({ increment: delta, message });
          }
          lastPct = pct;
          this.emit({
            requestId,
            phase: 'writing',
            percent: pct,
            message,
            bytesTotal: hex.size
          });
        };

        try {
          await handler.flash(dap, hex.data, hex.startAddress, onProgress, token);
          this.emit({ requestId, phase: 'done', percent: 100, bytesWritten: hex.size, bytesTotal: hex.size });
          const elapsed = Date.now() - started;
          vscode.window.showInformationMessage(
            vscode.l10n.t('Flash completed successfully in {0} ms.', elapsed)
          );
          log.info(`Flash completed in ${elapsed} ms.`);

          if (options.verifyAfterFlash) {
            await this.verifyInternal(dap, handler, hex, requestId, vsToken);
          }

          // Reset the target so the freshly-flashed image starts running.
          // Errors here are non-fatal — the flash itself already succeeded.
          try {
            await handler.reset(dap);
          } catch (resetErr) {
            log.warn(`Post-flash reset warning: ${(resetErr as Error).message}`);
          }
        } catch (err) {
          this.emit({ requestId, phase: 'error', percent: lastPct, message: (err as Error).message });
          if (err instanceof CancelledError) {
            vscode.window.showWarningMessage(vscode.l10n.t('Operation cancelled.'));
          } else {
            vscode.window.showErrorMessage(
              vscode.l10n.t('Flash failed: {0}', (err as Error).message)
            );
            log.error(err as Error);
          }
          throw err;
        }
      }
    );
  }

  public async verify(uri: vscode.Uri, options: { requestId?: string } = {}): Promise<{ success: boolean; mismatches: number }> {
    const hex = await this.loadHex(uri);
    const requestId = options.requestId ?? genId();
    const handler = this.deps.getHandler();
    const dap = this.deps.getDap();

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Verifying {0}...', basename(uri)),
        cancellable: true
      },
      async (progress, vsToken) => {
        const token = toCancellable(vsToken);
        let lastPct = 0;
        const onProgress = (pct: number): void => {
          const delta = pct - lastPct;
          if (delta > 0) {
            progress.report({ increment: delta });
          }
          lastPct = pct;
          this.emit({ requestId, phase: 'verifying', percent: pct, bytesTotal: hex.size });
        };
        try {
          const result = await handler.verify(dap, hex.data, hex.startAddress, onProgress, token);
          if (result.success) {
            vscode.window.showInformationMessage(
              vscode.l10n.t('Verify passed ({0} bytes match).', hex.size)
            );
          } else {
            vscode.window.showWarningMessage(
              vscode.l10n.t('Verify failed: {0} byte mismatch(es).', result.mismatches)
            );
          }
          this.emit({ requestId, phase: 'done', percent: 100 });
          return result;
        } catch (err) {
          if (err instanceof CancelledError) {
            vscode.window.showWarningMessage(vscode.l10n.t('Operation cancelled.'));
          } else {
            vscode.window.showErrorMessage(
              vscode.l10n.t('Verify failed: {0}', (err as Error).message)
            );
          }
          this.emit({ requestId, phase: 'error', percent: lastPct, message: (err as Error).message });
          throw err;
        }
      }
    );
  }

  public async recover(options: { requestId?: string } = {}): Promise<void> {
    const requestId = options.requestId ?? genId();
    const handler = this.deps.getHandler();
    const dap = this.deps.getDap();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Recovering target (mass erase)...'),
        cancellable: true
      },
      async (progress, vsToken) => {
        const token = toCancellable(vsToken);
        let lastPct = 0;
        const onProgress = (pct: number, message?: string): void => {
          const delta = pct - lastPct;
          if (delta > 0) {
            progress.report({ increment: delta, message });
          }
          lastPct = pct;
          this.emit({ requestId, phase: 'erasing', percent: pct, message });
        };
        try {
          await handler.recover(dap, onProgress, token);
          vscode.window.showInformationMessage(vscode.l10n.t('Recovery completed successfully.'));
          this.emit({ requestId, phase: 'done', percent: 100 });
        } catch (err) {
          if (err instanceof CancelledError) {
            vscode.window.showWarningMessage(vscode.l10n.t('Operation cancelled.'));
          } else {
            vscode.window.showErrorMessage(
              vscode.l10n.t('Recovery failed: {0}', (err as Error).message)
            );
          }
          this.emit({ requestId, phase: 'error', percent: lastPct, message: (err as Error).message });
          throw err;
        }
      }
    );
  }

  public async softReset(): Promise<void> {
    const handler = this.deps.getHandler();
    const dap = this.deps.getDap();
    try {
      await handler.reset(dap);
      vscode.window.showInformationMessage(vscode.l10n.t('Soft reset requested.'));
    } catch (err) {
      vscode.window.showErrorMessage(
        vscode.l10n.t('Soft reset failed: {0}', (err as Error).message)
      );
      throw err;
    }
  }

  private async verifyInternal(
    dap: unknown,
    handler: PlatformHandler,
    hex: ParsedHex,
    requestId: string,
    vsToken: vscode.CancellationToken
  ): Promise<void> {
    const token = toCancellable(vsToken);
    const result = await handler.verify(dap, hex.data, hex.startAddress, () => undefined, token);
    if (!result.success) {
      throw new FreeOcdError(
        `Verify failed: ${result.mismatches} byte mismatch(es).`,
        'VERIFY_FAILED'
      );
    }
    this.emit({ requestId, phase: 'done', percent: 100 });
  }

  private emit(p: FlashProgress): void {
    this.progressEmitter.fire(p);
  }
}

function basename(uri: vscode.Uri): string {
  const segments = uri.path.split('/');
  return segments[segments.length - 1] || uri.path;
}

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toCancellable(token: vscode.CancellationToken): Cancellable {
  return {
    isCancelled: () => token.isCancellationRequested
  };
}
