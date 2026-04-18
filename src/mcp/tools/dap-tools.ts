/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * DAPjs Proxy (`CmsisDAP`) and ADI (`DAP`) surface exposed as MCP tools.
 *
 * Processor (`CortexM`) tools live in `./processor-tools.ts`. All three
 * groups belong to the `#freeocd-low-level` tool set and are intentionally
 * low-level — AI tools typically prefer `flash_hex` / `verify_hex` /
 * `rtt_*`, but the low-level set makes these available for deep debugging.
 */

import { z } from 'zod';
import type { ToolDefinition } from './tool-registry';

const u32 = z.number().int().min(0).max(0xffffffff);
const u8 = z.number().int().min(0).max(0xff);

// ============================================================================
// Proxy (CmsisDAP)
// ============================================================================
export const dapInfoSchema = z.object({ key: u8 }).strict();
export const dapSwjClockSchema = z.object({ hz: z.number().int().min(1) }).strict();
export const dapSwjSequenceSchema = z
  .object({ bits: z.number().int().min(1), sequence: z.string() })
  .strict();
export const dapTransferConfigureSchema = z
  .object({
    idleCycles: u8,
    waitRetry: u32,
    matchRetry: u32
  })
  .strict();
export const dapConnectSchema = z.object({}).strict();
export const dapDisconnectSchema = z.object({}).strict();
export const dapReconnectSchema = z.object({}).strict();
export const dapResetSchema = z.object({}).strict();

// ============================================================================
// DAP (ADI)
// ============================================================================
export const dapReadRegSchema = z.object({ reg: u8 }).strict();
export const dapWriteRegSchema = z.object({ reg: u8, value: u32 }).strict();
export const dapReadApSchema = z.object({ apNum: u8, regOffset: u32 }).strict();
export const dapWriteApSchema = z.object({ apNum: u8, regOffset: u32, value: u32 }).strict();
export const dapReadMemSchema = z.object({ address: u32 }).strict();
export const dapWriteMemSchema = z.object({ address: u32, value: u32 }).strict();
export const dapReadBlockSchema = z
  .object({ address: u32, words: z.number().int().min(1).max(4096) })
  .strict();
export const dapWriteBlockSchema = z
  .object({ address: u32, values: z.array(u32).min(1).max(4096) })
  .strict();
export const dapReadBytesSchema = z
  .object({ address: u32, length: z.number().int().min(1).max(16384) })
  .strict();
export const dapWriteBytesSchema = z
  .object({ address: u32, dataBase64: z.string() })
  .strict();

export const dapTools: ToolDefinition[] = [
  // --- Proxy ---
  { name: 'dap_info', description: 'Query CMSIS-DAP DAP_INFO (capabilities, firmware version, etc.).', toolSet: 'freeocd-low-level', schema: dapInfoSchema, requiresConnection: true },
  { name: 'dap_swj_clock', description: 'Set SWJ clock frequency in Hz.', toolSet: 'freeocd-low-level', schema: dapSwjClockSchema, requiresConnection: true },
  { name: 'dap_swj_sequence', description: 'Issue a raw SWJ sequence (hex-encoded bits).', toolSet: 'freeocd-low-level', schema: dapSwjSequenceSchema, requiresConnection: true },
  { name: 'dap_transfer_configure', description: 'Configure idle cycles, wait retries, and match retries.', toolSet: 'freeocd-low-level', schema: dapTransferConfigureSchema, requiresConnection: true },
  { name: 'dap_connect', description: 'Reconnect the proxy (SWD mode).', toolSet: 'freeocd-low-level', schema: dapConnectSchema, requiresConnection: true },
  { name: 'dap_disconnect', description: 'Disconnect the proxy.', toolSet: 'freeocd-low-level', schema: dapDisconnectSchema, requiresConnection: true },
  { name: 'dap_reconnect', description: 'Disconnect + reconnect (clears DP cache).', toolSet: 'freeocd-low-level', schema: dapReconnectSchema, requiresConnection: true },
  { name: 'dap_reset', description: 'Issue DAP_RESET_TARGET.', toolSet: 'freeocd-low-level', schema: dapResetSchema, requiresConnection: true },

  // --- DAP/ADI ---
  { name: 'dap_read_dp', description: 'Read a DP register.', toolSet: 'freeocd-low-level', schema: dapReadRegSchema, requiresConnection: true },
  { name: 'dap_write_dp', description: 'Write a DP register.', toolSet: 'freeocd-low-level', schema: dapWriteRegSchema, requiresConnection: true },
  { name: 'dap_read_ap', description: 'Read an AP register via the proxy.', toolSet: 'freeocd-low-level', schema: dapReadApSchema, requiresConnection: true },
  { name: 'dap_write_ap', description: 'Write an AP register via the proxy.', toolSet: 'freeocd-low-level', schema: dapWriteApSchema, requiresConnection: true },
  { name: 'dap_read_mem8', description: 'Read one byte at address.', toolSet: 'freeocd-low-level', schema: dapReadMemSchema, requiresConnection: true },
  { name: 'dap_read_mem16', description: 'Read one half-word at address.', toolSet: 'freeocd-low-level', schema: dapReadMemSchema, requiresConnection: true },
  { name: 'dap_read_mem32', description: 'Read one word at address.', toolSet: 'freeocd-low-level', schema: dapReadMemSchema, requiresConnection: true },
  { name: 'dap_write_mem8', description: 'Write one byte at address.', toolSet: 'freeocd-low-level', schema: dapWriteMemSchema, requiresConnection: true },
  { name: 'dap_write_mem16', description: 'Write one half-word at address.', toolSet: 'freeocd-low-level', schema: dapWriteMemSchema, requiresConnection: true },
  { name: 'dap_write_mem32', description: 'Write one word at address.', toolSet: 'freeocd-low-level', schema: dapWriteMemSchema, requiresConnection: true },
  { name: 'dap_read_block', description: 'Read a block of 32-bit words (<= 4096).', toolSet: 'freeocd-low-level', schema: dapReadBlockSchema, requiresConnection: true },
  { name: 'dap_write_block', description: 'Write a block of 32-bit words (<= 4096).', toolSet: 'freeocd-low-level', schema: dapWriteBlockSchema, requiresConnection: true },
  { name: 'dap_read_bytes', description: 'Read raw bytes (returns base64).', toolSet: 'freeocd-low-level', schema: dapReadBytesSchema, requiresConnection: true },
  { name: 'dap_write_bytes', description: 'Write raw bytes (expects base64 payload).', toolSet: 'freeocd-low-level', schema: dapWriteBytesSchema, requiresConnection: true }
];
