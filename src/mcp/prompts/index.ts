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
 * We deliberately keep prompts self-contained (plain markdown with placeholder
 * substitution) so the same bundle works across VSCode Copilot, Windsurf
 * Cascade, Cursor, and any Cline-style MCP client.
 */

export interface PromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments: PromptArgument[];
  /**
   * Render the prompt body. Receives the argument map (may include
   * `undefined` values if the caller omitted optional args).
   */
  render(args: Record<string, string | undefined>): string;
}

const ADD_NEW_MCU_SUPPORT: PromptDefinition = {
  name: 'add_new_mcu_support',
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
      description: 'Optional FreeOCD target id of a similar MCU to use as a template.',
      required: false
    }
  ],
  render: (args) => {
    const hints = [
      args.datasheet_url ? `Datasheet: ${args.datasheet_url}` : undefined,
      args.similar_mcu ? `Reference target: ${args.similar_mcu}` : undefined
    ]
      .filter(Boolean)
      .join('\n');

    return [
      'You are helping extend FreeOCD to support a new MCU.',
      '',
      hints,
      '',
      'Follow this sequence and call MCP tools explicitly:',
      '1. Call `describe_capabilities` to learn the currently exposed tools and connection state.',
      '2. Call `list_targets` and pick the closest existing target for comparison.',
      '3. Call `get_target_info` with that id and study the JSON shape.',
      '4. Draft a new target JSON (id: `<platform>/<family>/<mcu>`, all addresses in hex strings).',
      '5. Call `validate_target_definition` with your draft and fix any issues reported.',
      '6. Call `create_target_definition` to persist the draft in workspaceStorage.',
      '7. If a probe is connected, call `test_target_definition` for a dry-run (IDR + CTRL-AP reads).',
      '8. If dry-run passes, call `flash_hex` with a known-good .hex to verify the end-to-end flow.',
      '',
      'If any step fails, call `get_last_error` and iterate on the JSON until it passes.'
    ]
      .filter((line) => line !== undefined)
      .join('\n');
  }
};

const DEBUG_FLASH_ERROR: PromptDefinition = {
  name: 'debug_flash_error',
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
      'A flash or recover operation failed. Help me find the root cause.',
      args.error_context ? `Additional context from the user: ${args.error_context}` : '',
      '',
      'Investigate in this order (stop as soon as you find the cause):',
      '1. Call `get_last_error` for the most recent failure.',
      '2. Call `get_session_log` (limit 20) to see the preceding tool calls.',
      '3. Call `get_connection_info` and `list_probes` to confirm hardware is attached.',
      '4. If connected, call `dap_info` with key=0xF0 (capabilities) and report firmware version.',
      '5. Call `dap_read_dp` reg=0 (IDCODE) and check it matches the target\'s `cputapid`.',
      '6. If CTRL-AP is relevant, call `dap_read_ap` with the target\'s CTRL-AP num and check IDR.',
      '7. Recommend a concrete next action (e.g. "run `recover`", "reconnect the probe", "lower SWJ clock").'
    ]
      .filter(Boolean)
      .join('\n');
  }
};

const CREATE_TARGET_FROM_DATASHEET: PromptDefinition = {
  name: 'create_target_from_datasheet',
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
      `Create a FreeOCD target definition JSON for the MCU: ${args.mcu_name ?? '(name missing)'}.`,
      '',
      'Use the attached `schema://target-definition` resource if available.',
      '',
      'Extract these fields from the datasheet text below:',
      '- `platform` (e.g. nordic / stm32 / rp2040)',
      '- `cpu` (e.g. cortex-m33)',
      '- `cputapid` (hex, from the ARM IDCODE section)',
      '- `ctrlAp` (num, idr) OR `accessPort` (type, num, idr)',
      '- `flashController` { type, base, registers.config.offset, registers.config.enableValue, registers.ready.offset }',
      '- `flash` { address, size }',
      '- `sram` { address, workAreaSize }',
      '- `capabilities` (subset of flash / verify / recover / rtt / erase_page / mass_erase)',
      '',
      'Do NOT add a `usbFilters` field to the target JSON. CMSIS-DAP probe',
      'USB vendor IDs are managed centrally in',
      '`vendor/freeocd-web/public/targets/probe-filters.json`; probes are',
      'orthogonal to the target MCU.',
      '',
      'Output the draft as a single JSON code block. Then call `validate_target_definition` to check it.',
      '',
      '--- DATASHEET EXCERPT BEGIN ---',
      args.datasheet_text ?? '(no datasheet text provided)',
      '--- DATASHEET EXCERPT END ---'
    ].join('\n');
  }
};

const TROUBLESHOOT_RTT: PromptDefinition = {
  name: 'troubleshoot_rtt',
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
      'Help me diagnose RTT.',
      args.symptom ? `Reported symptom: ${args.symptom}` : '',
      '',
      '1. Call `get_rtt_status` to see if we believe we are connected.',
      '2. Call `get_target_info` to confirm `sram.address` and `sram.workAreaSize`.',
      '3. Call `rtt_connect` with `scanStart` = target.sram.address and `scanRange` = 0x10000.',
      '4. If the control block is still not found, ask the user if the firmware calls `SEGGER_RTT_Init` early in `main()`.',
      '5. If control block is found but 0 buffers, ask about `SEGGER_RTT_printf` / buffer configuration.',
      '6. If reading bytes fails, verify the processor is not halted (`processor_is_halted`).',
      '7. Suggest concrete remediation and cite the relevant SEGGER RTT manual section.'
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
