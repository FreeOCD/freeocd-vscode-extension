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

import { connectionTools } from './tools/connection-tools';
import { targetTools } from './tools/target-tools';
import { flashTools } from './tools/flash-tools';
import { rttTools } from './tools/rtt-tools';
import { dapTools } from './tools/dap-tools';
import { sessionTools } from './tools/session-tools';
import { readAPReg } from '../dap/dap-operations';
import { FreeOcdError, NotConnectedError, NoTargetError } from '../common/errors';
import { log } from '../common/logger';
import { loadDapjs } from '../common/dapjs-loader';
import type { ToolDefinition } from './tools/tool-registry';

export interface McpToolContext {
  connection: ConnectionManager;
  targets: TargetManager;
  flasher: Flasher;
  sessionLog: SessionLog;
  getRtt(): RttHandler | undefined;
  setRtt(handler: RttHandler | undefined): void;
  autoFlash: AutoFlashWatcher;
  /** Extension-wide latest flash progress, keyed by requestId. */
  flashProgress: Map<string, unknown>;
}

const ALL_TOOLS: ToolDefinition[] = [
  ...connectionTools,
  ...targetTools,
  ...flashTools,
  ...rttTools,
  ...dapTools,
  ...sessionTools
];

export async function dispatchMcpTool(
  req: McpRequest,
  ctx: McpToolContext
): Promise<unknown> {
  const tool = ALL_TOOLS.find((t) => t.name === req.tool);
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

  switch (tool.name) {
    // --- Connection ---
    case 'list_connection_methods':
      return [{ method: 'hid', displayName: 'HID (CMSIS-DAP v1)' }];
    case 'list_probes':
      return ctx.connection.listProbes();
    case 'connect_probe':
      return connectProbe(ctx, args);
    case 'disconnect_probe':
      await ctx.connection.disconnect();
      return { ok: true };
    case 'get_connection_info':
      return ctx.connection.getInfo();

    // --- Target ---
    case 'list_targets':
      return ctx.targets.list();
    case 'get_target_info':
      return requireExists(ctx.targets.get(String(args.id)), `Target not found: ${args.id}`);
    case 'select_target':
      return ctx.targets.select(String(args.id));
    case 'create_target_definition':
      return ctx.targets.save(ctx.targets.validate(args.target));
    case 'update_target_definition': {
      const existing = requireExists(
        ctx.targets.get(String(args.id)),
        `Target not found: ${args.id}`
      );
      const merged = { ...existing, ...(args.patch as Record<string, unknown>) };
      return ctx.targets.save(ctx.targets.validate(merged));
    }
    case 'delete_target_definition':
      await ctx.targets.delete(String(args.id));
      return { ok: true };
    case 'validate_target_definition':
      try {
        return { ok: true, target: ctx.targets.validate(args.target) };
      } catch (err) {
        return {
          ok: false,
          issues: (err as { details?: unknown }).details ?? [],
          message: (err as Error).message
        };
      }
    case 'test_target_definition':
      return testTargetDefinition(ctx, String(args.id));

    // --- Flash ---
    case 'flash_hex': {
      const uri = resolveHexUri(String(args.path));
      await ctx.flasher.flash(uri, { verifyAfterFlash: Boolean(args.verify) });
      return { ok: true };
    }
    case 'verify_hex': {
      const uri = resolveHexUri(String(args.path));
      return ctx.flasher.verify(uri);
    }
    case 'recover':
      await ctx.flasher.recover();
      return { ok: true };
    case 'get_flash_progress':
      return ctx.flashProgress.get(String(args.requestId)) ?? null;
    case 'set_auto_flash_watch': {
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
    }
    case 'soft_reset':
      await ctx.flasher.softReset();
      return { ok: true };

    // --- RTT ---
    case 'rtt_connect':
      return rttConnect(ctx, args);
    case 'rtt_disconnect':
      ctx.getRtt()?.reset();
      ctx.setRtt(undefined);
      return { ok: true };
    case 'rtt_read': {
      const rtt = requireExists(ctx.getRtt(), 'RTT not connected.');
      const bytes = await rtt.read(Number(args.bufId ?? 0));
      return { bytesBase64: bufferToBase64(bytes), length: bytes.length };
    }
    case 'rtt_write': {
      const rtt = requireExists(ctx.getRtt(), 'RTT not connected.');
      const payload = new TextEncoder().encode(String(args.data ?? ''));
      const written = await rtt.write(payload, Number(args.bufId ?? 0));
      return { written };
    }
    case 'get_rtt_status':
      return ctx.getRtt()?.getState() ?? { connected: false, numBufUp: 0, numBufDown: 0 };

    // --- Session ---
    case 'describe_capabilities':
      return describeCapabilities(ctx);
    case 'get_session_log':
      return ctx.sessionLog.list(
        typeof args.limit === 'number' ? (args.limit as number) : undefined
      );
    case 'get_command_history':
      return ctx.sessionLog.list(
        typeof args.count === 'number' ? (args.count as number) : undefined
      );
    case 'get_last_error':
      return ctx.sessionLog.lastError() ?? null;
    case 'clear_session_log':
      ctx.sessionLog.clear();
      return { ok: true };

    // --- DAP/processor low-level passthroughs ---
    default:
      return dispatchLowLevel(ctx, tool.name, args);
  }
}

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
    const idr = await readAPReg(adi as object, target.ctrlAp.num, 0x0fc);
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
  const { RttHandler } = await import('../rtt/rtt-handler');
  const { adi } = ctx.connection.getDap();
  const scanStart =
    typeof args.scanStart === 'number'
      ? (args.scanStart as number)
      : parseInt(target?.sram.address ?? '0x20000000', 16);
  const scanRange =
    typeof args.scanRange === 'number' ? (args.scanRange as number) : 0x10000;

  // DAPjs processor wrapper — we need a CortexM instance for RTT.
  const dapjs = loadDapjs();
  const processor = new dapjs.CortexM(adi);
  const handler = new RttHandler(processor as never, { scanStartAddress: scanStart, scanRange });
  const count = await handler.init();
  if (count < 0) {
    throw new FreeOcdError('RTT control block not found in scan range.', 'RTT_NOT_FOUND');
  }
  ctx.setRtt(handler);
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
      'freeocd-session'
    ],
    tools: ALL_TOOLS.map((t) => ({ name: t.name, toolSet: t.toolSet, description: t.description })),
    connection: ctx.connection.getInfo(),
    currentTarget: ctx.targets.getCurrent() ?? null,
    availableTargets: ctx.targets.list().map((t) => ({ id: t.id, name: t.name, platform: t.platform }))
  };
}

