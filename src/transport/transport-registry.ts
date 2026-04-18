/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Simple registry keyed by `TransportMethod` ("hid"). Keeps the extension
 * transport-agnostic and future-proofs us for USB / WebUSB backends.
 */

import type { TransportBackend } from './transport-interface';
import type { TransportMethod } from '../common/types';

const backends = new Map<TransportMethod, TransportBackend>();

export function registerTransport(backend: TransportBackend): void {
  backends.set(backend.method, backend);
}

export function getTransport(method: TransportMethod): TransportBackend | undefined {
  return backends.get(method);
}

export function listTransports(): TransportBackend[] {
  return Array.from(backends.values());
}
