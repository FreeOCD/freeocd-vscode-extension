/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Dispatcher that executes an MCP tool call inside the extension host.
 *
 * The standalone MCP server (`mcp-server.ts`) validates arguments and then
 * forwards the call to the extension via `McpBridge`. The extension
 * installs this dispatcher as the bridge's request handler.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/connection-manager';
import type { TargetManager } from '../target/target-manager';
import type { Flasher } from '../flasher/flasher';
import type { RttHandler } from '../rtt/rtt-handler';
import type { SessionLog } from './session-log';
import type { McpRequest } from './mcp-bridge';
import type { AutoFlashWatcher } from '../flasher/auto-flash-watcher';

import { ALL_TOOLS, EXTENSION_TOOLS } from './tools';
import { readAPReg } from '../dap/dap-operations';
import { FreeOcdError, NotConnectedError, NoTargetError } from '../common/errors';
import { log } from '../common/logger';
import { loadDapjs } from '../common/dapjs-loader';
import { resolveHexUri as resolveWorkspaceHexUri } from '../common/hex-path';
import type { CortexMProcessor, DapAdi } from '../dap/dapjs-types';

export interface McpToolContext {
  connection: ConnectionManager;
  targets: TargetManager;
  flasher: Flasher;
  sessionLog: SessionLog;
  getRtt(): RttHandler | undefined;
  /**
   * Full RTT connect flow — acquires the shared RTT lock, issues the
   * soft-reset + halt sequence mirrored from `freeocd-web`, scans for the
   * control block, and attaches the Cortex-M processor to the
   * `StateManager` poll loop. Must be preferred over ad-hoc
   * `new RttHandler(...)` construction from MCP tool handlers so all the
   * concurrency invariants (lock + state monitor) stay consistent with the
   * UI command. Returns `null` if the control block could not be located.
   */
  connectRtt(options?: { scanStart?: number; scanRange?: number }): Promise<RttHandler | null>;
  /** Full RTT disconnect flow — stops polling, disposes the handler, releases the lock. */
  disconnectRtt(): Promise<void>;
  autoFlash: AutoFlashWatcher;
  /** Extension-wide latest flash progress, keyed by requestId. */
  flashProgress: Map<string, unknown>;
}

/**
 * Handler signature for a single MCP tool executed in the extension host.
 * Argument objects have already been validated against the tool's Zod
 * schema by `dispatchMcpTool`.
 */
type ToolHandler = (
  ctx: McpToolContext,
  args: Record<string, unknown>
) => Promise<unknown> | unknown;

export async function dispatchMcpTool(
  req: McpRequest,
  ctx: McpToolContext
): Promise<unknown> {
  const tool = EXTENSION_TOOLS.find((t) => t.name === req.tool);
  if (!tool) {
    throw new FreeOcdError(`Unknown tool: ${req.tool}`, 'UNKNOWN_TOOL');
  }
  const parsed = tool.schema.safeParse(req.args ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new FreeOcdError(`Argument validation failed: ${details}`, 'ARG_VALIDATION');
  }
  if (tool.requiresConnection && !ctx.connection.isConnected()) {
    throw new NotConnectedError();
  }
  if (tool.requiresTarget && !ctx.targets.getCurrent()) {
    throw new NoTargetError();
  }

  const args = parsed.data as Record<string, unknown>;
  log.debug(`MCP tool ${tool.name} ${JSON.stringify(args)}`);

  const handler = HANDLERS[tool.name];
  if (!handler) {
    throw new FreeOcdError(`Unhandled tool: ${tool.name}`, 'UNHANDLED');
  }
  return handler(ctx, args);
}

const connectionHandlers: Record<string, ToolHandler> = {
  list_connection_methods: () => [{ method: 'hid', displayName: 'HID (CMSIS-DAP v1)' }],
  list_probes: (ctx) => ctx.connection.listProbes(),
  connect_probe: (ctx, args) => connectProbe(ctx, args),
  disconnect_probe: async (ctx) => {
    await ctx.connection.disconnect();
    return { ok: true };
  },
  get_connection_info: (ctx) => ctx.connection.getInfo()
};

