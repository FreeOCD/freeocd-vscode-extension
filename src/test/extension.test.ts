import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension activation', () => {
  test('Extension is present', () => {
    const ext = vscode.extensions.getExtension('FreeOCD.freeocd-extension');
    assert.ok(ext, 'Extension should be registered');
  });

  test('Extension activates without error', async () => {
    const ext = vscode.extensions.getExtension('FreeOCD.freeocd-extension');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    assert.ok(ext?.isActive, 'Extension should be active after activate()');
  });
});
