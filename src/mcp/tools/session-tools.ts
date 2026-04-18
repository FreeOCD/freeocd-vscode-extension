/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

import { z } from 'zod';
import type { ToolDefinition } from './tool-registry';

export const describeCapabilitiesSchema = z.object({}).strict();
export const getSessionLogSchema = z
  .object({ limit: z.number().int().min(1).max(2000).optional() })
  .strict();
export const getCommandHistorySchema = z
  .object({ count: z.number().int().min(1).max(2000).optional() })
  .strict();
export const getLastErrorSchema = z.object({}).strict();
export const clearSessionLogSchema = z.object({}).strict();

export const sessionTools: ToolDefinition[] = [
  {
    name: 'describe_capabilities',
    description:
      'One-shot overview for AI: exposed tools, tool sets, current connection/target/hex state, DAPjs version, supported targets. Use this first.',
    toolSet: 'freeocd-session',
    schema: describeCapabilitiesSchema
  },
  {
    name: 'get_session_log',
    description: 'Return the most recent command log entries across UI, MCP, tasks, and watchers.',
    toolSet: 'freeocd-session',
    schema: getSessionLogSchema
  },
  {
    name: 'get_command_history',
    description: 'Return command history with args and result summaries.',
    toolSet: 'freeocd-session',
    schema: getCommandHistorySchema
  },
  {
    name: 'get_last_error',
    description: 'Return the most recent failed command (message, stack, code).',
    toolSet: 'freeocd-session',
    schema: getLastErrorSchema
  },
  {
    name: 'clear_session_log',
    description: 'Clear the in-memory session log.',
    toolSet: 'freeocd-session',
    schema: clearSessionLogSchema
  }
];
