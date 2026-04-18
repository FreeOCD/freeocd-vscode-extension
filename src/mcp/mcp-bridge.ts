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

const REQUEST_FILE = 'request.json';
const RESPONSE_FILE = 'response.json';
const STATUS_FILE = 'status.json';

export class McpBridge {
  private readonly requestUri: vscode.Uri;
  private readonly responseUri: vscode.Uri;
  private readonly statusUri: vscode.Uri;

  private watcher: vscode.FileSystemWatcher | undefined;
  private handler: McpRequestHandler | undefined;
  private statusDebounce: ReturnType<typeof setTimeout> | undefined;
  private pendingStatus: McpStatus | undefined;
  private enabled = true;

  constructor(
    public readonly ipcDir: vscode.Uri,
    private readonly sessionLog: SessionLog
  ) {
    this.requestUri = vscode.Uri.joinPath(ipcDir, REQUEST_FILE);
    this.responseUri = vscode.Uri.joinPath(ipcDir, RESPONSE_FILE);
    this.statusUri = vscode.Uri.joinPath(ipcDir, STATUS_FILE);
  }

  public async activate(handler: McpRequestHandler): Promise<void> {
    this.handler = handler;
    await vscode.workspace.fs.createDirectory(this.ipcDir);

    const pattern = new vscode.RelativePattern(this.ipcDir, REQUEST_FILE);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange(() => this.consumeRequest());
    this.watcher.onDidCreate(() => this.consumeRequest());
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
      void this.activate(this.handler);
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

  private async consumeRequest(): Promise<void> {
    if (!this.enabled || !this.handler) {
      return;
    }
    let raw: Uint8Array;
    try {
      raw = await vscode.workspace.fs.readFile(this.requestUri);
    } catch {
      return;
    }
    let req: McpRequest;
    try {
      req = JSON.parse(new TextDecoder().decode(raw));
    } catch (err) {
      log.warn(`Malformed MCP request: ${(err as Error).message}`);
      return;
    }

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
      await this.writeResponse(resp);
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
      await this.writeResponse(resp);
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
    }
  }

  private async writeResponse(resp: McpResponse): Promise<void> {
    const body = new TextEncoder().encode(JSON.stringify(resp, null, 2));
    try {
      await vscode.workspace.fs.writeFile(this.responseUri, body);
    } catch (err) {
      log.warn(`Failed to write MCP response: ${(err as Error).message}`);
    }
  }
}
