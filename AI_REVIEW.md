# Production Code Review Checklist

Reusable checklist for production-level code reviews of the **FreeOCD VSCode
Extension**. Each item has a unique ID for issue / PR cross-referencing.

## Project Context

> **For AI reviewers**: Read this section first to understand the project scope
> before evaluating checklist items.

- **Project**: FreeOCD VSCode Extension — open-source CMSIS-DAP flasher,
  verifier, and RTT debugger for embedded development
- **Architecture**: TypeScript modules in `src/` organised by domain, plus a
  standalone MCP server entry point, Webpack-bundled for the VS Code host
- **Key technologies**: VS Code Extension API (1.101+), `node-hid`
  (CMSIS-DAP v1 HID transport), DAP.js (git submodule under `vendor/dapjs`),
  Model Context Protocol (`@modelcontextprotocol/sdk`), `@vscode/l10n` (i18n),
  `zod` (MCP input validation)
- **Platforms**: macOS arm64 / x64, Windows x64 / ARM, Linux x64 / arm64 /
  armhf (ChromeOS Crostini covered) | VS Code, Windsurf, Cursor, Cline
- **License**: BSD-3-Clause (extension); DAP.js MIT;
- **Source modules** (all in `src/`):
  - `extension.ts` — Entry point, command registration, orchestration
  - `common/` — `dapjs-loader.ts`, `errors.ts`, `logger.ts`, `types.ts`
  - `connection/connection-manager.ts` — Probe lifecycle, target binding
  - `transport/` — `hid-transport.ts`, `transport-interface.ts`,
    `transport-registry.ts` (CMSIS-DAP v1 HID)
  - `dap/dap-operations.ts` — Higher-level DAP helpers (AP/DP read/write,
    transferBlock)
  - `flasher/` — `flasher.ts`, `hex-parser.ts`, `auto-flash-watcher.ts`
  - `target/` — `target-manager.ts`, `target-schema.ts` (Zod),
    `platform-handler.ts`, `nordic-handler.ts`
  - `rtt/` — `rtt-handler.ts`, `rtt-terminal.ts` (Pseudoterminal)
  - `ui/` — `status.ts` (LanguageStatusItem / StatusBar), `tree-providers.ts`,
    `file-decoration-provider.ts`
  - `mcp/` — `mcp-provider.ts` (VS Code auto-discovery),
    `mcp-bridge.ts` (bridge wiring), `mcp-server.ts` (stdio server),
    `tool-handlers.ts`, `session-log.ts`, `tools/`, `prompts/`, `resources/`
  - `tasks/` — Tasks API provider (flash / verify / recover)

## How to Use This Checklist

### For Human Reviewers

Copy the tables into a GitHub Issue or PR comment. Fill the **Status** column:
✅ pass | ⚠️ minor issue | ❌ must fix | ➖ not applicable

### For AI Reviewers (Cascade, Copilot, Cursor, etc.)

1. Read the **Project Context** above and the **Glossary** at the end.
2. For each checklist item, read the **Key Files** and **Verification** columns
   to know where to look and how to verify.
3. Use the **Priority** column to triage findings: fix `Critical` and `High`
   items first.
4. When reporting findings, reference the checklist **ID**
   (e.g., "SEC-02 violation in `hex-parser.ts:120`").
5. Items marked with 🤖 in the Verification column are especially suitable for
   automated / AI-assisted checking.

### Priority Levels

| Priority | Meaning | Action |
|----------|---------|--------|
| **Critical** | Security vulnerability, data loss, or crash in normal use | Must fix before release |
| **High** | Significant bug, reliability issue, or missing validation | Should fix before release |
| **Medium** | Code quality, maintainability, or minor UX issue | Fix in current or next cycle |
| **Low** | Style, documentation, or nice-to-have improvement | Fix when convenient |

---

