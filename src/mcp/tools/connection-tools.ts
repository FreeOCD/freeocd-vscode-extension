/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

import { z } from 'zod';
import type { ToolDefinition } from './tool-registry';

export const listConnectionMethodsSchema = z.object({}).strict();
export const listProbesSchema = z.object({}).strict();
export const connectProbeSchema = z
  .object({
    vendorId: z.number().int().optional(),
    productId: z.number().int().optional(),
    serialNumber: z.string().optional(),
    path: z.string().optional()
  })
  .strict();
export const disconnectProbeSchema = z.object({}).strict();
export const getConnectionInfoSchema = z.object({}).strict();

export const connectionTools: ToolDefinition[] = [
  {
    name: 'list_connection_methods',
    description: 'List transport methods available in this build (e.g. "hid").',
    toolSet: 'freeocd-session',
    schema: listConnectionMethodsSchema,
    annotations: {
      title: 'List Connection Methods',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'list_probes',
    description: 'Enumerate CMSIS-DAP probes currently attached to the host.',
    toolSet: 'freeocd-session',
    schema: listProbesSchema,
    annotations: {
      title: 'List CMSIS-DAP Probes',
      readOnlyHint: true,
      // Enumeration reads from USB and may differ between calls as the user
      // plugs / unplugs probes, so it is not idempotent even though it is
      // read-only.
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'connect_probe',
    description:
      'Open a connection to a CMSIS-DAP probe. Match by vendorId/productId/serial/path.',
    toolSet: 'freeocd-session',
    schema: connectProbeSchema,
    annotations: {
      title: 'Connect to Probe',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  {
    name: 'disconnect_probe',
    description: 'Close the current probe connection.',
    toolSet: 'freeocd-session',
    schema: disconnectProbeSchema,
    requiresConnection: true,
    annotations: {
      title: 'Disconnect Probe',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  {
    name: 'get_connection_info',
    description: 'Return the current connection state, method, probe metadata, and last error.',
    toolSet: 'freeocd-session',
    schema: getConnectionInfoSchema,
    annotations: {
      title: 'Get Connection Info',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  }
];
