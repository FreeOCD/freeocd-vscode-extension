/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * MCP Prompts (VSCode 1.101+ / MCP spec 2025-03-26).
 *
 * Each prompt is a reusable, parameterized instruction template that a user
 * invokes from Chat as `/mcp.freeocd.<name>`. The server returns a
 * `messages` array that the host LLM evaluates as if the user had typed it.
 *
 * Design goals (model-agnostic — must work equally well on Copilot, Claude,
 * GPT, Gemini, and local models behind Cline-style clients):
 *   - Self-contained plain markdown: no vendor-specific syntax, no reliance
 *     on the client injecting extra system context.
 *   - Explicit tool protocol: every step names the exact MCP tool to call
 *     and what to extract from its result, so weaker models can follow the
 *     procedure mechanically while stronger models can shortcut safely.
 *   - Grounding rules: models must derive register addresses / IDs only
 *     from tool results, resources, or user-provided datasheets — never
 *     from memory. Embedded flash controllers vary per die revision, so a
 *     hallucinated address can brick hardware.
 *   - Safety gates: destructive operations (recover / mass erase / flash)
 *     always require explicit user confirmation before the tool call.
 *   - Bounded loops: every retry loop has a max attempt count and a defined
 *     "stop and report" exit so agents cannot spin on a dead probe.
 */

export interface PromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptDefinition {
  name: string;
  /** Human-readable display name shown by clients (MCP `title`). */
  title: string;
  description: string;
  arguments: PromptArgument[];
  /**
   * Render the prompt body. Receives the argument map (may include
   * `undefined` values if the caller omitted optional args).
   */
  render(args: Record<string, string | undefined>): string;
}

/**
 * Shared ground rules injected into every prompt. Kept short and imperative:
 * long rule lists degrade instruction-following on smaller models.
 */
const GROUND_RULES = [
  '## Ground rules (follow strictly)',
  '- Call exactly one FreeOCD MCP tool at a time and read its result before deciding the next step.',
  '- NEVER invent or recall register addresses, IDR values, AP numbers, or memory maps from memory. Use only values obtained from tool results, FreeOCD resources (`freeocd://status`, `freeocd://targets/{id}`, `schema://target-definition`), or text the user provided.',
  '- Write all addresses and register values as hex strings, e.g. `"0x00000000"`.',
  '- Destructive operations (`recover`, mass erase, `flash_hex` over unknown firmware) — ask the user for explicit confirmation first, stating what will be erased.',
  '- After any tool error: call `get_last_error`, adjust once or twice at most, then stop and report what you tried and what failed. Do not retry the same call more than 2 times.',
  '- If hardware is required but `get_connection_info` shows no probe, stop and tell the user which cable/probe to attach instead of guessing.'
].join('\n');

const REPORT_FORMAT = [
  '## Final report format',
  'End with a short markdown report:',
  '- **Result**: success / partial / blocked',
  '- **What was done**: tool calls that mattered, with key values',
  '- **Root cause / findings** (if diagnosing)',
  '- **Next action for the user**: one concrete, copy-pastable step'
].join('\n');

const ADD_NEW_MCU_SUPPORT: PromptDefinition = {
  name: 'add_new_mcu_support',
  title: 'Add New MCU Support',
  description:
    'Guide the AI through adding support for a new MCU: capability check → reference target → draft → validate → test → flash.',
  arguments: [
    {
      name: 'datasheet_url',
      description: 'Optional URL to the MCU datasheet (PDF or HTML).',
      required: false
    },
    {
      name: 'similar_mcu',
      description:
        'Optional FreeOCD target id of a similar MCU to use as a template (completions available).',
      required: false
    }
  ],
  render: (args) => {
    const hints = [
      args.datasheet_url ? `- Datasheet: ${args.datasheet_url}` : undefined,
      args.similar_mcu ? `- Reference target: \`${args.similar_mcu}\`` : undefined
    ]
      .filter(Boolean)
      .join('\n');

    return [
      '# Task: add FreeOCD support for a new MCU',
      '',
      'You are an embedded-debug engineer extending FreeOCD (a CMSIS-DAP flash/debug tool) with a new ARM Cortex-M target definition.',
      '',
      hints ? `## Provided context\n${hints}` : undefined,
      '',
      GROUND_RULES,
      '',
      '## Procedure',
      '1. Call `describe_capabilities` → note connection state and which tools are usable right now.',
      '2. Call `list_targets`, then `get_target_info` on the closest existing target (use the reference target above if given). Study the exact JSON shape — your draft must match it field-for-field.',
      '3. Read the `schema://target-definition` resource; treat it as the authoritative schema.',
      '4. Draft the new target JSON:',
      '   - `id` format: `<platform>/<family>/<mcu>` (lowercase).',
      '   - Every address/IDR value must come from the datasheet or the reference target — if a value is unknown, ask the user rather than guessing.',
      '   - Do NOT add `usbFilters` (probe USB IDs are managed centrally and are orthogonal to the target MCU).',
      '5. Call `validate_target_definition` with the draft. Fix every reported issue and re-validate (max 3 iterations, then report).',
      '6. Call `create_target_definition` to persist the draft.',
      '7. Hardware dry-run (only if a probe is connected): call `test_target_definition` — it reads IDCODE and CTRL-AP IDR without writing anything. Compare returned IDCODE against the draft `cputapid`.',
      '8. End-to-end check (only with explicit user confirmation, since it writes flash): `flash_hex` with a user-supplied known-good .hex, then `verify_hex`.',
      '',
      REPORT_FORMAT
    ]
      .filter((line) => line !== undefined)
      .join('\n');
  }
};

