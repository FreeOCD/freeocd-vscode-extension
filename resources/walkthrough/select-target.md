# Select a target MCU

FreeOCD ships with the **nRF54L15** target out of the box. Additional MCUs
can be added via:

- **User-defined target JSON** — import a file with `FreeOCD: Import Target Definition`.
- **AI-assisted MCU support** — run `/mcp.freeocd.add_new_mcu_support` from
  Copilot Chat / Windsurf Cascade / Cursor chat to have the AI draft and
  validate a new target definition for you.

## Steps

1. Run `FreeOCD: Select Target MCU`.
2. Pick the target from the Quick Pick.
3. Your selection is stored in the `freeocd.target.mcu` setting.

The currently-selected target is shown in the **Target** TreeView and in the
Language Status bar (bottom-right).
