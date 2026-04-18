/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 *
 * The `HidTransport` class below mirrors the protocol handling in
 * `vendor/dapjs/src/transport/hid.ts` (DAPjs, MIT License,
 * Copyright Arm Limited 2018). Only the minimum amount of code required
 * for node-hid integration is adapted; the original file is the authoritative
 * reference for protocol framing.
 */

/**
 * node-hid-backed transport for CMSIS-DAP v1 probes.
 *
 * A CMSIS-DAP v1 probe exposes a 64-byte HID report. We send commands by
 * calling `device.write` (prefixing an extra byte on Windows, per node-hid
 * documentation) and read responses via the async `device.read` callback.
 */

import { platform } from 'os';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { HID } from 'node-hid';
import type { BufferSource, DapjsTransport, TransportBackend } from './transport-interface';
import type { ProbeInfo, TransportMethod } from '../common/types';
import { log } from '../common/logger';

const DEFAULT_PACKET_SIZE = 64;

/**
 * CMSIS-DAP v1 HID vendor/product ID filter list.
 *
 * Includes the canonical CMSIS-DAP interface class (0x03 = HID) and a set of
 * well-known DAPLink / picoprobe / XIAO / NUCLEO / STLink vendor IDs seen in
 * the wild. The filter is intentionally broad: any HID device with a usage
 * page of 0xFF00 (vendor-specific) and a product string containing "CMSIS-DAP"
 * is considered a candidate.
 */
export const CMSIS_DAP_USAGE_PAGE = 0xff00;

/**
 * Known CMSIS-DAP probe vendor IDs loaded from resources/probe-filters.json.
 * These vendor IDs are used to filter probes in addition to usagePage and
 * product name matching.
 */
let KNOWN_CMSIS_DAP_VENDOR_IDS: number[] = [];

/**
 * Initialize vendor ID filter from JSON file.
 * This must be called after the extension context is available.
 */
export function initProbeFilters(extensionPath: string): void {
  let filtersPath: string;
  let loaded = false;

  // Try production path first (out/probe-filters.json)
  try {
    filtersPath = join(extensionPath, 'probe-filters.json');
    const filtersData = JSON.parse(readFileSync(filtersPath, 'utf-8'));
    if (filtersData.vendorIds && Array.isArray(filtersData.vendorIds)) {
      KNOWN_CMSIS_DAP_VENDOR_IDS = filtersData.vendorIds.map((vid: string) => parseInt(vid, 16));
      log.info(`Loaded ${KNOWN_CMSIS_DAP_VENDOR_IDS.length} CMSIS-DAP vendor IDs: ${KNOWN_CMSIS_DAP_VENDOR_IDS.map(vid => '0x' + vid.toString(16)).join(', ')}`);
      loaded = true;
    }
  } catch (err) {
    // Try development path (resources/probe-filters.json)
    try {
      filtersPath = join(extensionPath, 'resources/probe-filters.json');
      const filtersData = JSON.parse(readFileSync(filtersPath, 'utf-8'));
      if (filtersData.vendorIds && Array.isArray(filtersData.vendorIds)) {
        KNOWN_CMSIS_DAP_VENDOR_IDS = filtersData.vendorIds.map((vid: string) => parseInt(vid, 16));
        log.info(`Loaded ${KNOWN_CMSIS_DAP_VENDOR_IDS.length} CMSIS-DAP vendor IDs: ${KNOWN_CMSIS_DAP_VENDOR_IDS.map(vid => '0x' + vid.toString(16)).join(', ')}`);
        loaded = true;
      }
    } catch (devErr) {
      log.warn(`Failed to load probe-filters.json from both production and development paths. Vendor ID filtering will be disabled.`);
    }
  }
}

/**
 * node-hid transport implementation conforming to `DapjsTransport`.
 */
export class HidTransport implements DapjsTransport {
  public readonly packetSize = DEFAULT_PACKET_SIZE;
  private readonly os = platform();
  private device: HID;
  private closed = false;

