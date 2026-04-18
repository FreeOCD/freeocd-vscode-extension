# Security Policy

## Reporting a vulnerability

If you discover a security issue in FreeOCD, **please do not open a public
GitHub issue**. Instead, report it privately through one of the following
channels:

1. [GitHub Security Advisories](https://github.com/FreeOCD/freeocd-vscode-extension/security/advisories/new) — preferred.
2. Email the maintainers (see commit log for current addresses).

We will acknowledge receipt within 5 business days and aim to publish a fix
within 30 days, coordinated with a CVE and Security Advisory where
appropriate.

## Threat model

FreeOCD talks to physical hardware over USB HID and exposes an MCP server
that AI agents can drive. The most relevant threats we think about are:

- **Malicious or corrupt `.hex`** — The Intel HEX parser validates record
  checksums, rejects oversized records, and never interprets record types
  outside the standard set. It still executes a write against the target
  memory — users must only flash firmware they trust.
- **Malicious target JSON** — Target JSON can move flash / SRAM pointers.
  We validate via a Zod schema plus the CI `validate-targets.js` script,
  and persist user-defined targets under `context.storageUri/targets/**`
  (workspaceStorage, never in the user's repo).
- **Path traversal** — All filesystem access goes through
  `vscode.workspace.fs` + `Uri.joinPath` + `RelativePattern`; we never
  `String.concat` user input onto a base path.
- **Unauthorised MCP access** — The bundled MCP server is a stdio child
  process launched exclusively by the extension (or by a user who manually
  pasted the `freeocd.setupMcp` payload into their IDE). The server has no
  network surface.
- **Untrusted workspace** — The extension declares
  `"capabilities.untrustedWorkspaces": { "supported": false }` so VS Code
  blocks activation in an untrusted workspace.
- **Native binding supply chain** — `node-hid` prebuilt binaries are
  delivered via npm. CI verifies the native binding loads on every matrix
  leg. VSCE's secret scanning (shipped with VS Code 1.101+) refuses to
  package anything containing API keys or `.env` files.

## Hardening guidance for contributors

- Never call `child_process.spawn` / `exec` with user-supplied strings.
- Never interpret arbitrary binaries as code (we read `.hex` only).
- Keep MCP tool schemas **strict** via Zod (`.strict()`) so unknown fields
  are rejected.
- Run `npm audit` on every PR; open a security advisory for any
  uncorrected high-severity finding in a transitive dependency.

## Acknowledgements

Thanks to the embedded security community and the Arm / Nordic / SEGGER
engineers whose public documentation made this project possible.