## 1. Security (SEC)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| SEC-01 | Critical | Input validation | All public APIs and MCP tool handlers validate parameters at entry (type, range, empty, null). No unchecked casts from `unknown`. | All `src/**/*.ts`, `src/mcp/tools/` | 🤖 Search for unchecked `as` casts; verify every `server.tool()` uses a Zod schema with `.strict()` where possible | |
| SEC-02 | Critical | Filesystem access via VS Code API | All user-visible filesystem writes go through `vscode.workspace.fs` (not the Node `fs` module) so they work on Remote / WSL / SSH hosts. Extension-internal storage under `context.globalStorageUri` / `context.storageUri`. | `src/target/target-manager.ts`, `src/mcp/**` | 🤖 Grep for `require('fs')` / `import ... from 'fs'` in non-test, non-script code | |
| SEC-03 | Critical | Path traversal prevention | Target JSON / hex-file paths built via `Uri.joinPath` — never string concatenation. Users cannot save a target under a namespace they do not own. | `src/target/target-manager.ts`, `src/flasher/flasher.ts` | 🤖 Grep for `startsWith` on paths; verify `Uri.joinPath` usage | |
| SEC-04 | Critical | No dynamic code execution | No `eval` / `new Function` / dynamic `require` anywhere. `spawn` / `exec` never takes untrusted input. | All `src/**/*.ts` | 🤖 Grep for `eval(`, `Function(`, `new Function`, `child_process` | |
| SEC-05 | High | Intel HEX parser safety | Parser enforces per-line checksums and rejects unknown record types without side effects. Overlong / truncated lines rejected. | `src/flasher/hex-parser.ts` | 🤖 Review unit tests for bad-checksum and unknown-record inputs | |
| SEC-06 | High | MCP output validation | MCP tool responses use `{ type: 'text', text: string }` typed literals. No arbitrary object passthrough. `isError` flag set explicitly on failure. | `src/mcp/tool-handlers.ts`, `src/mcp/tools/` | 🤖 Verify all tool handlers return typed `content` arrays with `isError` on error paths | |
| SEC-07 | High | Untrusted workspace | `capabilities.untrustedWorkspaces.supported` is `false` in `package.json`; `virtualWorkspaces` is `false`. | `package.json` | 🤖 Check `capabilities` fields | |
| SEC-08 | High | RTT / console sanitisation | Control characters from device output are either rendered through the terminal's ANSI handling or stripped before being passed to VS Code notifications / log channels (no terminal injection via notifications). | `src/rtt/rtt-terminal.ts`, `src/rtt/rtt-handler.ts` | 🤖 Verify non-ANSI contexts strip `[\x00-\x08\x0B-\x1F\x7F]` before display | |
| SEC-09 | Critical | Secret management | No hardcoded tokens, keys, or credentials anywhere in source, fixtures, or target JSON. CI secrets stored in GitHub Secrets with environment protection. VSCE secret scanner passes. | All files | 🤖 Grep for API-key / token / Bearer patterns; check VSCE scan output | |
| SEC-10 | High | Zod schema strictness | Every MCP tool input has a **strict** Zod schema (`.strict()` where possible). Target JSON validated at load time via `target-schema.ts`. | `src/mcp/tools/`, `src/target/target-schema.ts` | 🤖 Verify `.strict()` on object schemas; verify target JSON rejected on schema mismatch | |
| SEC-11 | High | JSON parse safety | All `JSON.parse()` of external data (target files, MCP bridge IPC if any) wrapped in try/catch. Malformed input never crashes the extension host or MCP server. | `src/target/**`, `src/mcp/**` | 🤖 Grep for `JSON.parse` and verify each is inside try/catch | |
| SEC-12 | Medium | Dependency audit | `npm audit` run regularly. Known transitive issues documented in `SECURITY.md` with impact analysis. | `SECURITY.md`, `package-lock.json` | Run `npm audit` and compare output with SECURITY.md | |
| SEC-13 | Medium | DAP transfer bounds | DAP `transferBlock` / AP / DP helpers validate word counts and memory addresses against the target's declared ranges before issuing transfers. | `src/dap/dap-operations.ts`, `src/target/target-schema.ts` | 🤖 Verify range checks at function entry for block-mode operations | |

## 2. Stability (STA)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| STA-01 | Critical | Non-blocking `activate()` | `activate()` performs no blocking I/O on the extension host main thread. DAPjs loaded lazily on first use. | `src/extension.ts`, `src/common/dapjs-loader.ts` | Review `activate()` for synchronous heavy work; verify `dapjs-loader` lazy pattern | |
| STA-02 | High | Flash concurrency guard | Overlapping flash / verify / recover operations are prevented. Concurrent user-initiated requests surface a clear message rather than racing on the probe. | `src/flasher/flasher.ts`, `src/extension.ts` | 🤖 Verify flag set in try and cleared in finally; check all call sites | |
| STA-03 | High | Probe connection guard | Concurrent `connect` calls rejected or coalesced. Returns early if already connecting or connected. | `src/connection/connection-manager.ts` | 🤖 Verify guard at top of connect entry point | |
| STA-04 | High | Dispose chain | Every `Disposable` registered in `context.subscriptions`. BLE/HID handles, EventEmitters, terminals disposed on deactivation. | `src/extension.ts`, all managers | 🤖 Verify all `push(disposable)` calls; check `deactivate()` function | |
| STA-05 | High | Timer cleanup | All `setTimeout`/`setInterval` handles stored and cleared in `dispose()`, error paths, and state transitions. RTT polling timer cleared when terminal closes. Flash progress timers cleared on cancel. | `src/rtt/**`, `src/flasher/**` | 🤖 Grep for `setTimeout`/`setInterval` and verify corresponding `clearTimeout`/`clearInterval` | |
| STA-06 | High | Pseudoterminal cleanup | RTT `Pseudoterminal` close handler clears polling timers, disposables, and detaches from the RTT handler. | `src/rtt/rtt-terminal.ts` | Review `close()` handler for full cleanup | |
| STA-07 | High | Flash cancellation recovery | If a flash is cancelled, flash-controller state is recoverable; user is explicitly pointed to `FreeOCD: Recover` in the resulting error message. | `src/flasher/flasher.ts`, `src/target/nordic-handler.ts` | Review cancellation path and error message content | |
| STA-08 | Medium | Error boundaries | All async command handlers wrapped in try/catch with user-facing `showErrorMessage`. Background errors logged via `LogOutputChannel` without throwing. | `src/extension.ts` | 🤖 Verify each `registerCommand` callback has try/catch | |
| STA-09 | Medium | RTT polling tolerates halts | RTT polling tolerates target halts / flash operations (polling stops during flash and resumes safely afterwards). | `src/rtt/rtt-handler.ts`, `src/flasher/flasher.ts` | Review pause / resume interaction | |
| STA-10 | Medium | Graceful degradation | Extension activates without a probe attached. MCP server works even if a probe is not connected (reports a clear status). Commands that require a probe emit a `NotConnectedError`. | `src/extension.ts`, `src/mcp/**` | Test: activate with no probe, no workspace, MCP enabled and disabled | |
| STA-11 | Medium | MCP server crash handling | Standalone MCP server has `uncaughtException` and `unhandledRejection` handlers that log to stderr and exit. No silent hangs. | `src/mcp/mcp-server.ts` | 🤖 Verify process crash handlers exist at module level | |
| STA-12 | Low | Session-log bounds | MCP session log ring buffer capped by `freeocd.mcp.sessionLogSize`. Oldest entries evicted. | `src/mcp/session-log.ts`, `package.json` | 🤖 Verify buffer cap and eviction logic | |