// Declare the webpack-defined constant for the extension bundle too.
declare const EXTENSION_VERSION: string;

async function dispatchLowLevel(
  ctx: McpToolContext,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!ctx.connection.isConnected()) {
    throw new NotConnectedError();
  }
  const { adi, proxy } = ctx.connection.getDap() as {
    adi: { [key: string]: unknown };
    proxy: { [key: string]: unknown };
  };

  const callAdi = async (method: string, ...methodArgs: unknown[]): Promise<unknown> => {
    const fn = adi[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
    if (typeof fn !== 'function') {
      throw new FreeOcdError(`DAPjs ADI.${method} is not available.`, 'NO_METHOD');
    }
    return fn.apply(adi, methodArgs);
  };

  const callProxy = async (method: string, ...methodArgs: unknown[]): Promise<unknown> => {
    const fn = proxy[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
    if (typeof fn !== 'function') {
      throw new FreeOcdError(`DAPjs proxy.${method} is not available.`, 'NO_METHOD');
    }
    return fn.apply(proxy, methodArgs);
  };

  switch (tool) {
    // Proxy
    case 'dap_info':
      return callProxy('dapInfo', args.key);
    case 'dap_swj_clock':
      return callProxy('swjClock', args.hz);
    case 'dap_swj_sequence':
      return callProxy('swjSequence', args.bits, args.sequence);
    case 'dap_transfer_configure':
      return callProxy('transferConfigure', args.idleCycles, args.waitRetry, args.matchRetry);
    case 'dap_connect':
      return callProxy('connect');
    case 'dap_disconnect':
      return callProxy('disconnect');
    case 'dap_reconnect':
      return callProxy('reconnect');
    case 'dap_reset':
      return callProxy('reset');

    // DAP/ADI
    case 'dap_read_dp':
      return callAdi('readDP', args.reg);
    case 'dap_write_dp':
      return callAdi('writeDP', args.reg, args.value);
    case 'dap_read_ap':
      return readAPReg(adi as unknown as object, Number(args.apNum), Number(args.regOffset));
    case 'dap_write_ap':
      return callAdi('writeAP', args.apNum, args.regOffset, args.value);
    case 'dap_read_mem8':
      return callAdi('readMem8', args.address);
    case 'dap_read_mem16':
      return callAdi('readMem16', args.address);
    case 'dap_read_mem32':
      return callAdi('readMem32', args.address);
    case 'dap_write_mem8':
      return callAdi('writeMem8', args.address, args.value);
    case 'dap_write_mem16':
      return callAdi('writeMem16', args.address, args.value);
    case 'dap_write_mem32':
      return callAdi('writeMem32', args.address, args.value);
    case 'dap_read_block': {
      const words = await callAdi('readBlock', args.address, args.words);
      return Array.from((words as Uint32Array) ?? []);
    }
    case 'dap_write_block':
      return callAdi(
        'writeBlock',
        args.address,
        new Uint32Array((args.values as number[]) ?? [])
      );
    case 'dap_read_bytes': {
      const bytes = (await callAdi('readBytes', args.address, args.length)) as Uint8Array;
      return { bytesBase64: bufferToBase64(bytes), length: bytes.length };
    }
    case 'dap_write_bytes': {
      const bytes = base64ToBuffer(String(args.dataBase64 ?? ''));
      return callAdi('writeBytes', args.address, bytes);
    }

    // Processor (CortexM wrapping)
    default:
      return dispatchProcessor(ctx, tool, args);
  }
}

async function dispatchProcessor(
  ctx: McpToolContext,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!ctx.connection.isConnected()) {
    throw new NotConnectedError();
  }
  const { adi } = ctx.connection.getDap();
  const dapjs = loadDapjs();
  const cortex = new dapjs.CortexM(adi) as {
    getState(): Promise<unknown>;
    isHalted(): Promise<boolean>;
    halt(): Promise<void>;
    resume(): Promise<void>;
    readCoreRegister(id: number): Promise<number>;
    readCoreRegisters(): Promise<number[]>;
    writeCoreRegister(id: number, value: number): Promise<void>;
    execute(address: number, code: Uint32Array): Promise<void>;
  };

  switch (tool) {
    case 'processor_get_state':
      return cortex.getState();
    case 'processor_is_halted':
      return cortex.isHalted();
    case 'processor_halt':
      await cortex.halt();
      return { ok: true };
    case 'processor_resume':
      await cortex.resume();
      return { ok: true };
    case 'processor_read_core_register':
      return cortex.readCoreRegister(Number(args.registerId));
    case 'processor_read_core_registers':
      return cortex.readCoreRegisters();
    case 'processor_write_core_register':
      await cortex.writeCoreRegister(Number(args.registerId), Number(args.value));
      return { ok: true };
    case 'processor_execute':
      await cortex.execute(Number(args.address), new Uint32Array(args.code as number[]));
      return { ok: true };
    default:
      throw new FreeOcdError(`Unhandled tool: ${tool}`, 'UNHANDLED');
  }
}

function resolveHexUri(input: string): vscode.Uri {
  if (input.startsWith('/') || /^[a-zA-Z]:[\\/]/u.test(input)) {
    return vscode.Uri.file(input);
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    return vscode.Uri.joinPath(folder.uri, input);
  }
  return vscode.Uri.file(input);
}

function bufferToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBuffer(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}
