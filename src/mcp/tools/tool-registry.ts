/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Declarative registry for MCP tool definitions.
 *
 * Each tool ships with a Zod schema (runtime validation) and belongs to one
 * of the Chat Tool Sets defined in the bundled
 * `resources/tool-sets/freeocd.toolsets.jsonc` (freeocd-flash / freeocd-rtt /
 * freeocd-target / freeocd-low-level / freeocd-session). VS Code 1.101+ does
 * not expose a `contributes.chatToolSets` manifest entry, so users import the
 * bundled file via the "Configure Tool Sets" command. See README.md for the
 * full installation walkthrough.
 */

import type { ZodType } from 'zod';

export type ToolSetName =
  | 'freeocd-flash'
  | 'freeocd-rtt'
  | 'freeocd-target'
  | 'freeocd-low-level'
  | 'freeocd-session'
  | 'freeocd-ai';

export interface ToolDefinition<TArgs = unknown, _TResult = unknown> {
  name: string;
  description: string;
  toolSet: ToolSetName;
  schema: ZodType<TArgs>;
  /** Requires an active probe connection. */
  requiresConnection?: boolean;
  /** Requires a selected target MCU. */
  requiresTarget?: boolean;
  /**
   * If true, this tool runs entirely in the standalone MCP server process
   * (typically because it uses MCP sampling) and is NOT forwarded to the
   * extension host. AI / sampling tools must set this flag.
   */
  serverOnly?: boolean;
}

export type ToolDef = ToolDefinition<any, any>;