const targetHandlers: Record<string, ToolHandler> = {
  list_targets: (ctx) => ctx.targets.list(),
  get_target_info: (ctx, args) =>
    requireExists(ctx.targets.get(String(args.id)), `Target not found: ${args.id}`),
  select_target: (ctx, args) => ctx.targets.select(String(args.id)),
  create_target_definition: (ctx, args) => ctx.targets.save(ctx.targets.validate(args.target)),
  update_target_definition: (ctx, args) => {
    const existing = requireExists(
      ctx.targets.get(String(args.id)),
      `Target not found: ${args.id}`
    );
    const merged = { ...existing, ...(args.patch as Record<string, unknown>) };
    return ctx.targets.save(ctx.targets.validate(merged));
  },
  delete_target_definition: async (ctx, args) => {
    await ctx.targets.delete(String(args.id));
    return { ok: true };
  },
  validate_target_definition: (ctx, args) => {
    try {
      return { ok: true, target: ctx.targets.validate(args.target) };
    } catch (err) {
      return {
        ok: false,
        issues: (err as { details?: unknown }).details ?? [],
        message: (err as Error).message
      };
    }
  },
  test_target_definition: (ctx, args) => testTargetDefinition(ctx, String(args.id))
};

const flashHandlers: Record<string, ToolHandler> = {
  flash_hex: async (ctx, args) => {
    const uri = resolveHexUri(String(args.path));
    await ctx.flasher.flash(uri, { verifyAfterFlash: Boolean(args.verify) });
    return { ok: true };
  },
  verify_hex: (ctx, args) => ctx.flasher.verify(resolveHexUri(String(args.path))),
  recover: async (ctx) => {
    await ctx.flasher.recover();
    return { ok: true };
  },
  get_flash_progress: (ctx, args) => ctx.flashProgress.get(String(args.requestId)) ?? null,
  set_auto_flash_watch: async (ctx, args) => {
    const path = args.path ? String(args.path) : undefined;
    const enabled = Boolean(args.enabled);
    if (!enabled) {
      await ctx.autoFlash.update(undefined);
    } else if (path) {
      await ctx.autoFlash.update(resolveHexUri(path));
    }
    if (args.confirmBeforeFlash !== undefined) {
      await vscode.workspace
        .getConfiguration('freeocd')
        .update('autoFlash.confirmBeforeFlash', Boolean(args.confirmBeforeFlash), true);
    }
    await vscode.workspace
      .getConfiguration('freeocd')
      .update('autoFlash.enabled', enabled, true);
    return { ok: true };
  },
  soft_reset: async (ctx) => {
    await ctx.flasher.softReset();
    return { ok: true };
  }
};

const rttHandlers: Record<string, ToolHandler> = {
  rtt_connect: (ctx, args) => rttConnect(ctx, args),
  rtt_disconnect: async (ctx) => {
    await ctx.disconnectRtt();
    return { ok: true };
  },
  rtt_read: async (ctx, args) => {
    const rtt = requireExists(ctx.getRtt(), 'RTT not connected.');
    const bytes = await rtt.read(Number(args.bufId ?? 0));
    return { bytesBase64: bufferToBase64(bytes), length: bytes.length };
  },
  rtt_write: async (ctx, args) => {
    const rtt = requireExists(ctx.getRtt(), 'RTT not connected.');
    const payload = new TextEncoder().encode(String(args.data ?? ''));
    const written = await rtt.write(payload, Number(args.bufId ?? 0));
    return { written };
  },
  get_rtt_status: (ctx) =>
    ctx.getRtt()?.getState() ?? { connected: false, numBufUp: 0, numBufDown: 0 }
};

const sessionHandlers: Record<string, ToolHandler> = {
  describe_capabilities: (ctx) => describeCapabilities(ctx),
  get_session_log: (ctx, args) =>
    ctx.sessionLog.list(typeof args.limit === 'number' ? (args.limit as number) : undefined),
  get_command_history: (ctx, args) =>
    ctx.sessionLog.list(typeof args.count === 'number' ? (args.count as number) : undefined),
  get_last_error: (ctx) => ctx.sessionLog.lastError() ?? null,
  clear_session_log: (ctx) => {
    ctx.sessionLog.clear();
    return { ok: true };
  }
};

function requireExists<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === null) {
    throw new FreeOcdError(message, 'NOT_FOUND');
  }
  return value;
}

async function connectProbe(ctx: McpToolContext, args: Record<string, unknown>): Promise<unknown> {
  const probes = await ctx.connection.listProbes();
  const match = probes.find((p) => {
    if (args.path && p.path !== args.path) {
      return false;
    }
    if (args.serialNumber && p.serialNumber !== args.serialNumber) {
      return false;
    }
    if (args.vendorId !== undefined && p.vendorId !== Number(args.vendorId)) {
      return false;
    }
    if (args.productId !== undefined && p.productId !== Number(args.productId)) {
      return false;
    }
    return true;
  });
  if (!match) {
    throw new FreeOcdError('No probe matches the requested filter.', 'NO_MATCH');
  }
  await ctx.connection.connect(match);
  return ctx.connection.getInfo();
}

