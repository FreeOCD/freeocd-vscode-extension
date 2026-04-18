/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 *
 * Portions of this file are derived from `freeocd-web`
 * (`public/js/core/dap-operations.js`), BSD 3-Clause License,
 * Copyright (c) 2026, FreeOCD. Which in turn adapts constants from
 * `DAPjs` (MIT License, Copyright Arm Limited 2018).
 */

/**
 * Low-level DAP operations that bypass DAPjs' response parsing bug.
 *
 * DAPjs' `transfer()` / `transferBlock()` try to read data words from
 * responses even for WRITE operations, causing "Offset is outside the bounds
 * of the DataView" errors when the probe returns a shorter response
 * (only cmd + count + ack for writes). These helpers build raw DAP_TRANSFER
 * packets and only parse the 3-byte header for write operations.
 */

import type { DapjsTransport } from '../transport/transport-interface';
import { DapTransferError } from '../common/errors';

// DP Register constants
export const DP_REG_SELECT = 0x8;
export const DP_REG_RDBUFF = 0xc;

// DAP Port and Transfer Mode constants
export const DAP_PORT_DEBUG = 0x00;
export const DAP_PORT_ACCESS = 0x01;
export const DAP_TRANSFER_WRITE = 0x00;
export const DAP_TRANSFER_READ = 0x02;

// Bank Select Mask constants
const BANK_SELECT_APSEL = 0xff000000;
const BANK_SELECT_APBANKSEL = 0x000000f0;

// CMSIS-DAP command constants
const DAP_COMMAND_TRANSFER = 0x05;

// MEM-AP register offsets (only A[3:2] bits used in transfer)
export const AP_CSW = 0x00;
export const AP_TAR = 0x04;
export const AP_DRW = 0x0c;

// CSW value for 32-bit access with auto-increment single
export const CSW_VALUE = 0x23000052;

export interface DapTransferOp {
  port: number;
  mode: number;
  register: number;
  value?: number;
}

export function createSelectValue(apNum: number, regOffset: number): number {
  const apsel = (apNum << 24) & BANK_SELECT_APSEL;
  const apbanksel = regOffset & BANK_SELECT_APBANKSEL;
  return (apsel | apbanksel) >>> 0;
}

export function getTransferRegister(regOffset: number): number {
  return regOffset & 0x0c;
}

/** Retrieve the underlying transport object from a DAPjs proxy/ADI instance. */
export function getTransport(dapOrProxy: object): DapjsTransport | null {
  const propNames = Object.getOwnPropertyNames(dapOrProxy);
  for (const name of propNames) {
    const prop = (dapOrProxy as Record<string, unknown>)[name];
    if (
      prop &&
      typeof prop === 'object' &&
      typeof (prop as { write?: unknown }).write === 'function' &&
      typeof (prop as { read?: unknown }).read === 'function'
    ) {
      return prop as DapjsTransport;
    }
  }
  return null;
}

/** Retrieve the `CmsisDAP` proxy from an `ADI` instance. */
export function getProxy(dap: object): {
  transferBlock: (...args: unknown[]) => Promise<unknown>;
  transfer: (ops: DapTransferOp[]) => Promise<number[]>;
} {
  const propNames = Object.getOwnPropertyNames(dap);
  for (const name of propNames) {
    const prop = (dap as Record<string, unknown>)[name];
    if (
      prop &&
      typeof prop === 'object' &&
      typeof (prop as { transferBlock?: unknown }).transferBlock === 'function'
    ) {
      return prop as {
        transferBlock: (...args: unknown[]) => Promise<unknown>;
        transfer: (ops: DapTransferOp[]) => Promise<number[]>;
      };
    }
  }
  throw new DapTransferError('Could not find proxy object with transferBlock in ADI instance.');
}

/**
 * Raw DAP_TRANSFER write that bypasses DAPjs response parsing.
 *
 * Builds a raw DAP_TRANSFER packet and parses only the 3-byte response
 * header. Throws `DapTransferError` on protocol errors.
 */
export async function rawDapTransferWrite(
  transport: DapjsTransport,
  operations: DapTransferOp[]
): Promise<boolean> {
  const packetSize = 3 + operations.length * 5;
  const packet = new Uint8Array(packetSize);
  const view = new DataView(packet.buffer);

  packet[0] = DAP_COMMAND_TRANSFER;
  packet[1] = 0;
  packet[2] = operations.length;

  let offset = 3;
  for (const op of operations) {
    packet[offset] = op.port | op.mode | op.register;
    view.setUint32(offset + 1, op.value ?? 0, true);
    offset += 5;
  }

  await transport.write(packet);
  const response = await transport.read();

  if (response.byteLength < 3) {
    throw new DapTransferError(`DAP_TRANSFER response too short: ${response.byteLength} bytes`);
  }

  const respCmd = response.getUint8(0);
  const respCount = response.getUint8(1);
  const respAck = response.getUint8(2);

  if (respCmd !== DAP_COMMAND_TRANSFER) {
    throw new DapTransferError(
      `Bad response command: expected 0x05, got 0x${respCmd.toString(16)}`
    );
  }

  if (respCount !== operations.length) {
    throw new DapTransferError(
      `Transfer count mismatch: expected ${operations.length}, got ${respCount}`
    );
  }

  const ackValue = respAck & 0x07;
  if (ackValue === 0x02) {
    throw new DapTransferError('Transfer response WAIT', ackValue);
  }
  if (ackValue === 0x04) {
    throw new DapTransferError('Transfer response FAULT', ackValue);
  }
  if (ackValue !== 0x01) {
    throw new DapTransferError(
      `Transfer response error: ACK=0x${respAck.toString(16)}`,
      ackValue
    );
  }

  return true;
}

export async function readAPReg(
  dap: object,
  apNum: number,
  regOffset: number,
  retries: number = 3
): Promise<number | undefined> {
  const selectValue = createSelectValue(apNum, regOffset);
  const transferReg = getTransferRegister(regOffset);

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const proxy = getProxy(dap);

      await proxy.transfer([
        {
          port: DAP_PORT_DEBUG,
          mode: DAP_TRANSFER_WRITE,
          register: DP_REG_SELECT,
          value: selectValue
        }
      ]);

      await proxy.transfer([
        {
          port: DAP_PORT_ACCESS,
          mode: DAP_TRANSFER_READ,
          register: transferReg
        }
      ]);

      const result = await proxy.transfer([
        {
          port: DAP_PORT_DEBUG,
          mode: DAP_TRANSFER_READ,
          register: DP_REG_RDBUFF
        }
      ]);

      if (result && result.length > 0) {
        return result[0];
      }

      await sleep(50);
    } catch (err) {
      if (attempt < retries - 1) {
        await sleep(50);
      } else {
        throw err;
      }
    }
  }
  return undefined;
}

export async function writeAPReg(
  dap: object,
  apNum: number,
  regOffset: number,
  value: number,
  retries: number = 3
): Promise<void> {
  const selectValue = createSelectValue(apNum, regOffset);
  const transferReg = getTransferRegister(regOffset);

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const proxy = getProxy(dap);

      await proxy.transfer([
        {
          port: DAP_PORT_DEBUG,
          mode: DAP_TRANSFER_WRITE,
          register: DP_REG_SELECT,
          value: selectValue
        }
      ]);

      await proxy.transfer([
        {
          port: DAP_PORT_ACCESS,
          mode: DAP_TRANSFER_WRITE,
          register: transferReg,
          value
        }
      ]);

      return;
    } catch (err) {
      if (attempt < retries - 1) {
        await sleep(50);
      } else {
        throw err;
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
