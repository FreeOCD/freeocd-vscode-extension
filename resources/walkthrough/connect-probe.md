# Connect a CMSIS-DAP probe

FreeOCD talks to your target MCU through a CMSIS-DAP v1 probe over USB HID.

## Supported probes

- **DAPLink** boards (Arm mbed, NUCLEO, many vendor development kits)
- **CMSIS-DAP** firmware on XIAO / Pico / custom debug boards
- **Picoprobe** (RP2040 as a debug probe)
- Any probe that advertises a CMSIS-DAP-compatible HID interface

## Steps

1. Plug the probe into your computer.
2. Open the **FreeOCD** sidebar (activity bar icon).
3. Click **Connect Probe**, or run `FreeOCD: Connect Probe` from the Command Palette (⇧⌘P / Ctrl+Shift+P).

> **Linux users:** you may need to add a udev rule for your probe. See the
> [Troubleshooting](https://github.com/FreeOCD/freeocd-vscode-extension#troubleshooting)
> section of the README for a ready-to-copy rule file.
