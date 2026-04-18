/*
 * SPDX-License-Identifier: MIT
 * SPDX-FileCopyrightText: Copyright (C) 2021 Ciro Cattuto
 *
 * Portions of this file are derived from `dapjs/examples/rtt/rtt.js`
 * (MIT License, Copyright (C) 2021 Ciro Cattuto) via `freeocd-web`
 * (`public/js/core/rtt-handler.js`, BSD 3-Clause License,
 * Copyright (c) 2026, FreeOCD).
 *
 * The original DAPjs RTT example is the authoritative reference for the
 * SEGGER RTT control block layout and buffer offsets used below.
 */

/**
 * SEGGER RTT (Real-Time Transfer) handler.
 *
 * Locates the RTT control block in the target's SRAM by scanning for the
 * "SEGGER RTT" signature, then exposes `read / write` primitives over the
 * up / down ring buffers.
 */

import { log } from '../common/logger';
import type { RttState } from '../common/types';

interface Processor {
  readBlock(addr: number, words: number): Promise<Uint32Array>;
  readMem32(addr: number): Promise<number>;
  readBytes(addr: number, len: number): Promise<Uint8Array>;
  writeMem8(addr: number, value: number): Promise<void>;
  writeMem32(addr: number, value: number): Promise<void>;
}

interface RttBuffer {
  bufAddr: number;
  pBuffer: number;
  sizeOfBuffer: number;
  wrOff: number;
  rdOff: number;
  flags: number;
}

export interface RttOptions {
  scanStartAddress?: number;
  scanRange?: number;
  scanBlockSize?: number;
  scanStride?: number;
}

// "SEGGER RTT" as raw bytes. We search the byte stream directly rather than
// a hex string, so the match offset cannot fall on a nibble boundary
// (`indexOf` on a hex string can match at odd indices, which would yield a
// non-integer byte offset and an incorrect control-block address).
const RTT_SIGNATURE_BYTES = new Uint8Array([
  0x53, 0x45, 0x47, 0x47, 0x45, 0x52, 0x20, 0x52, 0x54, 0x54
]); // "SEGGER RTT"

export class RttHandler {
  private readonly scanStartAddress: number;
  private readonly scanRange: number;
  private readonly scanBlockSize: number;
  private readonly scanStride: number;

  private numBufUp = 0;
  private numBufDown = 0;
  private bufUp: Record<number, RttBuffer> = {};
  private bufDown: Record<number, RttBuffer> = {};
  private rttCtrlAddr: number | null = null;
  private initialized = false;

  constructor(private readonly processor: Processor, options: RttOptions = {}) {
    this.scanStartAddress = options.scanStartAddress ?? 0x20000000;
    this.scanRange = options.scanRange ?? 0x10000;
    this.scanBlockSize = options.scanBlockSize ?? 0x1000;
    this.scanStride = options.scanStride ?? 0x0800;
  }

  public getState(): RttState {
    return {
      connected: this.initialized,
      numBufUp: this.numBufUp,
      numBufDown: this.numBufDown,
      controlBlockAddress: this.rttCtrlAddr ?? undefined
    };
  }

  public async init(): Promise<number> {
    log.info('Locating RTT control block...');

    for (let offset = 0; offset < this.scanRange; offset += this.scanStride) {
      try {
        const data32 = await this.processor.readBlock(
          this.scanStartAddress + offset,
          this.scanBlockSize / 4
        );
        const data = new Uint8Array(data32.buffer);
        const sigIndex = indexOfBytes(data, RTT_SIGNATURE_BYTES);
        if (sigIndex >= 0) {
          this.rttCtrlAddr = this.scanStartAddress + offset + sigIndex;
          log.info(`RTT control block found at 0x${this.rttCtrlAddr.toString(16)}`);
          break;
        }
      } catch (err) {
        log.warn(`Scan error at offset 0x${offset.toString(16)}: ${(err as Error).message}`);
      }
    }

    if (!this.rttCtrlAddr) {
      log.warn('RTT control block not found.');
      return -1;
    }

    const data32 = await this.processor.readBlock(this.rttCtrlAddr, this.scanBlockSize / 4);
    const data = new Uint8Array(data32.buffer);
    const dv = new DataView(data.buffer);

    this.numBufUp = dv.getUint32(16, true);
    this.numBufDown = dv.getUint32(20, true);
    log.info(`RTT: ${this.numBufUp} up buffers, ${this.numBufDown} down buffers`);

    for (let bufIndex = 0; bufIndex < this.numBufUp; bufIndex++) {
      const bufOffset = 24 + bufIndex * 24;
      this.bufUp[bufIndex] = parseBuffer(dv, bufOffset, this.rttCtrlAddr);
    }
    for (let bufIndex = 0; bufIndex < this.numBufDown; bufIndex++) {
      const bufOffset = 24 + (this.numBufUp + bufIndex) * 24;
      this.bufDown[bufIndex] = parseBuffer(dv, bufOffset, this.rttCtrlAddr);
    }

    this.initialized = true;
    return this.numBufUp + this.numBufDown;
  }

