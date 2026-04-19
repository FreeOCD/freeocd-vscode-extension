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
 * CMSIS-DAP v1 HID vendor-specific usage page.
 *
 * A HID device is considered a CMSIS-DAP probe candidate when either its USB
 * vendor ID is listed in `probe-filters.json`, or its HID usage page equals
 * this value (0xFF00), or its USB product string contains "CMSIS-DAP"
 * (case-insensitive; the hyphen is optional to tolerate firmware labels such
 * as "CMSISDAP" seen in the wild). These signals are combined with OR
 * semantics.
 */
export const CMSIS_DAP_USAGE_PAGE = 0xff00;

/**
 * Known CMSIS-DAP probe vendor IDs loaded from `probe-filters.json`.
 * Used alongside HID usage page and product name matching (OR semantics):
 * a device is accepted when its vendor ID is in this list OR it already
 * looks like a CMSIS-DAP probe by usagePage / product string.
 */
let KNOWN_CMSIS_DAP_VENDOR_IDS: number[] = [];

/**
 * Initialize vendor ID filter from JSON file.
 * This must be called after the extension context is available.
 *
 * The canonical `probe-filters.json` is maintained in the `freeocd-web`
 * sister project and vendored in as a git submodule at
 * `vendor/freeocd-web/public/targets/probe-filters.json`. Webpack's
 * `CopyWebpackPlugin` copies the whole `public/targets/` tree into
 * `out/targets/` for packaged VSIXs. When running from source (extension
 * development host) the file is loaded directly from the submodule path as a
 * fallback.
 */
export function initProbeFilters(extensionPath: string): void {
  const candidates = [
    join(extensionPath, 'out', 'targets', 'probe-filters.json'),
    join(extensionPath, 'vendor', 'freeocd-web', 'public', 'targets', 'probe-filters.json')
  ];

  for (const filtersPath of candidates) {
    if (tryLoadProbeFilters(filtersPath)) {
      return;
    }
  }

  log.warn(
    'Failed to load probe-filters.json from any known location ' +
      `(${candidates.join(', ')}). Probe detection will rely solely on the ` +
      'HID usage page and product string.'
  );
}

function tryLoadProbeFilters(filtersPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(filtersPath, 'utf-8');
  } catch {
    return false;
  }
  let filtersData: unknown;
  try {
    filtersData = JSON.parse(raw);
  } catch (err) {
    log.warn(`probe-filters.json at ${filtersPath} is not valid JSON: ${(err as Error).message}`);
    return false;
  }
  const vendorIds = (filtersData as { vendorIds?: unknown }).vendorIds;
  if (!Array.isArray(vendorIds)) {
    return false;
  }
  // Each entry must be an object of the form
  // `{ "vid": "0x2E8A", "$comment": "Raspberry Pi — ..." }`.
  //
  // The legacy bare-hex-string form (`"0x2E8A"`) is no longer accepted —
  // the canonical `probe-filters.json` ships in `freeocd-web` and has been
  // migrated to the object form to carry a `$comment` describing each VID.
  // Mirror this in `freeocd-web`'s `core/probe-filters.js` when bumping the
  // submodule pin.
  const parsed: number[] = [];
  for (const entry of vendorIds) {
    if (!entry || typeof entry !== 'object') {
      log.warn(
        'Skipping invalid vendor entry in probe-filters.json ' +
          `(expected { vid: "0x..." }): ${JSON.stringify(entry)}`
      );
      continue;
    }
    const vidStr = (entry as { vid?: unknown }).vid;
    if (typeof vidStr !== 'string') {
      log.warn(
        'Skipping invalid vendor entry in probe-filters.json ' +
          `(missing string \`vid\`): ${JSON.stringify(entry)}`
      );
      continue;
    }
    const vid = parseInt(vidStr, 16);
    if (Number.isNaN(vid)) {
      log.warn(`Skipping invalid vendor ID in probe-filters.json: ${vidStr}`);
      continue;
    }
    parsed.push(vid);
  }
  KNOWN_CMSIS_DAP_VENDOR_IDS = parsed;
  log.info(
    `Loaded ${KNOWN_CMSIS_DAP_VENDOR_IDS.length} CMSIS-DAP vendor IDs from ${filtersPath}: ` +
      KNOWN_CMSIS_DAP_VENDOR_IDS.map((vid) => '0x' + vid.toString(16)).join(', ')
  );
  return true;
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
        /CMSIS-?DAP/i.test(product);

      // Vendor ID whitelist loaded from probe-filters.json. Combined with
      // `isCmsisDap` via OR: a device is accepted if either signal matches.
      // When the JSON failed to load, the list is empty and this check
      // always returns false, so detection falls back to `isCmsisDap` alone.
      const isKnownProbe = KNOWN_CMSIS_DAP_VENDOR_IDS.includes(device.vendorId);

      if (!isCmsisDap && !isKnownProbe) {
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
