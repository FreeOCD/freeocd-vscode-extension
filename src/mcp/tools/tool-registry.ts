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
 *
 * Tool annotations follow the MCP 2025-11-25 spec. They're **hints** (not
 * enforceable contracts); clients use them to decide auto-approval, UI
 * affordances, etc. Setting them accurately is the single biggest UX win
 * an MCP server can give an agent — e.g. a correctly-annotated read-only
 * `list_targets` can skip the "allow this tool?" prompt in Copilot agent
 * mode while still gating `recover` (destructive) behind confirmation.
 */

import type { ZodType } from 'zod';

export type ToolSetName =
  | 'freeocd-flash'
  | 'freeocd-rtt'
  | 'freeocd-target'
  | 'freeocd-low-level'
  | 'freeocd-session'
  | 'freeocd-ai';

/**
 * MCP 2025-11-25 tool behavior hints. All fields are optional and all are
 * untrusted by the client unless the server is trusted — we set them
 * honestly so clients that do trust us (e.g. Copilot) can give users a
 * better permission / confirmation experience.
 */
export interface ToolAnnotations {
  /** Human-readable display name (e.g. "Flash Target"). */
  title?: string;
  /** Tool does not modify any state (safe to call without confirmation). */
  readOnlyHint?: boolean;
  /**
   * Tool may perform destructive operations (mass erase, unlock, etc.).
   * Clients should gate invocation behind explicit user confirmation.
   * Only meaningful when `readOnlyHint` is `false` or unset.
   */
  destructiveHint?: boolean;
  /**
   * Calling the tool repeatedly with the same args produces the same
   * effect (e.g. writing the same hex yields the same flash state).
   */
  idempotentHint?: boolean;
  /**
   * Tool interacts with an "open world" (remote hosts, user filesystem,
   * attached hardware). For FreeOCD this is `true` whenever the tool
   * touches the physical probe / target.
   */
  openWorldHint?: boolean;
}

export interface ToolDefinition<TArgs = unknown, _TResult = unknown> {
  name: string;
  description: string;
  toolSet: ToolSetName;
  schema: ZodType<TArgs>;
  /**
   * Optional MCP behavior hints. Highly recommended for any non-trivial
   * tool — clients use these to decide auto-approval, icons, etc.
   */
  annotations?: ToolAnnotations;
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
