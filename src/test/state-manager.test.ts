/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

import * as assert from 'assert';
import { StateManager, type HealthCheckable } from '../common/state-manager';

/**
 * Minimal fake Cortex-M processor that either resolves or rejects
 * `getState()`, plus counts how many times it was called so the tests can
 * assert polling behaviour.
 */
class FakeProcessor implements HealthCheckable {
  public calls = 0;
  private shouldThrow = false;

  public setHealth(healthy: boolean): void {
    this.shouldThrow = !healthy;
  }

  public async getState(): Promise<unknown> {
    this.calls++;
    if (this.shouldThrow) {
      throw new Error('probe disappeared');
    }
    return { halted: false };
  }
}

/** Wait at least `ms` ms using a real timer. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `predicate` every 5 ms until it returns true or `timeoutMs` elapses.
 * Used for timing-sensitive poll-loop assertions so they are robust against
 * timer drift on slow CI runners (macOS Node 20 has been observed to delay
 * the first sub-50 ms `setTimeout` well past the nominal interval, which
 * would cause fixed-wait assertions to flake).
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await wait(5);
  }
}

suite('StateManager', () => {
  test('getState reports the initial (disconnected) snapshot', () => {
    const sm = new StateManager();
    assert.deepStrictEqual(sm.getState(), {
      isDeviceConnected: false,
      isRttConnected: false
    });
    sm.dispose();
  });

  test('attachProcessor flips the RTT connected flag', () => {
    const sm = new StateManager();
    const events: string[] = [];
    sm.on('rttConnected', () => events.push('connected'));
    sm.on('rttDisconnected', () => events.push('disconnected'));

    sm.attachProcessor(new FakeProcessor());
    sm.attachProcessor(null);

    assert.deepStrictEqual(events, ['connected', 'disconnected']);
    sm.dispose();
  });

  test('polling calls getState at the configured interval', async () => {
    const sm = new StateManager();
    const proc = new FakeProcessor();
    sm.setPollIntervalMs(20);
    sm.attachProcessor(proc);
    sm.startPolling();
    // Wait for at least 2 ticks to land. We avoid a fixed sleep because
    // timer drift on CI (notably macOS Node 20) can delay the first tick
    // well past the nominal interval; a generous timeout keeps the test
    // deterministic without making it quantitative about the exact rate.
    await waitFor(() => proc.calls >= 2, 2000);
    sm.stopPolling();
    assert.ok(proc.calls >= 2, `expected >=2 calls, got ${proc.calls}`);
    sm.dispose();
  });

  test('polling stops after stopPolling', async () => {
    const sm = new StateManager();
    const proc = new FakeProcessor();
    sm.setPollIntervalMs(20);
    sm.attachProcessor(proc);
    sm.startPolling();
    await wait(50);
    sm.stopPolling();
    const afterStop = proc.calls;
    await wait(80);
    assert.strictEqual(proc.calls, afterStop, 'no new ticks after stop');
    sm.dispose();
  });

  test('setExternalOperationInProgress pauses the loop', async () => {
    const sm = new StateManager();
    const proc = new FakeProcessor();
    sm.setPollIntervalMs(20);
    sm.attachProcessor(proc);
    sm.setExternalOperationInProgress(true);
    sm.startPolling();
    await wait(80);
    // The poll loop wakes up but the external-operation flag keeps it
    // from issuing any DAP transfers.
    assert.strictEqual(proc.calls, 0);
    sm.setExternalOperationInProgress(false);
    // Event-driven wait so the assertion does not flake on slow CI.
    await waitFor(() => proc.calls >= 1, 2000);
    assert.ok(proc.calls >= 1, `expected resume, got ${proc.calls} calls`);
    sm.stopPolling();
    sm.dispose();
  });

  test('fires onConnectionLost when a healthy probe goes silent', async () => {
    const sm = new StateManager();
    const proc = new FakeProcessor();
    sm.setPollIntervalMs(15);
    let lost: Error | undefined;
    sm.setCallbacks({
      onConnectionLost: (err) => {
        lost = err;
      }
    });
    sm.attachProcessor(proc);
    sm.startPolling();
    // Device was marked connected after the first successful getState().
    await waitFor(() => sm.getState().isDeviceConnected, 2000);
    assert.strictEqual(sm.getState().isDeviceConnected, true);
    proc.setHealth(false);
    await waitFor(() => lost !== undefined, 2000);
    sm.stopPolling();

    assert.ok(lost, 'expected onConnectionLost to fire');
    assert.match(
      lost!.message,
      /Device connection lost: probe disappeared/u,
      'error message should name the underlying failure'
    );
    assert.strictEqual(sm.getState().isDeviceConnected, false);
    sm.dispose();
  });

  test('stopPolling clears any pending timer (no stray ticks)', async () => {
    const sm = new StateManager();
    const proc = new FakeProcessor();
    sm.setPollIntervalMs(10);
    sm.attachProcessor(proc);
    sm.startPolling();
    sm.stopPolling();
    const before = proc.calls;
    await wait(40);
    assert.strictEqual(proc.calls, before, 'no ticks fired after stop');
    sm.dispose();
  });

  test('dispose is idempotent and stops polling', async () => {
    const sm = new StateManager();
    const proc = new FakeProcessor();
    sm.setPollIntervalMs(10);
    sm.attachProcessor(proc);
    sm.startPolling();
    sm.dispose();
    sm.dispose();
    const before = proc.calls;
    await wait(30);
    assert.strictEqual(proc.calls, before);
  });
});
