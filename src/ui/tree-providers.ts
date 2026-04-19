/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Sidebar `TreeView` data providers:
 *   - Connection: current probe / transport method.
 *   - Target: current target id + platform / CPU / flash region.
 *   - Flasher: selected .hex, verify checkbox, auto-flash checkbox.
 *   - Debugger (RTT): connection state + control block address.
 *   - MCP Status: last request / response summary.
 *
 * We use `TreeItemCheckboxState` (VSCode 1.72+) to toggle "Verify after flash"
 * and "Auto-flash on save" directly inside the TreeView.
 */

import * as vscode from 'vscode';
import type { ConnectionInfo, RttState, TargetDefinition } from '../common/types';

type UpdateFn = () => void;

interface ConnectionDeps {
  info: () => ConnectionInfo;
}
interface TargetDeps {
  current: () => TargetDefinition | undefined;
}
interface FlasherDeps {
  hexUri: () => vscode.Uri | undefined;
  verifyAfterFlash: () => boolean;
  autoFlash: () => boolean;
  setVerifyAfterFlash: (v: boolean) => Promise<void>;
  setAutoFlash: (v: boolean) => Promise<void>;
}
interface RttDeps {
  state: () => RttState;
}
interface McpStatusDeps {
  lastSummary: () => string;
}

function createEmitter(): {
  emitter: vscode.EventEmitter<void>;
  onChange: vscode.Event<void>;
  update: UpdateFn;
} {
  const emitter = new vscode.EventEmitter<void>();
  return {
    emitter,
    onChange: emitter.event,
    update: () => emitter.fire()
  };
}

// ============================================================================
// Connection
// ============================================================================

export class ConnectionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: ConnectionDeps) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
    return e;
  }

  public getChildren(): vscode.TreeItem[] {
    const info = this.deps.info();
    if (info.state !== 'connected' || !info.probe) {
      return [];
    }
    const items: vscode.TreeItem[] = [];
    items.push(
      labeled(vscode.l10n.t('Product'), info.probe.product ?? vscode.l10n.t('(unknown)'))
    );
    items.push(labeled(vscode.l10n.t('Vendor'), `0x${info.probe.vendorId.toString(16)}`));
    items.push(
      labeled(vscode.l10n.t('Product ID'), `0x${info.probe.productId.toString(16)}`)
    );
    if (info.probe.serialNumber) {
      items.push(labeled(vscode.l10n.t('Serial'), info.probe.serialNumber));
    }
    items.push(labeled(vscode.l10n.t('Transport'), info.method));
    return items;
  }

  public dispose(): void {
    this.emitter.dispose();
  }
}

// ============================================================================
// Target
// ============================================================================

type TargetItemKind = 'info' | 'change';

class TargetItem extends vscode.TreeItem {
  constructor(
    public readonly kind: TargetItemKind,
    label: string,
    description?: string,
    command?: vscode.Command
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (description) {
      this.description = description;
    }
    if (command) {
      this.command = command;
    }
    this.contextValue = kind;
  }
}

export class TargetTreeProvider implements vscode.TreeDataProvider<TargetItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: TargetDeps) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(e: TargetItem): vscode.TreeItem {
    return e;
  }

  public getChildren(): TargetItem[] {
    const target = this.deps.current();
    if (!target) {
      return [
        new TargetItem(
          'change',
          // Reuse the existing "Select a target MCU" key so this label is
          // translated consistently with the QuickPick placeholder.
          vscode.l10n.t('Select a target MCU'),
          undefined,
          { command: 'freeocd.selectTargetMcu', title: '' }
        )
      ];
    }
    const unknown = vscode.l10n.t('(unknown)');
    return [
      new TargetItem('info', vscode.l10n.t('Id'), target.id),
      new TargetItem('info', vscode.l10n.t('Platform'), target.platform),
      new TargetItem('info', vscode.l10n.t('CPU'), target.cpu),
      new TargetItem('info', vscode.l10n.t('Flash address'), target.flash.address),
      new TargetItem('info', vscode.l10n.t('Flash size'), target.flash.size ?? unknown),
      new TargetItem('info', vscode.l10n.t('SRAM address'), target.sram.address),
      new TargetItem('info', vscode.l10n.t('Capabilities'), target.capabilities.join(', ')),
      new TargetItem(
        'change',
        vscode.l10n.t('Change Target'),
        target.name,
        { command: 'freeocd.selectTargetMcu', title: '' }
      )
    ];
  }

  public dispose(): void {
    this.emitter.dispose();
  }
}

