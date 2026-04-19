/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Standalone MCP server. Runs as a child process launched by the IDE's MCP
 * client (VSCode Copilot agent, Windsurf Cascade, Cursor, Cline).
 *
 * Architecture:
 *   1. This server owns **no hardware state**. It forwards each tool call
 *      as a file-based request/response round-trip to the extension host,
 *      which actually owns the probe.
 *   2. Tool, prompt, and resource definitions are embedded at build time so
 *      the server needs no filesystem beyond `FREEOCD_IPC_DIR`.
 *   3. The extension passes `FREEOCD_IPC_DIR` and `FREEOCD_EXTENSION_DIR`
 *      via the `mcpServerDefinitionProvider` contribution (or the
 *      `freeocd.setupMcp` clipboard payload for manual IDE setup).
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { connectionTools } from './tools/connection-tools';
import { targetTools } from './tools/target-tools';
import { flashTools } from './tools/flash-tools';
import { rttTools } from './tools/rtt-tools';
import { dapTools } from './tools/dap-tools';
import { processorTools } from './tools/processor-tools';
import { sessionTools } from './tools/session-tools';
import { aiTools } from './tools/ai-tools';
import type { ToolDefinition } from './tools/tool-registry';
import { PROMPTS } from './prompts';
import { buildStaticResources } from './resources';
import { dispatchAiTool } from './ai-handlers';

// Injected by webpack.DefinePlugin
declare const EXTENSION_VERSION: string;

const IPC_DIR = process.env.FREEOCD_IPC_DIR;
const REQUEST_TIMEOUT_MS = Number(process.env.FREEOCD_REQUEST_TIMEOUT_MS ?? '120000');

if (!IPC_DIR) {
  console.error('[freeocd-mcp] FREEOCD_IPC_DIR environment variable is not set. Aborting.');
  process.exit(2);
}

// Per-request filenames so concurrent tool calls don't clobber each other.
// The extension-side `McpBridge` watches `request-*.json` and writes the
// matching `response-<requestId>.json`.
const STATUS_FILE = path.join(IPC_DIR, 'status.json');

function requestFileFor(requestId: string): string {
  return path.join(IPC_DIR!, `request-${requestId}.json`);
}

function responseFileFor(requestId: string): string {
  return path.join(IPC_DIR!, `response-${requestId}.json`);
}

const ALL_TOOLS: ToolDefinition[] = [
  ...connectionTools,
  ...targetTools,
  ...flashTools,
  ...rttTools,
  ...dapTools,
  ...processorTools,
  ...sessionTools,
  ...aiTools
];

const SERVER_INSTRUCTIONS = [
  'FreeOCD exposes every DAP.js capability plus target/flash/RTT/session tools.',
  '',
  'Suggested workflow for an unsupported MCU:',
  '  1. `describe_capabilities` → inventory tools and state',
  '  2. `list_targets` / `get_target_info` → inspect the closest existing target',
  '  3. `create_target_definition` (draft) → `validate_target_definition`',
  '  4. `test_target_definition` on connected hardware (dry-run)',
  '  5. `flash_hex` → `verify_hex`',
  '',
  'Tools are grouped into Tool Sets:',
  '  - #freeocd-flash    (flash / verify / recover / get_flash_progress / set_auto_flash_watch / soft_reset)',
  '  - #freeocd-rtt      (rtt_connect / rtt_read / rtt_write / get_rtt_status)',
  '  - #freeocd-target   (list_targets / get_target_info / create_target_definition / ...)',
  '  - #freeocd-low-level (dap_* / processor_*)',
  '  - #freeocd-session  (describe_capabilities / get_session_log / get_last_error)',
  '  - #freeocd-ai       (ai_diagnose_flash_failure / ai_generate_target_from_datasheet /',
  '                       ai_summarize_session / ai_suggest_target_fix)',
  '',
  'AI tools (prefix `ai_`) use MCP sampling to delegate reasoning back to your',
  'host LLM. The first call will prompt you to authorize model access.'
].join('\n');

