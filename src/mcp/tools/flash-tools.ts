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
    requiresTarget: true
  },
  {
    name: 'verify_hex',
    description: 'Verify flash contents against the given HEX file.',
    toolSet: 'freeocd-flash',
    schema: verifyHexSchema,
    requiresConnection: true,
    requiresTarget: true
  },
  {
    name: 'recover',
    description: 'Run the platform-specific mass erase / unlock sequence (e.g. Nordic CTRL-AP).',
    toolSet: 'freeocd-flash',
    schema: recoverSchema,
    requiresConnection: true,
    requiresTarget: true
  },
  {
    name: 'get_flash_progress',
    description: 'Return the latest phase/percent/message for the given flash requestId.',
    toolSet: 'freeocd-flash',
    schema: getFlashProgressSchema
  },
  {
    name: 'set_auto_flash_watch',
    description:
      'Enable or disable auto-flash on change. If a path is given, update the watched file.',
    toolSet: 'freeocd-flash',
    schema: setAutoFlashWatchSchema
  },
  {
    name: 'soft_reset',
    description: 'Issue a soft reset via the platform handler (falls back to DAP_RESET_TARGET).',
    toolSet: 'freeocd-flash',
    schema: softResetSchema,
    requiresConnection: true,
    requiresTarget: true
  }
];
