/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 *
 * Portions of this file mirror the design of `freeocd-web`
 * (`public/js/platform/platform-handler.js`), BSD 3-Clause License,
 * Copyright (c) 2026, FreeOCD.
 */

/**
 * Platform handler abstract base.
 *
 * Each MCU family (Nordic nRF, STM32, RP2040, ESP32, ...) provides its own
 * concrete handler that implements the `recover / flash / verify / reset`
 * operations on top of a generic DAPjs `ADI` instance.
 */

import type { TargetDefinition } from '../common/types';

/** Progress callback invoked with a 0-100 percentage. */
export type ProgressCallback = (percent: number, message?: string) => void;

/** Cancellation signal. `isCancelled()` is polled during long-running ops. */
export interface Cancellable {
  isCancelled(): boolean;
}

export abstract class PlatformHandler {
  protected readonly target: TargetDefinition;

  constructor(target: TargetDefinition) {
    this.target = target;
  }

  public getTarget(): TargetDefinition {
    return this.target;
  }

  /** Mass erase / unlock via platform-specific access port (e.g. CTRL-AP). */
  public abstract recover(dap: unknown, onProgress: ProgressCallback, token: Cancellable): Promise<unknown>;

  /** Program `firmware` to the device starting at `startAddress`. */
  public abstract flash(
    dap: unknown,
    firmware: Uint8Array,
    startAddress: number,
    onProgress: ProgressCallback,
    token: Cancellable
  ): Promise<void>;

  /** Read back `firmware` and compare. */
  public abstract verify(
    dap: unknown,
    firmware: Uint8Array,
    startAddress: number,
    onProgress: ProgressCallback,
    token: Cancellable
  ): Promise<{ success: boolean; mismatches: number }>;

  /** Reset the target (SYSRESETREQ / CTRL-AP reset / etc.). */
  public abstract reset(dap: unknown): Promise<void>;
}
