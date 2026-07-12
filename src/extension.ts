/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Extension entry point. Wires everything together:
 *
 *   - Logger / status bar / language status
 *   - Connection manager + HID backend
 *   - Target manager (built-in + user-defined)
 *   - Flasher + auto-flash watcher
 *   - RTT handler + Pseudoterminal
 *   - MCP bridge + stdio server definition provider (feature-detected)
 *   - Tasks API provider
 *   - TreeViews, viewsWelcome, walkthroughs
 *   - All commands
 */

import * as vscode from 'vscode';

import { log, initLogger } from './common/logger';
import { OperationLock } from './common/operation-lock';
import { StateManager } from './common/state-manager';
import { resolveHexUri } from './common/hex-path';
import type { FlashProgress } from './common/types';

import { HidBackend, initProbeFilters } from './transport/hid-transport';
import { registerTransport } from './transport/transport-registry';
import { ConnectionManager } from './connection/connection-manager';
import { TargetManager } from './target/target-manager';
import { Flasher } from './flasher/flasher';
import { AutoFlashWatcher } from './flasher/auto-flash-watcher';
import { RttSession } from './rtt/rtt-session';

import { SessionLog } from './mcp/session-log';
import { McpBridge } from './mcp/mcp-bridge';
import { dispatchMcpTool, type McpToolContext } from './mcp/tool-handlers';
import { registerMcpProvider } from './mcp/mcp-provider';

import { StatusManager } from './ui/status';
import { StatusCoordinator } from './ui/status-coordinator';
import { registerCommands } from './commands/register-commands';
import {
  ConnectionTreeProvider,
  TargetTreeProvider,
  FlasherTreeProvider,
  DebuggerTreeProvider,
  McpStatusTreeProvider
} from './ui/tree-providers';
import { HexFileDecorationProvider } from './ui/file-decoration-provider';

import { FreeocdTaskProvider } from './tasks/task-provider';

