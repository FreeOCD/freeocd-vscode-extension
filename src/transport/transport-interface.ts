/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Abstract transport layer used by DAPjs.
 *
 * Both `HID` (node-hid) and any future `USB` (libusb) / `WebUSB` backends
 * conform to this signature so the rest of the code base stays transport-
 * agnostic.
 */

import type { ProbeInfo, TransportMethod } from '../common/types';

/**
 * Minimal `BufferSource` alias to avoid pulling in `lib.dom` just for a type
 * name. Matches the Web standard definition (any `ArrayBuffer` or view).
 */
export type BufferSource = ArrayBufferView | ArrayBuffer;

/**
 * Runtime transport handle matching DAPjs' `Transport` interface
 * (`vendor/dapjs/src/transport/index.ts`): synchronous `open/close` and
 * asynchronous `read/write`.
 */
export interface DapjsTransport {
  readonly packetSize: number;
  open(): Promise<void>;
  close(): Promise<void>;
  read(): Promise<DataView>;
  write(data: BufferSource): Promise<void>;
}

/**
 * Pluggable transport backend. Implementations enumerate probes and open a
 * `DapjsTransport` for a given `ProbeInfo`.
 */
export interface TransportBackend {
  readonly method: TransportMethod;
  readonly displayName: string;

  /** List probes currently attached to the host. */
  list(): Promise<ProbeInfo[]>;

  /** Open a transport handle for the given probe (already listed). */
  open(probe: ProbeInfo): Promise<DapjsTransport>;
}
