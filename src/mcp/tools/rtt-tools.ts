/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

import { z } from 'zod';
import type { ToolDefinition } from './tool-registry';

export const rttConnectSchema = z
  .object({
    scanStart: z.number().int().optional(),
    scanRange: z.number().int().optional(),
    pollingInterval: z.number().int().optional()
  })
  .strict();
export const rttDisconnectSchema = z.object({}).strict();
export const rttReadSchema = z
  .object({
    bufId: z.number().int().min(0).optional(),
    maxBytes: z.number().int().min(1).optional()
  })
  .strict();
export const rttWriteSchema = z
  .object({
    bufId: z.number().int().min(0).optional(),
    data: z.string()
  })
  .strict();
export const getRttStatusSchema = z.object({}).strict();

export const rttTools: ToolDefinition[] = [
  {
    name: 'rtt_connect',
    description:
      'Scan the target SRAM for the SEGGER RTT control block and open up/down buffers.',
    toolSet: 'freeocd-rtt',
    schema: rttConnectSchema,
    requiresConnection: true,
    requiresTarget: true
  },
  {
    name: 'rtt_disconnect',
    description: 'Stop RTT polling and release buffers.',
    toolSet: 'freeocd-rtt',
    schema: rttDisconnectSchema
  },
  {
    name: 'rtt_read',
    description: 'Read pending bytes from an RTT up-buffer (target → host).',
    toolSet: 'freeocd-rtt',
    schema: rttReadSchema,
    requiresConnection: true
  },
  {
    name: 'rtt_write',
    description: 'Write a UTF-8 string to an RTT down-buffer (host → target).',
    toolSet: 'freeocd-rtt',
    schema: rttWriteSchema,
    requiresConnection: true
  },
  {
    name: 'get_rtt_status',
    description: 'Return connected/controlBlockAddress/numBufUp/numBufDown.',
    toolSet: 'freeocd-rtt',
    schema: getRttStatusSchema
  }
];
