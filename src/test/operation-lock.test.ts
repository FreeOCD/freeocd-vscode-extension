/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

import * as assert from 'assert';
import {
  OperationLock,
  OperationBusyError,
  type OperationType
} from '../common/operation-lock';

suite('OperationLock', () => {
  test('starts unlocked', () => {
    const lock = new OperationLock();
    assert.strictEqual(lock.isLocked(), false);
    assert.strictEqual(lock.getCurrent(), null);
    assert.strictEqual(lock.getOwner(), null);
  });

  test('tryAcquire succeeds when idle', () => {
    const lock = new OperationLock();
    assert.strictEqual(lock.tryAcquire('FLASH', 'test'), true);
    assert.strictEqual(lock.getCurrent(), 'FLASH');
    assert.strictEqual(lock.getOwner(), 'test');
    assert.strictEqual(lock.isLocked(), true);
  });

  test('tryAcquire is idempotent for the same op type', () => {
    const lock = new OperationLock();
    assert.strictEqual(lock.tryAcquire('FLASH', 'first'), true);
    assert.strictEqual(lock.tryAcquire('FLASH', 'second'), true);
    // Owner is preserved from the first successful acquire so the lock
    // tells us who originally took it, not who last asked for it.
    assert.strictEqual(lock.getOwner(), 'first');
  });

  test('tryAcquire rejects a conflicting op type', () => {
    const lock = new OperationLock();
    assert.strictEqual(lock.tryAcquire('FLASH', 'flash'), true);
    assert.strictEqual(lock.tryAcquire('RTT', 'rtt'), false);
    assert.strictEqual(lock.getCurrent(), 'FLASH');
  });

  test('release clears the holder', () => {
    const lock = new OperationLock();
    lock.tryAcquire('RECOVER', 'test');
    assert.strictEqual(lock.release('RECOVER'), true);
    assert.strictEqual(lock.isLocked(), false);
    assert.strictEqual(lock.getCurrent(), null);
    assert.strictEqual(lock.getOwner(), null);
  });

  test('release from a non-holder is a no-op', () => {
    const lock = new OperationLock();
    lock.tryAcquire('FLASH', 'test');
    // A stale `finally` block tries to release a lock that a prior
    // failed `tryAcquire` never actually obtained. This must not break
    // the lock.
    assert.strictEqual(lock.release('RTT'), false);
    assert.strictEqual(lock.getCurrent(), 'FLASH');
  });

  test('acquireOrThrow throws OperationBusyError on conflict', () => {
    const lock = new OperationLock();
    lock.acquireOrThrow('FLASH', 'flash');
    assert.throws(() => lock.acquireOrThrow('VERIFY', 'verify'), (err: unknown) => {
      assert.ok(err instanceof OperationBusyError);
      assert.strictEqual(err.requested, 'VERIFY');
      assert.strictEqual(err.held, 'FLASH');
      assert.strictEqual(err.heldOwner, 'flash');
      assert.strictEqual(err.code, 'OPERATION_BUSY');
      return true;
    });
  });

  test('emits `changed` on acquire and release', () => {
    const lock = new OperationLock();
    const events: (OperationType | null)[] = [];
    lock.on('changed', (op) => events.push(op));

    lock.tryAcquire('FLASH', 'test');
    // Idempotent re-acquire by the same op must NOT emit again — the
    // lock state did not actually change.
    lock.tryAcquire('FLASH', 'test-again');
    lock.release('FLASH');

    assert.deepStrictEqual(events, ['FLASH', null]);
  });

  test('isConflicting distinguishes self from others', () => {
    const lock = new OperationLock();
    lock.tryAcquire('FLASH', 'flash');
    assert.strictEqual(lock.isConflicting('FLASH'), false);
    assert.strictEqual(lock.isConflicting('RTT'), true);
  });

  test('dispose clears state and removes listeners', () => {
    const lock = new OperationLock();
    let fired = 0;
    lock.on('changed', () => fired++);
    lock.tryAcquire('FLASH', 'test');
    lock.dispose();
    // Listener was removed, so further state changes don't reach us.
    lock.tryAcquire('RTT', 'test');
    assert.strictEqual(fired, 1);
    assert.strictEqual(lock.getCurrent(), 'RTT');
  });
});
