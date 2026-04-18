/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * File-based IPC bridge between the extension host (which owns the probe)
 * and the standalone MCP server child process.
 *
 * All IPC files live under `context.storageUri/mcp-ipc/` (workspaceStorage —
 * never in the user's repository). The MCP server reads its IPC directory
 * from the `FREEOCD_IPC_DIR` environment variable set by the extension at
 * launch time.
 *
 * File layout:
 *   - `request.json`  — Written by the MCP server; the extension watches and
 *                       executes the command.
 *   - `response.json` — Written by the extension once the command completes.
 *   - `status.json`   — Written by the extension on connection / target /
 *                       flash / RTT state changes (debounced).
 */

import * as vscode from 'vscode';
import { log } from '../common/logger';
import type { SessionLog } from './session-log';

export interface McpRequest {
  requestId: string;
  tool: string;
  args?: Record<string, unknown>;
  timestamp: string;
}

export interface McpResponse {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: { message: string; code?: string; stack?: string };
  durationMs?: number;
  timestamp: string;
}

export interface McpStatus {
  connection: {
    state: string;
    method: string;
    probe?: { vendorId: number; productId: number; serialNumber?: string; product?: string };
  };
  target?: { id: string; name: string; platform: string };
  hexFile?: string;
  flash: { inProgress: boolean; lastRequestId?: string; lastSuccess?: boolean };
  rtt: { connected: boolean; numBufUp: number; numBufDown: number };
  lastError?: string;
  timestamp: string;
}

export type McpRequestHandler = (req: McpRequest) => Promise<unknown>;

// Per-request files: `request-<requestId>.json` / `response-<requestId>.json`.
// Using unique filenames lets the MCP host issue concurrent tool calls
// without requests overwriting each other. The status file remains a
// singleton since it's an atomic snapshot.
const REQUEST_GLOB = 'request-*.json';
const STATUS_FILE = 'status.json';
const REQUEST_ID_RE = /^request-(.+)\.json$/u;

/** Maximum number of recently-handled requestIds to remember for dedup. */
const DEDUP_WINDOW = 256;

export class McpBridge {
  private readonly statusUri: vscode.Uri;

  private watcher: vscode.FileSystemWatcher | undefined;
  private handler: McpRequestHandler | undefined;
  private statusDebounce: ReturnType<typeof setTimeout> | undefined;
  private pendingStatus: McpStatus | undefined;
  private enabled = true;
  // Keep insertion-ordered so we can evict the oldest id when we exceed the
  // dedup window. Stores the last N requestIds we've started handling.
  private readonly recentIds = new Set<string>();

  constructor(
    public readonly ipcDir: vscode.Uri,
    private readonly sessionLog: SessionLog
  ) {
    this.statusUri = vscode.Uri.joinPath(ipcDir, STATUS_FILE);
  }

  public async activate(handler: McpRequestHandler): Promise<void> {
    this.handler = handler;
    await vscode.workspace.fs.createDirectory(this.ipcDir);

    const pattern = new vscode.RelativePattern(this.ipcDir, REQUEST_GLOB);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange((uri) => this.consumeRequest(uri));
    this.watcher.onDidCreate((uri) => this.consumeRequest(uri));
    log.info(`MCP bridge active at ${this.ipcDir.fsPath}`);
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.watcher?.dispose();
      this.watcher = undefined;
      return;
    }
    if (!this.watcher && this.handler) {
      // Fire-and-forget is fine here — setEnabled() is synchronous for
      // callers — but we must surface activation failures instead of
      // swallowing them silently (otherwise the bridge appears enabled
      // while no watcher is installed and no MCP requests are processed).
      this.activate(this.handler).catch((err) => {
        log.error(err as Error);
      });
    }
  }

  public dispose(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (this.statusDebounce) {
      clearTimeout(this.statusDebounce);
      this.statusDebounce = undefined;
    }
  }

  /**
   * Debounce status updates so rapid state transitions don't thrash the
   * filesystem. A 500 ms debounce is generous given flash/verify pacing.
   */
  public publishStatus(status: McpStatus): void {
    if (!this.enabled) {
      return;
    }
    this.pendingStatus = status;
    if (this.statusDebounce) {
      clearTimeout(this.statusDebounce);
    }
    this.statusDebounce = setTimeout(() => {
      void this.flushStatus();
    }, 500);
  }

  private async flushStatus(): Promise<void> {
    if (!this.pendingStatus) {
      return;
    }
    const snapshot = this.pendingStatus;
    this.pendingStatus = undefined;
    try {
      const body = new TextEncoder().encode(JSON.stringify(snapshot, null, 2));
      await vscode.workspace.fs.writeFile(this.statusUri, body);
    } catch (err) {
      log.warn(`Failed to write MCP status: ${(err as Error).message}`);
    }
  }

  private async consumeRequest(requestUri: vscode.Uri): Promise<void> {
    if (!this.enabled || !this.handler) {
      return;
    }
    // Derive the request id from the file name so we can dedup on the watcher
    // emitting the same event twice (some file-systems notify for both
    // `create` and `change` for a single write).
    const fileName = requestUri.path.slice(requestUri.path.lastIndexOf('/') + 1);
    const match = REQUEST_ID_RE.exec(fileName);
    if (!match) {
      return;
    }
    const fileId = match[1];
    if (this.recentIds.has(fileId)) {
      return;
    }
    this.rememberId(fileId);

    let raw: Uint8Array;
    try {
      raw = await vscode.workspace.fs.readFile(requestUri);
    } catch {
      return;
    }
    let req: McpRequest;
    try {
      req = JSON.parse(new TextDecoder().decode(raw));
    } catch (err) {
      log.warn(`Malformed MCP request ${fileName}: ${(err as Error).message}`);
      return;
    }

    // The filename id and the JSON body id should always match; prefer the
    // body id for downstream bookkeeping but keep using `fileId` for the
    // response filename so the server reads the file it is waiting on.
    const responseUri = vscode.Uri.joinPath(this.ipcDir, `response-${fileId}.json`);

    const started = Date.now();
    try {
      const result = await this.handler(req);
      const resp: McpResponse = {
        requestId: req.requestId,
        success: true,
        result,
        durationMs: Date.now() - started,
        timestamp: new Date().toISOString()
      };
      await this.writeResponse(responseUri, resp);
      this.sessionLog.record({
        id: req.requestId,
        timestamp: resp.timestamp,
        source: 'mcp',
        command: req.tool,
        args: req.args,
        success: true,
        durationMs: resp.durationMs
      });
    } catch (err) {
      const error = err as Error;
      const resp: McpResponse = {
        requestId: req.requestId,
        success: false,
        error: {
          message: error.message,
          code: (error as { code?: string }).code,
          stack: error.stack
        },
        durationMs: Date.now() - started,
        timestamp: new Date().toISOString()
      };
      await this.writeResponse(responseUri, resp);
      this.sessionLog.record({
        id: req.requestId,
        timestamp: resp.timestamp,
        source: 'mcp',
        command: req.tool,
        args: req.args,
        success: false,
        durationMs: resp.durationMs,
        error: error.message
      });
    } finally {
      // Delete the request file so the watcher doesn't re-trigger on a
      // subsequent restart / rescan.
      try {
        await vscode.workspace.fs.delete(requestUri);
      } catch {
        // Already gone — ignore.
      }
    }
  }

  private rememberId(id: string): void {
    this.recentIds.add(id);
    if (this.recentIds.size > DEDUP_WINDOW) {
      const oldest = this.recentIds.values().next().value;
      if (oldest !== undefined) {
        this.recentIds.delete(oldest);
      }
    }
  }

  /**
   * Atomic write: write to a sibling `.tmp` file then rename over the final
   * path so readers never observe a partial JSON document.
   */
  private async writeResponse(responseUri: vscode.Uri, resp: McpResponse): Promise<void> {
    const body = new TextEncoder().encode(JSON.stringify(resp, null, 2));
    const tmpUri = responseUri.with({ path: responseUri.path + '.tmp' });
    try {
      await vscode.workspace.fs.writeFile(tmpUri, body);
      await vscode.workspace.fs.rename(tmpUri, responseUri, { overwrite: true });
    } catch (err) {
      log.warn(`Failed to write MCP response: ${(err as Error).message}`);
      // Clean up any stray temp file.
      try {
        await vscode.workspace.fs.delete(tmpUri);
      } catch {
        // ignore
      }
    }
  }
}
