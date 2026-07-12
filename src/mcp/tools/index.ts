/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Single source of truth for the MCP tool catalog.
 *
 * Both the standalone MCP server (`mcp-server.ts`) and the extension-host
 * dispatcher (`tool-handlers.ts`) consume these arrays so the tool list can
 * never drift between the two processes.
 */

import { connectionTools } from './connection-tools';
import { targetTools } from './target-tools';
import { flashTools } from './flash-tools';
import { rttTools } from './rtt-tools';
import { dapTools } from './dap-tools';
import { processorTools } from './processor-tools';
import { sessionTools } from './session-tools';
import { aiTools } from './ai-tools';
import type { ToolDefinition } from './tool-registry';

/** Every tool the MCP server exposes, including the `serverOnly` `ai_*` family. */
export const ALL_TOOLS: ToolDefinition[] = [
  ...connectionTools,
  ...targetTools,
  ...flashTools,
  ...rttTools,
  ...dapTools,
  ...processorTools,
  ...sessionTools,
  ...aiTools
];

/**
 * Tools dispatched inside the extension host. `serverOnly` tools (the
 * `ai_*` family) run entirely in the MCP server process and are excluded.
 */
export const EXTENSION_TOOLS: ToolDefinition[] = ALL_TOOLS.filter((t) => !t.serverOnly);
