/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 *
 * Portions of this file are derived from `freeocd-web`
 * (`public/js/platform/nordic-handler.js`), BSD 3-Clause License,
 * Copyright (c) 2026, FreeOCD.
 */

/**
 * Nordic Semiconductor platform handler.
 *
 * Implements CTRL-AP mass erase recovery, RRAMC / NVMC flash programming,
 * verification, and reset for the Nordic nRF series microcontrollers.
 */

import { PlatformHandler, type Cancellable, type ProgressCallback } from './platform-handler';
import {
  readAPReg,
  writeAPReg,
  rawDapTransferWrite,
  getProxy,
  getTransport,
  sleep,
  DAP_PORT_DEBUG,
  DAP_PORT_ACCESS,
  DAP_TRANSFER_WRITE,
  DP_REG_SELECT,
  AP_CSW,
  AP_TAR,
  AP_DRW,
  CSW_VALUE
} from '../dap/dap-operations';
import { CancelledError, FreeOcdError } from '../common/errors';
import { log } from '../common/logger';
import type { TargetDefinition } from '../common/types';

// CTRL-AP register offsets (common across Nordic nRF series)
const CTRL_AP_RESET = 0x000;
const CTRL_AP_ERASEALL = 0x004;
const CTRL_AP_ERASEALLSTATUS = 0x008;
const CTRL_AP_ERASEPROTECTSTATUS = 0x00c;
const CTRL_AP_IDR_REG = 0x0fc;

interface DapInstance {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  reset(): Promise<void>;
  readMem32(addr: number): Promise<number>;
  writeMem32(addr: number, value: number): Promise<void>;
}

function asDap(dap: unknown): DapInstance {
  return dap as DapInstance;
}

export class NordicHandler extends PlatformHandler {
  private readonly ctrlApNum: number;
  private readonly ctrlApIdr: number;
  private readonly eraseAllStatus: { ready: number; readyToReset: number; busy: number; error: number };

  constructor(target: TargetDefinition) {
    super(target);
    if (!target.ctrlAp) {
      throw new FreeOcdError(
        `Nordic target definition is missing ctrlAp block: ${target.id}`,
        'INVALID_TARGET'
      );
    }
    this.ctrlApNum = target.ctrlAp.num;
    this.ctrlApIdr = parseInt(target.ctrlAp.idr, 16);
    const es = target.eraseAllStatus ?? { ready: 0, readyToReset: 1, busy: 2, error: 3 };
    this.eraseAllStatus = es;
  }

  public async recover(
    dapHandle: unknown,
    onProgress: ProgressCallback,
    token: Cancellable
  ): Promise<unknown> {
    const dap = asDap(dapHandle);
    log.info('Initializing DAP connection for recovery...');

    const idr = await readAPReg(dap as unknown as object, this.ctrlApNum, CTRL_AP_IDR_REG);
    if (idr === undefined) {
      log.warn('Could not read CTRL-AP IDR; attempting mass erase anyway...');
    } else {
      log.info(`CTRL-AP IDR: 0x${idr.toString(16).toUpperCase()}`);
      if (idr !== this.ctrlApIdr) {
        log.warn(
          `Unexpected CTRL-AP IDR (expected 0x${this.ctrlApIdr.toString(16).toUpperCase()})`
        );
      }
    }

    throwIfCancelled(token);
    let eraseSuccess = await this.attemptEraseAll(dap, onProgress, false, token);

    if (!eraseSuccess) {
      log.warn('Mass erase failed, attempting fallback (reconnect + retry)...');
      try {
        await dap.disconnect();
        await sleep(500);
        await dap.connect();
        log.info('Reconnected for fallback erase');
        await sleep(200);
        throwIfCancelled(token);
        eraseSuccess = await this.attemptEraseAll(dap, onProgress, true, token);
        if (!eraseSuccess) {
          throw new FreeOcdError('Both mass erase and fallback erase failed.', 'RECOVER_FAILED');
        }
      } catch (fallbackErr) {
        throw new FreeOcdError(
          `Erase failed: ${(fallbackErr as Error).message}`,
          'RECOVER_FAILED'
        );
      }
    }

    onProgress(80);

    await sleep(10);
    log.info('Resetting device...');
    await writeAPReg(dap as unknown as object, this.ctrlApNum, CTRL_AP_RESET, 2);
    await sleep(10);
    await writeAPReg(dap as unknown as object, this.ctrlApNum, CTRL_AP_RESET, 0);
    await writeAPReg(dap as unknown as object, this.ctrlApNum, CTRL_AP_ERASEALL, 0);

    log.info('Waiting for device to stabilize...');
    await sleep(500);
    onProgress(85);

    log.info('Reconnecting to verify recovery...');
    try {
      await dap.reconnect();
      log.info('Reconnected successfully');
    } catch (reconnectErr) {
      log.warn(`Reconnect warning: ${(reconnectErr as Error).message}`);
    }

    await sleep(200);
    onProgress(90);
    await this.verifyRecovery(dap);
    onProgress(100);
    log.info('Mass erase completed successfully!');
    return dap;
  }

