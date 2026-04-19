/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

import { z } from 'zod';
import type { ToolDefinition } from './tool-registry';

export const flashHexSchema = z
  .object({
    path: z.string().min(1),
    verify: z.boolean().optional()
  })
  .strict();

export const recoverSchema = z.object({}).strict();
export const verifyHexSchema = z.object({ path: z.string().min(1) }).strict();
export const getFlashProgressSchema = z.object({ requestId: z.string().min(1) }).strict();
export const setAutoFlashWatchSchema = z
  .object({
    path: z.string().min(1).optional(),
    enabled: z.boolean(),
    confirmBeforeFlash: z.boolean().optional()
  })
  .strict();
export const softResetSchema = z.object({}).strict();

export const flashTools: ToolDefinition[] = [
  {
    name: 'flash_hex',
    description:
      'Flash an Intel HEX file to the connected target. Optionally verify after flash.',
    toolSet: 'freeocd-flash',
    schema: flashHexSchema,
    requiresConnection: true,
    requiresTarget: true,
    annotations: {
      title: 'Flash HEX File',
      readOnlyHint: false,
      // `destructiveHint: true` because flash overwrites any existing
      // firmware on the target — the client SHOULD request explicit
      // user confirmation before invoking this tool.
      destructiveHint: true,
      // Flashing the same file twice produces the same final state, so
      // the operation itself is idempotent (even though it physically
      // re-writes flash each time).
      idempotentHint: true,
      openWorldHint: true
    }
  },
  {
    name: 'verify_hex',
    description: 'Verify flash contents against the given HEX file.',
    toolSet: 'freeocd-flash',
    schema: verifyHexSchema,
    requiresConnection: true,
    requiresTarget: true,
    annotations: {
      title: 'Verify HEX File',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  {
    name: 'recover',
    description: 'Run the platform-specific mass erase / unlock sequence (e.g. Nordic CTRL-AP).',
    toolSet: 'freeocd-flash',
    schema: recoverSchema,
    requiresConnection: true,
    requiresTarget: true,
    annotations: {
      title: 'Recover Target (Mass Erase)',
      readOnlyHint: false,
      // Mass erase is the most destructive operation FreeOCD exposes —
      // it wipes every sector and (on Nordic) unlocks the debug
      // interface. Clients MUST prompt for explicit user confirmation.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  {
    name: 'get_flash_progress',
    description:
      'Return the latest phase/percent/message/elapsedMs/etaMs for the given flash requestId.',
    toolSet: 'freeocd-flash',
    schema: getFlashProgressSchema,
    annotations: {
      title: 'Get Flash Progress',
      readOnlyHint: true,
      // Progress snapshots evolve over time as the flash progresses, so
      // repeated calls DON'T return the same value.
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'set_auto_flash_watch',
    description:
      'Enable or disable auto-flash on change. If a path is given, update the watched file.',
    toolSet: 'freeocd-flash',
    schema: setAutoFlashWatchSchema,
    annotations: {
      title: 'Configure Auto-Flash Watch',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'soft_reset',
    description: 'Issue a soft reset via the platform handler (falls back to DAP_RESET_TARGET).',
    toolSet: 'freeocd-flash',
    schema: softResetSchema,
    requiresConnection: true,
    requiresTarget: true,
    annotations: {
      title: 'Soft Reset Target',
      readOnlyHint: false,
      // A reset is a targeted reboot — it disrupts execution but doesn't
      // delete anything, so it is NOT `destructiveHint: true`.
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  }
];
