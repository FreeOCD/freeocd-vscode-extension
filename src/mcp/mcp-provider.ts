/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * VSCode 1.101+ MCP Server Definition Provider registration (feature-
 * detected so older VSCode / Windsurf / Cursor builds still work).
 *
 * Also provides the payload used by `freeocd.setupMcp` for manual IDE setup.
 */

import * as vscode from 'vscode';
import { log } from '../common/logger';
import type { McpConfigPayload } from '../common/types';

export interface McpProviderOptions {
  /** Absolute path to the bundled mcp-server.js. */
  serverJs: string;
  /** Extension install directory (for bundled DAPjs / icons). */
  extensionDir: string;
  /** IPC directory used by the bridge (workspaceStorage). */
  ipcDir: string;
}

/**
 * Attempt to register an MCP server definition provider. Returns a disposable
 * if registration succeeded, `undefined` otherwise (host IDE has no MCP API).
 */
export function registerMcpProvider(opts: McpProviderOptions): vscode.Disposable | undefined {
  const lm = (vscode as unknown as {
    lm?: { registerMcpServerDefinitionProvider?: Function };
  }).lm;
  if (!lm || typeof lm.registerMcpServerDefinitionProvider !== 'function') {
    log.info('vscode.lm.registerMcpServerDefinitionProvider not available; skipping auto-registration.');
    return undefined;
  }

  try {
    const provider = {
      // VSCode invokes this whenever it (re)loads the provider.
      provideMcpServerDefinitions: () => [makeServerDefinition(opts)]
    };
    const disposable = lm.registerMcpServerDefinitionProvider('freeocd.mcpServer', provider);
    log.info('Registered MCP server definition provider for VSCode Copilot agent mode.');
    return disposable as vscode.Disposable;
  } catch (err) {
    log.warn(`MCP provider registration failed: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Produce the JSON payload used by IDEs that don't support the
 * `mcpServerDefinitionProviders` contribution yet (Windsurf, Cursor, Cline).
 * We expose this via the `freeocd.setupMcp` command.
 */
export function buildMcpConfigPayload(opts: McpProviderOptions): {
  windsurf: unknown;
  cursor: unknown;
  cline: unknown;
  generic: McpConfigPayload;
} {
  const env: Record<string, string> = {
    FREEOCD_IPC_DIR: opts.ipcDir,
    FREEOCD_EXTENSION_DIR: opts.extensionDir
  };

  const generic: McpConfigPayload = {
    command: process.execPath, // VSCode's bundled Node
    args: [opts.serverJs],
    env
  };

  return {
    windsurf: {
      mcpServers: {
        freeocd: {
          command: generic.command,
          args: generic.args,
          env: generic.env
        }
      }
    },
    cursor: {
      mcpServers: {
        freeocd: {
          command: generic.command,
          args: generic.args,
          env: generic.env
        }
      }
    },
    cline: {
      mcpServers: {
        freeocd: {
          command: generic.command,
          args: generic.args,
          env: generic.env,
          disabled: false,
          autoApprove: []
        }
      }
    },
    generic
  };
}

function makeServerDefinition(opts: McpProviderOptions): Record<string, unknown> {
  return {
    label: 'FreeOCD',
    transport: 'stdio',
    command: process.execPath,
    args: [opts.serverJs],
    env: {
      FREEOCD_IPC_DIR: opts.ipcDir,
      FREEOCD_EXTENSION_DIR: opts.extensionDir
    }
  };
}