const WALKTHROUGH_ID = 'FreeOCD.freeocd-extension#freeocd.getStarted';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger();
  log.info(`FreeOCD extension activating (v${context.extension.packageJSON.version}).`);

  // --------------------------------------------------------------------------
  // Initialize probe filters
  // --------------------------------------------------------------------------
  initProbeFilters(context.extensionUri.fsPath);

  // --------------------------------------------------------------------------
  // Transport + connection
  // --------------------------------------------------------------------------
  // Lazy-require node-hid so the extension still activates in environments
  // where the native binding is missing (we surface a clear error on connect).
  let nodeHid: typeof import('node-hid') | undefined;
  try {
    nodeHid = require('node-hid') as typeof import('node-hid');
  } catch (err) {
    log.warn(`node-hid native binding failed to load: ${(err as Error).message}`);
  }
  const backend = nodeHid ? new HidBackend(nodeHid) : undefined;
  if (backend) {
    registerTransport(backend);
  }
  const connection = new ConnectionManager(backend);

  // --------------------------------------------------------------------------
  // Target manager
  // --------------------------------------------------------------------------
  if (!context.storageUri) {
    // Happens only when no workspace is open. MCP IPC requires a storage URI,
    // so we ask the user to open a folder first.
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        'FreeOCD requires an open folder/workspace. Please open one to use Flash / RTT / MCP features.'
      )
    );
    return;
  }
  const targets = new TargetManager(context.extensionUri, context.storageUri);
  await targets.reload();
  const savedId = vscode.workspace.getConfiguration('freeocd').get<string>('target.mcu');
  if (savedId && targets.get(savedId)) {
    targets.select(savedId);
  }

  // --------------------------------------------------------------------------
  // Shared exclusive-operation lock + StateManager
  //
  // These two objects coordinate across every probe user (Flasher, RTT,
  // MCP tools). Without them, two DAP transfers from different call sites
  // can race on the single CMSIS-DAP v1 HID transport and wedge node-hid.
  // See `src/common/operation-lock.ts` and `src/common/state-manager.ts`
  // for the full rationale; this mirrors the `freeocd-web` design.
  // --------------------------------------------------------------------------
  const operationLock = new OperationLock();
  const stateManager = new StateManager();

  // --------------------------------------------------------------------------
  // RTT
  // --------------------------------------------------------------------------
  const rttSession = new RttSession({
    connection,
    targets,
    operationLock,
    stateManager,
    onSessionChanged: () => {
      debuggerTree.refresh();
      publishStatus();
    }
  });

  stateManager.setCallbacks({
    onConnectionLost: async (err) => {
      log.warn(`StateManager detected connection loss: ${err.message}`);
      vscode.window.showWarningMessage(
        vscode.l10n.t('RTT disconnected: {0}', err.message)
      );
      await rttSession.teardown('connection lost');
    }
  });

  // --------------------------------------------------------------------------
  // Flasher + auto-flash
  //
  // The flasher is wired with the shared `OperationLock` plus before/after
  // hooks that (a) disconnect RTT so the operation owns the DAP transport
  // and (b) pause the StateManager poll loop so its health-check transfers
  // don't race with the flash.
  // --------------------------------------------------------------------------
  let rttWasConnectedBeforeOperation = false;

  const flasher = new Flasher({
    getDap: () => connection.getDap().adi,
    getHandler: () => targets.createHandler(),
    lock: operationLock,
    onBeforeOperation: async (op) => {
      // StateManager must stop polling before we take over the transport;
      // the external-operation flag handles the "poll tick is already
      // mid-await" race (the tick will observe the flag on its next
      // iteration and skip).
      stateManager.setExternalOperationInProgress(true);
      stateManager.stopPolling();
      rttWasConnectedBeforeOperation = rttSession.isConnected();
      if (rttWasConnectedBeforeOperation) {
        log.info(`${op}: RTT is connected, disconnecting for the operation...`);
        await rttSession.teardown(`preparing for ${op}`);
      }
    },
    onAfterOperation: async () => {
      stateManager.setExternalOperationInProgress(false);
      if (rttWasConnectedBeforeOperation) {
        // We deliberately do not auto-reconnect RTT — this matches the
        // freeocd-web UX where the user must re-click "Connect RTT" after
        // a flash. Auto-reconnect would be surprising (the target may have
        // just been mass-erased and the RTT control block is gone).
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            'RTT was disconnected for the operation. Reconnect it manually when you are ready.'
          )
        );
        rttWasConnectedBeforeOperation = false;
      }
    }
  });
  const autoFlash = new AutoFlashWatcher(flasher);

  const hexUriFromConfig = (): vscode.Uri | undefined => {
    const raw = vscode.workspace.getConfiguration('freeocd').get<string>('hexFile');
    return raw ? resolveHexUri(raw) : undefined;
  };

  // --------------------------------------------------------------------------
  // Session log + MCP
  // --------------------------------------------------------------------------
  const sessionLog = new SessionLog(
    vscode.workspace.getConfiguration('freeocd').get<number>('mcp.sessionLogSize', 200)
  );
  const ipcDir = vscode.Uri.joinPath(context.storageUri, 'mcp-ipc');
  const bridge = new McpBridge(ipcDir, sessionLog);
  const flashProgress = new Map<string, FlashProgress>();
  // Cap the map size so long-running sessions don't grow it unbounded; we
  // also actively evict terminal ('done' / 'error') entries after a short
  // grace period so `get_flash_progress` can still observe the last known
  // status for a brief window before the entry disappears.
  const FLASH_PROGRESS_MAX = 256;
  const FLASH_PROGRESS_TTL_MS = 60_000;
  flasher.onDidReportProgress((p) => {
    flashProgress.set(p.requestId, p);
    if (flashProgress.size > FLASH_PROGRESS_MAX) {
      const oldestKey = flashProgress.keys().next().value;
      if (oldestKey !== undefined) {
        flashProgress.delete(oldestKey);
      }
    }
    if (p.phase === 'done' || p.phase === 'error') {
      const id = p.requestId;
      setTimeout(() => {
        flashProgress.delete(id);
      }, FLASH_PROGRESS_TTL_MS).unref?.();
    }
  });

  const mcpContext: McpToolContext = {
    connection,
    targets,
    flasher,
    sessionLog,
    getRtt: () => rttSession.getHandler(),
    setRtt: (h) => {
      rttSession.setHandler(h);
    },
    connectRtt: (opts) => rttSession.connect(opts),
    disconnectRtt: () => rttSession.teardown('MCP rtt_disconnect'),
    autoFlash,
    flashProgress
  };

  await bridge.activate((req) => dispatchMcpTool(req, mcpContext));

  const mcpEnabled = vscode.workspace.getConfiguration('freeocd').get<boolean>('mcp.enabled', true);
  bridge.setEnabled(mcpEnabled);

  // EventEmitter bridged into `McpServerDefinitionProvider.onDidChangeMcpServerDefinitions`
  // so a user toggling `freeocd.mcp.enabled` forces VSCode to re-query
  // the provider instead of requiring a window reload.
  const mcpProviderChangeEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(mcpProviderChangeEmitter);

  const mcpProvider = registerMcpProvider({
    serverJs: vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp-server.js').fsPath,
    extensionDir: context.extensionUri.fsPath,
    ipcDir: ipcDir.fsPath,
    version: context.extension.packageJSON.version as string | undefined,
    onDidChange: mcpProviderChangeEmitter.event
  });
  if (mcpProvider) {
    context.subscriptions.push(mcpProvider);
  }

  // --------------------------------------------------------------------------
  // UI: status, TreeViews, file decorations
  // --------------------------------------------------------------------------
  const status = new StatusManager();
  status.setConnection(connection.getInfo());
  status.setTarget(targets.getCurrent()?.name);
  connection.on('stateChanged', (info) => {
    status.setConnection(info);
    connectionTree.refresh();
    publishStatus();
  });
  targets.onDidChangeTarget((t) => {
    status.setTarget(t?.name);
    targetTree.refresh();
    publishStatus();
  });

  const hexDecoration = new HexFileDecorationProvider();
  hexDecoration.setSelected(hexUriFromConfig());
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(hexDecoration)
  );

  const connectionTree = new ConnectionTreeProvider({ info: () => connection.getInfo() });
  const targetTree = new TargetTreeProvider({ current: () => targets.getCurrent() });
  const flasherTree = new FlasherTreeProvider({
    hexUri: hexUriFromConfig,
    verifyAfterFlash: () =>
      vscode.workspace.getConfiguration('freeocd').get<boolean>('flash.verifyAfterFlash', true),
    autoFlash: () =>
      vscode.workspace.getConfiguration('freeocd').get<boolean>('autoFlash.enabled', false),
    setVerifyAfterFlash: async (v) =>
      vscode.workspace.getConfiguration('freeocd').update('flash.verifyAfterFlash', v, true),
    setAutoFlash: async (v) => {
      await vscode.workspace.getConfiguration('freeocd').update('autoFlash.enabled', v, true);
      await autoFlash.update(v ? hexUriFromConfig() : undefined);
    }
  });
  const debuggerTree = new DebuggerTreeProvider({
    state: () => rttSession.getState()
  });
  const mcpStatusTree = new McpStatusTreeProvider({
    lastSummary: () => statusCoordinator.getSummary()
  });

  const statusCoordinator = new StatusCoordinator({
    connection,
    targets,
    bridge,
    sessionLog,
    hexUri: hexUriFromConfig,
    rttState: () => rttSession.getState(),
    onPublished: () => mcpStatusTree.refresh()
  });

  function publishStatus(): void {
    statusCoordinator.publish();
  }

  const connectionView = vscode.window.createTreeView('freeocd-connection', {
    treeDataProvider: connectionTree
  });
  const targetView = vscode.window.createTreeView('freeocd-target', { treeDataProvider: targetTree });
  const flasherView = vscode.window.createTreeView('freeocd-flasher', {
    treeDataProvider: flasherTree,
    manageCheckboxStateManually: true
  });
  flasherView.onDidChangeCheckboxState((e) => flasherTree.handleCheckboxChange(e.items));
  const debuggerView = vscode.window.createTreeView('freeocd-debugger', {
    treeDataProvider: debuggerTree
  });
  const mcpView = vscode.window.createTreeView('freeocd-mcp-status', {
    treeDataProvider: mcpStatusTree
  });

  context.subscriptions.push(connectionView, targetView, flasherView, debuggerView, mcpView);

  // --------------------------------------------------------------------------
  // Tasks provider
  // --------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(
      FreeocdTaskProvider.taskType,
      new FreeocdTaskProvider(flasher, targets)
    )
  );

  // --------------------------------------------------------------------------
  // Commands
  // --------------------------------------------------------------------------
  registerCommands(context, {
    hasHidBackend: backend !== undefined,
    connection,
    targets,
    flasher,
    autoFlash,
    rttSession,
    hexDecoration,
    hexUriFromConfig,
    refreshConnectionTree: () => connectionTree.refresh(),
    refreshFlasherTree: () => flasherTree.refresh(),
    publishStatus,
    mcpPaths: {
      serverJs: vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp-server.js').fsPath,
      extensionDir: context.extensionUri.fsPath,
      ipcDir: ipcDir.fsPath
    }
  });

  // --------------------------------------------------------------------------
  // Walkthrough on first activation
  // --------------------------------------------------------------------------
  await maybeShowWalkthrough(context);

  // --------------------------------------------------------------------------
  // React to settings changes
  // --------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('freeocd.mcp.enabled')) {
        bridge.setEnabled(
          vscode.workspace.getConfiguration('freeocd').get<boolean>('mcp.enabled', true)
        );
        // Also nudge VSCode's MCP layer so it re-queries the provider and
        // picks up the new enabled state without a window reload.
        mcpProviderChangeEmitter.fire();
      }
      if (e.affectsConfiguration('freeocd.mcp.sessionLogSize')) {
        sessionLog.setCapacity(
          vscode.workspace.getConfiguration('freeocd').get<number>('mcp.sessionLogSize', 200)
        );
      }
      if (e.affectsConfiguration('freeocd.hexFile')) {
        hexDecoration.setSelected(hexUriFromConfig());
        flasherTree.refresh();
      }
      if (
        e.affectsConfiguration('freeocd.autoFlash.enabled') ||
        e.affectsConfiguration('freeocd.hexFile')
      ) {
        const enabled = vscode.workspace
          .getConfiguration('freeocd')
          .get<boolean>('autoFlash.enabled', false);
        void autoFlash.update(enabled ? hexUriFromConfig() : undefined);
      }
    })
  );

  context.subscriptions.push(
    { dispose: () => targets.dispose() },
    { dispose: () => flasher.dispose() },
    { dispose: () => autoFlash.dispose() },
    { dispose: () => status.dispose() },
    { dispose: () => connectionTree.dispose() },
    { dispose: () => targetTree.dispose() },
    { dispose: () => flasherTree.dispose() },
    { dispose: () => debuggerTree.dispose() },
    { dispose: () => mcpStatusTree.dispose() },
    { dispose: () => hexDecoration.dispose() },
    { dispose: () => bridge.dispose() },
    { dispose: () => rttSession.dispose() },
    { dispose: () => stateManager.dispose() },
    { dispose: () => operationLock.dispose() }
  );

  // Tear RTT down automatically when the probe is disconnected — otherwise
  // the StateManager poll loop keeps hitting a dead DAP proxy and spams
  // warnings. This fires for both user-initiated disconnects
  // (`freeocd.disconnectProbe`) and error-induced transitions.
  connection.on('stateChanged', (info) => {
    if (info.state !== 'connected' && rttSession.isConnected()) {
      void rttSession.teardown(`probe state -> ${info.state}`);
    }
  });

  publishStatus();
  log.info('FreeOCD extension activation complete.');
}

async function maybeShowWalkthrough(context: vscode.ExtensionContext): Promise<void> {
  const show = vscode.workspace
    .getConfiguration('freeocd')
    .get<boolean>('showWalkthroughOnFirstActivation', true);
  const key = 'freeocd.walkthroughShown';
  if (!show || context.globalState.get<boolean>(key)) {
    return;
  }
  await context.globalState.update(key, true);
  try {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
  } catch (err) {
    log.warn(`Could not open walkthrough: ${(err as Error).message}`);
  }
}


export function deactivate(): void {
  log.info('FreeOCD extension deactivating.');
}
