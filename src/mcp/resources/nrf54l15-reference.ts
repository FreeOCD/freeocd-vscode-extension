/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Embedded reference copy of the nRF54L15 target definition. Kept in sync
 * with `vendor/freeocd-web/public/targets/nordic/nrf54/nrf54l15.json` (the
 * canonical source of truth shared with the freeocd-web sister project) by
 * code review.
 *
 * CMSIS-DAP probe USB filtering is managed centrally in
 * `vendor/freeocd-web/public/targets/probe-filters.json`, so target
 * definitions must not carry a `usbFilters` field.
 */
export const NRF54L15_REFERENCE = JSON.stringify(
  {
    id: 'nordic/nrf54/nrf54l15',
    name: 'nRF54L15',
    platform: 'nordic',
    cpu: 'cortex-m33',
    cputapid: '0x6ba02477',
    ctrlAp: {
      num: 2,
      idr: '0x32880000'
    },
    eraseAllStatus: {
      ready: 0,
      readyToReset: 1,
      busy: 2,
      error: 3
    },
    flashController: {
      type: 'rramc',
      base: '0x5004B000',
      registers: {
        config: { offset: '0x500', enableValue: '0x101' },
        ready: { offset: '0x400' },
        readyNext: { offset: '0x404' }
      }
    },
    flash: {
      address: '0x00000000',
      size: '0x0017D000'
    },
    sram: {
      address: '0x20000000',
      workAreaSize: '0x4000'
    },
    capabilities: ['recover', 'flash', 'verify', 'rtt'],
    description: 'Nordic nRF54L15 (Cortex-M33, RRAMC)'
  },
  null,
  2
);