// ============================================================================
// Flasher — with checkboxes for verify / auto-flash.
// ============================================================================

type FlasherItemKind = 'hex' | 'verify' | 'auto';

class FlasherItem extends vscode.TreeItem {
  constructor(
    public readonly kind: FlasherItemKind,
    label: string,
    state: vscode.TreeItemCheckboxState | undefined,
    description?: string,
    command?: vscode.Command
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (state !== undefined) {
      this.checkboxState = state;
    }
    if (description) {
      this.description = description;
    }
    if (command) {
      this.command = command;
    }
    this.contextValue = kind;
  }
}

export class FlasherTreeProvider implements vscode.TreeDataProvider<FlasherItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: FlasherDeps) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(e: FlasherItem): vscode.TreeItem {
    return e;
  }

  public getChildren(): FlasherItem[] {
    const hex = this.deps.hexUri();
    const items: FlasherItem[] = [
      new FlasherItem(
        'hex',
        vscode.l10n.t('HEX File'),
        undefined,
        hex ? vscode.workspace.asRelativePath(hex) : vscode.l10n.t('Not selected'),
        { command: 'freeocd.selectHexFile', title: vscode.l10n.t('Select a .hex file') }
      ),
      new FlasherItem(
        'verify',
        vscode.l10n.t('Verify after flash'),
        this.deps.verifyAfterFlash()
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked
      ),
      new FlasherItem(
        'auto',
        vscode.l10n.t('Auto-flash on save'),
        this.deps.autoFlash()
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked
      )
    ];
    return items;
  }

  public async handleCheckboxChange(
    changes: ReadonlyArray<readonly [FlasherItem, vscode.TreeItemCheckboxState]>
  ): Promise<void> {
    for (const [item, state] of changes) {
      const checked = state === vscode.TreeItemCheckboxState.Checked;
      if (item.kind === 'verify') {
        await this.deps.setVerifyAfterFlash(checked);
      } else if (item.kind === 'auto') {
        await this.deps.setAutoFlash(checked);
      }
    }
    this.refresh();
  }

  public dispose(): void {
    this.emitter.dispose();
  }
}

// ============================================================================
// Debugger (RTT)
// ============================================================================

export class DebuggerTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: RttDeps) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
    return e;
  }

  public getChildren(): vscode.TreeItem[] {
    const state = this.deps.state();
    if (!state.connected) {
      return [];
    }
    return [
      labeled(vscode.l10n.t('State'), vscode.l10n.t('connected')),
      labeled(vscode.l10n.t('Up buffers'), String(state.numBufUp)),
      labeled(vscode.l10n.t('Down buffers'), String(state.numBufDown)),
      labeled(
        vscode.l10n.t('Control block'),
        state.controlBlockAddress !== undefined
          ? `0x${state.controlBlockAddress.toString(16)}`
          : '?'
      )
    ];
  }

  public dispose(): void {
    this.emitter.dispose();
  }
}

// ============================================================================
// MCP Status
// ============================================================================

export class McpStatusTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: McpStatusDeps) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
    return e;
  }

  public getChildren(): vscode.TreeItem[] {
    const summary = this.deps.lastSummary();
    if (!summary) {
      return [];
    }
    return [labeled(vscode.l10n.t('Last'), summary)];
  }

  public dispose(): void {
    this.emitter.dispose();
  }
}

// ============================================================================
// Helpers
// ============================================================================

function labeled(label: string, description: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = description;
  return item;
}

export { createEmitter };