  constructor(device: HID, private readonly reopen: () => HID) {
    this.device = device;
  }

  public async open(): Promise<void> {
    // Re-create the underlying node-hid device if we were previously closed
    // (e.g. after DAPjs `ADI.reconnect()` which closes the transport then
    // re-opens it). node-hid does not support reopening a closed HID handle,
    // so we ask the backend to construct a fresh one via the `reopen` factory.
    if (this.closed) {
      this.device = this.reopen();
      this.closed = false;
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.device.close();
    } catch (err) {
      log.warn(`HidTransport.close error: ${(err as Error).message}`);
    }
  }

  public async read(): Promise<DataView> {
    // Always use the async read callback (which runs on a node-hid background
    // thread) rather than the synchronous `readTimeout`. The sync variant
    // blocks the JS event loop and — on macOS — reliably causes `Cannot write
    // to hid device` errors after a few thousand iterations of a flash loop.
    const data = await new Promise<number[]>((resolve, reject) => {
      this.device.read((error, bytes) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } else {
          resolve(bytes);
        }
      });
    });

    const buffer = new Uint8Array(data).buffer;
    return new DataView(buffer);
  }

  public async write(data: BufferSource): Promise<void> {
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    const array: number[] = Array.from(view);

    // Pad to packet size.
    while (array.length < this.packetSize) {
      array.push(0);
    }

    // Windows requires prepending a throwaway report ID byte.
    if (this.os === 'win32') {
      array.unshift(0);
    }

    const bytesWritten = this.device.write(array);
    if (bytesWritten !== array.length) {
      throw new Error(`HID write mismatch: expected ${array.length} bytes, wrote ${bytesWritten}`);
    }
  }
}

/**
 * Backend that uses `node-hid` to enumerate and open CMSIS-DAP v1 probes.
 *
 * We require the caller to pass the `node-hid` module so this file stays
 * unit-testable and the main extension can decide when to pay the native
 * binding cost.
 */
export class HidBackend implements TransportBackend {
  public readonly method: TransportMethod = 'hid';
  public readonly displayName = 'HID (CMSIS-DAP v1)';

  // Keep the node-hid module private; we intentionally avoid taking a compile-
  // time dependency on node-hid so the MCP server bundle (which never opens a
  // probe) does not pull it in.
  constructor(private readonly nodeHid: typeof import('node-hid')) {}

  public async list(): Promise<ProbeInfo[]> {
    const devices = this.nodeHid.devices();
    const candidates: ProbeInfo[] = [];

    for (const device of devices) {
      const product = device.product ?? '';
      const isCmsisDap =
        device.usagePage === CMSIS_DAP_USAGE_PAGE ||
        /CMSIS-?DAP/i.test(product) ||
        /DAPLink/i.test(product) ||
        /Picoprobe/i.test(product);

      // Vendor ID filtering: if we have a list of known vendor IDs, only include devices from those vendors
      // If the list is empty (e.g., JSON failed to load), skip this check to maintain backward compatibility
      const isKnownProbe =
        KNOWN_CMSIS_DAP_VENDOR_IDS.length === 0 ||
        KNOWN_CMSIS_DAP_VENDOR_IDS.includes(device.vendorId);

      if (!isCmsisDap || !isKnownProbe) {
        continue;
      }

      candidates.push({
        path: device.path ?? '',
        vendorId: device.vendorId,
        productId: device.productId,
        serialNumber: device.serialNumber,
        manufacturer: device.manufacturer,
        product: device.product,
        release: device.release,
        interface: device.interface,
        usagePage: device.usagePage,
        usage: device.usage
      });
    }

    return candidates;
  }

  public async open(probe: ProbeInfo): Promise<DapjsTransport> {
    if (!probe.path) {
      throw new Error('Probe path is empty.');
    }
    const HID = this.nodeHid.HID;
    const path = probe.path;
    const device = new HID(path);
    return new HidTransport(device, () => new HID(path));
  }
}