## 3. Cross-Platform Compatibility (PLT)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| PLT-01 | High | No POSIX-specific paths | No literal `/tmp`, `~`, or home-directory assumptions. Use `context.storageUri` / `context.globalStorageUri` and `Uri.joinPath`. | All `src/**/*.ts` | 🤖 Grep for `/tmp`, `~/`, `process.env.HOME` | |
| PLT-02 | High | Path separators | Use `Uri.joinPath` for workspace-visible paths and `path.join` for local FS only. No string concatenation with `/` for file paths. | All `src/**/*.ts` | 🤖 Grep for string path concatenation patterns in non-URL contexts | |
| PLT-03 | High | Path comparison | Use `path.relative()` (not `startsWith()`) for workspace containment checks. | `src/target/**`, `src/flasher/**` | 🤖 Grep for `startsWith` applied to file paths | |
| PLT-04 | High | Line endings | RTT terminal performs LF→CRLF translation. No `\r\n` assumptions in hex parsing. | `src/rtt/rtt-terminal.ts`, `src/flasher/hex-parser.ts` | 🤖 Review line-ending handling in parsers | |
| PLT-05 | High | node-hid Windows prepended byte | Windows-specific prepended-byte handled in `HidTransport.write`. | `src/transport/hid-transport.ts` | Review `write()` for Windows branch and per-OS comment | |
| PLT-06 | High | VSIX platform targets | All 7 platform targets (macOS arm64 / x64, Windows x64 / ARM, Linux x64 / arm64 / armhf) produce a loadable VSIX with correct prebuilt `node-hid` binary. | `.github/workflows/release.yml`, `.vscodeignore` | Verify matrix and per-platform binding inclusion | |
| PLT-07 | Medium | `linux-armhf` cross-build | `linux-armhf` VSIX built via QEMU cross-build in CI. | `.github/workflows/release.yml` | Verify QEMU setup step in release workflow | |
| PLT-08 | Medium | ChromeOS Crostini | `linux-x64` VSIX works inside ChromeOS Crostini (Debian). | README, release notes | Manual smoke test once per release | |
| PLT-09 | Medium | CI matrix | CI runs on macOS + Windows + Linux × supported Node versions. All combinations green. | `.github/workflows/ci.yml` | Verify matrix definition and recent CI results | |
| PLT-10 | Low | Filesystem case sensitivity | `forceConsistentCasingInFileNames: true` in `tsconfig.json`. | `tsconfig.json` | 🤖 Verify tsconfig flag | |
| PLT-11 | Low | Node.js version alignment | CI, release, and `engines.node` (if declared) are mutually consistent. | `package.json`, `.github/workflows/*.yml` | 🤖 Compare Node versions across workflows | |

## 4. Multi-IDE Compatibility (IDE)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| IDE-01 | High | VS Code API minimum | `engines.vscode = ^1.101.0` matches the MCP APIs we rely on. | `package.json` | Check VS Code API docs for each API; verify availability at declared minimum | |
| IDE-02 | High | MCP auto-discovery feature detection | `mcpServerDefinitionProviders` declared in `package.json` + `vscode.lm.registerMcpServerDefinitionProvider` call guarded by `typeof` feature detection. | `package.json`, `src/mcp/mcp-provider.ts`, `src/extension.ts` | 🤖 Verify `typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function'` guard | |
| IDE-03 | High | API feature detection | Every optional API is guarded (`typeof` / optional chaining). Extension loads in IDEs without the API and degrades gracefully. | `src/extension.ts`, `src/mcp/**` | 🤖 Grep for optional API calls; verify `typeof` or `?.` guards | |
| IDE-04 | Medium | `freeocd.setupMcp` output | Command produces valid MCP config JSON for Windsurf, Cursor, and Cline with correct absolute paths to the MCP server entry. | `src/extension.ts`, `src/mcp/mcp-provider.ts` | Run the command, paste output into each client, verify it loads | |
| IDE-05 | Medium | Compatibility matrix documented | README documents supported IDEs including Windsurf Next (1.110+). | `README.md` | Cross-reference README with observed API availability | |
| IDE-06 | Medium | Open VSX publishing | Release pipeline publishes to Open VSX with failure isolation. | `.github/workflows/release.yml` | Verify `ovsx publish` step with `continue-on-error` | |

## 5. Reliability (REL)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| REL-01 | High | node-hid failure surface | node-hid open / read / write failures surface via a user-facing error message and do not crash the extension host. | `src/transport/hid-transport.ts` | Review error paths; verify notification vs. silent throw | |
| REL-02 | High | DAP timeout bubbling | DAP transfer timeouts bubble up with `DapTransferError` and a meaningful ACK code. | `src/dap/dap-operations.ts`, `src/common/errors.ts` | 🤖 Verify error class usage and timeout constant definitions | |
| REL-03 | High | AP/DP retries | `readAPReg` / `writeAPReg` retry 3 times with a 50 ms backoff before giving up. | `src/dap/dap-operations.ts` | 🤖 Verify retry count and delay constants | |
| REL-04 | Medium | RTT polling robustness | RTT polling is cancellable and tolerates intermittent target halts. | `src/rtt/rtt-handler.ts` | Review polling loop and cancel token handling | |
| REL-05 | Medium | Probe refresh | `FreeOCD: Refresh Probes` deterministically rebuilds the probe list without leaving stale handles. | `src/connection/connection-manager.ts` | Test refresh before and after hot-plug | |
| REL-06 | Medium | Auto-flash watcher | Auto-flash watcher is scoped to the currently selected `.hex` file only. Debounced to avoid double-triggering on save. | `src/flasher/auto-flash-watcher.ts` | 🤖 Verify glob scope and debounce timer | |