  public async flash(
    dapHandle: unknown,
    firmware: Uint8Array,
    startAddress: number,
    onProgress: ProgressCallback,
    token: Cancellable
  ): Promise<void> {
    const dap = asDap(dapHandle);
    log.info(`Flashing ${firmware.length} bytes starting at 0x${startAddress.toString(16)}...`);

    const proxy = getProxy(dap as unknown as object);
    const transport = getTransport(proxy as unknown as object);
    if (!transport) {
      throw new FreeOcdError('Could not find transport object in proxy.', 'NO_TRANSPORT');
    }

    const paddedSize = Math.ceil(firmware.length / 4) * 4;
    const padded = new Uint8Array(paddedSize);
    padded.fill(0xff);
    padded.set(firmware);
    const words = new Uint32Array(padded.buffer);
    const totalWords = words.length;

    // Select MEM-AP (AP #0) bank 0
    await rawDapTransferWrite(transport, [
      {
        port: DAP_PORT_DEBUG,
        mode: DAP_TRANSFER_WRITE,
        register: DP_REG_SELECT,
        value: 0x00000000
      }
    ]);

    // Write CSW for 32-bit access with auto-increment
    await rawDapTransferWrite(transport, [
      {
        port: DAP_PORT_ACCESS,
        mode: DAP_TRANSFER_WRITE,
        register: AP_CSW,
        value: CSW_VALUE
      }
    ]);

    await this.initFlashController(dap, transport);

    log.info(`Writing ${totalWords} words...`);
    let wordsWritten = 0;
    let currentTarAddress = -1;

    while (wordsWritten < totalWords) {
      throwIfCancelled(token);
      const currentAddress = startAddress + wordsWritten * 4;
      const needTarUpdate = currentTarAddress === -1 || (currentAddress & 0x3ff) === 0;

      if (needTarUpdate) {
        await rawDapTransferWrite(transport, [
          {
            port: DAP_PORT_ACCESS,
            mode: DAP_TRANSFER_WRITE,
            register: AP_TAR,
            value: currentAddress
          }
        ]);
        currentTarAddress = currentAddress;
      }

      await rawDapTransferWrite(transport, [
        {
          port: DAP_PORT_ACCESS,
          mode: DAP_TRANSFER_WRITE,
          register: AP_DRW,
          value: words[wordsWritten]
        }
      ]);
      currentTarAddress += 4;
      wordsWritten++;

      if (wordsWritten % 256 === 0 || wordsWritten === totalWords) {
        const progress = (wordsWritten / totalWords) * 100;
        onProgress(progress, `Flashed ${wordsWritten * 4} / ${firmware.length} bytes`);
      }
    }

    log.info('Firmware write completed!');
  }

  public async verify(
    dapHandle: unknown,
    firmware: Uint8Array,
    startAddress: number,
    onProgress: ProgressCallback,
    token: Cancellable
  ): Promise<{ success: boolean; mismatches: number }> {
    const dap = asDap(dapHandle);
    log.info('Verifying firmware (reading back entire image)...');

    const verifySize = firmware.length;
    const verifyWords = Math.ceil(verifySize / 4);
    let mismatchCount = 0;

    for (let wordIdx = 0; wordIdx < verifyWords; wordIdx++) {
      throwIfCancelled(token);
      const addr = startAddress + wordIdx * 4;
      const actualWord = await dap.readMem32(addr);

      for (let byteOffset = 0; byteOffset < 4; byteOffset++) {
        const byteIdx = wordIdx * 4 + byteOffset;
        if (byteIdx >= verifySize) {
          break;
        }
        const actualByte = (actualWord >> (8 * byteOffset)) & 0xff;
        const expectedByte = firmware[byteIdx];
        if (actualByte !== expectedByte) {
          mismatchCount++;
          if (mismatchCount <= 5) {
            log.warn(
              `Verify mismatch at 0x${(startAddress + byteIdx).toString(16)}: ` +
                `expected 0x${expectedByte.toString(16).padStart(2, '0')}, ` +
                `got 0x${actualByte.toString(16).padStart(2, '0')}`
            );
          }
        }
      }

      if (wordIdx % 256 === 0 || wordIdx === verifyWords - 1) {
        onProgress(((wordIdx + 1) / verifyWords) * 100);
      }
      if (wordIdx % 256 === 0) {
        await sleep(0);
      }
    }

    if (mismatchCount > 0) {
      log.error(`Verification failed: ${mismatchCount} byte mismatches in ${verifySize} bytes`);
      return { success: false, mismatches: mismatchCount };
    }
    log.info(`Verification passed: all ${verifySize} bytes match`);
    return { success: true, mismatches: 0 };
  }

