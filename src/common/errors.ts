/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Domain-specific error classes used throughout the extension.
 *
 * Keeping these typed allows the UI layer to decide whether to display a
 * notification, a status-bar message, or a diagnostic; and allows the MCP
 * bridge to serialize consistent error codes back to AI tools.
 */

export class FreeOcdError extends Error {
  constructor(message: string, public readonly code: string = 'FREEOCD_ERROR') {
    super(message);
    this.name = 'FreeOcdError';
  }
}

export class NotConnectedError extends FreeOcdError {
  constructor(message: string = 'No probe connected.') {
    super(message, 'NOT_CONNECTED');
    this.name = 'NotConnectedError';
  }
}

export class NoTargetError extends FreeOcdError {
  constructor(message: string = 'No target MCU selected.') {
    super(message, 'NO_TARGET');
    this.name = 'NoTargetError';
  }
}

export class TargetValidationError extends FreeOcdError {
  constructor(message: string, public readonly details?: unknown) {
    super(message, 'TARGET_VALIDATION');
    this.name = 'TargetValidationError';
  }
}

export class HexParseError extends FreeOcdError {
  constructor(message: string) {
    super(message, 'HEX_PARSE');
    this.name = 'HexParseError';
  }
}

export class DapTransferError extends FreeOcdError {
  constructor(message: string, public readonly ack?: number) {
    super(message, 'DAP_TRANSFER');
    this.name = 'DapTransferError';
  }
}

export class CancelledError extends FreeOcdError {
  constructor(message: string = 'Operation cancelled.') {
    super(message, 'CANCELLED');
    this.name = 'CancelledError';
  }
}
