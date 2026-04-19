/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 *
 * Mirrors the `StateManager` class in `freeocd-web`
 * (`public/js/core/state-manager.js`), BSD 3-Clause License,
 * Copyright (c) 2026, FreeOCD.
 */

/**
 * Active state monitor for the probe connection and the RTT session.
 *
 * Periodically polls the target Cortex-M processor to detect silent probe
 * failures (USB cable unplugged, firmware crash, node-hid handle wedged)
 * that the receive-only transport layer cannot observe on its own. When a
 * health-check error is detected, `StateManager` invokes a cleanup
 * callback so the extension host can tear down the RTT handler and clear
 * the terminal.
 *
 * The poll loop is paused during long-running foreground operations
 * (Flash / Recover / Verify / Reset) via `setExternalOperationInProgress`
 * so it never competes on the DAP transport with those operations. The
 * `freeocd-web` counterpart does the exact same thing; this is load
 * bearing, because two concurrent DAP transfers on a single CMSIS-DAP v1
 * HID probe will silently corrupt each other's responses.
 */

import { EventEmitter } from 'events';
import { log } from './logger';

/** Narrow subset of the DAPjs `CortexM` API used for the health check. */
export interface HealthCheckable {
  getState(): Promise<unknown>;
}

export interface StateManagerCallbacks {
  /**
   * Called when a health-check error is observed while RTT is connected.
   * Implementers should tear down the RTT handler, close the terminal,
   * and update the UI. The callback is invoked with the observed error so
   * it can be surfaced to the user.
   */
  onConnectionLost?: (err: Error) => void | Promise<void>;
}

export interface StateSnapshot {
  isDeviceConnected: boolean;
  isRttConnected: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Events emitted by `StateManager`:
 *  - `stateChange`        → `(snapshot: StateSnapshot) => void`
 *  - `deviceConnected`    → `() => void`
 *  - `deviceDisconnected` → `() => void`
 *  - `rttConnected`       → `() => void`
 *  - `rttDisconnected`    → `() => void`
 *  - `stateError`         → `(err: Error) => void`
 *
 * The error event is intentionally **not** named `error` — Node's
 * `EventEmitter` throws synchronously when an `error` event is emitted
 * without a registered listener, which would turn a benign probe-lost
 * diagnostic into an unhandled promise rejection inside the poll loop.
 */
export class StateManager extends EventEmitter {
  private isDeviceConnected = false;
  private isRttConnected = false;
  private processor: HealthCheckable | null = null;

  private pollHandle: ReturnType<typeof setTimeout> | undefined;
  private isPolling = false;
  private isExternalOperationInProgress = false;
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  private callbacks: StateManagerCallbacks = {};
  private destroyed = false;

  public setCallbacks(callbacks: StateManagerCallbacks): void {
    this.callbacks = callbacks;
  }

  public setPollIntervalMs(ms: number): void {
    if (ms > 0 && Number.isFinite(ms)) {
      this.pollIntervalMs = ms;
    }
  }

  /**
   * Pause / resume the poll loop during long-running foreground operations
   * (Flash / Recover / Verify / Reset). Callers MUST balance every `true`
   * with a `false`, typically in a `finally` block.
   *
   * This flag is deliberately separate from `stopPolling()` so the caller
   * can "park" the loop for the duration of an operation without having
   * to remember to restart it afterwards.
   */
  public setExternalOperationInProgress(inProgress: boolean): void {
    this.isExternalOperationInProgress = inProgress;
  }

  /**
   * Attach a Cortex-M processor to health-check. Pass `null` when the RTT
   * session ends so the loop stops issuing DAP transfers against a stale
   * handle. Automatically updates the `isRttConnected` flag and emits the
   * corresponding event.
   */
  public attachProcessor(processor: HealthCheckable | null): void {
    this.processor = processor;
    this.setRttConnected(processor !== null);
  }

  public setRttConnected(connected: boolean): void {
    const prev = this.isRttConnected;
    this.isRttConnected = connected;
    if (connected && !prev) {
      this.emit('rttConnected');
    } else if (!connected && prev) {
      this.emit('rttDisconnected');
    }
    if (connected !== prev) {
      this.emit('stateChange', this.getState());
    }
  }

  public setDeviceConnected(connected: boolean): void {
    const prev = this.isDeviceConnected;
    this.isDeviceConnected = connected;
    if (connected && !prev) {
      this.emit('deviceConnected');
    } else if (!connected && prev) {
      this.emit('deviceDisconnected');
    }
    if (connected !== prev) {
      this.emit('stateChange', this.getState());
    }
  }

  public getState(): StateSnapshot {
    return {
      isDeviceConnected: this.isDeviceConnected,
      isRttConnected: this.isRttConnected
    };
  }

  public startPolling(): void {
    if (this.destroyed || this.isPolling) {
      return;
    }
    this.isPolling = true;
    this.schedule();
  }

  public stopPolling(): void {
    this.isPolling = false;
    if (this.pollHandle !== undefined) {
      clearTimeout(this.pollHandle);
      this.pollHandle = undefined;
    }
  }

  public dispose(): void {
    this.destroyed = true;
    this.stopPolling();
    this.processor = null;
    this.callbacks = {};
    this.removeAllListeners();
  }

  private schedule(): void {
    if (!this.isPolling || this.destroyed) {
      return;
    }
    this.pollHandle = setTimeout(() => {
      void this.tick();
    }, this.pollIntervalMs);
    // Don't let our poll timer pin the event loop alive; in tests / CLI
    // contexts we want the process to exit once all real work is done.
    const handle = this.pollHandle as unknown as { unref?: () => void };
    handle.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.isPolling || this.destroyed) {
      return;
    }
    // Skip the health check entirely while a foreground operation owns the
    // DAP transport. Two concurrent DAP transfers on a CMSIS-DAP v1 HID
    // probe silently corrupt each other's responses, so this is not just a
    // performance optimisation.
    if (this.isExternalOperationInProgress) {
      this.schedule();
      return;
    }
    try {
      await this.checkDeviceState();
    } catch (err) {
      this.handleError(err as Error);
    }
    this.schedule();
  }

  private async checkDeviceState(): Promise<void> {
    if (!this.processor) {
      if (this.isDeviceConnected) {
        this.setDeviceConnected(false);
      }
      return;
    }
    try {
      // `CortexM.getState()` issues a short DP/AP read sequence that will
      // throw if the probe / target has gone away. That's exactly the
      // signal we want for the health check.
      await this.processor.getState();
      if (!this.isDeviceConnected) {
        this.setDeviceConnected(true);
      }
    } catch (err) {
      if (this.isDeviceConnected) {
        this.handleError(
          new Error(`Device connection lost: ${(err as Error).message}`)
        );
        this.setDeviceConnected(false);
      }
    }
  }

  private handleError(err: Error): void {
    this.emit('stateError', err);
    log.warn(`StateManager: ${err.message}`);
    if (this.isRttConnected && this.callbacks.onConnectionLost) {
      try {
        const result = this.callbacks.onConnectionLost(err);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((cbErr: unknown) =>
            log.warn(
              `StateManager cleanup error: ${(cbErr as Error).message}`
            )
          );
        }
      } catch (cbErr) {
        log.warn(`StateManager cleanup error: ${(cbErr as Error).message}`);
      }
    }
  }
}
