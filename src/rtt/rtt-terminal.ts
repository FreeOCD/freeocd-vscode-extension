/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * `vscode.Pseudoterminal` wrapper around `RttHandler`.
 *
 * Provides bidirectional RTT I/O inside an integrated terminal:
 *   - Incoming target bytes are decoded as UTF-8 and LF→CRLF-translated.
 *   - User keystrokes are echoed locally and queued as down-buffer writes.
 *   - Polling runs on the interval configured by `freeocd.rtt.pollingInterval`.
 */

import * as vscode from 'vscode';
import type { RttHandler } from './rtt-handler';
import { log } from '../common/logger';

const TERMINAL_NAME = 'FreeOCD RTT';

export class RttTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  public readonly onDidWrite = this.writeEmitter.event;
  public readonly onDidClose = this.closeEmitter.event;

  private terminal: vscode.Terminal | undefined;
  private pollHandle: ReturnType<typeof setInterval> | undefined;
  private inputBuffer: number[] = [];
  private closed = false;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(
    private readonly rtt: RttHandler,
    private readonly pollingIntervalMs: number = 100
  ) {}

  public show(): vscode.Terminal {
    if (!this.terminal) {
      this.terminal = vscode.window.createTerminal({
        name: TERMINAL_NAME,
        pty: this
      });
    }
    this.terminal.show(true);
    return this.terminal;
  }

  public dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this.terminal?.dispose();
    this.terminal = undefined;
  }

  // ==========================================================================
  // vscode.Pseudoterminal
  // ==========================================================================

  public open(): void {
    this.writeEmitter.fire('\x1b[2m[FreeOCD RTT connected]\x1b[0m\r\n');
    this.pollHandle = setInterval(() => {
      void this.pollOnce();
    }, this.pollingIntervalMs);
  }

  public close(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
    this.closeEmitter.fire();
  }

  public handleInput(data: string): void {
    // Local echo so the user sees what they typed.
    this.writeEmitter.fire(data.replace(/\r/gu, '\r\n'));
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      // Convert CR to LF for the target.
      this.inputBuffer.push(code === 13 ? 10 : code);
    }
  }

  // ==========================================================================
  // Internal polling
  // ==========================================================================

  private async pollOnce(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      const bytes = await this.rtt.read(0);
      if (bytes.length > 0) {
        const text = this.decoder.decode(bytes, { stream: true }).replace(/\n/gu, '\r\n');
        this.writeEmitter.fire(text);
      }
      if (this.inputBuffer.length > 0) {
        const pending = Uint8Array.from(this.inputBuffer);
        this.inputBuffer = [];
        const written = await this.rtt.write(pending, 0);
        if (written === -1) {
          // Buffer full; put the bytes back at the head.
          this.inputBuffer.unshift(...Array.from(pending));
        }
      }
    } catch (err) {
      log.warn(`RTT poll error: ${(err as Error).message}`);
    }
  }
}