const DEBUG_FLASH_ERROR: PromptDefinition = {
  name: 'debug_flash_error',
  title: 'Debug Flash Failure',
  description:
    'Investigate the latest flash / recover failure using session history and low-level DAP probes.',
  arguments: [
    {
      name: 'error_context',
      description: 'Optional additional context (e.g. "only fails after recover").',
      required: false
    }
  ],
  render: (args) => {
    return [
      '# Task: root-cause a flash / recover failure',
      '',
      'You are an embedded-debug engineer. A FreeOCD flash or recover operation failed; find the most specific root cause supported by evidence, then recommend one concrete fix.',
      args.error_context ? `\n## User-provided context\n${args.error_context}` : '',
      '',
      GROUND_RULES,
      '',
      '## Procedure (stop as soon as the evidence pinpoints the cause)',
      '1. `get_last_error` → record the exact error message and code.',
      '2. `get_session_log` (limit 20) → what sequence of operations led to the failure? Note any earlier warnings.',
      '3. Read `freeocd://status` and call `list_probes` → is the probe attached, is a target selected?',
      '4. If connected: `dap_info` with key `0xF0` → record probe capabilities and firmware version.',
      '5. `dap_read_dp` reg `0x0` (IDCODE) → compare against the selected target\'s `cputapid` from `get_target_info`. A mismatch means wrong target selection or a wired-but-unpowered board.',
      '6. If the target defines a CTRL-AP: `dap_read_ap` on that AP num, check IDR. IDR readable but flash writes failing usually means approtect/lock → the fix is `recover` (destructive: confirm with the user first).',
      '7. Classify the cause as one of: (a) no/flaky probe connection, (b) wrong target definition, (c) locked/protected device, (d) power/reset issue, (e) firmware image problem (bad .hex range), (f) transient — and say which evidence supports it.',
      '',
      '## Common fixes to recommend (pick ONE that matches the evidence)',
      '- Locked device → run `recover` (after user confirmation).',
      '- IDCODE mismatch → select the correct target or check board power.',
      '- Intermittent DAP errors → reseat USB / lower SWJ clock.',
      '- Hex range outside `flash.address`+`flash.size` → rebuild firmware with correct memory map.',
      '',
      REPORT_FORMAT
    ]
      .filter(Boolean)
      .join('\n');
  }
};