  public async reset(dapHandle: unknown): Promise<void> {
    const dap = asDap(dapHandle);
    log.info('Resetting device via CTRL-AP...');
    try {
      await writeAPReg(dap as unknown as object, this.ctrlApNum, CTRL_AP_RESET, 2);
      await sleep(10);
      await writeAPReg(dap as unknown as object, this.ctrlApNum, CTRL_AP_RESET, 0);
      await sleep(100);
      log.info('Device reset completed');
    } catch (err) {
      log.warn(`CTRL-AP reset error: ${(err as Error).message}`);
      log.info('Attempting fallback reset via DAP_RESET_TARGET...');
      try {
        await dap.reset();
        log.info('Fallback reset succeeded');
      } catch (fallbackErr) {
        log.error(`Fallback reset also failed: ${(fallbackErr as Error).message}`);
        throw fallbackErr;
      }
    }
  }

  private async attemptEraseAll(
    dap: DapInstance,
    onProgress: ProgressCallback,
    isRetry: boolean,
    token: Cancellable
  ): Promise<boolean> {
    const prefix = isRetry ? '[Retry] ' : '';
    const timeout = 300;

    log.info(`${prefix}Resetting ERASEALL task...`);
    await writeAPReg(dap as unknown as object, this.ctrlApNum, CTRL_AP_ERASEALL, 0);
    await sleep(10);

    log.info(`${prefix}Triggering mass erase (ERASEALL)...`);
    await writeAPReg(dap as unknown as object, this.ctrlApNum, CTRL_AP_ERASEALL, 1);

    log.info(`${prefix}Waiting for erase to start...`);
    let status: number | undefined;

    for (let i = 0; i < timeout; i++) {
      throwIfCancelled(token);
      status = await readAPReg(dap as unknown as object, this.ctrlApNum, CTRL_AP_ERASEALLSTATUS);
      if (status === undefined) {
        await sleep(100);
        onProgress((i / timeout) * 30);
        continue;
      }
      if (status === this.eraseAllStatus.busy) {
        log.info(`${prefix}Erase in progress (BUSY)...`);
        break;
      }
      if (status === this.eraseAllStatus.error) {
        log.error(`${prefix}Erase failed with ERROR status`);
        return false;
      }
      if (status === this.eraseAllStatus.readyToReset) {
        log.info(`${prefix}Device already erased (READYTORESET)`);
        return true;
      }
      await sleep(100);
      onProgress((i / timeout) * 30);
    }

    if (
      status === undefined ||
      (status !== this.eraseAllStatus.busy && status !== this.eraseAllStatus.readyToReset)
    ) {
      log.error(`${prefix}Timeout waiting for erase to start`);
      return false;
    }

    if (status === this.eraseAllStatus.busy) {
      log.info(`${prefix}Waiting for erase to complete...`);
      for (let i = 0; i < timeout; i++) {
        throwIfCancelled(token);
        status = await readAPReg(dap as unknown as object, this.ctrlApNum, CTRL_AP_ERASEALLSTATUS);
        if (status === undefined) {
          await sleep(100);
          onProgress(30 + (i / timeout) * 50);
          continue;
        }
        if (status === this.eraseAllStatus.readyToReset) {
          log.info(`${prefix}Erase completed successfully (READYTORESET)`);
          return true;
        }
        if (status === this.eraseAllStatus.error) {
          log.error(`${prefix}Erase failed with ERROR status`);
          return false;
        }
        await sleep(100);
        onProgress(30 + (i / timeout) * 50);
      }
      log.error(`${prefix}Timeout waiting for erase to complete`);
      return false;
    }

    return true;
  }

  private async verifyRecovery(dap: DapInstance): Promise<void> {
    log.info('Verifying device accessibility...');
    try {
      const verifyIdr = await readAPReg(dap as unknown as object, this.ctrlApNum, CTRL_AP_IDR_REG);
      if (verifyIdr !== undefined) {
        log.info(`Post-erase CTRL-AP IDR: 0x${verifyIdr.toString(16).toUpperCase()}`);
      }
      const protectStatus = await readAPReg(
        dap as unknown as object,
        this.ctrlApNum,
        CTRL_AP_ERASEPROTECTSTATUS
      );
      if (protectStatus !== undefined) {
        log.info(`ERASEPROTECTSTATUS: ${protectStatus}`);
        if (protectStatus >= 1) {
          log.info('Device is unlocked');
        } else {
          log.warn('Device may still be locked');
          await sleep(500);
          await dap.reconnect();
          await sleep(200);
          const retryStatus = await readAPReg(
            dap as unknown as object,
            this.ctrlApNum,
            CTRL_AP_ERASEPROTECTSTATUS
          );
          if (retryStatus !== undefined && retryStatus >= 1) {
            log.info('Device is now unlocked after retry');
          } else {
            log.warn('Device still appears locked after retry');
          }
        }
      }
    } catch (err) {
      log.warn(`Verification warning: ${(err as Error).message}`);
      log.warn('Device may need manual power cycle');
    }
  }

