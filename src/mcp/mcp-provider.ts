/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * VSCode 1.101+ MCP Server Definition Provider registration (feature-
 * detected so older VSCode / Windsurf / Cursor builds still work).
 *
 * Uses the official `vscode.McpStdioServerDefinition` class and the full
 * `McpServerDefinitionProvider` contract:
 *
 *   - `provideMcpServerDefinitions` returns a single stdio definition that
 *     launches the bundled `out/mcp-server.js` as a child of VSCode's own
 *     Node runtime (`process.execPath`).
 *   - `onDidChangeMcpServerDefinitions` fires whenever the extension version
 *     advances (so VSCode re-discovers freshly-shipped tools) or when the
 *     user toggles `freeocd.mcp.enabled`, letting the IDE re-probe without a
 *     full window reload.
 *   - `resolveMcpServerDefinition` is the host's pre-start hook; we use it to
 *     verify that the bundled server script is actually present (a stale
 *     install could have the contribution but no `out/mcp-server.js`) and to
 *     surface a clear error in that case rather than letting the stdio spawn
 *     fail with a cryptic ENOENT.
 *
 * Also provides the payload used by `freeocd.setupMcp` for manual IDE setup
 * (Windsurf / Cursor / Cline, none of which implement the VSCode
 * contribution point yet).
 */

import * as fs from 'fs';
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
  /**
   * Extension version string (from `package.json`). Passed through to
   * VSCode's McpStdioServerDefinition so VSCode knows when to refresh its
   * cached tool list (it compares this string on activation).
   */
  version?: string;
  /**
   * Optional event source the caller can fire to force VSCode to re-query
   * `provideMcpServerDefinitions`. Currently wired to the
   * `freeocd.mcp.enabled` configuration change.
   */
  onDidChange?: vscode.Event<void>;
}

/**
 * Attempt to register an MCP server definition provider. Returns a disposable
 * if registration succeeded, `undefined` otherwise (host IDE has no MCP API).
 *
 * VSCode 1.101+ exposes `vscode.McpStdioServerDefinition` *and* the
 * `vscode.lm.registerMcpServerDefinitionProvider` function; older VSCode
 * builds (and alternative hosts like Windsurf / Cursor) may have neither.
 * We therefore feature-detect both and fall back silently — users on
 * unsupported hosts still have the `freeocd.setupMcp` clipboard path.
 */
export function registerMcpProvider(opts: McpProviderOptions): vscode.Disposable | undefined {
  const lm = (vscode as unknown as {
    lm?: { registerMcpServerDefinitionProvider?: Function };
  }).lm;
  const McpStdioServerDefinition = (vscode as unknown as {
    McpStdioServerDefinition?: new (
      label: string,
      command: string,
      args?: string[],
      env?: Record<string, string | number | null>,
      version?: string
    ) => unknown;
  }).McpStdioServerDefinition;

  if (!lm || typeof lm.registerMcpServerDefinitionProvider !== 'function') {
    log.info(
      'vscode.lm.registerMcpServerDefinitionProvider not available; skipping auto-registration.'
    );
    return undefined;
  }
  if (typeof McpStdioServerDefinition !== 'function') {
    log.info(
      'vscode.McpStdioServerDefinition class not available; skipping auto-registration.'
    );
    return undefined;
  }

  try {
    const disposables: vscode.Disposable[] = [];

    // Bridge the caller's change event into the shape VSCode expects on the
    // provider (`Event<void>`). We own the emitter so we can also dispose
    // it cleanly when the extension deactivates.
    const didChangeEmitter = new vscode.EventEmitter<void>();
    disposables.push(didChangeEmitter);
    if (opts.onDidChange) {
      disposables.push(opts.onDidChange(() => didChangeEmitter.fire()));
    }

    const provider: vscode.McpServerDefinitionProvider = {
      onDidChangeMcpServerDefinitions: didChangeEmitter.event,

      // Called eagerly by VSCode during activation, and again whenever the
      // emitter above fires. MUST NOT prompt the user or do long work —
      // that belongs in `resolveMcpServerDefinition`.
      provideMcpServerDefinitions: () => [makeServerDefinition(opts, McpStdioServerDefinition)],

      // Called right before VSCode spawns the server child process. This is
      // where user-interactive setup (auth, API keys, etc.) is allowed;
      // FreeOCD has no such setup, so we just assert the bundled server
      // script actually exists on disk and return the definition unchanged.
      resolveMcpServerDefinition: (server) => {
        try {
          if (!fs.existsSync(opts.serverJs)) {
            throw new Error(
              `FreeOCD MCP server script not found at ${opts.serverJs}. ` +
                'Reinstall the extension or run "npm run compile" if this is a dev build.'
            );
          }
        } catch (err) {
          // Surfacing the error here causes VSCode to cancel the pending
          // tool call with a readable message instead of swallowing it.
          log.error(err as Error);
          throw err;
        }
        return server;
      }
    };

    const disposable = lm.registerMcpServerDefinitionProvider(
      'freeocd.mcpServer',
      provider
    );
    disposables.push(disposable as vscode.Disposable);
    log.info('Registered MCP server definition provider for VSCode Copilot agent mode.');

    return vscode.Disposable.from(...disposables);
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

/**
 * Build a typed `McpStdioServerDefinition` for VSCode's MCP provider API.
 *
 * We intentionally go through the feature-detected constructor reference
 * rather than `new vscode.McpStdioServerDefinition(...)` so the extension
 * still loads on hosts that don't expose the class at runtime (the
 * registration function above bails out earlier in that case).
 */
function makeServerDefinition(
  opts: McpProviderOptions,
  ctor: new (
    label: string,
    command: string,
    args?: string[],
    env?: Record<string, string | number | null>,
    version?: string
  ) => unknown
): vscode.McpStdioServerDefinition {
  const env: Record<string, string | number | null> = {
    FREEOCD_IPC_DIR: opts.ipcDir,
    FREEOCD_EXTENSION_DIR: opts.extensionDir
  };
  return new ctor(
    'FreeOCD',
    process.execPath,
    [opts.serverJs],
    env,
    opts.version
  ) as vscode.McpStdioServerDefinition;
}
