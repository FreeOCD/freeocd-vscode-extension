/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * RTT session lifecycle controller.
 *
 * Owns the `RttHandler` / `RttTerminal` pair and coordinates them with the
 * shared `OperationLock` and `StateManager`. Both the UI command
 * (`freeocd.connectRtt`) and the MCP tool handlers (`rtt_connect` /
 * `rtt_disconnect`) drive RTT exclusively through this controller so the
 * concurrency invariants (lock ownership + health polling) stay consistent
 * regardless of the caller.
 */

import * as vscode from 'vscode';

import { log } from '../common/logger';
import { FreeOcdError, NotConnectedError, NoTargetError } from '../common/errors';
import { loadDapjs } from '../common/dapjs-loader';
import type { OperationLock } from '../common/operation-lock';
import type { StateManager } from '../common/state-manager';
import type { RttState } from '../common/types';
import type { ConnectionManager } from '../connection/connection-manager';
import type { TargetManager } from '../target/target-manager';
import type { RttHandler } from './rtt-handler';
import { RttTerminal } from './rtt-terminal';

export interface RttSessionDeps {
  connection: ConnectionManager;
  targets: TargetManager;
  operationLock: OperationLock;
  stateManager: StateManager;
  /** Invoked whenever the session state changes (connect / teardown). */
  onSessionChanged(): void;
}

const DISCONNECTED_STATE: RttState = { connected: false, numBufUp: 0, numBufDown: 0 };

export class RttSession {
  private handler: RttHandler | undefined;
  private terminal: RttTerminal | undefined;

  constructor(private readonly deps: RttSessionDeps) {}

  public getHandler(): RttHandler | undefined {
    return this.handler;
  }

  public setHandler(handler: RttHandler | undefined): void {
    this.handler = handler;
  }

  public isConnected(): boolean {
    return this.handler !== undefined;
  }

  public getState(): RttState {
    return this.handler?.getState() ?? DISCONNECTED_STATE;
  }

  /**
   * Shared RTT connect flow used by both `freeocd.connectRtt` (UI command)
   * and MCP tool handlers (`rtt_connect`). Mirrors `freeocd-web`'s
   * `connectRtt()`:
   *
   *   1. Acquire the shared `RTT` slot of the operation lock (so Flash /
   *      Recover triggered concurrently from MCP or Tasks gets
   *      OPERATION_BUSY instead of racing on the transport).
   *   2. Soft-reset + halt the target to guarantee the RTT control block
   *      is in a clean state before we scan for it.
   *   3. Scan for the SEGGER RTT signature.
   *   4. Resume the target so firmware can actually produce RTT traffic.
   *   5. Attach the Cortex-M handle to the `StateManager` poll loop so a
   *      probe disappearance automatically tears the session down.
   *
   * Returns the handler on success or `null` when the scan finds no
   * control block. Throws `OPERATION_BUSY` on lock conflict and propagates
   * any DAP transfer error from the underlying `RttHandler.init()` /
   * `softReset` / `halt` calls.
   */
  public async connect(options?: {
    scanStart?: number;
    scanRange?: number;
  }): Promise<RttHandler | null> {
    const { connection, targets, operationLock, stateManager } = this.deps;
    if (!connection.isConnected()) {
      throw new NotConnectedError();
    }
    if (!targets.getCurrent()) {
      throw new NoTargetError();
    }
    if (!operationLock.tryAcquire('RTT', 'RttSession.connect')) {
      const held = operationLock.getCurrent();
      throw new FreeOcdError(
        `Cannot connect RTT: ${held ?? 'another'} operation is already in progress.`,
        'OPERATION_BUSY'
      );
    }

    let lockOwned = true;
    try {
      const config = vscode.workspace.getConfiguration('freeocd');
      const { RttHandler } = await import('./rtt-handler');
      const dapjs = loadDapjs();
      const processor = new dapjs.CortexM(connection.getDap().proxy);

      log.info('RTT: issuing soft reset + halt to clean up target state...');
      try {
        await processor.softReset();
        await new Promise((r) => setTimeout(r, 1000));
        await processor.halt();
      } catch (err) {
        // Non-fatal: some targets (already-halted, locked, or in a
        // transient reset state) may reject one of these. Continue and
        // let the subsequent scan decide.
        log.warn(`RTT pre-init reset warning: ${(err as Error).message}`);
      }

      const scanStart =
        options?.scanStart ?? parseInt(config.get<string>('rtt.scanStart', '0x20000000'), 16);
      const scanRange =
        options?.scanRange ?? parseInt(config.get<string>('rtt.scanRange', '0x10000'), 16);
      const handler = new RttHandler(processor, {
        scanStartAddress: scanStart,
        scanRange
      });
      const count = await handler.init();
      if (count < 0) {
        return null;
      }

      try {
        await processor.resume();
      } catch (err) {
        log.warn(`RTT resume warning: ${(err as Error).message}`);
      }

      this.handler = handler;
      stateManager.attachProcessor(processor);
      stateManager.startPolling();
      // Session now owns the RTT lock for its entire lifetime; only
      // `teardown()` will release it. Flip the flag so the `finally`
      // block below skips its cleanup path.
      lockOwned = false;
      this.deps.onSessionChanged();
      return handler;
    } finally {
      if (lockOwned) {
        operationLock.release('RTT');
      }
    }
  }

  /**
   * Tear down the RTT session and release the shared RTT lock.
   *
   * Used as:
   *   1. the body of `freeocd.disconnectRtt`,
   *   2. the pre-flash/recover cleanup hook, and
   *   3. the StateManager `onConnectionLost` callback (probe went away).
   *
   * Safe to call when RTT is already disconnected. Swallows errors from
   * the underlying RTT reset so callers can always run it unconditionally
   * in a `finally` block.
   */
  public async teardown(reason?: string): Promise<void> {
    const { stateManager, operationLock } = this.deps;
    // Always stop the poll loop first — continuing to issue DAP transfers
    // while we're disposing the terminal only invites more failures.
    stateManager.stopPolling();
    stateManager.attachProcessor(null);
    if (this.terminal) {
      try {
        this.terminal.dispose();
      } catch (err) {
        log.warn(`RTT terminal dispose error: ${(err as Error).message}`);
      }
      this.terminal = undefined;
    }
    if (this.handler) {
      try {
        this.handler.reset();
      } catch (err) {
        log.warn(`RTT handler reset error: ${(err as Error).message}`);
      }
      this.handler = undefined;
    }
    operationLock.release('RTT');
    this.deps.onSessionChanged();
    if (reason) {
      log.info(`RTT torn down: ${reason}`);
    }
  }

  /** (Re)open the RTT pseudoterminal for the current handler. */
  public openTerminal(pollingIntervalMs: number): void {
    if (!this.handler) {
      return;
    }
    this.terminal?.dispose();
    this.terminal = new RttTerminal(this.handler, pollingIntervalMs);
    this.terminal.show();
  }

  public dispose(): void {
    this.terminal?.dispose();
  }
}
