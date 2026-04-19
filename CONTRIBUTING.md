# Contributing to FreeOCD

Thanks for your interest in FreeOCD. This guide covers the development
workflow, coding conventions, and the most common "how do I add X?"
recipes.

## Prerequisites

- **Node.js 22.x** (LTS recommended). Node 20 is also supported by CI.
- **VS Code 1.101+** (or Windsurf Next 1.110+, Cursor on a comparable base,
  Cline on top of VS Code).
- **Git** with submodule support (`git clone --recurse-submodules`).
- **Linux only**: `libusb-1.0-0-dev`, `libudev-dev`, and udev rules for
  CMSIS-DAP (see `README.md` § Troubleshooting).
- **A CMSIS-DAP probe** (DAPLink / Picoprobe / XIAO+CMSIS-DAP / …) for
  end-to-end testing with real hardware.

## First checkout

```sh
git clone --recurse-submodules https://github.com/FreeOCD/freeocd-vscode-extension.git
cd freeocd-vscode-extension
npm install
npm run build:dapjs
```

`npm run build:dapjs` runs `cd vendor/dapjs && npm install && npm run build`
and produces `vendor/dapjs/dist/dap.umd.js`, which webpack copies to
`out/dap.umd.js` during the extension build.

## Development workflow

```sh
npm run watch        # webpack --mode development --watch
```

Then press **F5** in VS Code to launch the Extension Development Host.

Useful scripts:

| Command                   | What it does                                           |
|---------------------------|--------------------------------------------------------|
| `npm run lint`            | ESLint over `src/`                                     |
| `npm run lint:targets`    | Validate every target JSON under `vendor/freeocd-web/public/targets/**` |
| `npx tsc --noEmit -p .`   | Full TypeScript typecheck                              |
| `npm run compile`         | Production webpack build (→ `out/`)                    |
| `npm test`                | Run the extension test suite (vscode-test)             |
| `npm run package`         | `vsce package` — produces a VSIX                       |

## Project structure

A high-level map; see the rev.4 plan for a full walkthrough.

```
src/
  common/          # logger, error classes, cross-module types
  transport/       # node-hid + registry for future backends
  connection/      # probe lifecycle (connect / disconnect)
  target/          # target JSON schema, platform handlers, target manager
  dap/             # low-level DAP helpers (raw DAP_TRANSFER)
  flasher/         # HEX parser, flasher, auto-flash watcher
  rtt/             # SEGGER RTT handler + Pseudoterminal
  mcp/
    tools/         # MCP tool declarations (connection/target/flash/rtt/dap/session)
    prompts/       # /mcp.freeocd.<prompt> definitions
    resources/     # schema:// reference:// docs:// logs://
    mcp-server.ts  # standalone stdio server (bundled separately)
    mcp-bridge.ts  # workspaceStorage IPC
    mcp-provider.ts # feature-detected mcpServerDefinitionProviders
    tool-handlers.ts # extension-side dispatcher
  tasks/           # `freeocd` task type provider
  ui/              # status, tree providers, file decorations
  extension.ts     # activate() / deactivate()

resources/
  icons/           # SVG / PNG
  walkthrough/     # Markdown for the Getting Started walkthrough
  tool-sets/       # Chat tool-set bundle (freeocd.toolsets.jsonc)

vendor/dapjs/         # git submodule (MIT) — DAPjs UMD bundle
vendor/freeocd-web/   # git submodule (BSD-3-Clause) — shared target tree
                      # (public/targets/ is copied to out/targets/ at build)

scripts/
  validate-targets.js  # CI target JSON validator (walks vendor/freeocd-web)
```

## Code style

- **TypeScript strict mode** — avoid `any`; use `unknown` with narrowing.
- **English** comments and docstrings in source files (per user rule).
- Localise **all** user-visible strings with `vscode.l10n.t(...)` and keep
  `l10n/bundle.l10n.json`, `l10n/bundle.l10n.ja.json`,
  `l10n/bundle.l10n.zh-cn.json`, and `l10n/bundle.l10n.zh-tw.json` in sync.

## Adding a new target MCU

