/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * AI-assisted tools that use MCP sampling (spec 2025-06-18) to delegate
 * language-model calls back to the host client (VSCode Copilot / Windsurf /
 * Cursor).
 *
 * These tools run entirely in the standalone MCP server process. They gather
 * hardware / session context via the normal `forwardRequest` IPC path to the
 * extension host, then issue a `sampling/createMessage` back to the MCP
 * client to let the user's configured LLM reason about the context.
 *
 * All tools in this module must set `serverOnly: true` so that the extension
 * host dispatcher does not attempt to route them over IPC.
 */

import { z } from 'zod';
import type { ToolDefinition } from './tool-registry';

export const aiDiagnoseFlashFailureSchema = z
  .object({
    /**
     * Optional free-form context from the user (e.g. "started failing after
     * swapping cables"). Passed verbatim into the sampling prompt.
     */
    userContext: z.string().max(2000).optional()
  })
  .strict();

export const aiGenerateTargetFromDatasheetSchema = z
  .object({
    mcuName: z.string().min(1).max(200),
    datasheetExcerpt: z.string().min(1).max(20000),
    /** Optional FreeOCD target id to use as a structural template. */
    similarTargetId: z.string().min(1).optional(),
    /**
     * Maximum number of validate-and-refine iterations the tool may run.
     * Each iteration makes one sampling call.
     */
    maxIterations: z.number().int().min(1).max(5).optional()
  })
  .strict();

export const aiSummarizeSessionSchema = z
  .object({
    /** How many recent session log entries to include (default 50). */
    limit: z.number().int().min(1).max(500).optional(),
    /** Optional focus hint (e.g. "RTT", "flash", "recover"). */
    focus: z.string().max(200).optional()
  })
  .strict();

export const aiSuggestTargetFixSchema = z
  .object({
    targetId: z.string().min(1),
    /**
     * Optional error message or validation output to focus the suggestion on.
     * If omitted, the tool uses the most recent session error.
     */
    errorMessage: z.string().max(4000).optional()
  })
  .strict();

export const aiTools: ToolDefinition[] = [
  {
    name: 'ai_diagnose_flash_failure',
    description:
      'Diagnose the most recent flash / recover / verify failure using MCP sampling. Gathers connection info, session log, last error, and live CMSIS-DAP diagnostics, then asks the host LLM to produce a structured root-cause analysis with recommended actions.',
    toolSet: 'freeocd-ai',
    schema: aiDiagnoseFlashFailureSchema,
    serverOnly: true,
    annotations: {
      title: 'AI: Diagnose Flash Failure',
      // `readOnlyHint` as far as hardware / extension state goes —
      // the tool drives MCP sampling against the client's LLM, but it
      // does not flash, write, or otherwise change any target state.
      readOnlyHint: true,
      // LLM calls are non-deterministic, so two calls return different
      // analysis text.
      idempotentHint: false,
      // `openWorldHint` is true: the LLM is an external system over
      // which the server has no control.
      openWorldHint: true
    }
  },
  {
    name: 'ai_generate_target_from_datasheet',
    description:
      'Generate a FreeOCD target definition JSON from a datasheet excerpt by delegating to the host LLM via MCP sampling. Iterates validate-and-refine up to maxIterations times until the draft passes `validate_target_definition`.',
    toolSet: 'freeocd-ai',
    schema: aiGenerateTargetFromDatasheetSchema,
    serverOnly: true,
    annotations: {
      title: 'AI: Generate Target from Datasheet',
      readOnlyHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'ai_summarize_session',
    description:
      'Summarize the recent FreeOCD session (tool calls, errors, state transitions) using MCP sampling. Useful after a long debug session to capture what was tried and what worked.',
    toolSet: 'freeocd-ai',
    schema: aiSummarizeSessionSchema,
    serverOnly: true,
    annotations: {
      title: 'AI: Summarize Session',
      readOnlyHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'ai_suggest_target_fix',
    description:
      'Given a FreeOCD target id and (optionally) an error message, sample the host LLM for concrete JSON patch suggestions that would fix the target definition. Returns both a natural-language explanation and a machine-applicable merge patch.',
    toolSet: 'freeocd-ai',
    schema: aiSuggestTargetFixSchema,
    serverOnly: true,
    annotations: {
      title: 'AI: Suggest Target Fix',
      readOnlyHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  }
];
