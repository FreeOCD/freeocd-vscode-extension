# FreeOCD VSCode Extension

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/FreeOCD/freeocd-vscode-extension)
[![CI](https://github.com/FreeOCD/freeocd-vscode-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/FreeOCD/freeocd-vscode-extension/actions/workflows/ci.yml)
[![Release](https://github.com/FreeOCD/freeocd-vscode-extension/actions/workflows/release.yml/badge.svg)](https://github.com/FreeOCD/freeocd-vscode-extension/actions/workflows/release.yml)
[![License: BSD-3-Clause](https://img.shields.io/badge/License-BSD%203--Clause-blue.svg)](LICENSE)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/FreeOCD.freeocd-extension?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=FreeOCD.freeocd-extension)
[![Open VSX](https://img.shields.io/open-vsx/v/FreeOCD/freeocd-extension?label=Open%20VSX)](https://open-vsx.org/extension/FreeOCD/freeocd-extension)

Open-source CMSIS-DAP flasher, verifier, and RTT debugger for embedded
development — powered by [DAP.js] and integrated with every MCP-capable IDE
(VS Code Copilot, Windsurf, Cursor, Cline) so AI agents can drive your
hardware the same way you do.

## Design Philosophy

A debugger is a tool that developers place their trust in during the most
critical moments of development. We hold ourselves to that standard:

- **Reliability** — Every flash and recover operation must complete correctly,
  or fail explicitly with clear guidance
- **Stability** — Robust error recovery, bounded timeouts, and concurrency
  guards ensure the tool never hangs or leaves a device in an unknown state
- **Security** — All user inputs are validated; no external network requests;
  least-privilege CI/CD; MCP tools run in isolated subprocess
- **Compatibility** — Clean VS Code API feature detection, graceful degradation,
  and a modular architecture that welcomes new targets and platforms
- **Performance** — Responsive UI using VS Code's native components that never
  blocks during long operations; lazy-loaded DAPjs for fast activation

## Highlights

- **Flash / Verify / Recover / Soft reset** over CMSIS-DAP v1 (node-hid).
- **SEGGER RTT** bidirectional terminal via `vscode.Pseudoterminal` (ANSI,
  LF→CRLF translation, configurable polling interval).
- **Auto-flash on save** for a single selected `.hex` file, with optional
  confirmation dialog.
- **Full MCP surface**: tools, prompts, resources, and chat tool sets
  (VS Code 1.101+ stable APIs).
- **Target JSON + Zod schema**: nRF54L15 out of the box, AI-assisted
  workflow for any additional MCU.
- **Tasks API**: chain flash / verify / recover from `tasks.json`.
- **Walkthrough + viewsWelcome + LanguageStatusItem**: first-run UX.
- **7 platform-specific VSIX** builds: macOS arm64 / x64, Windows x64 / ARM,
  Linux x64 / arm64 / armhf (ChromeOS Crostini covered).

## Quick start

1. Install the extension from the [VS Code Marketplace] or [Open VSX].
2. Plug in a CMSIS-DAP-class probe (DAPLink / Picoprobe / XIAO+CMSIS-DAP / …).
3. Open the **FreeOCD** sidebar.
4. Run `FreeOCD: Connect Probe` → `Select Target MCU` → `Select .hex File` →
   `Flash`.

[VS Code Marketplace]: https://marketplace.visualstudio.com/items?itemName=FreeOCD.freeocd-extension
[Open VSX]: https://open-vsx.org/extension/FreeOCD/freeocd-extension
[DAP.js]: https://github.com/ARMmbed/dapjs

## Supported MCUs

Out of the box:

- **Nordic nRF54L15** (Cortex-M33, RRAMC) — `nordic/nrf54/nrf54l15`

Additional MCUs can be added via:

- **User-defined target JSON** — `FreeOCD: Import Target Definition`.
- **AI-assisted workflow** — in any MCP-enabled chat run
  `/mcp.freeocd.add_new_mcu_support` or `/mcp.freeocd.create_target_from_datasheet`.

See [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-new-target-mcu) for the PR
workflow.

## MCP integration

The extension auto-registers an MCP server with any VSCode-family IDE that
implements `vscode.lm.registerMcpServerDefinitionProvider` (VS Code 1.101+,
Windsurf Next 1.110+). For other clients, run `FreeOCD: Setup MCP` to copy
ready-to-paste JSON into your clipboard for:

- **Windsurf** — `~/.codeium/windsurf/mcp_config.json`
- **Cursor** — `~/.cursor/mcp.json`
- **Cline** — `~/.cline/cline_mcp_settings.json`

### Tool Sets

VS Code 1.101+ lets you group MCP tools under a single `#mention` via a tool
sets file (the `contributes.chatToolSets` manifest entry does not exist).
FreeOCD ships a ready-to-import JSONC file so you do not have to hand-craft
one.

1. Run **Configure Tool Sets** from the Command Palette and choose
   **Create new tool sets file**.
2. Open
   [`resources/tool-sets/freeocd.toolsets.jsonc`](resources/tool-sets/freeocd.toolsets.jsonc)
   (also installed into the VSIX at `tool-sets/freeocd.toolsets.jsonc`) and
   copy its entire contents.
3. Paste into the tool sets file VS Code opened in step 1 and save.
4. Reference groups in chat with `#freeocd-flash`, `#freeocd-rtt`,
   `#freeocd-target`, `#freeocd-low-level`, or `#freeocd-session` to scope
   AI tool access.

The bundled file is the single source of truth for group membership — edit
it locally if you want to add custom MCU tools alongside FreeOCD's built-in
ones.

### Prompts

From chat:

- `/mcp.freeocd.add_new_mcu_support`
- `/mcp.freeocd.debug_flash_error`
- `/mcp.freeocd.create_target_from_datasheet`
- `/mcp.freeocd.troubleshoot_rtt`

### Resources

Attach as chat context:

- `schema://target-definition`
- `reference://targets/nrf54l15`
- `docs://mcu-workflow`
- `docs://dap-glossary`
- `docs://arm-cortex-m-registers`
- `logs://session-log`

## Tasks API example

Wire flash into your build in `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Flash firmware",
      "type": "freeocd",
      "action": "flash",
      "file": "build/firmware.hex",
      "verify": true,
      "problemMatcher": []
    }
  ]
}
```

## Troubleshooting

### Linux udev rules

Add a rules file so non-root users can access CMSIS-DAP HID devices:

```
# /etc/udev/rules.d/50-cmsis-dap.rules
# DAPLink / CMSIS-DAP v1 (HID interface, usagePage 0xFF00)
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0d28", MODE="0666"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="2886", MODE="0666"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="2e8a", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0d28", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="2886", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="2e8a", MODE="0666"
```

Reload with `sudo udevadm control --reload && sudo udevadm trigger`.

### Windows

No WinUSB / Zadig required — CMSIS-DAP v1 speaks plain HID. If the probe
still doesn't appear, check Device Manager for a yellow triangle on the
"HID-compliant device" entry and re-plug the probe.

### macOS

macOS may prompt for permission to access the probe the first time. Accept
the prompt and reconnect.

## Licenses and attribution

- FreeOCD — [BSD 3-Clause](LICENSE)
- DAP.js (bundled under `vendor/dapjs`) — [MIT](vendor/dapjs/LICENSE)

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities, and
[AI_REVIEW.md](AI_REVIEW.md) for the AI-oriented review checklist.
