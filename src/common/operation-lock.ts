/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 *
 * Mirrors the `OperationLock` class in `freeocd-web`
 * (`public/js/main.js`), BSD 3-Clause License, Copyright (c) 2026, FreeOCD.
 */

/**
 * Shared single-holder lock for Flash / Verify / Recover / Reset / RTT.
 *
 * The extension is driven from multiple, independent entry points (the
 * command palette, the TreeView buttons, the `FreeocdTaskProvider`, the
 * `AutoFlashWatcher`, and the MCP bridge), and every one of those entry
 * points ultimately talks to the same probe over a single CMSIS-DAP HID
 * transport. Without a shared exclusive-operation gate, two long-running
 * operations — e.g. an RTT polling session and a recover triggered via
 * MCP — can race on the DAP transport and wedge `node-hid`.
 *
 * `OperationLock` centralises that gate:
 *   - A caller obtains the lock via `tryAcquire(op, owner)` before issuing
 *     DAP transfers, and releases it in a `finally` block.
 *   - Re-acquire attempts by the **same** operation type succeed silently
 *     (idempotent re-entry), so helpers inside a locked flow are free to
 *     call `tryAcquire` defensively.
 *   - Different operation types are rejected until the lock is released.
 *
 * This is deliberately simpler than `Flasher.runExclusive()` (which only
 * covers the flasher): it is the authoritative gate across all entry
 * points into the probe.
 */

import { EventEmitter } from 'events';
import { FreeOcdError } from './errors';

export type OperationType = 'FLASH' | 'VERIFY' | 'RECOVER' | 'RESET' | 'RTT';

export class OperationBusyError extends FreeOcdError {
  constructor(
    public readonly requested: OperationType,
    public readonly held: OperationType,
    public readonly heldOwner: string | null
  ) {
    super(
      heldOwner
        ? `Cannot start ${requested}: ${held} (${heldOwner}) is already in progress.`
        : `Cannot start ${requested}: ${held} is already in progress.`,
      'OPERATION_BUSY'
    );
    this.name = 'OperationBusyError';
  }
}

/**
 * Events:
 *  - `changed` — emitted whenever the held operation transitions, with the
 *    new operation (or `null` when released). Useful for driving button
 *    enabled/disabled state in the UI.
 */
export class OperationLock extends EventEmitter {
  private current: OperationType | null = null;
  private owner: string | null = null;

  /**
   * Try to acquire the lock. Returns `true` on success (or when already
   * held by the same operation type, so callers can defensively re-acquire
   * inside a locked flow). Returns `false` if a different operation holds
   * the lock.
   */
  public tryAcquire(operation: OperationType, owner: string): boolean {
    if (this.current === null) {
      this.current = operation;
      this.owner = owner;
      this.emit('changed', this.current);
      return true;
    }
    if (this.current === operation) {
      return true;
    }
    return false;
  }

  /**
   * Same as `tryAcquire` but throws `OperationBusyError` on conflict. Useful
   * at API boundaries where the caller does not want to handle the boolean
   * result (MCP tool handlers, VS Code commands).
   */
  public acquireOrThrow(operation: OperationType, owner: string): void {
    if (this.current === null) {
      this.current = operation;
      this.owner = owner;
      this.emit('changed', this.current);
      return;
    }
    if (this.current === operation) {
      return;
    }
    throw new OperationBusyError(operation, this.current, this.owner);
  }

  /**
   * Release the lock. A release request from an operation type that does
   * not currently hold the lock is a no-op (returns `false`) so that
   * best-effort cleanup code in `finally` blocks cannot corrupt the lock
   * state if the prior `tryAcquire` failed.
   */
  public release(operation: OperationType): boolean {
    if (this.current === operation) {
      this.current = null;
      this.owner = null;
      this.emit('changed', null);
      return true;
    }
    return false;
  }

  public getCurrent(): OperationType | null {
    return this.current;
  }

  public getOwner(): string | null {
    return this.owner;
  }

  public isLocked(): boolean {
    return this.current !== null;
  }

  public isLockedBy(operation: OperationType): boolean {
    return this.current === operation;
  }

  /**
   * `true` if another operation (different from `operation`) currently
   * holds the lock.
   */
  public isConflicting(operation: OperationType): boolean {
    return this.current !== null && this.current !== operation;
  }

  public dispose(): void {
    this.removeAllListeners();
    this.current = null;
    this.owner = null;
  }
}