async function testTargetDefinition(ctx: McpToolContext, id: string): Promise<unknown> {
  const target = requireExists(ctx.targets.get(id), `Target not found: ${id}`);
  if (!ctx.connection.isConnected()) {
    throw new NotConnectedError();
  }
  const { adi } = ctx.connection.getDap();
  const result: Record<string, unknown> = { target: target.id };
  if (target.ctrlAp) {
    const idr = await readAPReg(adi, target.ctrlAp.num, 0x0fc);
    result.ctrlApIdr = idr !== undefined ? `0x${idr.toString(16).toUpperCase()}` : null;
    result.ctrlApIdrExpected = target.ctrlAp.idr;
    result.ctrlApIdrMatches =
      idr !== undefined && idr === parseInt(target.ctrlAp.idr, 16);
  }
  return result;
}

async function rttConnect(ctx: McpToolContext, args: Record<string, unknown>): Promise<unknown> {
  if (!ctx.connection.isConnected()) {
    throw new NotConnectedError();
  }
  const target = ctx.targets.getCurrent();
  const scanStart =
    typeof args.scanStart === 'number'
      ? (args.scanStart as number)
      : parseInt(target?.sram.address ?? '0x20000000', 16);
  const scanRange =
    typeof args.scanRange === 'number' ? (args.scanRange as number) : 0x10000;

  // Delegate to the shared RTT connect flow so MCP-initiated sessions
  // acquire the shared lock, run the soft-reset / halt sequence, and get
  // attached to the `StateManager` poll loop — exactly the same way the
  // UI command does.
  const handler = await ctx.connectRtt({ scanStart, scanRange });
  if (!handler) {
    throw new FreeOcdError('RTT control block not found in scan range.', 'RTT_NOT_FOUND');
  }
  return handler.getState();
}

function describeCapabilities(ctx: McpToolContext): unknown {
  return {
    version: typeof EXTENSION_VERSION === 'undefined' ? 'unknown' : EXTENSION_VERSION,
    toolSets: [
      'freeocd-flash',
      'freeocd-rtt',
      'freeocd-target',
      'freeocd-low-level',
      'freeocd-session',
      'freeocd-ai'
    ],
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      toolSet: t.toolSet,
      description: t.description
    })),
    connection: ctx.connection.getInfo(),
    currentTarget: ctx.targets.getCurrent() ?? null,
    availableTargets: ctx.targets.list().map((t) => ({ id: t.id, name: t.name, platform: t.platform }))
  };
}

// Declare the webpack-defined constant for the extension bundle too.
declare const EXTENSION_VERSION: string;

interface DapCallers {
  adi: DapAdi;
  callAdi(method: string, ...methodArgs: unknown[]): Promise<unknown>;
  callProxy(method: string, ...methodArgs: unknown[]): Promise<unknown>;
}

/**
 * Wrap a low-level handler with connection checking and reflective DAP
 * accessors. The low-level passthrough tools dispatch by method name onto
 * whatever the loaded DAPjs build exposes (including methods beyond the
 * typed `DapAdi` / `CmsisDapProxy` subsets), so `callAdi` / `callProxy`
 * stay reflective by design.
 */
