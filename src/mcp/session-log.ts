/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * In-memory circular log of recent command invocations (UI, MCP, tasks,
 * watchers). Used by `get_session_log` / `get_command_history` /
 * `get_last_error` MCP tools so an AI can triangulate failures without
 * replaying everything from scratch.
 */

import type { SessionLogEntry } from '../common/types';

export class SessionLog {
  private entries: SessionLogEntry[] = [];

  constructor(private capacity: number = 200) {}

  public setCapacity(capacity: number): void {
    this.capacity = Math.max(10, capacity);
    this.trim();
  }

  public record(entry: SessionLogEntry): void {
    this.entries.push(entry);
    this.trim();
  }

  public list(limit?: number): SessionLogEntry[] {
    if (!limit || limit >= this.entries.length) {
      return [...this.entries];
    }
    return this.entries.slice(-limit);
  }

  public lastError(): SessionLogEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (!this.entries[i].success) {
        return this.entries[i];
      }
    }
    return undefined;
  }

  public clear(): void {
    this.entries = [];
  }

  private trim(): void {
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }
}
