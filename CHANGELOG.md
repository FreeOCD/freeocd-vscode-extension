# Changelog

All notable changes to the FreeOCD VSCode extension will be documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/FreeOCD/freeocd-vscode-extension/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/FreeOCD/freeocd-vscode-extension/releases/tag/v0.0.1