function dapHandler(
  fn: (dap: DapCallers, args: Record<string, unknown>) => Promise<unknown> | unknown
): ToolHandler {
  return (ctx, args) => {
    if (!ctx.connection.isConnected()) {
      throw new NotConnectedError();
    }
    const { adi, proxy } = ctx.connection.getDap();
    const adiRecord = adi as unknown as Record<string, unknown>;
    const proxyRecord = proxy as unknown as Record<string, unknown>;
    const callAdi = async (method: string, ...methodArgs: unknown[]): Promise<unknown> => {
      const f = adiRecord[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (typeof f !== 'function') {
        throw new FreeOcdError(`DAPjs ADI.${method} is not available.`, 'NO_METHOD');
      }
      return f.apply(adi, methodArgs);
    };
    const callProxy = async (method: string, ...methodArgs: unknown[]): Promise<unknown> => {
      const f = proxyRecord[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (typeof f !== 'function') {
        throw new FreeOcdError(`DAPjs proxy.${method} is not available.`, 'NO_METHOD');
      }
      return f.apply(proxy, methodArgs);
    };
    return fn({ adi, callAdi, callProxy }, args);
  };
}

const dapHandlers: Record<string, ToolHandler> = {
  // Proxy
  dap_info: dapHandler((dap, args) => dap.callProxy('dapInfo', args.key)),
  dap_swj_clock: dapHandler((dap, args) => dap.callProxy('swjClock', args.hz)),
  dap_swj_sequence: dapHandler((dap, args) =>
    dap.callProxy('swjSequence', args.bits, args.sequence)
  ),
  dap_transfer_configure: dapHandler((dap, args) =>
    dap.callProxy('transferConfigure', args.idleCycles, args.waitRetry, args.matchRetry)
  ),
  dap_connect: dapHandler((dap) => dap.callProxy('connect')),
  dap_disconnect: dapHandler((dap) => dap.callProxy('disconnect')),
  dap_reconnect: dapHandler((dap) => dap.callProxy('reconnect')),
  dap_reset: dapHandler((dap) => dap.callProxy('reset')),

  // DAP/ADI
  dap_read_dp: dapHandler((dap, args) => dap.callAdi('readDP', args.reg)),
  dap_write_dp: dapHandler((dap, args) => dap.callAdi('writeDP', args.reg, args.value)),
  dap_read_ap: dapHandler((dap, args) =>
    readAPReg(dap.adi, Number(args.apNum), Number(args.regOffset))
  ),
  dap_write_ap: dapHandler((dap, args) =>
    dap.callAdi('writeAP', args.apNum, args.regOffset, args.value)
  ),
  dap_read_mem8: dapHandler((dap, args) => dap.callAdi('readMem8', args.address)),
  dap_read_mem16: dapHandler((dap, args) => dap.callAdi('readMem16', args.address)),
  dap_read_mem32: dapHandler((dap, args) => dap.callAdi('readMem32', args.address)),
  dap_write_mem8: dapHandler((dap, args) => dap.callAdi('writeMem8', args.address, args.value)),
  dap_write_mem16: dapHandler((dap, args) => dap.callAdi('writeMem16', args.address, args.value)),
  dap_write_mem32: dapHandler((dap, args) => dap.callAdi('writeMem32', args.address, args.value)),
  dap_read_block: dapHandler(async (dap, args) => {
    const words = await dap.callAdi('readBlock', args.address, args.words);
    return Array.from((words as Uint32Array) ?? []);
  }),
  dap_write_block: dapHandler((dap, args) =>
    dap.callAdi('writeBlock', args.address, new Uint32Array((args.values as number[]) ?? []))
  ),
  dap_read_bytes: dapHandler(async (dap, args) => {
    const bytes = (await dap.callAdi('readBytes', args.address, args.length)) as Uint8Array;
    return { bytesBase64: bufferToBase64(bytes), length: bytes.length };
  }),
  dap_write_bytes: dapHandler((dap, args) =>
    dap.callAdi('writeBytes', args.address, base64ToBuffer(String(args.dataBase64 ?? '')))
  )
};

/** Wrap a processor handler with connection checking and a fresh CortexM handle. */
function processorHandler(
  fn: (cortex: CortexMProcessor, args: Record<string, unknown>) => Promise<unknown> | unknown
): ToolHandler {
  return (ctx, args) => {
    if (!ctx.connection.isConnected()) {
      throw new NotConnectedError();
    }
    const { proxy } = ctx.connection.getDap();
    const dapjs = loadDapjs();
    return fn(new dapjs.CortexM(proxy), args);
  };
}

const processorHandlers: Record<string, ToolHandler> = {
  processor_get_state: processorHandler((cortex) => cortex.getState()),
  processor_is_halted: processorHandler((cortex) => cortex.isHalted()),
  processor_halt: processorHandler(async (cortex) => {
    await cortex.halt();
    return { ok: true };
  }),
  processor_resume: processorHandler(async (cortex) => {
    await cortex.resume();
    return { ok: true };
  }),
  processor_read_core_register: processorHandler((cortex, args) =>
    cortex.readCoreRegister(Number(args.registerId))
  ),
  processor_read_core_registers: processorHandler((cortex) => cortex.readCoreRegisters()),
  processor_write_core_register: processorHandler(async (cortex, args) => {
    await cortex.writeCoreRegister(Number(args.registerId), Number(args.value));
    return { ok: true };
  }),
  processor_execute: processorHandler(async (cortex, args) => {
    await cortex.execute(Number(args.address), new Uint32Array(args.code as number[]));
    return { ok: true };
  })
};

const HANDLERS: Record<string, ToolHandler> = {
  ...connectionHandlers,
  ...targetHandlers,
  ...flashHandlers,
  ...rttHandlers,
  ...sessionHandlers,
  ...dapHandlers,
  ...processorHandlers
};

function resolveHexUri(input: string): vscode.Uri {
  return resolveWorkspaceHexUri(input) ?? vscode.Uri.file(input);
}

function bufferToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBuffer(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}
