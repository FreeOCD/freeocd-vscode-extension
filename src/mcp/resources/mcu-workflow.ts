/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

export const MCU_WORKFLOW = `# Adding a New MCU to FreeOCD

This document is the authoritative playbook for extending FreeOCD to a new
microcontroller. It is optimised for AI agents that drive the process via
the MCP tools.

## 1. Establish baseline

1. Call \`describe_capabilities\` to list tools and current state.
2. Call \`list_probes\` — confirm the user has a CMSIS-DAP-class probe attached.
3. If disconnected, ask the user to run \`Connect Probe\` or call \`connect_probe\`.

## 2. Gather MCU facts

For a correct target definition we need:

- **CPU core** (Cortex-M0 / M0+ / M3 / M4 / M7 / M33 / M55 / M85, or RISC-V)
- **ARM IDCODE** (the value read from DP register 0) — put it in \`cputapid\`.
- **Flash map**: start address, total size, erase granularity.
- **SRAM map**: start address, workable area size (first 16 KiB of SRAM is usually safe).
- **Flash controller model**: \`rramc\` (nRF54L), \`nvmc\` (nRF52/53), \`fmc\` (STM32 F-series), \`fpec\` (STM32 L-series), \`qspi\` (external), or a new type.
- **Access port scheme**: most ARM MCUs expose MEM-AP #0. Vendor-specific recovery uses a separate AP (e.g. Nordic CTRL-AP #2).

## 3. Draft the target JSON

Use the bundled schema:

- Fetch \`schema://target-definition\` (attach as Chat context if your client supports MCP Resources).
- Fetch \`reference://targets/nrf54l15\` for a worked example.
- Target ids are of the form \`<platform>/<family>/<mcu>\`, e.g. \`stm32/g4/stm32g491\`.
- **All addresses must be hex strings**, e.g. \`"0x5004B000"\`.
- **Do NOT include a \`usbFilters\` field.** CMSIS-DAP probe vendor IDs are
  managed centrally in \`probe-filters.json\` inside the \`freeocd-web\`
  sister project and are orthogonal to the target MCU.

## 4. Validate

Call \`validate_target_definition\` with your draft. Iterate until it passes.
The schema is permissive for \`flashController.type\`, so you can register new
controller models — but the platform handler must also know how to drive them.

## 5. Persist

Call \`create_target_definition\` to save the draft in the workspace's
extension storage (\`.../globalStorage/FreeOCD.freeocd-extension/...\`).

## 6. Dry-run

If hardware is attached, call \`test_target_definition\`. This reads:

- DP IDCODE (sanity)
- AP IDR for the declared access port
- CTRL-AP IDR (if defined)

Mismatches are surfaced as a diagnostic — do not proceed to flash if the
IDCODE or IDR do not match.

## 7. Flash end-to-end

When the dry-run passes, ask the user to point \`freeocd.hexFile\` at a
known-good firmware and call \`flash_hex\`. Finish with \`verify_hex\`.

## 8. Upstream the target

The canonical target tree lives in the \`FreeOCD/freeocd-web\` sister project
and is vendored into this extension as a git submodule at
\`vendor/freeocd-web/public/targets/\`. Both front-ends share the same JSON.

1. Open a PR against \`FreeOCD/freeocd-web\` adding the new JSON under
   \`public/targets/<platform>/<family>/<mcu>.json\` and registering its id in
   \`public/targets/index.json\`. If the MCU ships with a new CMSIS-DAP probe
   VID, also update \`public/targets/probe-filters.json\`.
2. Once that PR merges, open a PR against \`FreeOCD/freeocd-vscode-extension\`
   bumping the submodule pin (\`git submodule update --remote
   vendor/freeocd-web\`). The
   \`.github/ISSUE_TEMPLATE/new_mcu_support.yml\` form covers the information
   reviewers need.
3. If a brand-new platform handler is required, split that into a separate
   PR in the extension repository (\`src/target/<platform>-handler.ts\` +
   registration in \`PLATFORM_HANDLERS\`).
`;
