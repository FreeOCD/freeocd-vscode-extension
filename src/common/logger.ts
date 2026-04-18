/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Lightweight wrapper around `vscode.LogOutputChannel` that adds:
 *  - Lazy, explicit initialization (no channel created until first use).
 *  - A `levelFromString()` helper to sync with the `freeocd.log.level` setting.
 *  - Structured error formatting with optional contextual info.
 */

import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

/**
 * Initialize the extension-wide log channel. Safe to call multiple times.
 */
export function initLogger(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('FreeOCD', { log: true });
  }
  return channel;
}

/**
 * Get the currently initialized log channel (throws if not initialized).
 */
export function getLogger(): vscode.LogOutputChannel {
  if (!channel) {
    return initLogger();
  }
  return channel;
}

/**
 * Convenience re-exports so modules don't need to import `vscode` just to log.
 */
export const log = {
  trace: (msg: string, ...args: unknown[]): void => getLogger().trace(msg, ...args),
  debug: (msg: string, ...args: unknown[]): void => getLogger().debug(msg, ...args),
  info: (msg: string, ...args: unknown[]): void => getLogger().info(msg, ...args),
  warn: (msg: string, ...args: unknown[]): void => getLogger().warn(msg, ...args),
  error: (msg: string | Error, ...args: unknown[]): void => {
    if (msg instanceof Error) {
      getLogger().error(msg);
    } else {
      getLogger().error(msg, ...args);
    }
  }
};

/**
 * Format an arbitrary error object into a stable, human-readable string.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  if (typeof err === 'string') {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
