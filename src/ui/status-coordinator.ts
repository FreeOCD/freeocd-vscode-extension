/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Aggregates extension-wide state (connection, target, hex selection, RTT,
 * last MCP error) into the `McpBridge` status file and a one-line summary
 * for the MCP status TreeView. Every subsystem that changes user-visible
 * state calls `publish()` after the change.
 */

import type * as vscode from 'vscode';

import type { ConnectionManager } from '../connection/connection-manager';
import type { TargetManager } from '../target/target-manager';
import type { McpBridge } from '../mcp/mcp-bridge';
import type { SessionLog } from '../mcp/session-log';
import type { RttState, TargetDefinition } from '../common/types';

export interface StatusCoordinatorDeps {
  connection: ConnectionManager;
  targets: TargetManager;
  bridge: McpBridge;
  sessionLog: SessionLog;
  hexUri(): vscode.Uri | undefined;
  rttState(): RttState;
  /** Invoked after each publish so dependent views can refresh. */
  onPublished(): void;
}

export class StatusCoordinator {
  private summary = '';

  constructor(private readonly deps: StatusCoordinatorDeps) {}

  /** One-line "probe / target" summary for the MCP status TreeView. */
  public getSummary(): string {
    return this.summary;
  }

  public publish(): void {
    const { connection, targets, bridge, sessionLog } = this.deps;
    const info = connection.getInfo();
    const target = targets.getCurrent();
    const hexUri = this.deps.hexUri();
    bridge.publishStatus({
      connection: {
        state: info.state,
        method: info.method,
        probe: info.probe
          ? {
              vendorId: info.probe.vendorId,
              productId: info.probe.productId,
              serialNumber: info.probe.serialNumber,
              product: info.probe.product
            }
          : undefined
      },
      target: target
        ? { id: target.id, name: target.name, platform: target.platform }
        : undefined,
      hexFile: hexUri?.fsPath,
      flash: { inProgress: false },
      rtt: this.deps.rttState(),
      lastError: sessionLog.lastError()?.error,
      timestamp: new Date().toISOString()
    });
    this.summary = describeSummary(info, target);
    this.deps.onPublished();
  }
}

function describeSummary(
  info: { state: string; probe?: { product?: string } },
  target: TargetDefinition | undefined
): string {
  const probe = info.probe?.product ?? info.state;
  const t = target ? target.name : 'no target';
  return `${probe} / ${t}`;
}
