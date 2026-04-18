/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

export const DAP_GLOSSARY = `# DAP / CMSIS-DAP / RTT Glossary

- **DAP (Debug Access Port)** — ARM's standard on-chip debug interface. Exposes an external debugger to the CPU's internal registers and memory.
- **CMSIS-DAP** — ARM's open firmware standard for USB-HID (v1) or USB-bulk (v2) debug probes. FreeOCD speaks v1 (HID).
- **DAPLink** — An open-source CMSIS-DAP-compatible firmware used on many development kits (Arm Mbed, XIAO, NUCLEO).
- **SWD (Serial Wire Debug)** — Two-wire ARM debug protocol (SWCLK + SWDIO). FreeOCD uses SWD over CMSIS-DAP.
- **DP (Debug Port)** — The SWD-side half of the DAP. Hosts DP registers (CTRL/STAT, SELECT, RDBUFF).
- **AP (Access Port)** — A DP-side hub that routes transactions to different internal buses. Multiple APs can coexist (MEM-AP, CTRL-AP, APB-AP).
- **MEM-AP** — The standard memory access port. Used for reading/writing address space (flash, SRAM, peripherals).
- **CTRL-AP** — Nordic's vendor-specific access port used for mass erase / unlock. Not a standard ARM AP.
- **APB-AP** — ARMv8-M access port for AP-space system peripherals.
- **IDCODE / IDR** — Identity registers that uniquely identify a DP (IDCODE) or an AP (IDR).
- **TAR / DRW / CSW** — MEM-AP transfer address register / data read-write register / control status word. Standard MEM-AP programming model.
- **RRAMC** — Nordic nRF54-series flash controller for resistive RAM (RRAM).
- **NVMC** — Nordic nRF52/53-series non-volatile memory controller for embedded flash.
- **RTT (Real-Time Transfer)** — SEGGER's low-overhead, bidirectional serial protocol implemented entirely in target SRAM. Requires no hardware peripheral.
- **Mass erase** — Vendor-specific operation that erases the entire flash, typically used to recover a locked device.
- **Readback protection** — Security feature that prevents external tooling from reading flash contents. Nordic's ERASEPROTECT / STM32's RDP.
`;