## 6. Performance (PRF)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| PRF-01 | High | Activation time ≤ 300 ms | Activation is ≤ 300 ms on a cold boot on a modern laptop. No synchronous DAPjs load, no probe enumeration at activation. | `src/extension.ts` | Measure with VS Code `Developer: Show Running Extensions` | |
| PRF-02 | High | Lazy initialisation | DAPjs loader, MCP bridge, and HID transport are initialised on first use, not in `activate()`. | `src/common/dapjs-loader.ts`, `src/mcp/mcp-bridge.ts` | Review entry points; verify lazy patterns | |
| PRF-03 | Medium | Activation event | `activationEvents` = `onStartupFinished` (not `*`) to avoid blocking IDE startup. | `package.json` | 🤖 Check `activationEvents` field | |
| PRF-04 | Medium | DAP bulk reads | DAP `transferBlock` used where possible for bulk reads (e.g., flash verify). No word-at-a-time read loops for large regions. | `src/dap/dap-operations.ts`, `src/flasher/flasher.ts` | Review verify path for block-mode usage | |
| PRF-05 | Medium | RTT polling debounce | RTT polling is cancellable and debounced, default 100 ms, bounded by `freeocd.rtt.pollingInterval`. | `src/rtt/rtt-handler.ts`, `package.json` | 🤖 Verify configuration plumbing and default value | |
| PRF-06 | Medium | Flash progress throttling | Flash progress is reported at most once per 256 words (or equivalent) to avoid spamming the progress API. | `src/flasher/flasher.ts` | 🤖 Review progress throttling logic | |
| PRF-07 | Low | File decoration caching | `FileDecorationProvider` caches badges internally; changes are scoped via `onDidChangeFileDecorations` with a minimal URI set. | `src/ui/file-decoration-provider.ts` | Review cache + change-event scoping | |
| PRF-08 | Low | Webpack bundling | Production mode with `nosources-source-map`. Externals set for `vscode`. Bundle size tracked per release. | `webpack.config.js` | 🤖 Verify `mode` and `devtool` settings; compare bundle sizes across releases | |

## 7. Readability & Code Organization (RDO)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| RDO-01 | High | TypeScript strict mode | `"strict": true` in `tsconfig.json` (implies `noImplicitAny`, `strictNullChecks`, etc.). | `tsconfig.json` | 🤖 Verify `strict: true` flag | |
| RDO-02 | Medium | Module decomposition | Single-responsibility modules: `transport/` vs `dap/` vs `flasher/` vs `target/` vs `rtt/` vs `mcp/` vs `ui/`. No circular imports. | `src/` directory | 🤖 Analyse import graph; detect circular dependencies | |
| RDO-03 | Medium | JSDoc on exports | Every exported symbol has JSDoc. Internal helpers have at least a brief comment. Comments explain *why*, not *what*. | All `src/**/*.ts` | 🤖 Grep for exported functions without JSDoc | |
| RDO-04 | Medium | ESLint rules | `curly`, `eqeqeq`, `prefer-const`, `no-throw-literal`, naming conventions, `no-unused-vars`. `npm run lint` passes with zero warnings. | `eslint.config.js` | Run `npm run lint` | |
| RDO-05 | Medium | Constants centralisation | Timeouts, USB usage page, DAP opcodes, retry counts, and buffer caps defined as named constants (not magic numbers in business logic). | `src/common/types.ts`, domain modules | 🤖 Grep for numeric literals used as timeouts or limits not declared as named constants | |
| RDO-06 | Low | Naming conventions | PascalCase: types / classes / interfaces. camelCase: variables / functions. UPPER_SNAKE_CASE: constants. `_` prefix: private / unused. | All `src/**/*.ts` | 🤖 Run ESLint `@typescript-eslint/naming-convention` rule | |
| RDO-07 | Low | Module size monitoring | Flag modules exceeding ~500 lines for potential splitting, unless justified in a module-level comment. | `src/extension.ts`, `src/target/nordic-handler.ts`, `src/mcp/tool-handlers.ts` | 🤖 Count lines per module | |
| RDO-08 | Low | Structured logging | All `LogOutputChannel` messages prefixed with `[CATEGORY]` tags (e.g. `[FLASH]`, `[DAP]`, `[RTT]`, `[MCP]`) for machine parsing. | `src/common/logger.ts`, call sites | 🤖 Grep for log calls without `[TAG]` prefix | |
| RDO-09 | Low | Dead code | No unused imports, functions, or variables. Unused parameters prefixed with `_`. | All `src/**/*.ts` | 🤖 Run `npm run lint` | |

