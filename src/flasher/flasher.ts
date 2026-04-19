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

  // Single-flight guard so overlapping flash / verify / recover operations
  // cannot race on the same probe. The VS Code progress UI is modal enough
  // to discourage casual double-clicks, but MCP tool calls, tasks, and the
  // auto-flash watcher all bypass that UI. AI_REVIEW checklist item STA-02
  // ("Overlapping flash / verify / recover operations are prevented") relies
  // on this flag.
  private inProgress = false;

  constructor(private readonly deps: FlasherDeps) {}

  public dispose(): void {
    this.progressEmitter.dispose();
  }

  private async runExclusive<T>(op: string, fn: () => Promise<T>): Promise<T> {
    if (this.inProgress) {
      throw new FreeOcdError(
        `Another flash operation is already in progress; cannot start ${op}.`,
        'FLASH_BUSY'
      );
    }
    this.inProgress = true;
    try {
      return await fn();
    } finally {
      this.inProgress = false;
    }
  }

  public async loadHex(uri: vscode.Uri): Promise<ParsedHex> {
    const raw = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(raw);
    return parseIntelHex(text);
  }

  /**
   * Flash a .hex file with progress UI and cancellation support.
   *
   * When `verifyAfterFlash` is enabled, a second progress notification is
   * opened for the verify phase so its progress bar and timing information
   * are actually visible to the user (the original in-line verify re-used
   * the flash progress UI that was already at 100%, making the verify phase
   * appear frozen).
   */
  public async flash(
    uri: vscode.Uri,
    options: { verifyAfterFlash?: boolean; requestId?: string } = {}
  ): Promise<void> {
    return this.runExclusive('flash', async () => {
      const requestId = options.requestId ?? genId();
      const hex = await this.loadHex(uri);

      // Phase 1: write image with its own progress UI.
      await this.runFlashWithProgress(uri, hex, requestId);

      // Phase 2: optional verify with an independent progress UI so the
      // user can see the verify percentage, elapsed time, and ETA.
      if (options.verifyAfterFlash) {
        const result = await this.runVerifyWithProgress(uri, hex, requestId);
        if (!result.success) {
          const err = new FreeOcdError(
            `Verify failed: ${result.mismatches} byte mismatch(es).`,
            'VERIFY_FAILED'
          );
          vscode.window.showErrorMessage(
            vscode.l10n.t('Flash failed: {0}', err.message)
          );
          log.error(err);
          throw err;
        }
      }

      // Phase 3: reset so the freshly-flashed image starts running.
      // Failure here is non-fatal — the flash itself already succeeded.
      try {
        await this.deps.getHandler().reset(this.deps.getDap());
      } catch (resetErr) {
        log.warn(`Post-flash reset warning: ${(resetErr as Error).message}`);
      }
    });
  }

  public async verify(
    uri: vscode.Uri,
    options: { requestId?: string } = {}
  ): Promise<{ success: boolean; mismatches: number }> {
    return this.runExclusive('verify', async () => {
      const hex = await this.loadHex(uri);
      const requestId = options.requestId ?? genId();
      const result = await this.runVerifyWithProgress(uri, hex, requestId);
      if (result.success) {
        vscode.window.showInformationMessage(
          vscode.l10n.t('Verify passed ({0} bytes match).', hex.size)
        );
      } else {
        vscode.window.showWarningMessage(
          vscode.l10n.t('Verify failed: {0} byte mismatch(es).', result.mismatches)
        );
      }
      return result;
    });
  }

  public async recover(options: { requestId?: string } = {}): Promise<void> {
    return this.runExclusive('recover', async () => {
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
          const started = Date.now();
          let lastPct = 0;
          const onProgress = (pct: number, message?: string): void => {
            const clamped = pct > lastPct ? pct : lastPct;
            const delta = clamped - lastPct;
            const elapsedMs = Date.now() - started;
            const { message: displayMessage, etaMs } = buildProgressMessage(
              elapsedMs,
              clamped,
              message
            );
            if (delta > 0) {
              progress.report({ increment: delta, message: displayMessage });
            }
            lastPct = clamped;
            this.emit({
              requestId,
              phase: 'erasing',
              percent: clamped,
              message,
              elapsedMs,
              etaMs
            });
          };
          try {
            await handler.recover(dap, onProgress, token);
            const elapsedMs = Date.now() - started;
            vscode.window.showInformationMessage(
              vscode.l10n.t('Recovery completed successfully.')
            );
            log.info(`Recovery completed in ${elapsedMs} ms.`);
            this.emit({ requestId, phase: 'done', percent: 100, elapsedMs });
          } catch (err) {
            const elapsedMs = Date.now() - started;
            if (err instanceof CancelledError) {
              vscode.window.showWarningMessage(vscode.l10n.t('Operation cancelled.'));
            } else {
              vscode.window.showErrorMessage(
                vscode.l10n.t('Recovery failed: {0}', (err as Error).message)
              );
            }
            this.emit({
              requestId,
              phase: 'error',
              percent: lastPct,
              message: (err as Error).message,
              elapsedMs
            });
            throw err;
          }
        }
      );
    });
  }

  public async softReset(): Promise<void> {
    return this.runExclusive('soft reset', async () => {
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
    });
  }

  /**
   * Internal: run the flash phase inside its own `withProgress`. Notifies
   * the UI of elapsed / estimated-remaining time on every progress tick.
   *
   * Throws on cancellation or flash failure; the caller is responsible for
   * subsequent phases (verify / reset).
   */
  private async runFlashWithProgress(
    uri: vscode.Uri,
    hex: ParsedHex,
    requestId: string
  ): Promise<void> {
    const handler = this.deps.getHandler();
    const dap = this.deps.getDap();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Flashing {0} ({1} bytes)...', basename(uri), hex.size),
        cancellable: true
      },
      async (progress, vsToken) => {
        const token = toCancellable(vsToken);
        const started = Date.now();

        this.emit({ requestId, phase: 'preparing', percent: 0, elapsedMs: 0 });

        let lastPct = 0;
        const onProgress = (pct: number, message?: string): void => {
          // Clamp to monotonically non-decreasing percentages so a transient
          // regression in reported progress does not cause us to
          // over-report the next increment.
          const clamped = pct > lastPct ? pct : lastPct;
          const delta = clamped - lastPct;
          const elapsedMs = Date.now() - started;
          const { message: displayMessage, etaMs } = buildProgressMessage(
            elapsedMs,
            clamped,
            message
          );
          if (delta > 0) {
            progress.report({ increment: delta, message: displayMessage });
          }
          lastPct = clamped;
          this.emit({
            requestId,
            phase: 'writing',
            percent: clamped,
            message,
            bytesTotal: hex.size,
            elapsedMs,
            etaMs
          });
        };

        try {
          await handler.flash(dap, hex.data, hex.startAddress, onProgress, token);
          const elapsedMs = Date.now() - started;
          this.emit({
            requestId,
            phase: 'done',
            percent: 100,
            bytesWritten: hex.size,
            bytesTotal: hex.size,
            elapsedMs
          });
          vscode.window.showInformationMessage(
            vscode.l10n.t('Flash completed successfully in {0} ms.', elapsedMs)
          );
          log.info(`Flash completed in ${elapsedMs} ms.`);
        } catch (err) {
          const elapsedMs = Date.now() - started;
          this.emit({
            requestId,
            phase: 'error',
            percent: lastPct,
            message: (err as Error).message,
            elapsedMs
          });
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

  /**
   * Internal: run the verify phase inside its own `withProgress`. Emits
   * elapsed / estimated-remaining time on every progress tick.
   *
   * Returns `{success, mismatches}`. Throws on cancellation or transport
   * errors; the caller decides how to surface a byte-mismatch failure
   * (warning vs. fatal Flash failure).
   */
  private async runVerifyWithProgress(
    uri: vscode.Uri,
    hex: ParsedHex,
    requestId: string
  ): Promise<{ success: boolean; mismatches: number }> {
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
        const started = Date.now();

        this.emit({ requestId, phase: 'verifying', percent: 0, elapsedMs: 0 });

        let lastPct = 0;
        const onProgress = (pct: number, message?: string): void => {
          const clamped = pct > lastPct ? pct : lastPct;
          const delta = clamped - lastPct;
          const elapsedMs = Date.now() - started;
          const { message: displayMessage, etaMs } = buildProgressMessage(
            elapsedMs,
            clamped,
            message
          );
          if (delta > 0) {
            progress.report({ increment: delta, message: displayMessage });
          }
          lastPct = clamped;
          this.emit({
            requestId,
            phase: 'verifying',
            percent: clamped,
            message,
            bytesTotal: hex.size,
            elapsedMs,
            etaMs
          });
        };

        try {
          const result = await handler.verify(
            dap,
            hex.data,
            hex.startAddress,
            onProgress,
            token
          );
          const elapsedMs = Date.now() - started;
          this.emit({ requestId, phase: 'done', percent: 100, elapsedMs });
          log.info(`Verify completed in ${elapsedMs} ms (${result.mismatches} mismatches).`);
          return result;
        } catch (err) {
          const elapsedMs = Date.now() - started;
          this.emit({
            requestId,
            phase: 'error',
            percent: lastPct,
            message: (err as Error).message,
            elapsedMs
          });
          if (err instanceof CancelledError) {
            vscode.window.showWarningMessage(vscode.l10n.t('Operation cancelled.'));
          } else {
            vscode.window.showErrorMessage(
              vscode.l10n.t('Verify failed: {0}', (err as Error).message)
            );
          }
          throw err;
        }
      }
    );
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

/**
 * Format a duration (seconds) into a compact human-friendly string.
 * Mirrors the `freeocd-web` helper so the two UIs stay in sync:
 *   <60s   -> "Xs"
 *   <3600s -> "Xm Ys"
 *   else   -> "Xh Ym"
 */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '?';
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * Build a VS Code progress message with elapsed / estimated-remaining
 * time, mirroring the `freeocd-web` step progress UI. Remaining time is
 * suppressed until at least 1s has elapsed and progress is strictly
 * between 0% and 100% so we don't display wild ETAs like "~99h
 * remaining" while the operation is ramping up.
 *
 * Example output: `"Flashing: 42% (3s elapsed, ~4s remaining)"`.
 */
function buildProgressMessage(
  elapsedMs: number,
  percent: number,
  baseMessage?: string
): { message: string; etaMs?: number } {
  const elapsedSec = elapsedMs / 1000;
  const timeParts: string[] = [`${formatTime(elapsedSec)} elapsed`];
  let etaMs: number | undefined;
  if (elapsedSec >= 1 && percent > 0 && percent < 100) {
    const remainingSec = (elapsedSec / percent) * (100 - percent);
    if (remainingSec > 0) {
      timeParts.push(`~${formatTime(remainingSec)} remaining`);
      etaMs = Math.round(remainingSec * 1000);
    }
  }
  const timingStr = `(${timeParts.join(', ')})`;
  const message = baseMessage ? `${baseMessage} ${timingStr}` : timingStr;
  return { message, etaMs };
}