const CREATE_TARGET_FROM_DATASHEET: PromptDefinition = {
  name: 'create_target_from_datasheet',
  title: 'Create Target From Datasheet',
  description:
    'Extract CTRL-AP / MEM-AP / flash controller parameters from a datasheet snippet and generate a FreeOCD target JSON draft.',
  arguments: [
    {
      name: 'mcu_name',
      description: 'Human-readable MCU name (e.g. "nRF54L15", "STM32G491").',
      required: true
    },
    {
      name: 'datasheet_text',
      description: 'Pasted datasheet excerpt (register map, flash programming section).',
      required: true
    }
  ],
  render: (args) => {
    return [
      `# Task: create a FreeOCD target definition for **${args.mcu_name ?? '(name missing)'}**`,
      '',
      'You are an embedded-debug engineer. Extract debug/flash parameters from the datasheet excerpt below and produce a schema-valid FreeOCD target JSON.',
      '',
      GROUND_RULES,
      '',
      '## Extraction rules',
      '- Use ONLY values present in the datasheet excerpt (or explicitly confirmed by the user). If a required field is not in the excerpt, set it to `null` and list it under "Missing fields" in your report — do NOT fill it from memory.',
      '- Read the `schema://target-definition` resource first; it is the authoritative schema.',
      '',
      '## Fields to extract',
      '- `platform` (e.g. nordic / stm32 / rp2040)',
      '- `cpu` (e.g. cortex-m33)',
      '- `cputapid` (hex, from the ARM IDCODE / DAP section)',
      '- `ctrlAp` (num, idr) OR `accessPort` (type, num, idr)',
      '- `flashController` { type, base, registers.config.offset, registers.config.enableValue, registers.ready.offset }',
      '- `flash` { address, size }',
      '- `sram` { address, workAreaSize }',
      '- `capabilities` (subset of flash / verify / recover / rtt / erase_page / mass_erase)',
      '',
      'Do NOT add a `usbFilters` field: CMSIS-DAP probe USB vendor IDs are managed centrally in `vendor/freeocd-web/public/targets/probe-filters.json`; probes are orthogonal to the target MCU.',
      '',
      '## Output',
      '1. The draft as a single JSON code block (id format `<platform>/<family>/<mcu>`, all addresses as hex strings).',
      '2. Then call `validate_target_definition` with the draft and fix any reported issues (max 3 iterations).',
      '3. Finish with the report, including a "Missing fields" list the user must supply before hardware testing.',
      '',
      REPORT_FORMAT,
      '',
      '--- DATASHEET EXCERPT BEGIN ---',
      args.datasheet_text ?? '(no datasheet text provided)',
      '--- DATASHEET EXCERPT END ---'
    ].join('\n');
  }
};

const TROUBLESHOOT_RTT: PromptDefinition = {
  name: 'troubleshoot_rtt',
  title: 'Troubleshoot RTT',
  description:
    'Walk through common causes when RTT fails to attach or produces no output.',
  arguments: [
    {
      name: 'symptom',
      description:
        'Optional short description of the symptom (e.g. "no up buffer", "control block not found").',
      required: false
    }
  ],
  render: (args) => {
    return [
      '# Task: diagnose an RTT (SEGGER Real Time Transfer) problem',
      '',
      'You are an embedded-debug engineer. RTT locates a `_SEGGER_RTT` control block in target SRAM and exchanges data through ring buffers; failures are almost always one of: control block not present, wrong scan range, halted core, or firmware not writing.',
      args.symptom ? `\n## Reported symptom\n${args.symptom}` : '',
      '',
      GROUND_RULES,
      '',
      '## Procedure (stop at the first step that reveals the cause)',
      '1. `get_rtt_status` → are we already connected? How many up/down buffers?',
      '2. `get_target_info` → record `sram.address` and `sram.workAreaSize`.',
      '3. Not connected? Call `rtt_connect` with `scanStart` = the target\'s `sram.address` and `scanRange` = `0x10000`. Note: this soft-resets and briefly halts the core — warn the user if their firmware must not restart.',
      '4. Control block not found → the firmware likely never initializes RTT. Ask the user: does `main()` call `SEGGER_RTT_Init()` (or write via `SEGGER_RTT_printf`) early? Is the RTT section linked into RAM covered by the scan range?',
      '5. Control block found but 0 up buffers → RTT is linked but no buffer configured; check `SEGGER_RTT_ALLOC_UPBUFFER` / buffer count config.',
      '6. Connected but no data → call `processor_is_halted`; a halted core writes nothing. If halted, `processor_resume`. Also confirm the firmware actually logs on the expected channel (channel 0 by default).',
      '7. Reads fail intermittently → check `freeocd://status` for connection drops; recommend reseating the probe or lowering the SWJ clock.',
      '',
      'Cite the relevant SEGGER RTT manual section when recommending firmware-side changes.',
      '',
      REPORT_FORMAT
    ]
      .filter(Boolean)
      .join('\n');
  }
};

export const PROMPTS: PromptDefinition[] = [
  ADD_NEW_MCU_SUPPORT,
  DEBUG_FLASH_ERROR,
  CREATE_TARGET_FROM_DATASHEET,
  TROUBLESHOOT_RTT
];
