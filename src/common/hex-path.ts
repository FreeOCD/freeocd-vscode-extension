/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Shared .hex file path resolution.
 *
 * Absolute paths (POSIX `/...` or Windows drive-letter `C:\...`) are used
 * as-is; relative paths are resolved against the first workspace folder.
 */

import * as vscode from 'vscode';

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/u;

/**
 * Resolve a .hex file path to a `vscode.Uri`. Returns `undefined` when the
 * path is relative and no workspace folder is open to resolve it against.
 */
export function resolveHexUri(input: string): vscode.Uri | undefined {
  if (input.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(input)) {
    return vscode.Uri.file(input);
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, input) : undefined;
}
