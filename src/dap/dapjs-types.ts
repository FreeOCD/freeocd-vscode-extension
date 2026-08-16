/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Shared structural types for the DAPjs handles used across the extension.
 *
 * DAPjs is loaded at runtime as a UMD bundle (see `common/dapjs-loader.ts`),
 * so its classes cannot be imported as types. These interfaces model the
 * subset of the `ADI`, `CmsisDAP`, and `CortexM` APIs that this code base
 * actually uses (see `vendor/dapjs/src/`), giving every consumer one typed
 * contract instead of ad-hoc `unknown` casts.
 */

import type { DapTransferOp } from './dap-operations';

/** Subset of the DAPjs `ADI` API (memory + lifecycle operations). */
export interface DapAdi {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  reset(): Promise<boolean>;
  readDP(register: number): Promise<number>;
  writeDP(register: number, value: number): Promise<void>;
  readMem8(address: number): Promise<number>;
  writeMem8(address: number, value: number): Promise<void>;
  readMem16(address: number): Promise<number>;
  writeMem16(address: number, value: number): Promise<void>;
  readMem32(address: number): Promise<number>;
  writeMem32(address: number, value: number): Promise<void>;
  readBlock(address: number, count: number): Promise<Uint32Array>;
  writeBlock(address: number, values: Uint32Array): Promise<void>;
  readBytes(address: number, count: number): Promise<Uint8Array>;
  writeBytes(address: number, values: Uint8Array): Promise<void>;
}

/** Subset of the DAPjs `CmsisDAP` proxy API. */
export interface CmsisDapProxy {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  reset(): Promise<boolean>;
  transfer(operations: DapTransferOp[]): Promise<number[]>;
}

/**
 * Subset of the DAPjs `CortexM` API. `CortexM` extends `ADI`, so the
 * memory-access surface is available on it as well.
 */
export interface CortexMProcessor extends DapAdi {
  getState(): Promise<number>;
  isHalted(): Promise<boolean>;
  halt(): Promise<void>;
  resume(): Promise<void>;
  softReset(): Promise<void>;
  readCoreRegister(register: number): Promise<number>;
  readCoreRegisters(registers?: number[]): Promise<number[]>;
  writeCoreRegister(register: number, value: number): Promise<void>;
  execute(
    address: number,
    code: Uint32Array,
    stackPointer?: number,
    programCounter?: number
  ): Promise<void>;
}