  public async read(bufId: number = 0): Promise<Uint8Array> {
    if (!this.initialized) {
      throw new Error('RTT not initialized.');
    }
    const buf = this.bufUp[bufId];
    if (!buf) {
      throw new Error(`Up buffer ${bufId} not found.`);
    }
    buf.rdOff = await this.processor.readMem32(buf.bufAddr + 16);
    buf.wrOff = await this.processor.readMem32(buf.bufAddr + 12);

    if (buf.wrOff > buf.rdOff) {
      const data = await this.processor.readBytes(buf.pBuffer + buf.rdOff, buf.wrOff - buf.rdOff);
      buf.rdOff = buf.wrOff;
      await this.processor.writeMem32(buf.bufAddr + 16, buf.rdOff);
      return data;
    }
    if (buf.wrOff < buf.rdOff) {
      const data1 = await this.processor.readBytes(
        buf.pBuffer + buf.rdOff,
        buf.sizeOfBuffer - buf.rdOff
      );
      const data2 = await this.processor.readBytes(buf.pBuffer, buf.wrOff);
      const out = new Uint8Array(data1.length + data2.length);
      out.set(data1, 0);
      out.set(data2, data1.length);
      buf.rdOff = buf.wrOff;
      await this.processor.writeMem32(buf.bufAddr + 16, buf.rdOff);
      return out;
    }
    return new Uint8Array(0);
  }

  public async write(data: Uint8Array, bufId: number = 0): Promise<number> {
    if (!this.initialized) {
      throw new Error('RTT not initialized.');
    }
    const buf = this.bufDown[bufId];
    if (!buf) {
      throw new Error(`Down buffer ${bufId} not found.`);
    }
    buf.rdOff = await this.processor.readMem32(buf.bufAddr + 16);
    buf.wrOff = await this.processor.readMem32(buf.bufAddr + 12);

    let numAvail: number;
    // Per the SEGGER RTT ring-buffer protocol, one byte must always remain
    // free so the empty state (wrOff == rdOff) is distinguishable from the
    // full state. Both branches therefore subtract 1.
    if (buf.wrOff >= buf.rdOff) {
      numAvail = buf.sizeOfBuffer - (buf.wrOff - buf.rdOff) - 1;
    } else {
      numAvail = buf.rdOff - buf.wrOff - 1;
    }

    if (numAvail < data.length) {
      return -1;
    }

    for (let i = 0; i < data.length; i++) {
      await this.processor.writeMem8(buf.pBuffer + buf.wrOff, data[i]);
      if (++buf.wrOff === buf.sizeOfBuffer) {
        buf.wrOff = 0;
      }
    }
    await this.processor.writeMem32(buf.bufAddr + 12, buf.wrOff);
    return data.length;
  }

  public reset(): void {
    this.numBufUp = 0;
    this.numBufDown = 0;
    this.bufUp = {};
    this.bufDown = {};
    this.rttCtrlAddr = null;
    this.initialized = false;
  }
}

function parseBuffer(dv: DataView, bufOffset: number, baseAddr: number): RttBuffer {
  return {
    bufAddr: baseAddr + bufOffset,
    pBuffer: dv.getUint32(bufOffset + 4, true),
    sizeOfBuffer: dv.getUint32(bufOffset + 8, true),
    wrOff: dv.getUint32(bufOffset + 12, true),
    rdOff: dv.getUint32(bufOffset + 16, true),
    flags: dv.getUint32(bufOffset + 20, true)
  };
}

/**
 * Byte-wise search: return the first index in `haystack` where `needle` is
 * found, or -1 if not present. Unlike converting to a hex string and running
 * `indexOf`, this guarantees byte-aligned matches.
 */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || haystack.length < needle.length) {
    return -1;
  }
  const end = haystack.length - needle.length;
  outer: for (let i = 0; i <= end; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}
