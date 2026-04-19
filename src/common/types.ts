/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Cross-module type definitions (probe metadata, connection state, target
 * definitions, flash progress, RTT state, etc.).
 *
 * This file is intentionally dependency-free (no `vscode` imports) so the
 * MCP server bundle can reuse its types without pulling in the extension
 * host surface.
 */

export type TransportMethod = 'hid';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ProbeInfo {
  /** node-hid path (platform-specific, opaque identifier). */
  path: string;
  vendorId: number;
  productId: number;
  serialNumber?: string;
  manufacturer?: string;
  product?: string;
  release?: number;
  interface?: number;
  usagePage?: number;
  usage?: number;
}

export interface ConnectionInfo {
  state: ConnectionState;
  method: TransportMethod;
  probe?: ProbeInfo;
  error?: string;
}

/** Erase-all status values for Nordic CTRL-AP mass erase. */
export interface EraseAllStatus {
  ready: number;
  readyToReset: number;
  busy: number;
  error: number;
}

/** Access-port definition for DAP access. */
export interface AccessPortDef {
  type: 'mem-ap' | 'ctrl-ap' | 'apb-ap';
  num: number;
  idr: string;
}

/** Flash controller definition (platform-specific registers). */
export interface FlashControllerDef {
  type: 'rramc' | 'nvmc' | 'fmc' | 'fpec' | 'qspi' | string;
  base: string;
  registers: Record<string, { offset: string; enableValue?: string }>;
}

export interface MemoryRegion {
  address: string;
  size?: string;
  workAreaSize?: string;
  pageSize?: string;
}

export type TargetCapability =
  | 'flash'
  | 'verify'
  | 'recover'
  | 'rtt'
  | 'erase_page'
  | 'mass_erase';

/**
 * Target definition schema (superset of `freeocd-web` JSON, extensible for
 * STM32, RP2040, ESP32, NXP, Silicon Labs, Renesas, etc.).
 */
export interface TargetDefinition {
  /** Fully-qualified target identifier (e.g. "nordic/nrf54/nrf54l15"). */
  id: string;
  name: string;
  platform: string;
  cpu: string;
  cputapid: string;
  ctrlAp?: { num: number; idr: string };
  accessPort?: AccessPortDef;
  eraseAllStatus?: EraseAllStatus;
  flashController: FlashControllerDef;
  flash: MemoryRegion;
  sram: MemoryRegion;
  capabilities: TargetCapability[];
  description?: string;
  quirks?: Record<string, unknown>;
}

export interface FlashProgress {
  requestId: string;
  phase: 'preparing' | 'erasing' | 'writing' | 'verifying' | 'resetting' | 'done' | 'error';
  percent: number;
  bytesWritten?: number;
  bytesTotal?: number;
  message?: string;
}

export interface SessionLogEntry {
  id: string;
  timestamp: string;
  source: 'ui' | 'mcp' | 'task' | 'watcher';
  command: string;
  args?: unknown;
  success: boolean;
  durationMs?: number;
  error?: string;
}

export interface RttState {
  connected: boolean;
  numBufUp: number;
  numBufDown: number;
  controlBlockAddress?: number;
}

export interface McpConfigPayload {
  /** Absolute path to the bundled `mcp-server.js`. */
  command: string;
  args: string[];
  env: Record<string, string>;
}
