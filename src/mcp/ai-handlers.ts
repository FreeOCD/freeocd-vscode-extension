/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Server-side handlers for AI-assisted MCP tools.
 *
 * These handlers run in the standalone MCP server process (`mcp-server.ts`).
 * They:
 *   1. Gather context from the extension host by calling existing tools
 *      through the normal file-based IPC bridge (`forwardRequest`).
 *   2. Build a prompt and call `server.createMessage(...)` to request LLM
 *      sampling from the MCP client (VSCode Copilot / Windsurf / Cursor).
 *   3. Return a structured result.
 *
 * The first time any of these tools is invoked in a session, VS Code will
 * prompt the user to authorize the server to access their configured models
 * (per the MCP 2025-06-18 sampling specification).
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type {
  CreateMessageRequestParamsBase,
  CreateMessageResult
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Forwarder function that proxies a tool call to the extension host via the
 * file IPC bridge. Matches the signature of `forwardRequest` in
 * `mcp-server.ts`.
 */
export type ForwardRequestFn = (tool: string, args: unknown) => Promise<unknown>;

export interface AiHandlerDeps {
  server: Server;
  forward: ForwardRequestFn;
}

/** Default sampling cap — most host LLMs easily handle 2k tokens for replies. */
const DEFAULT_MAX_TOKENS = 2048;

/**
 * Model preferences biased toward an analytically-strong model. The client
 * ultimately picks; these are only hints (per MCP spec).
 */
const ANALYSIS_MODEL_HINTS: CreateMessageRequestParamsBase['modelPreferences'] = {
  hints: [{ name: 'claude' }, { name: 'gpt' }],
  intelligencePriority: 0.8,
  speedPriority: 0.3,
  costPriority: 0.2
};

// ===========================================================================
// Public dispatcher
// ===========================================================================

/**
 * Dispatch an AI / sampling tool by name. Returns the structured JSON
 * payload that will be serialized back to the MCP client.
 *
 * Throws on validation or sampling failure; the caller is responsible for
 * converting the error into an MCP `{ isError: true }` tool result.
 */
export async function dispatchAiTool(
  name: string,
  args: Record<string, unknown>,
  deps: AiHandlerDeps
): Promise<unknown> {
  switch (name) {
    case 'ai_diagnose_flash_failure':
      return diagnoseFlashFailure(args, deps);
    case 'ai_generate_target_from_datasheet':
      return generateTargetFromDatasheet(args, deps);
    case 'ai_summarize_session':
      return summarizeSession(args, deps);
    case 'ai_suggest_target_fix':
      return suggestTargetFix(args, deps);
    default:
      throw new Error(`Unhandled AI tool: ${name}`);
  }
}

// ===========================================================================
// ai_diagnose_flash_failure
// ===========================================================================

async function diagnoseFlashFailure(
  args: Record<string, unknown>,
  deps: AiHandlerDeps
): Promise<unknown> {
  const userContext = typeof args.userContext === 'string' ? args.userContext : undefined;

  // Parallel context fetch; individual failures are swallowed to `null` so
  // the LLM still sees as much partial state as possible.
  const [connection, lastError, sessionLog, capabilities] = await Promise.all([
    safeForward(deps.forward, 'get_connection_info', {}),
    safeForward(deps.forward, 'get_last_error', {}),
    safeForward(deps.forward, 'get_session_log', { limit: 20 }),
    safeForward(deps.forward, 'describe_capabilities', {})
  ]);

  const contextJson = stringifyContext({
    connection,
    lastError,
    sessionLog,
    capabilities,
    userContext
  });

  const systemPrompt = [
    'You are FreeOCD\'s on-device CMSIS-DAP diagnostics assistant.',
    'Given the JSON context, produce a root-cause analysis of the most recent',
    'flash / verify / recover failure. Respond ONLY with a single JSON object',
    'of the form:',
    '{',
    '  "likelyRootCause": string,           // one short sentence',
    '  "severity": "info" | "warning" | "error",',
    '  "evidence": string[],                // 1-5 bullet points from the context',
    '  "recommendedActions": string[],      // 1-5 concrete next steps (imperative)',
    '  "suggestedMcpTools": string[]        // FreeOCD tool names to run next',
    '}',
    '',
    'Do NOT wrap the JSON in markdown. Do NOT include commentary outside the JSON.'
  ].join('\n');

  const userPrompt = [
    'Diagnose the most recent failure using this FreeOCD session context:',
    '',
    '```json',
    contextJson,
    '```'
  ].join('\n');

  const result = await sample(deps.server, {
    systemPrompt,
    messages: [{ role: 'user', content: { type: 'text', text: userPrompt } }],
    maxTokens: DEFAULT_MAX_TOKENS,
    modelPreferences: ANALYSIS_MODEL_HINTS,
    includeContext: 'thisServer'
  });

  const text = extractText(result);
  const parsed = tryParseJsonObject(text);

  return {
    model: result.model,
    stopReason: result.stopReason,
    diagnosis: parsed ?? { raw: text },
    rawText: parsed ? undefined : text
  };
}

// ===========================================================================
// ai_generate_target_from_datasheet
// ===========================================================================

async function generateTargetFromDatasheet(
  args: Record<string, unknown>,
  deps: AiHandlerDeps
): Promise<unknown> {
  const mcuName = String(args.mcuName);
  const datasheetExcerpt = String(args.datasheetExcerpt);
  const similarTargetId =
    typeof args.similarTargetId === 'string' ? args.similarTargetId : undefined;
  const maxIterations = typeof args.maxIterations === 'number' ? args.maxIterations : 3;

  // Fetch the reference template (schema + optional similar target) up front.
  const [targetList, similarTarget] = await Promise.all([
    safeForward(deps.forward, 'list_targets', {}),
    similarTargetId
      ? safeForward(deps.forward, 'get_target_info', { id: similarTargetId })
      : Promise.resolve(null)
  ]);

  const systemPrompt = [
    'You generate FreeOCD target definition JSON from datasheet excerpts.',
    'Respond ONLY with a single JSON object — the full target definition.',
    'Required fields: id (platform/family/part), name, platform, cpu, cputapid,',
    'flashController { type, base, registers: { config: {offset, enableValue},',
    'ready: {offset} } }, flash {address,size}, sram {address,workAreaSize},',
    'capabilities (subset of flash,verify,recover,rtt,erase_page,mass_erase).',
    'Optional: ctrlAp {num,idr}, accessPort {type,num,idr}, eraseAllStatus {...},',
    'description, quirks. All numeric addresses MUST be hex strings like "0x00000000".',
    'Do NOT include usbFilters — probe filters are managed separately.',
    'Do NOT wrap the JSON in markdown or add commentary.'
  ].join('\n');

  const baseContext: Record<string, unknown> = {
    mcuName,
    availableTargets: targetList,
    similarTarget
  };

  let lastCandidate: unknown = null;
  let lastValidation: unknown = null;
  const iterations: Array<Record<string, unknown>> = [];

  for (let i = 0; i < maxIterations; i++) {
    const userPrompt = buildTargetGenerationPrompt({
      datasheetExcerpt,
      baseContext,
      previousCandidate: lastCandidate,
      previousValidation: lastValidation,
      iteration: i
    });

    const result = await sample(deps.server, {
      systemPrompt,
      messages: [{ role: 'user', content: { type: 'text', text: userPrompt } }],
      maxTokens: DEFAULT_MAX_TOKENS * 2,
      modelPreferences: ANALYSIS_MODEL_HINTS,
      includeContext: 'thisServer'
    });

    const text = extractText(result);
    const candidate = tryParseJsonObject(text);
    lastCandidate = candidate ?? text;

    if (!candidate) {
      iterations.push({ iteration: i, status: 'parse_error', raw: text.slice(0, 500) });
      continue;
    }

    const validation = (await safeForward(deps.forward, 'validate_target_definition', {
      target: candidate
    })) as { ok?: boolean; issues?: unknown; message?: string } | null;
    lastValidation = validation;
    iterations.push({
      iteration: i,
      model: result.model,
      stopReason: result.stopReason,
      status: validation?.ok ? 'valid' : 'invalid',
      issues: validation?.ok ? undefined : validation?.issues
    });
    if (validation?.ok) {
      return {
        ok: true,
        target: candidate,
        iterations
      };
    }
  }

  return {
    ok: false,
    message: `Could not converge on a valid target after ${maxIterations} iteration(s).`,
    lastCandidate,
    lastValidation,
    iterations
  };
}

function buildTargetGenerationPrompt(opts: {
  datasheetExcerpt: string;
  baseContext: Record<string, unknown>;
  previousCandidate: unknown;
  previousValidation: unknown;
  iteration: number;
}): string {
  const lines: string[] = [];
  if (opts.iteration === 0) {
    lines.push(`Generate a FreeOCD target definition for: ${String(opts.baseContext.mcuName)}`);
  } else {
    lines.push(
      `Iteration ${opts.iteration + 1}: the previous draft failed validation. Fix the reported issues and return a new JSON draft.`
    );
  }
  lines.push('', 'Context:', '```json', stringifyContext(opts.baseContext), '```');
  if (opts.previousCandidate !== null && opts.previousCandidate !== undefined) {
    lines.push(
      '',
      'Previous draft:',
      '```json',
      stringifyContext(opts.previousCandidate),
      '```'
    );
  }
  if (opts.previousValidation) {
    lines.push(
      '',
      'Previous validation result:',
      '```json',
      stringifyContext(opts.previousValidation),
      '```'
    );
  }
  lines.push('', 'Datasheet excerpt:', '```', opts.datasheetExcerpt, '```');
  return lines.join('\n');
}

// ===========================================================================
// ai_summarize_session
// ===========================================================================

async function summarizeSession(
  args: Record<string, unknown>,
  deps: AiHandlerDeps
): Promise<unknown> {
  const limit = typeof args.limit === 'number' ? args.limit : 50;
  const focus = typeof args.focus === 'string' ? args.focus : undefined;

  const sessionLog = await safeForward(deps.forward, 'get_session_log', { limit });

  const systemPrompt = [
    'You summarize FreeOCD (CMSIS-DAP flashing / debugging) session logs for developers.',
    'Produce a concise JSON object:',
    '{',
    '  "headline": string,                  // one-sentence summary',
    '  "keyEvents": string[],               // 3-7 bullet points, chronological',
    '  "errors": string[],                  // notable error messages (may be empty)',
    '  "successfulOperations": string[],    // operations that completed (may be empty)',
    '  "suggestedNextStep": string          // single recommendation',
    '}',
    '',
    'Respond ONLY with the JSON. No markdown, no prose around it.'
  ].join('\n');

  const userPrompt = [
    focus ? `Focus the summary on: ${focus}` : 'Summarize the following session log.',
    '',
    '```json',
    stringifyContext(sessionLog),
    '```'
  ].join('\n');

  const result = await sample(deps.server, {
    systemPrompt,
    messages: [{ role: 'user', content: { type: 'text', text: userPrompt } }],
    maxTokens: DEFAULT_MAX_TOKENS,
    modelPreferences: {
      hints: ANALYSIS_MODEL_HINTS?.hints,
      intelligencePriority: 0.6,
      speedPriority: 0.5,
      costPriority: 0.4
    },
    includeContext: 'thisServer'
  });

  const text = extractText(result);
  const parsed = tryParseJsonObject(text);
  return {
    model: result.model,
    stopReason: result.stopReason,
    summary: parsed ?? { raw: text }
  };
}

// ===========================================================================
// ai_suggest_target_fix
// ===========================================================================

async function suggestTargetFix(
  args: Record<string, unknown>,
  deps: AiHandlerDeps
): Promise<unknown> {
  const targetId = String(args.targetId);
  const userError = typeof args.errorMessage === 'string' ? args.errorMessage : undefined;

  const [target, sessionError] = await Promise.all([
    safeForward(deps.forward, 'get_target_info', { id: targetId }),
    userError ? Promise.resolve(null) : safeForward(deps.forward, 'get_last_error', {})
  ]);

  const systemPrompt = [
    'You propose fixes to FreeOCD target definitions (JSON).',
    'Given the current target JSON and the error, respond ONLY with a JSON object:',
    '{',
    '  "explanation": string,      // one short paragraph describing the suggested fix',
    '  "confidence": "low" | "medium" | "high",',
    '  "patch": object,            // shallow-merge patch to apply onto the target',
    '  "fullTarget": object        // the complete fixed target (patch already applied)',
    '}',
    '',
    'Preserve hex-string formatting for addresses. Do not add usbFilters.',
    'Do NOT wrap the JSON in markdown or add prose outside it.'
  ].join('\n');

  const userPrompt = [
    `Propose a fix for the FreeOCD target "${targetId}".`,
    '',
    'Current target:',
    '```json',
    stringifyContext(target),
    '```',
    '',
    'Reported error:',
    '```',
    userError ?? stringifyContext(sessionError) ?? '(no error context)',
    '```'
  ].join('\n');

  const result = await sample(deps.server, {
    systemPrompt,
    messages: [{ role: 'user', content: { type: 'text', text: userPrompt } }],
    maxTokens: DEFAULT_MAX_TOKENS * 2,
    modelPreferences: ANALYSIS_MODEL_HINTS,
    includeContext: 'thisServer'
  });

  const text = extractText(result);
  const parsed = tryParseJsonObject(text);

  let validation: unknown = null;
  if (parsed && typeof parsed === 'object' && 'fullTarget' in parsed) {
    validation = await safeForward(deps.forward, 'validate_target_definition', {
      target: (parsed as { fullTarget: unknown }).fullTarget
    });
  }

  return {
    model: result.model,
    stopReason: result.stopReason,
    suggestion: parsed ?? { raw: text },
    validation
  };
}

// ===========================================================================
// Shared helpers
// ===========================================================================

/**
 * Wrap a forwardRequest call so a failing context fetch does not abort the
 * sampling flow. Returns `null` on failure and the error message via a side
 * channel is not critical — the LLM will see "null" and can reason about it.
 */
async function safeForward(
  forward: ForwardRequestFn,
  tool: string,
  args: unknown
): Promise<unknown> {
  try {
    return await forward(tool, args);
  } catch {
    return null;
  }
}

/**
 * Issue a sampling request to the MCP client. Throws if the client rejects
 * or if the transport fails; the caller converts this into a tool error.
 */
async function sample(
  server: Server,
  params: CreateMessageRequestParamsBase
): Promise<CreateMessageResult> {
  return server.createMessage(params);
}

/**
 * Extract the first text content block from a sampling result. We ignore
 * image / audio blocks here because all FreeOCD AI tools request text-only
 * structured JSON output.
 */
function extractText(result: CreateMessageResult): string {
  if (result.content.type === 'text') {
    return result.content.text;
  }
  return '';
}

/**
 * Best-effort JSON object parser. Strips surrounding markdown code fences
 * if the model ignored our "no markdown" instruction, then tries to parse.
 * Returns `null` if the text is not a parsable JSON object.
 */
function tryParseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) {
    return null;
  }
  const trimmed = stripCodeFences(text.trim());
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function stripCodeFences(text: string): string {
  const fencePattern = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/u;
  const match = fencePattern.exec(text);
  if (match) {
    return match[1].trim();
  }
  return text;
}

/**
 * Stringify a context object for embedding in the prompt. Caps the output so
 * a pathological session log can't blow past the client's context window.
 */
function stringifyContext(value: unknown): string {
  const MAX_LEN = 12_000;
  let json: string;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    json = String(value);
  }
  if (json.length > MAX_LEN) {
    return `${json.slice(0, MAX_LEN)}\n… [truncated ${json.length - MAX_LEN} chars]`;
  }
  return json;
}