async function main(): Promise<void> {
  const server = new Server(
    {
      name: 'freeocd',
      version: EXTENSION_VERSION
    },
    {
      // `sampling` is a CLIENT capability (the client answers the
      // server-initiated `sampling/createMessage` request), so we do not
      // declare it here. The `ai_*` tools in `ai-handlers.ts` simply call
      // `server.createMessage(...)` and surface a tool error if the host
      // client does not support sampling.
      capabilities: {
        tools: {},
        prompts: {},
        resources: {}
      },
      instructions: SERVER_INSTRUCTIONS
    }
  );

  const resources = buildStaticResources();

  // --------------------------------------------------------------------------
  // Tools
  // --------------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: jsonSchemaFor(tool.name)
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = ALL_TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      return toolError(`Unknown tool: ${request.params.name}`);
    }
    const parseResult = tool.schema.safeParse(request.params.arguments ?? {});
    if (!parseResult.success) {
      return toolError(
        `Argument validation failed: ${parseResult.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`
      );
    }
    try {
      // `serverOnly` tools (the `ai_*` family) run entirely in this process
      // because they drive MCP sampling against the host client. They may
      // still call `forwardRequest` internally to gather extension-host
      // context (session log, target info, etc.).
      const result = tool.serverOnly
        ? await dispatchAiTool(
            tool.name,
            parseResult.data as Record<string, unknown>,
            { server, forward: forwardRequest }
          )
        : await forwardRequest(tool.name, parseResult.data);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (err) {
      return toolError((err as Error).message);
    }
  });

  // --------------------------------------------------------------------------
  // Prompts
  // --------------------------------------------------------------------------
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments.map((a) => ({
        name: a.name,
        description: a.description,
        required: Boolean(a.required)
      }))
    }))
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = PROMPTS.find((p) => p.name === request.params.name);
    if (!prompt) {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    const args = (request.params.arguments ?? {}) as Record<string, string | undefined>;
    const body = prompt.render(args);
    return {
      description: prompt.description,
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: body }
        }
      ]
    };
  });

  // --------------------------------------------------------------------------
  // Resources
  // --------------------------------------------------------------------------
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType
    }))
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const res = resources.find((r) => r.uri === request.params.uri);
    if (!res) {
      // Dynamic resource: logs://session-log
      if (request.params.uri === 'logs://session-log') {
        const log = await forwardRequest('get_session_log', { limit: 200 }).catch(() => []);
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: 'application/json',
              text: JSON.stringify(log, null, 2)
            }
          ]
        };
      }
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }
    const text = await res.read();
    return {
      contents: [{ uri: res.uri, mimeType: res.mimeType, text }]
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[freeocd-mcp] Fatal error:', err);
  process.exit(1);
});

// ============================================================================
// Helpers
// ============================================================================

function toolError(message: string): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  return {
    isError: true,
    content: [{ type: 'text', text: message }]
  };
}

function jsonSchemaFor(toolName: string): Record<string, unknown> {
  // Minimal fallback schema — the authoritative schema is the Zod one,
  // which we validate above. We expose a lax inputSchema so older MCP
  // clients that can't parse Zod still accept any JSON object.
  void toolName;
  return {
    type: 'object',
    additionalProperties: true
  };
}

interface ForwardRequest {
  requestId: string;
  tool: string;
  args?: Record<string, unknown>;
  timestamp: string;
}

interface ForwardResponse {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: { message: string; code?: string; stack?: string };
}

async function forwardRequest(tool: string, args: unknown): Promise<unknown> {
  const requestId = randomUUID();
  const req: ForwardRequest = {
    requestId,
    tool,
    args: args as Record<string, unknown>,
    timestamp: new Date().toISOString()
  };
  const requestFile = requestFileFor(requestId);
  const responseFile = responseFileFor(requestId);
  const requestTmp = `${requestFile}.tmp`;

  fs.mkdirSync(IPC_DIR!, { recursive: true });
  // Atomic write of the request: write to a sibling tmp file, then rename.
  // This ensures the extension's watcher never reads a partial JSON document
  // (which would previously force a fragile "Unexpected" error retry loop).
  fs.writeFileSync(requestTmp, JSON.stringify(req, null, 2));
  fs.renameSync(requestTmp, requestFile);

  try {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(50);
      if (!fs.existsSync(responseFile)) {
        continue;
      }
      // Parse the response in its own try/catch so that only real JSON parse
      // errors (SyntaxError from partial reads during an atomic rename) are
      // retried. Application errors that happen to mention "JSON" in their
      // message must propagate out instead of silently spinning until timeout.
      const raw = fs.readFileSync(responseFile, 'utf8');
      let resp: ForwardResponse;
      try {
        resp = JSON.parse(raw) as ForwardResponse;
      } catch (err) {
        if (err instanceof SyntaxError) {
          // Partial read during the extension's atomic rename is unlikely but
          // possible on unusual filesystems — retry on JSON parse errors.
          continue;
        }
        throw err;
      }
      if (resp.requestId !== requestId) {
        // Defensive: file should always match because it's uniquely named.
        continue;
      }
      if (!resp.success) {
        const msg = resp.error?.message ?? 'Unknown error';
        throw new Error(msg);
      }
      return resp.result;
    }
    throw new Error(`Timed out waiting for extension host response for ${tool}`);
  } finally {
    // Best-effort cleanup so stale files don't accumulate in IPC_DIR.
    for (const file of [responseFile, requestFile, requestTmp]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Already gone (extension host or previous iteration cleaned it up).
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Suppress "unused STATUS_FILE" — reserved for future status streaming.
void STATUS_FILE;
