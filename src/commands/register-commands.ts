/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Registers every `freeocd.*` command. The extension entry point stays a
 * pure composition root; all command bodies (probe pick, target pick, hex
 * pick, flash / verify / recover / reset, RTT connect / terminal, MCP
 * setup) live here and receive their collaborators via `CommandDeps`.
 */

import * as vscode from 'vscode';

import { log, formatError } from '../common/logger';
import { FreeOcdError } from '../common/errors';
import type { ConnectionManager } from '../connection/connection-manager';
import type { TargetManager } from '../target/target-manager';
import type { Flasher } from '../flasher/flasher';
import type { AutoFlashWatcher } from '../flasher/auto-flash-watcher';
import type { RttSession } from '../rtt/rtt-session';
import { buildMcpConfigPayload } from '../mcp/mcp-provider';
import type { HexFileDecorationProvider } from '../ui/file-decoration-provider';

export interface CommandDeps {
  /** Undefined when the node-hid native binding failed to load. */
  hasHidBackend: boolean;
  connection: ConnectionManager;
  targets: TargetManager;
  flasher: Flasher;
  autoFlash: AutoFlashWatcher;
  rttSession: RttSession;
  hexDecoration: HexFileDecorationProvider;
  hexUriFromConfig(): vscode.Uri | undefined;
  refreshConnectionTree(): void;
  refreshFlasherTree(): void;
  publishStatus(): void;
  /** Paths needed by `freeocd.setupMcp`. */
  mcpPaths: { serverJs: string; extensionDir: string; ipcDir: string };
}

export function registerCommands(
  context: vscode.ExtensionContext,
  deps: CommandDeps
): void {
  const {
    connection,
    targets,
    flasher,
    autoFlash,
    rttSession,
    hexDecoration,
    hexUriFromConfig
  } = deps;

  function handleError(err: unknown): void {
    if (err instanceof FreeOcdError) {
      vscode.window.showErrorMessage(err.message);
    } else {
      vscode.window.showErrorMessage(formatError(err).split('\n')[0]);
    }
    log.error(err as Error);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('freeocd.connectProbe', async () => {
      if (!deps.hasHidBackend) {
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
      deps.refreshConnectionTree();
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
          deps.refreshFlasherTree();
          if (
            vscode.workspace.getConfiguration('freeocd').get<boolean>('autoFlash.enabled', false)
          ) {
            await autoFlash.update(uri);
          }
          deps.publishStatus();
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
      deps.refreshFlasherTree();
    }),

    vscode.commands.registerCommand('freeocd.connectRtt', async () => {
      try {
        const handler = await rttSession.connect();
        if (!handler) {
          vscode.window.showWarningMessage(
            vscode.l10n.t('RTT control block not found in scan range.')
          );
          return;
        }
        const state = handler.getState();
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            'RTT connected ({0} up, {1} down buffers).',
            state.numBufUp,
            state.numBufDown
          )
        );
        const config = vscode.workspace.getConfiguration('freeocd');
        if (config.get<boolean>('rtt.autoOpenTerminal', true)) {
          await vscode.commands.executeCommand('freeocd.openRttTerminal');
        }
      } catch (err) {
        handleError(err);
      }
    }),

    vscode.commands.registerCommand('freeocd.disconnectRtt', async () => {
      await rttSession.teardown('user requested disconnect');
      vscode.window.showInformationMessage(vscode.l10n.t('RTT disconnected.'));
    }),

    vscode.commands.registerCommand('freeocd.openRttTerminal', async () => {
      try {
        if (!rttSession.isConnected()) {
          await vscode.commands.executeCommand('freeocd.connectRtt');
        }
        if (!rttSession.isConnected()) {
          return;
        }
        const interval = vscode.workspace
          .getConfiguration('freeocd')
          .get<number>('rtt.pollingInterval', 100);
        rttSession.openTerminal(interval);
      } catch (err) {
        handleError(err);
      }
    }),

    vscode.commands.registerCommand('freeocd.setupMcp', async () => {
      const payload = buildMcpConfigPayload(deps.mcpPaths);
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
}