## 8. Documentation Currency (DOC)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| DOC-01 | High | README "Quick start" works | Steps in README "Quick start" work verbatim on a freshly installed extension. | `README.md` | Dry-run the quick start in a clean profile each release | |
| DOC-02 | High | CHANGELOG | Follows *Keep a Changelog* + SemVer. Latest entry version matches `package.json` version. | `CHANGELOG.md`, `package.json` | 🤖 Compare `version` with latest CHANGELOG heading | |
| DOC-03 | Medium | README features list | All features listed exist in code. No vaporware. No unlisted major features. | `README.md`, `package.json` | 🤖 Cross-reference feature list with `package.json` commands and `contributes` | |
| DOC-04 | Medium | CONTRIBUTING | Includes the three-step "Adding a new MCU" recipe and references the MCP-assisted workflow. | `CONTRIBUTING.md` | Cross-reference with `src/target/` and MCP prompts | |
| DOC-05 | Medium | SECURITY.md | Describes reporting process and threat model. Dependency audit findings match current `npm audit` output. | `SECURITY.md` | Run `npm audit` and compare with documented issues | |
| DOC-06 | Medium | AI_REVIEW linked | This file is linked from README and CONTRIBUTING. | `README.md`, `CONTRIBUTING.md` | 🤖 Grep for `AI_REVIEW.md` references | |
| DOC-07 | Low | MCP documentation | Documented tool list, prompts, resources, and tool sets match the MCP server implementation. | `README.md`, `src/mcp/**` | 🤖 Compare documented tool names with `server.tool()` calls in `src/mcp/tools/` | |

## 9. Internationalization & Translation (I18N)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| I18N-01 | High | No literal English UI strings | All user-facing strings in source use `vscode.l10n.t()`. Log-only messages may be English. | All `src/**/*.ts` | 🤖 Grep for string literals in `showErrorMessage`, `showWarningMessage`, `showInformationMessage`, `TreeItem` labels, QuickPick items | |
| I18N-02 | High | `package.nls.*` key parity | All keys in `package.nls.json` exist in every `package.nls.{locale}.json`. No missing or extra keys. | `package.nls.json`, `package.nls.ja.json` | 🤖 Diff key sets across all files | |
| I18N-03 | High | `bundle.l10n.*` key parity | All keys in `l10n/bundle.l10n.json` exist in every `l10n/bundle.l10n.{locale}.json`. | `l10n/bundle.l10n.json`, `l10n/bundle.l10n.ja.json` | 🤖 Diff key sets across all files | |
| I18N-04 | Medium | Placeholder consistency | `{0}`, `{1}` etc. present in all translations matching the source string. No missing or extra placeholders. | All `l10n/` and `package.nls.*` files | 🤖 Regex for `\{[0-9]+\}` and compare counts across locales | |
| I18N-05 | Medium | New string coverage | When adding new `l10n.t()` calls, every locale bundle and every `package.nls.*` file updated simultaneously. | All `l10n/` and `package.nls.*` files | 🤖 Count keys per file; flag mismatches | |
| I18N-06 | Low | Translation quality | Translations are natural and contextually accurate. | All locale files | Human review by native speakers | |

## 10. VSIX Packaging (PKG)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| PKG-01 | High | `.vscodeignore` exclusions | Excludes `src/`, `vendor/` (except the shipped DAPjs dist and the freeocd-web LICENSE), `scripts/`, `.github/`, build artefacts, source maps, `*.ts`, dev config files. | `.vscodeignore` | 🤖 Review exclusion patterns; run `vsce ls` and check for unexpected files | |
| PKG-02 | High | Required inclusions | Includes `out/extension.js`, MCP server bundle, `out/targets/` (copied from `vendor/freeocd-web/public/targets/`), `resources/tool-sets/`, `resources/walkthrough/`, icons, `l10n/`, `package.nls.*`, LICENSE, README, CHANGELOG. | `.vscodeignore`, `webpack.config.js` | Run `vsce ls` and verify all required files are present | |
| PKG-03 | High | node-hid runtime tree | Only the `node-hid` runtime subtree is included in `node_modules/`. Other dev dependencies stripped. | `.vscodeignore` | Inspect VSIX with `unzip -l`; verify only node-hid + its prebuilds are present | |
| PKG-04 | High | 7-target VSIX build | `vsce package --target <platform>` succeeds for all 7 targets with the correct prebuilt binary. | `.github/workflows/release.yml` | Verify release matrix produces 7 artefacts | |
| PKG-05 | Medium | No dev artefacts | Test output, source maps (except `nosources-source-map`), `*.ts`, lock file, config files excluded from VSIX. | `.vscodeignore` | 🤖 Run `vsce ls` and grep for test / dev files | |
| PKG-06 | Medium | Secret scanner clean | VSCE secret scanner reports no issues. | `.github/workflows/release.yml` | Verify scan output in CI logs | |
| PKG-07 | Medium | VSIX size monitoring | Track VSIX size per platform. Flag unexpected growth. | `.github/workflows/release.yml` | Compare VSIX sizes across releases | |
| PKG-08 | Low | Icon file | `resources/icons/freeocd.png` referenced in `package.json` exists and is a reasonable size. | `package.json`, `resources/icons/` | 🤖 Verify icon file exists and `icon` field is correct | |
| PKG-09 | Low | Extension manifest | `package.json` fields: `name`, `displayName`, `description`, `version`, `engines`, `publisher`, `icon`, `license`, `repository`, `categories`, `keywords` all present and correct. | `package.json` | 🤖 Validate required fields per VS Code extension manifest spec | |

