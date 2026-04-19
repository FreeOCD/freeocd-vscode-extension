# Changelog

All notable changes to the FreeOCD VSCode extension will be documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.0.3] - 2026-04-20

### Changed

- **MCP**: Upgraded the `mcpServerDefinitionProvider` registration to the
  full VS Code 1.102+ contract. `vscode.McpStdioServerDefinition` is now
  used as a class, and both `onDidChangeMcpServerDefinitions` and
  `resolveMcpServerDefinition` are implemented. The `version` field is
  propagated from `package.json` so VS Code can detect tool-list changes
  across extension upgrades, and toggling `freeocd.mcp.enabled` now
  re-queries the provider without a window reload.
- **MCP**: Tool definitions now ship with MCP 2025-11-25 behavior
  annotations (`title`, `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`). Clients such as Copilot agent
  mode use these to decide auto-approval and confirmation dialogs —
  e.g. `list_targets` can run without prompting while `recover`,
  `flash_hex`, and `processor_execute` are gated behind explicit
  user confirmation.
- **MCP**: `tools/list` now returns real JSON Schema objects derived
  from the Zod argument schemas (via `zod-to-json-schema`) instead of
  a permissive fallback. LLMs can see `required` / `properties` /
  `enum` constraints directly, dramatically improving tool-call
  argument accuracy.

### Added

- **MCP**: Opportunistic [elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
  support for the `ai_diagnose_flash_failure` tool. Clients that declare
  the `elicitation` capability during the MCP handshake will get a form
  prompt for optional context (cable swap, new firmware, etc.) before
  the diagnostic sampling call, improving root-cause analysis quality.
  Clients that don't support elicitation fall back to the previous
  behavior silently.
- **MCP**: `zod-to-json-schema` promoted from a transitive dependency
  of `@modelcontextprotocol/sdk` to a direct dependency so the
  schema-conversion contract is versioned explicitly in `package.json`.

## [0.0.2] - 2026-04-19

### Changed

- Add icon to `selectHexFile` command for better visual feedback
- Make HEX File tree item clickable to open file selector
- Reorder flasher view menu items for better UX (select, flash, recover)

## [0.0.1] - 2026-04-18

### Added

- Initial public release of the FreeOCD VSCode extension.
- CMSIS-DAP v1 connection over `node-hid` with a pluggable `TransportInterface`
  / `TransportRegistry` for future USB / WebUSB backends.
- Nordic **nRF54L15** target definition (`nordic/nrf54/nrf54l15`) with
  CTRL-AP mass-erase recovery and RRAMC flash programming.
- Intel HEX parser + Flasher with `withProgress` + `CancellationToken`
  support for Flash, Verify, Recover, and Soft reset.
- Auto-flash watcher (single `.hex` file, safe-mode confirmation dialog).
- SEGGER RTT handler + `vscode.Pseudoterminal` bidirectional terminal with
  ANSI passthrough and LF→CRLF translation.
- Full MCP surface (tools, prompts, resources, chat tool sets) built on
  VS Code 1.101+ stable APIs:
  - Tools covering Connection / Target / Flasher / RTT / DAPjs proxy / ADI
    / Processor / session diagnostics.
  - Prompts: `add_new_mcu_support`, `debug_flash_error`,
    `create_target_from_datasheet`, `troubleshoot_rtt`.
  - Resources: `schema://target-definition`, `reference://targets/nrf54l15`,
    `docs://mcu-workflow`, `docs://dap-glossary`,
    `docs://arm-cortex-m-registers`, `logs://session-log`.
  - Tool sets: `freeocd-flash`, `freeocd-rtt`, `freeocd-target`,
    `freeocd-low-level`, `freeocd-session`.
- `freeocd.setupMcp` command that copies clipboard-ready MCP config JSON for
  Windsurf, Cursor, and Cline.
- Sidebar with five TreeViews (`Connection`, `Target`, `Flasher`,
  `Debugger`, `MCP Status`), `TreeItemCheckboxState` toggles, `viewsWelcome`
  onboarding, and a four-step Walkthrough.
- `LanguageStatusItem` + `StatusBarItem` combo with
  `accessibilityInformation` for screen readers.
- `FileDecorationProvider` that badges `.hex` files and highlights the
  selected one.
- Tasks API provider (`freeocd` task type) supporting flash / verify /
  recover from `tasks.json`.
- i18n for English (`bundle.l10n.json`), Japanese (`bundle.l10n.ja.json`),
  Simplified Chinese (`bundle.l10n.zh-cn.json`), and Traditional Chinese
  (`bundle.l10n.zh-tw.json`) plus the matching `package.nls.*.json` files.
- GitHub Actions workflows:
  - `ci.yml` — lint, typecheck, target JSON validation, 3 OS × 2 Node matrix
    build + test with `node-hid` verification.
  - `release.yml` — 7-target VSIX matrix (darwin-arm64 / darwin-x64 /
    win32-x64 / win32-arm64 / linux-x64 / linux-arm64 / linux-armhf) with
    publish to VS Code Marketplace, Open VSX, and GitHub Releases.
- Issue templates (`bug_report`, `feature_request`, `new_mcu_support`), PR
  template, and `dependabot.yml`.

### Notes

- The extension declares `"extensionKind": ["workspace"]` so it runs on the
  workspace host when used in remote / WSL / devcontainer setups.
- `activationEvents` is intentionally minimal (`onStartupFinished`); VS Code
  implicitly activates on commands / views / taskDefinitions / MCP providers.

[Unreleased]: https://github.com/FreeOCD/freeocd-vscode-extension/compare/v0.0.3...HEAD
[0.0.3]: https://github.com/FreeOCD/freeocd-vscode-extension/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/FreeOCD/freeocd-vscode-extension/releases/tag/v0.0.2
[0.0.1]: https://github.com/FreeOCD/freeocd-vscode-extension/releases/tag/v0.0.1