The canonical target MCU tree lives in the [`freeocd-web`](https://github.com/FreeOCD/freeocd-web)
sister project and is vendored into this repository as a git submodule at
`vendor/freeocd-web/public/targets/`. Both front-ends share the same JSON so
target support added in one front-end is automatically available in the other.

1. In the `freeocd-web` repository, drop a JSON file at
   `public/targets/<platform>/<family>/<mcu>.json` and add the ID to
   `public/targets/index.json`. See `freeocd-web`'s CONTRIBUTING.md for the
   full procedure (including probe-filters.json if the MCU ships with a new
   CMSIS-DAP probe VID).
2. In this repository, bump the submodule:
   `git submodule update --remote vendor/freeocd-web`.
3. Run `npm run lint:targets` (also invoked in CI) — it walks the vendored
   tree and validates every target JSON against the FreeOCD schema.
4. If you are introducing a brand-new platform:
   - Implement `src/target/<platform>-handler.ts` extending `PlatformHandler`.
   - Register it in `PLATFORM_HANDLERS` in `src/target/target-manager.ts`.
5. From an MCP-enabled chat, run `/mcp.freeocd.add_new_mcu_support` — the
   prompt walks the AI through `describe_capabilities` → draft →
   `validate_target_definition` → `test_target_definition` → `flash_hex`.

**Note**: Target JSONs must not carry a `usbFilters` field. CMSIS-DAP probe
USB vendor IDs are managed centrally in
`vendor/freeocd-web/public/targets/probe-filters.json`.

## Updating Chat tool sets

FreeOCD's chat tool sets (`#freeocd-flash`, `#freeocd-rtt`,
`#freeocd-target`, `#freeocd-low-level`, `#freeocd-session`) are defined in
[`resources/tool-sets/freeocd.toolsets.jsonc`](resources/tool-sets/freeocd.toolsets.jsonc).
Whenever you add, rename, or remove an MCP tool:

1. Update the relevant `tools` array in that JSONC file.
2. Keep the `toolSet` property on the `ToolDefinition` (in `src/mcp/tools/*`)
   in sync with the bundled file.
3. Note the change in `CHANGELOG.md` so users who previously imported the
   file know to re-import it.

## Adding a new transport

1. Implement `TransportBackend` in `src/transport/<name>-transport.ts`.
2. Register it via `registerTransport(backend)` from
   `src/extension.ts` (behind feature detection if it needs a new native
   dependency).
3. Extend the `freeocd.connection.method` configuration `enum` and the
   `TransportMethod` union in `src/common/types.ts`.

## Adding translations

1. Duplicate `package.nls.json` → `package.nls.<locale>.json` and translate
   values (keep the keys exactly).
2. Duplicate `l10n/bundle.l10n.json` → `l10n/bundle.l10n.<locale>.json`.
3. Document the locale code in the PR description.

## Releasing

1. Bump `version` in `package.json` and add a dated section to
   `CHANGELOG.md`.
2. Commit, tag `vX.Y.Z`, and push the tag:
   ```sh
   git commit -m "chore: release vX.Y.Z"
   git tag vX.Y.Z
   git push --follow-tags
   ```
3. `.github/workflows/release.yml` will:
   - Run the release gate (lint + typecheck + Linux test).
   - Build all 7 platform-specific VSIX.
   - Publish to VS Code Marketplace (`VSCE_PAT`/`AZURE_PAT` secret).
   - Publish to Open VSX (`OPEN_VSX_PAT` secret).
   - Create a GitHub Release with all VSIX attached.
4. Marketplace / Open VSX secrets must be set up by an admin before the
   first release:
   - **`AZURE_PAT`** — Azure DevOps PAT scoped to "Marketplace (Manage)".
   - **`OPEN_VSX_PAT`** — Open VSX PAT from <https://open-vsx.org/user-settings/tokens>.

## Testing on hardware

If your PR affects flash / recover / RTT, please include at minimum:

- Probe + target MCU + firmware details in the PR description.
- A successful `flash_hex` → `verify_hex` round trip.
- For recover changes, a "before / after" screenshot of the log.

## Code of conduct

Be kind. We are all here to make embedded development a nicer experience.