## 11. CI/CD Pipeline (CIC)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| CIC-01 | High | CI triggers | `.github/workflows/ci.yml` runs on push and PR with concurrency cancel. Lint, build, and test all pass. | `.github/workflows/ci.yml` | Verify workflow triggers and concurrency group | |
| CIC-02 | High | Release environment | Release workflow uses `environment: production` with `permissions: contents: write` scoped to the `publish` job only. | `.github/workflows/release.yml` | 🤖 Review `permissions` and `environment` blocks | |
| CIC-03 | High | Version consistency gate | Release workflow verifies the git tag matches `package.json.version` and fails early on mismatch. | `.github/workflows/release.yml` | 🤖 Verify version check step exists | |
| CIC-04 | High | 7-target matrix | Matrix produces 7 artefacts, all attached to the GitHub Release. | `.github/workflows/release.yml` | Inspect a recent Release page | |
| CIC-05 | Medium | Publish failure isolation | Marketplace (VSCE) and Open VSX publish steps use `continue-on-error: true`. GitHub Release is always created even if one marketplace fails. | `.github/workflows/release.yml` | 🤖 Verify `continue-on-error` on publish steps | |
| CIC-06 | Medium | Least-privilege permissions | Default `contents: read`. Write permission only where needed. No unnecessary token scopes. | `.github/workflows/*.yml` | 🤖 Review `permissions` blocks in all workflows | |
| CIC-07 | Medium | Secret management | `VSCE_PAT`, `OVSX_PAT` stored in GitHub Secrets with environment protection. `GITHUB_TOKEN` auto-provided. | `.github/workflows/release.yml` | Verify secrets usage and environment protection in GitHub settings | |
| CIC-08 | Low | Toolchain pinning | `vsce`, `ovsx`, Node.js versions pinned to specific versions. | `.github/workflows/*.yml`, `package.json` | 🤖 Verify explicit version numbers in all setup steps | |

## 12. Dependency Management (DEP)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| DEP-01 | High | node-hid pinning | `node-hid` pinned to a version with prebuild binaries available for all target platforms. | `package.json`, `package-lock.json` | 🤖 Verify prebuilt `.node` availability for all VSIX targets | |
| DEP-02 | High | DAPjs submodule | DAPjs consumed via git submodule (`vendor/dapjs`) — not npm — to preserve MIT attribution and control patch level. Submodule pinned to a known-good commit. | `.gitmodules`, `vendor/dapjs` | Run `git submodule status` and verify commit SHA | |
| DEP-03 | Medium | Minimal runtime dependencies | Only `node-hid`, `@modelcontextprotocol/sdk`, `@vscode/l10n`, `zod` at runtime. No accidental dev-only packages in `dependencies`. | `package.json` | 🤖 Cross-reference `dependencies` with `import` statements in `src/` | |
| DEP-04 | Medium | Lock file committed | `package-lock.json` committed and consistent with `package.json`. `npm ci` works in a clean environment. | `package-lock.json` | Run `npm ci` in a clean clone | |
| DEP-05 | Medium | Audit status | `npm audit` has no unresolved high-severity findings. Documented exceptions in `SECURITY.md`. | `SECURITY.md`, `package-lock.json` | Run `npm audit` and compare with SECURITY.md | |
| DEP-06 | Medium | Dependabot enabled | Dependabot weekly updates enabled for both `npm` and `github-actions`. | `.github/dependabot.yml` | 🤖 Verify `package-ecosystem: npm` and `github-actions` entries | |
| DEP-07 | Low | Version ranges | Caret (`^`) ranges for safe updates. No wildcard (`*`) or tilde (`~`) where caret is appropriate. | `package.json` | 🤖 Review version range specifiers | |
| DEP-08 | Low | Dev/prod separation | Build and test tools in `devDependencies`. Runtime libraries in `dependencies`. | `package.json` | 🤖 Verify each dependency is in the correct section | |

## 13. Error Handling & Logging (ERR)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| ERR-01 | High | Single error helper | All user-initiated commands go through a single `handleError()` helper that calls `vscode.window.showErrorMessage`. | `src/extension.ts`, `src/common/errors.ts` | 🤖 Verify every `registerCommand` callback funnels into the helper | |
| ERR-02 | High | Specific error classes | `NotConnectedError`, `NoTargetError`, `CancelledError`, `DapTransferError`, `HexParseError`, `TargetValidationError` surface meaningful codes to the MCP layer. | `src/common/errors.ts`, `src/mcp/tool-handlers.ts` | 🤖 Verify MCP layer maps these classes to structured error responses | |
| ERR-03 | High | No stack traces in notifications | Stack traces are logged via `LogOutputChannel`, not shown in notifications. | All `src/**/*.ts` | 🤖 Grep for `.stack` used with `showErrorMessage` | |
| ERR-04 | Medium | Error typing pattern | `error instanceof Error ? error.message : String(error)` used consistently. No `(error as any).message`. | All `src/**/*.ts` | 🤖 Grep for `error.message` without `instanceof` guard and `as any` casts | |
| ERR-05 | Medium | No leaked internals | User-facing messages do not expose absolute file paths, stack traces, or implementation details. | All `src/**/*.ts` | 🤖 Review all `showErrorMessage` / `showWarningMessage` for path or stack leaks | |
| ERR-06 | Medium | Error recovery guidance | User-facing error messages include a suggested next action where possible (e.g., "Run `FreeOCD: Recover`", "Reconnect the probe"). | `src/extension.ts`, `src/flasher/**` | Review error message text for actionability | |
| ERR-07 | Low | Silent failures justified | Each silent catch has a comment explaining why. | All `src/**/*.ts` | 🤖 Grep for empty catch blocks or catch without logging / comment | |

