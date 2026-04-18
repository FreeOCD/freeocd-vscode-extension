/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

export const ARM_CORTEX_M_REGISTERS = `# ARM Cortex-M Core Register Reference

## General-purpose registers (DCRSR register ID)

| ID   | Name     | Description                                       |
|------|----------|---------------------------------------------------|
| 0    | R0       | General-purpose / argument / return value         |
| 1    | R1       | General-purpose / argument                        |
| 2    | R2       | General-purpose / argument                        |
| 3    | R3       | General-purpose / argument / scratch              |
| 4    | R4       | Callee-saved                                      |
| 5    | R5       | Callee-saved                                      |
| 6    | R6       | Callee-saved                                      |
| 7    | R7       | Callee-saved / frame pointer (thumb)              |
| 8    | R8       | Callee-saved                                      |
| 9    | R9       | Platform register / SB                            |
| 10   | R10      | Callee-saved                                      |
| 11   | R11      | Callee-saved / frame pointer                      |
| 12   | R12 (IP) | Intra-procedure-call scratch                      |
| 13   | R13 (SP) | Current stack pointer (MSP or PSP, per CONTROL.SPSEL) |
| 14   | R14 (LR) | Link register (return address)                    |
| 15   | R15 (PC) | Program counter                                   |

## Special registers

| ID   | Name            | Description                                    |
|------|-----------------|------------------------------------------------|
| 16   | xPSR            | Combined APSR + IPSR + EPSR                    |
| 17   | MSP             | Main Stack Pointer                             |
| 18   | PSP             | Process Stack Pointer                          |
| 19   | PRIMASK/BASEPRI | Interrupt masks (packed)                       |
| 20   | CONTROL         | Privilege / SP-select / FPU state              |

## DHCSR bits (Debug Halting Control and Status Register at 0xE000EDF0)

- \`C_DEBUGEN\`  (bit 0)  — Enable halting debug
- \`C_HALT\`      (bit 1)  — Halt CPU
- \`C_STEP\`      (bit 2)  — Single-step
- \`C_MASKINTS\`  (bit 3)  — Mask interrupts during step
- \`S_REGRDY\`    (bit 16) — Register transfer complete
- \`S_HALT\`      (bit 17) — CPU is halted
- \`S_SLEEP\`     (bit 18) — CPU is sleeping
- \`S_LOCKUP\`    (bit 19) — CPU is in lockup
- \`DBGKEY\`      (bits 16-31, on write) = 0xA05F — Required to write this register

## Useful System Control Block offsets

- \`CPUID\`       0xE000ED00
- \`ICSR\`        0xE000ED04
- \`AIRCR\`       0xE000ED0C  (SYSRESETREQ via VECTKEY=0x05FA + bit 2)
- \`DHCSR\`       0xE000EDF0
- \`DCRSR\`       0xE000EDF4
- \`DCRDR\`       0xE000EDF8
- \`DEMCR\`       0xE000EDFC
`;
