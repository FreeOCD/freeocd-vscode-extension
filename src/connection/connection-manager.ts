/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Central manager for probe lifecycle: list / connect / disconnect.
 *
 * Wraps a `TransportBackend` (currently only `HidBackend`) and exposes the
 * connected DAPjs `Transport` + high-level `ADI` / `DAP` handles that the
 * flasher, RTT handler, and MCP layer consume.
 *
 * The manager emits a `ConnectionInfo` on every state change so UI and MCP
 * status views can update reactively.
 */

import { EventEmitter } from 'events';
import type { DapjsTransport, TransportBackend } from '../transport/transport-interface';
import type { ConnectionInfo, ProbeInfo } from '../common/types';
import { NotConnectedError, FreeOcdError } from '../common/errors';
import { log } from '../common/logger';
import { loadDapjs } from '../common/dapjs-loader';

export interface Dap {
  /** DAPjs `CmsisDAP` / proxy instance. */
  proxy: unknown;
  /** DAPjs `ADI` instance (provides readMem32 / writeMem32 / etc.). */
  adi: unknown;
}

/**
 * Events emitted by `ConnectionManager`:
 *   - `stateChanged` → `(info: ConnectionInfo) => void`
 */
export class ConnectionManager extends EventEmitter {
  private backend: TransportBackend | undefined;
  private transport: DapjsTransport | undefined;
  private current: ConnectionInfo;
  private dap: Dap | undefined;

  constructor(backend?: TransportBackend) {
    super();
    this.backend = backend;
    this.current = { state: 'disconnected', method: 'hid' };
  }

  public setBackend(backend: TransportBackend): void {
    this.backend = backend;
  }

  public getInfo(): ConnectionInfo {
    return this.current;
  }

  public isConnected(): boolean {
    return this.current.state === 'connected';
  }

  public getTransport(): DapjsTransport {
    if (!this.transport) {
      throw new NotConnectedError();
    }
    return this.transport;
  }

  public getDap(): Dap {
    if (!this.dap) {
      throw new NotConnectedError();
    }
    return this.dap;
  }

  public async listProbes(): Promise<ProbeInfo[]> {
    if (!this.backend) {
      throw new FreeOcdError('No transport backend registered.', 'NO_BACKEND');
    }
    return this.backend.list();
  }

  public async connect(probe: ProbeInfo): Promise<void> {
    if (!this.backend) {
      throw new FreeOcdError('No transport backend registered.', 'NO_BACKEND');
    }

    if (this.current.state === 'connected') {
      await this.disconnect();
    }

    this.updateState({ state: 'connecting', method: this.backend.method, probe });
    log.info(`Connecting to probe ${describe(probe)}...`);

    try {
      const transport = await this.backend.open(probe);
      await transport.open();
      this.transport = transport;

      // Lazy-require DAPjs so the MCP bundle doesn't pull it in. DAPjs is
      // distributed as UMD; we access it through the `out/dap.umd.js` file
      // that `webpack` copies from `vendor/dapjs/dist/`.
      const dapjs = loadDapjs();
      const proxy = new dapjs.CmsisDAP(transport, 0) as { connect: () => Promise<void> };
      const adi = new dapjs.ADI(transport);
      await proxy.connect();

      this.dap = { proxy, adi };
      this.updateState({ state: 'connected', method: this.backend.method, probe });
      log.info(`Connected to probe ${describe(probe)}.`);
    } catch (err) {
      this.updateState({
        state: 'error',
        method: this.backend.method,
        probe,
        error: (err as Error).message
      });
      log.error(err as Error);
      throw err;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      if (this.dap) {
        const proxy = this.dap.proxy as { disconnect?: () => Promise<void> };
        if (typeof proxy.disconnect === 'function') {
          try {
            await proxy.disconnect();
          } catch (err) {
            log.warn(`Proxy disconnect warning: ${(err as Error).message}`);
          }
        }
      }
      if (this.transport) {
        await this.transport.close();
      }
    } finally {
      this.transport = undefined;
      this.dap = undefined;
      this.updateState({
        state: 'disconnected',
        method: this.backend?.method ?? 'hid',
        probe: this.current.probe
      });
    }
  }

  private updateState(next: ConnectionInfo): void {
    this.current = next;
    this.emit('stateChanged', next);
  }
}

function describe(p: ProbeInfo): string {
  const label = p.product ?? `VID:0x${p.vendorId.toString(16)} PID:0x${p.productId.toString(16)}`;
  return p.serialNumber ? `${label} (${p.serialNumber})` : label;
}