## 14. Type Safety & API Contracts (TYP)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| TYP-01 | High | Strict mode | `strict: true` in `tsconfig.json` (implies `noImplicitAny`, `strictNullChecks`, etc.). | `tsconfig.json` | 🤖 Verify `strict: true` | |
| TYP-02 | High | MCP input schemas | Zod schemas cover every MCP tool input. Bounds and enums match business rules. `.strict()` applied where possible. | `src/mcp/tools/` | 🤖 Verify all `server.tool()` calls use Zod schemas | |
| TYP-03 | High | No `any` in `src/` | No `any` in `src/` (audited via ESLint). | All `src/**/*.ts`, `eslint.config.js` | 🤖 Run ESLint with `no-explicit-any` | |
| TYP-04 | Medium | DAPjs narrow interop casts | DAPjs interop uses narrow `as { method(): ... }` casts instead of `as any`. | `src/common/dapjs-loader.ts`, `src/dap/**` | 🤖 Grep for `as any` in DAPjs interop | |
| TYP-05 | Medium | Target JSON runtime validation | Target JSON is validated against the Zod schema (`target-schema.ts`) at load time. Invalid configs rejected with a precise error. | `src/target/target-schema.ts`, `src/target/target-manager.ts` | Review load logic; verify error reporting on invalid target | |
| TYP-06 | Medium | Explicit return types | All exported async functions have explicit return-type annotations. | All `src/**/*.ts` | 🤖 Grep for exported `async function` without `: Promise<` return type | |
| TYP-07 | Low | Enum exhaustiveness | Switch statements on union types handle all variants or have explicit `default` with `never` assertion. | All `src/**/*.ts` | 🤖 Grep for `switch` on typed values; verify exhaustiveness | |

## 15. Testing (TST)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| TST-01 | High | HEX parser unit tests | `hex-parser` has unit tests covering valid files, bad checksums, and all relevant record types. | `src/flasher/hex-parser.ts`, tests | Run `npm test` and verify coverage | |
| TST-02 | High | Target schema tests | `target-schema` validates every bundled target JSON under `vendor/freeocd-web/public/targets/`. A lint script (`npm run lint:targets`) runs in CI. | `src/target/target-schema.ts`, `scripts/validate-targets.js`, `vendor/freeocd-web/public/targets/` | 🤖 Run `npm run lint:targets` | |
| TST-03 | High | Extension activation test | Extension activation test loads the extension without errors via `vscode-test`. | `.vscode-test.*`, `src/test/**` | Run `npm test` | |
| TST-04 | Medium | Linux xvfb | `vscode-test` harness runs under `xvfb-run` on Linux in CI. macOS / Windows run directly. | `.github/workflows/ci.yml` | 🤖 Verify conditional `xvfb-run` in CI | |
| TST-05 | Medium | Coverage gaps tracked | Modules without unit tests listed (currently: MCP tool handlers, RTT handler, flasher, connection manager) and tracked toward closure. | `src/test/`, progress notes | 🤖 List `src/**/*.ts` vs test files; identify untested modules | |
| TST-06 | Medium | Regression discipline | New bugs get a failing test before the fix is applied. | Process | Enforce via PR review | |
| TST-07 | Low | Test isolation | Tests do not depend on external state (real probe, network, user filesystem). Use fixtures / mocks. | `src/test/**` | Review test implementations for external dependencies | |
| TST-08 | Low | Boundary value tests | Edge cases tested: empty HEX, record-type EOF only, max-length line, record at end-of-flash, all-zero verify. | `src/test/**` | 🤖 Review test cases for boundary conditions | |

## 16. Accessibility (A11Y)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| A11Y-01 | Medium | Status items accessibility | `LanguageStatusItem` / `StatusBarItem` set `accessibilityInformation` (label + role). | `src/ui/status.ts` | 🤖 Grep for `accessibilityInformation` on status items | |
| A11Y-02 | Medium | TreeView labels | All `TreeItem` instances have descriptive `label` and `tooltip`. No icon-only items. | `src/ui/tree-providers.ts` | 🤖 Grep for `new vscode.TreeItem` and verify `label` / `tooltip` | |
| A11Y-03 | Low | Error message clarity | Error messages are descriptive enough for users relying on assistive technology. No visual-only status indicators. | All `src/**/*.ts` | Review error messages for clarity without visual context | |
| A11Y-04 | Low | Walkthrough keyboard navigation | Walkthrough steps are keyboard-navigable (default VS Code behaviour preserved). | `resources/walkthrough/`, `package.json` | Manual keyboard-only test | |
| A11Y-05 | Low | Command palette discoverability | Every user-invocable command is registered in `package.json` with a descriptive, localised title. | `package.json` | 🤖 Verify `commands` contribution has a clear `title` for each | |

## 17. Backward Compatibility (BWC)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| BWC-01 | High | Command ID stability | Command ids remain stable (`freeocd.*`). External tools (MCP clients, tasks.json) depend on these IDs. | `package.json`, `src/extension.ts` | 🤖 Compare command IDs with previous release; flag renames | |
| BWC-02 | High | Configuration additivity | Configuration keys evolve additively. Renames go through a deprecation path with CHANGELOG note. | `package.json`, `CHANGELOG.md` | Review configuration read logic for migration paths | |
| BWC-03 | Medium | Target JSON schema evolution | Target JSON schema changes are backward compatible (new fields optional). Breaking changes bump schema version. | `src/target/target-schema.ts` | Review schema diff between releases | |
| BWC-04 | Medium | Task definition stability | `taskDefinitions` contributions stable. New `action` values only added, not renamed. | `package.json` | 🤖 Compare `taskDefinitions` with previous release | |
| BWC-05 | Medium | Semantic versioning | Version bump matches change scope: patch for fixes, minor for features, major for breaking changes. | `package.json`, `CHANGELOG.md` | Compare CHANGELOG entries with version bump level | |

