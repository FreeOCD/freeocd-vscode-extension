/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 *
 * Portions of this file are derived from `freeocd-web`
 * (`public/js/core/hex-parser.js`), BSD 3-Clause License,
 * Copyright (c) 2026, FreeOCD.
 */

/**
 * Intel HEX file parser.
 *
 * Parses an Intel HEX string into a contiguous binary buffer with the
 * starting address inferred from the records. Validates per-line checksums
 * and supports record types 0x00 (data), 0x01 (EOF), 0x02 (extended segment
 * address), 0x03 / 0x05 (start address — ignored), and 0x04 (extended linear
 * address).
 */

import { HexParseError } from '../common/errors';

export interface ParsedHex {
  data: Uint8Array;
  startAddress: number;
  size: number;
}

/**
 * Parse Intel HEX format into binary data.
 *
 * @param hex - Text content of an Intel HEX file.
 * @returns Contiguous binary buffer (gap bytes filled with `0xff`).
 */
export function parseIntelHex(hex: string): ParsedHex {
  const lines = hex.split(/\r?\n/u);
  const entries: Array<{ address: number; value: number }> = [];
  let extendedAddress = 0;
  let minAddress = Number.POSITIVE_INFINITY;
  let maxAddress = 0;

  for (const line of lines) {
    if (!line.startsWith(':')) {
      continue;
    }

    // Every HEX record encodes an even number of hex chars after the colon
    // (each byte is exactly 2 chars). An odd count indicates a truncated
    // record, which we reject up front so we surface a useful error rather
    // than letting a later checksum mismatch mask it.
    if (((line.length - 1) & 1) !== 0) {
      throw new HexParseError(`Record has odd hex character count: ${line}`);
    }

    const bytes: number[] = [];
    for (let i = 1; i < line.length; i += 2) {
      const byte = parseInt(line.substr(i, 2), 16);
      if (Number.isNaN(byte)) {
        throw new HexParseError(`Invalid hex byte at line: ${line}`);
      }
      bytes.push(byte);
    }

    if (bytes.length < 5) {
      throw new HexParseError(`Record too short: ${line}`);
    }

    const byteCount = bytes[0];
    const address = (bytes[1] << 8) | bytes[2];
    const recordType = bytes[3];

    // A HEX record is <byteCount> <addrHi> <addrLo> <type> <data...> <checksum>,
    // i.e. exactly `5 + byteCount` bytes. Reject truncated / overlong records
    // up-front instead of silently slicing past the end of `bytes`.
    if (bytes.length !== 5 + byteCount) {
      throw new HexParseError(
        `Record length mismatch: declared byteCount=${byteCount} but payload has ${bytes.length - 5} bytes: ${line}`
      );
    }

    const recordData = bytes.slice(4, 4 + byteCount);

    // Verify checksum.
    let checksum = 0;
    for (let i = 0; i < bytes.length - 1; i++) {
      checksum += bytes[i];
    }
    checksum = (~checksum + 1) & 0xff;
    if (checksum !== bytes[bytes.length - 1]) {
      throw new HexParseError(`Checksum error in HEX file at line: ${line}`);
    }

    switch (recordType) {
      case 0x00: {
        const fullAddress = extendedAddress + address;
        for (let i = 0; i < recordData.length; i++) {
          entries.push({ address: fullAddress + i, value: recordData[i] });
        }
        if (fullAddress < minAddress) {
          minAddress = fullAddress;
        }
        if (fullAddress + recordData.length > maxAddress) {
          maxAddress = fullAddress + recordData.length;
        }
        break;
      }
      case 0x01:
        break;
      case 0x02:
        if (recordData.length !== 2) {
          throw new HexParseError(
            `Extended segment address record must contain 2 data bytes: ${line}`
          );
        }
        extendedAddress = ((recordData[0] << 8) | recordData[1]) << 4;
        break;
      case 0x04:
        if (recordData.length !== 2) {
          throw new HexParseError(
            `Extended linear address record must contain 2 data bytes: ${line}`
          );
        }
        extendedAddress = ((recordData[0] << 8) | recordData[1]) << 16;
        break;
      case 0x03:
      case 0x05:
        // start segment / linear address — ignored.
        break;
      default:
        // Unknown record type; silently skip but log via caller if desired.
        break;
    }
  }

  if (entries.length === 0) {
    throw new HexParseError('No data records found in HEX file.');
  }

  const size = maxAddress - minAddress;
  const buffer = new Uint8Array(size);
  buffer.fill(0xff);
  for (const { address, value } of entries) {
    buffer[address - minAddress] = value;
  }

  return { data: buffer, startAddress: minAddress, size };
}