  private async initFlashController(
    dap: DapInstance,
    transport: import('../transport/transport-interface').DapjsTransport
  ): Promise<void> {
    const type = this.target.flashController.type;
    const base = parseInt(this.target.flashController.base, 16);
    if (type === 'rramc') {
      await this.initRRAMC(dap, transport, base);
    } else if (type === 'nvmc') {
      await this.initNVMC(dap, transport, base);
    } else {
      log.warn(`Unknown flash controller type: ${type}`);
    }
  }

  private async initRRAMC(
    dap: DapInstance,
    transport: import('../transport/transport-interface').DapjsTransport,
    base: number
  ): Promise<void> {
    const regs = this.target.flashController.registers;
    const configOffset = parseInt(regs.config.offset, 16);
    const configValue = parseInt(regs.config.enableValue ?? '0x101', 16);
    const readyOffset = parseInt(regs.ready.offset, 16);
    const configAddr = base + configOffset;
    const readyAddr = base + readyOffset;

    log.info('Configuring RRAMC for flash programming...');
    try {
      const currentConfig = await dap.readMem32(configAddr);
      log.info(`Current RRAMC CONFIG: 0x${currentConfig.toString(16)}`);

      await rawDapTransferWrite(transport, [
        {
          port: DAP_PORT_ACCESS,
          mode: DAP_TRANSFER_WRITE,
          register: AP_TAR,
          value: configAddr
        }
      ]);
      await rawDapTransferWrite(transport, [
        {
          port: DAP_PORT_ACCESS,
          mode: DAP_TRANSFER_WRITE,
          register: AP_DRW,
          value: configValue
        }
      ]);

      const newConfig = await dap.readMem32(configAddr);
      log.info(`New RRAMC CONFIG: 0x${newConfig.toString(16)}`);

      if ((newConfig & 0x1) !== 1) {
        log.warn('RRAMC WEN bit not set');
      } else {
        log.info('RRAMC write mode enabled');
      }

      let ready = await dap.readMem32(readyAddr);
      let retries = 0;
      while ((ready & 0x1) === 0 && retries < 100) {
        await sleep(10);
        ready = await dap.readMem32(readyAddr);
        retries++;
      }
      if ((ready & 0x1) === 0) {
        log.warn('RRAMC not ready after timeout');
      } else {
        log.info('RRAMC is ready for programming');
      }
    } catch (err) {
      log.warn(`RRAMC configuration error: ${(err as Error).message}`);
      log.info('Attempting flash write anyway...');
    }
  }

  private async initNVMC(
    dap: DapInstance,
    transport: import('../transport/transport-interface').DapjsTransport,
    base: number
  ): Promise<void> {
    const NVMC_CONFIG = base + 0x504;
    const NVMC_READY = base + 0x400;
    const NVMC_CONFIG_WEN = 1;

    log.info('Configuring NVMC for flash programming...');
    try {
      await rawDapTransferWrite(transport, [
        {
          port: DAP_PORT_ACCESS,
          mode: DAP_TRANSFER_WRITE,
          register: AP_TAR,
          value: NVMC_CONFIG
        }
      ]);
      await rawDapTransferWrite(transport, [
        {
          port: DAP_PORT_ACCESS,
          mode: DAP_TRANSFER_WRITE,
          register: AP_DRW,
          value: NVMC_CONFIG_WEN
        }
      ]);
      let ready = await dap.readMem32(NVMC_READY);
      let retries = 0;
      while ((ready & 0x1) === 0 && retries < 100) {
        await sleep(10);
        ready = await dap.readMem32(NVMC_READY);
        retries++;
      }
      if ((ready & 0x1) === 1) {
        log.info('NVMC write mode enabled');
      } else {
        log.warn('NVMC not ready after timeout');
      }
    } catch (err) {
      log.warn(`NVMC configuration error: ${(err as Error).message}`);
    }
  }
}

function throwIfCancelled(token: Cancellable): void {
  if (token.isCancelled()) {
    throw new CancelledError();
  }
}
