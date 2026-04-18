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
import { formatError } from './common/logger';
import { FreeOcdError, NotConnectedError, NoTargetError } from './common/errors';
import { loadDapjs } from './common/dapjs-loader';
import type { FlashProgress, TargetDefinition } from './common/types';

import { HidBackend, initProbeFilters } from './transport/hid-transport';
import { registerTransport } from './transport/transport-registry';
import { ConnectionManager } from './connection/connection-manager';
import { TargetManager } from './target/target-manager';
import { Flasher } from './flasher/flasher';
import { AutoFlashWatcher } from './flasher/auto-flash-watcher';
import type { RttHandler } from './rtt/rtt-handler';
import { RttTerminal } from './rtt/rtt-terminal';

import { SessionLog } from './mcp/session-log';
import { McpBridge } from './mcp/mcp-bridge';
import { dispatchMcpTool, type McpToolContext } from './mcp/tool-handlers';
import { registerMcpProvider, buildMcpConfigPayload } from './mcp/mcp-provider';

import { StatusManager } from './ui/status';
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
  // Flasher + auto-flash
  // --------------------------------------------------------------------------
  const flasher = new Flasher({
    getDap: () => connection.getDap().adi,
    getHandler: () => targets.createHandler()
  });
  const autoFlash = new AutoFlashWatcher(flasher);

  const hexUriFromConfig = (): vscode.Uri | undefined => {
    const raw = vscode.workspace.getConfiguration('freeocd').get<string>('hexFile');
    if (!raw) {
      return undefined;
    }
    if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/u.test(raw)) {
      return vscode.Uri.file(raw);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, raw) : undefined;
  };

  // --------------------------------------------------------------------------
  // RTT
  // --------------------------------------------------------------------------
  let rttHandler: RttHandler | undefined;
  let rttTerminal: RttTerminal | undefined;

  // --------------------------------------------------------------------------
  // Session log + MCP
  // --------------------------------------------------------------------------
  const sessionLog = new SessionLog(
    vscode.workspace.getConfiguration('freeocd').get<number>('mcp.sessionLogSize', 200)
  );
  const ipcDir = vscode.Uri.joinPath(context.storageUri, 'mcp-ipc');
  const bridge = new McpBridge(ipcDir, sessionLog);
  const flashProgress = new Map<string, FlashProgress>();
  flasher.onDidReportProgress((p) => flashProgress.set(p.requestId, p));

  const mcpContext: McpToolContext = {
    connection,
    targets,
    flasher,
    sessionLog,
    getRtt: () => rttHandler,
    setRtt: (h) => {
      rttHandler = h;
    },
    autoFlash,
    flashProgress
  };

  await bridge.activate((req) => dispatchMcpTool(req, mcpContext));

  const mcpEnabled = vscode.workspace.getConfiguration('freeocd').get<boolean>('mcp.enabled', true);
  bridge.setEnabled(mcpEnabled);

  const mcpProvider = registerMcpProvider({
    serverJs: vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp-server.js').fsPath,
    extensionDir: context.extensionUri.fsPath,
    ipcDir: ipcDir.fsPath
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
    state: () =>
      rttHandler?.getState() ?? { connected: false, numBufUp: 0, numBufDown: 0 }
  });
  let mcpSummary = '';
  const mcpStatusTree = new McpStatusTreeProvider({ lastSummary: () => mcpSummary });

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
    vscode.tasks.registerTaskProvider(FreeocdTaskProvider.taskType, new FreeocdTaskProvider(flasher))
  );

  // --------------------------------------------------------------------------
  // Commands
  // --------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('freeocd.connectProbe', async () => {
      if (!backend) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'node-hid native binding is unavailable. Re-install the extension or check your platform-specific VSIX.'
          )
        );
        return;
      }
      try {
        const probes = await connection.listProbes();
        if (probes.length === 0) {
          vscode.window.showWarningMessage(vscode.l10n.t('No CMSIS-DAP probes detected.'));
          return;
        }
        const picks = probes.map((p) => ({
          label: p.product ?? `VID:0x${p.vendorId.toString(16)}`,
          description: p.serialNumber ?? p.path,
          probe: p
        }));
        const picked = await vscode.window.showQuickPick(picks, {
          placeHolder: vscode.l10n.t('Select a CMSIS-DAP probe')
        });
        if (!picked) {
          return;
        }
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Connecting to probe...')
          },
          async () => connection.connect(picked.probe)
        );
      } catch (err) {
        handleError(err);
      }
    }),

    vscode.commands.registerCommand('freeocd.disconnectProbe', async () => {
      try {
        await connection.disconnect();
        vscode.window.showInformationMessage(vscode.l10n.t('Disconnected from probe'));
      } catch (err) {
        handleError(err);
      }
    }),

    vscode.commands.registerCommand('freeocd.refreshProbes', async () => {
      connectionTree.refresh();
    }),

    vscode.commands.registerCommand('freeocd.selectTargetMcu', async () => {
      try {
        const all = targets.list();
        if (all.length === 0) {
          await targets.reload();
        }
        const picks = targets.list().map((t) => ({
          label: t.name,
          description: t.id,
          detail: `${t.platform} · ${t.cpu}`,
          target: t
        }));
        const picked = await vscode.window.showQuickPick(picks, {
          placeHolder: vscode.l10n.t('Select a target MCU')
        });
        if (!picked) {
          return;
        }
        targets.select(picked.target.id);
        await vscode.workspace
          .getConfiguration('freeocd')
          .update('target.mcu', picked.target.id, true);
      } catch (err) {
        handleError(err);
      }
    }),

    vscode.commands.registerCommand('freeocd.importTargetDefinition', async () => {
      try {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { JSON: ['json'] },
          openLabel: vscode.l10n.t('Import Target Definition')
        });
        if (!picked || picked.length === 0) {
          return;
        }
        const def = await targets.import(picked[0]);
        vscode.window.showInformationMessage(
          vscode.l10n.t('Imported target: {0}', def.id)
        );
      } catch (err) {
        handleError(err);
      }
    }),

    vscode.commands.registerCommand(
      'freeocd.selectHexFile',
      async (resource?: vscode.Uri) => {
        try {
          let uri = resource;
          if (!uri) {
            const picked = await vscode.window.showOpenDialog({
              canSelectMany: false,
              filters: { [vscode.l10n.t('Intel HEX files')]: ['hex'] },
              openLabel: vscode.l10n.t('Select a .hex file')
            });
            uri = picked?.[0];
          }
          if (!uri) {
            return;
          }
          await vscode.workspace
            .getConfiguration('freeocd')
            .update('hexFile', vscode.workspace.asRelativePath(uri, false), true);
          hexDecoration.setSelected(uri);
          flasherTree.refresh();
          if (
            vscode.workspace.getConfiguration('freeocd').get<boolean>('autoFlash.enabled', false)
          ) {
            await autoFlash.update(uri);
          }
          publishStatus();
        } catch (err) {
          handleError(err);
        }
      }
    ),

    vscode.commands.registerCommand('freeocd.flash', async () => {
      try {
        const uri = hexUriFromConfig();
        if (!uri) {
          vscode.window.showWarningMessage(vscode.l10n.t('Select a .hex file first.'));
          return;
        }
        const verify = vscode.workspace
          .getConfiguration('freeocd')
          .get<boolean>('flash.verifyAfterFlash', true);
        await flasher.flash(uri, { verifyAfterFlash: verify });
      } catch (err) {
        handleError(err);
      }
    }),

    vscode.commands.registerCommand('freeocd.verify', async () => {
      try {
        const uri = hexUriFromConfig();
        if (!uri) {
          vscode.window.showWarningMessage(vscode.l10n.t('Select a .hex file first.'));
          return;
        }
        await flasher.verify(uri);
      } catch (err) {
        handleError(err);
      }
    }),

    vscode.commands.registerCommand('freeocd.recover', async () => {
      try {
        await flasher.recover();
      } catch (err) {
        handleError(err);
      }
    }),

    vscode.commands.registerCommand('freeocd.softReset', async () => {
      try {
        await flasher.softReset();
      } catch (err) {
        handleError(err);
      }
    }),

    vscode.commands.registerCommand('freeocd.toggleAutoFlash', async () => {
      const config = vscode.workspace.getConfiguration('freeocd');
      const current = config.get<boolean>('autoFlash.enabled', false);
      await config.update('autoFlash.enabled', !current, true);
      const uri = hexUriFromConfig();
      if (!current && uri) {
        await autoFlash.update(uri);
        vscode.window.showInformationMessage(
          vscode.l10n.t('Auto-flash enabled for {0}', vscode.workspace.asRelativePath(uri))
        );
      } else {
        await autoFlash.update(undefined);
        vscode.window.showInformationMessage(vscode.l10n.t('Auto-flash disabled.'));
      }
      flasherTree.refresh();
    }),

    vscode.commands.registerCommand('freeocd.connectRtt', async () => {
      try {
        if (!connection.isConnected()) {
          throw new NotConnectedError();
        }
        const target = targets.getCurrent();
        if (!target) {
          throw new NoTargetError();
        }
        const config = vscode.workspace.getConfiguration('freeocd');
        const { RttHandler } = await import('./rtt/rtt-handler');
        const dapjs = loadDapjs();
        const processor = new dapjs.CortexM(connection.getDap().proxy);
        const handler = new RttHandler(processor as never, {
          scanStartAddress: parseInt(config.get<string>('rtt.scanStart', '0x20000000'), 16),
          scanRange: parseInt(config.get<string>('rtt.scanRange', '0x10000'), 16)
        });
        const count = await handler.init();
        if (count < 0) {
          vscode.window.showWarningMessage(
            vscode.l10n.t('RTT control block not found in scan range.')
          );
          return;
        }
        rttHandler = handler;
        const state = handler.getState();
        vscode.window.showInformationMessage(
          vscode.l10n.t('RTT connected ({0} up, {1} down buffers).', state.numBufUp, state.numBufDown)
        );
        debuggerTree.refresh();
        publishStatus();

        if (config.get<boolean>('rtt.autoOpenTerminal', true)) {
          await vscode.commands.executeCommand('freeocd.openRttTerminal');
        }
      } catch (err) {
        handleError(err);
      }
    }),

    vscode.commands.registerCommand('freeocd.disconnectRtt', async () => {
      rttHandler?.reset();
      rttHandler = undefined;
      rttTerminal?.dispose();
      rttTerminal = undefined;
      debuggerTree.refresh();
      publishStatus();
      vscode.window.showInformationMessage(vscode.l10n.t('RTT disconnected.'));
    }),

    vscode.commands.registerCommand('freeocd.openRttTerminal', async () => {
      try {
        if (!rttHandler) {
          await vscode.commands.executeCommand('freeocd.connectRtt');
        }
        if (!rttHandler) {
          return;
        }
        const interval = vscode.workspace
          .getConfiguration('freeocd')
          .get<number>('rtt.pollingInterval', 100);
        rttTerminal?.dispose();
        rttTerminal = new RttTerminal(rttHandler, interval);
        rttTerminal.show();
      } catch (err) {
        handleError(err);
      }
    }),

    vscode.commands.registerCommand('freeocd.setupMcp', async () => {
      const payload = buildMcpConfigPayload({
        serverJs: vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp-server.js').fsPath,
        extensionDir: context.extensionUri.fsPath,
        ipcDir: ipcDir.fsPath
      });
      const text = JSON.stringify(
        {
          'Windsurf (~/.codeium/windsurf/mcp_config.json)': payload.windsurf,
          'Cursor (~/.cursor/mcp.json)': payload.cursor,
          'Cline (~/.cline/cline_mcp_settings.json)': payload.cline
        },
        null,
        2
      );
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'MCP configuration copied to clipboard. Paste it into your IDE\'s MCP settings.'
        )
      );
    }),

    vscode.commands.registerCommand('freeocd.openStorageFolder', async () => {
      if (!context.storageUri) {
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', context.storageUri);
    }),

    vscode.commands.registerCommand('freeocd.showLog', async () => {
      vscode.commands.executeCommand('workbench.action.output.toggleOutput');
      log.info('FreeOCD log opened via command.');
    })
  );

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
    { dispose: () => rttTerminal?.dispose() }
  );

  publishStatus();
  log.info('FreeOCD extension activation complete.');

  // --------------------------------------------------------------------------
  // Helpers (closures)
  // --------------------------------------------------------------------------
  function handleError(err: unknown): void {
    if (err instanceof FreeOcdError) {
      vscode.window.showErrorMessage(err.message);
    } else {
      vscode.window.showErrorMessage(formatError(err).split('\n')[0]);
    }
    log.error(err as Error);
  }

  function publishStatus(): void {
    const info = connection.getInfo();
    const target = targets.getCurrent();
    const hexUri = hexUriFromConfig();
    const rtt = rttHandler?.getState() ?? { connected: false, numBufUp: 0, numBufDown: 0 };
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
      rtt,
      lastError: sessionLog.lastError()?.error,
      timestamp: new Date().toISOString()
    });
    mcpSummary = describeSummary(info, target);
    mcpStatusTree.refresh();
  }
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

function describeSummary(
  info: { state: string; probe?: { product?: string } },
  target: TargetDefinition | undefined
): string {
  const probe = info.probe?.product ?? info.state;
  const t = target ? target.name : 'no target';
  return `${probe} / ${t}`;
}

export function deactivate(): void {
  log.info('FreeOCD extension deactivating.');
}