## 18. Privacy & Data Handling (PRI)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| PRI-01 | High | No telemetry | Extension does not collect or transmit telemetry, analytics, or usage data. If telemetry is added, it must be opt-in with clear disclosure. | All `src/**/*.ts` | 🤖 Grep for HTTP / HTTPS requests, `fetch`, `XMLHttpRequest`, telemetry APIs | |
| PRI-02 | High | No remote network calls | No remote network calls in steady state. Activation, flash, verify, recover, RTT, and MCP server all run locally. | All `src/**/*.ts` | 🤖 Grep for outbound network calls | |
| PRI-03 | Medium | Local-only logs | Workspace paths and RTT output are logged only to `LogOutputChannel`, never sent off-device. | `src/common/logger.ts`, `src/rtt/**` | Review log sinks | |
| PRI-04 | Low | Session-log privacy | MCP session log does not persist beyond `context.globalStorageUri` / process lifetime without user consent. | `src/mcp/session-log.ts` | Review persistence path and lifetime | |

## 19. Repository Hygiene (REP)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| REP-01 | Medium | `.gitignore` coverage | `.gitignore` excludes `out/`, `vendor/dapjs/dist/`, `node_modules/`, `*.vsix`, `.DS_Store`. | `.gitignore` | 🤖 Verify patterns cover all generated files | |
| REP-02 | Medium | No secrets in history | No secrets committed (Git history clean). | Git history | Run `gitleaks` or equivalent scan on full history | |
| REP-03 | Medium | Submodule pinned | `vendor/dapjs` submodule pinned to a known-good commit. | `.gitmodules`, `vendor/dapjs` | Run `git submodule status` and verify commit SHA | |
| REP-04 | Low | Branch protection | `main` branch requires PR review and passing CI before merge. | GitHub settings | Verify branch-protection rules in repo settings | |
| REP-05 | Low | Commit message convention | Commits follow a consistent format and include `Co-authored-by:` for AI-assisted commits. | Git history | Review recent commit messages | |

## 20. License & Attribution (LIC)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| LIC-01 | High | License file | `LICENSE` contains the BSD-3-Clause full text. | `LICENSE` | 🤖 Verify license text matches BSD-3-Clause template | |
| LIC-02 | High | FreeOCD-authored SPDX headers | Every source file FreeOCD authored carries the BSD-3-Clause SPDX header. | All `src/**/*.ts` | 🤖 Grep for missing `SPDX-License-Identifier: BSD-3-Clause` headers | |
| LIC-03 | High | DAPjs attribution | Files derived from DAPjs keep the original MIT header and `Copyright Arm Limited 2018`. | Files derived from `vendor/dapjs` | 🤖 Grep for DAPjs-derived files; verify headers | |
| LIC-04 | Medium | SEGGER RTT attribution | Files derived from the SEGGER RTT example keep the MIT header and `Copyright (C) 2021 Ciro Cattuto`. | RTT-related source files | 🤖 Grep for RTT-derived files; verify headers | |
| LIC-05 | Medium | freeocd-web attribution | Files derived from `freeocd-web` keep the BSD-3-Clause header and note the source. | Affected source files | Review per-file headers | |
| LIC-06 | Medium | No unwarranted copyright | Purely original TypeScript files do **not** carry DAPjs / SEGGER copyright lines. Only files with derived code include third-party headers. | All `src/**/*.ts` | 🤖 Grep for third-party copyright lines in files without derived code | |
| LIC-07 | Medium | Third-party license compatibility | All runtime dependency licenses are compatible with BSD-3-Clause. | `package.json`, `package-lock.json` | 🤖 Run `license-checker` or equivalent audit | |

---

## Glossary

> **For AI reviewers**: These terms have specific meanings in this project.
> The canonical definitions also ship as an MCP Resource at
> [`docs://dap-glossary`](src/mcp/resources/dap-glossary.ts).

| Term | Definition |
|------|-----------|
| **DAP** | Debug Access Port — ARM on-chip debug interface |
| **CMSIS-DAP** | Arm's standard USB debug-probe firmware |
| **CMSIS-DAP v1 / v2** | HID-based vs bulk-endpoint-based transports |
| **SWD** | Serial Wire Debug — two-wire DAP dialect |
| **DP / AP** | Debug Port / Access Port (DP-side routing hub) |
| **MEM-AP / CTRL-AP / APB-AP** | Standard / Nordic / ARMv8-M AP variants |
| **RTT** | SEGGER Real-Time Transfer — target SRAM ring buffers |
| **RRAMC / NVMC / FMC / FPEC** | Flash controllers for various vendors |
| **HID** | USB Human Interface Device — transport used by CMSIS-DAP v1 |
| **MCP** | Model Context Protocol — standardised API for AI agents to interact with tools |
| **MCP Server** | Standalone Node.js process providing MCP tools via stdio |
| **VSIX** | VS Code extension package format (ZIP with manifest) |
| **Walkthrough** | VS Code's guided onboarding feature |
| **LanguageStatusItem** | VS Code status area for editor-scoped state |
| **Cascade** | Windsurf IDE's AI assistant |

---

## Revision History

| Date       | Version | Changes                                                                                |
|------------|---------|----------------------------------------------------------------------------------------|
| 2026-04-18 | 0.0.1   | Initial checklist for the 0.0.1 release.                                                |

