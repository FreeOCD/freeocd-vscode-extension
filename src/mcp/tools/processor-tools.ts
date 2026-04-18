/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Cortex-M processor control tools (exposed via `#freeocd-low-level`).
 *
 * These tools wrap DAPjs `CortexM` operations: halt / resume / register
 * read-write / code execution. They are intentionally low-level — AI tools
 * typically prefer the higher-level `flash_hex` / `verify_hex` / `rtt_*`
 * tools, but `#freeocd-low-level` makes these available for deep debugging.
 */

import { z } from 'zod';
import type { ToolDefinition } from './tool-registry';

const u32 = z.number().int().min(0).max(0xffffffff);

export const processorGetStateSchema = z.object({}).strict();
export const processorIsHaltedSchema = z.object({}).strict();
export const processorHaltSchema = z.object({}).strict();
export const processorResumeSchema = z.object({}).strict();
export const processorReadRegSchema = z.object({ registerId: z.number().int().min(0) }).strict();
export const processorReadRegsSchema = z.object({}).strict();
export const processorWriteRegSchema = z
  .object({ registerId: z.number().int().min(0), value: u32 })
  .strict();
export const processorExecuteSchema = z
  .object({ address: u32, code: z.array(u32).min(1).max(512) })
  .strict();

export const processorTools: ToolDefinition[] = [
  { name: 'processor_get_state', description: 'Get CPU state (halted / running / locked).', toolSet: 'freeocd-low-level', schema: processorGetStateSchema, requiresConnection: true },
  { name: 'processor_is_halted', description: 'Return true if the CPU is currently halted.', toolSet: 'freeocd-low-level', schema: processorIsHaltedSchema, requiresConnection: true },
  { name: 'processor_halt', description: 'Halt the CPU via DHCSR.', toolSet: 'freeocd-low-level', schema: processorHaltSchema, requiresConnection: true },
  { name: 'processor_resume', description: 'Resume the CPU via DHCSR.', toolSet: 'freeocd-low-level', schema: processorResumeSchema, requiresConnection: true },
  { name: 'processor_read_core_register', description: 'Read a single core register (R0-R15, xPSR, CONTROL).', toolSet: 'freeocd-low-level', schema: processorReadRegSchema, requiresConnection: true },
  { name: 'processor_read_core_registers', description: 'Read all standard core registers.', toolSet: 'freeocd-low-level', schema: processorReadRegsSchema, requiresConnection: true },
  { name: 'processor_write_core_register', description: 'Write a core register.', toolSet: 'freeocd-low-level', schema: processorWriteRegSchema, requiresConnection: true },
  { name: 'processor_execute', description: 'Upload a code blob to SRAM, set PC/R7, and run.', toolSet: 'freeocd-low-level', schema: processorExecuteSchema, requiresConnection: true }
];
