/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * `LanguageStatusItem` + `StatusBarItem` combo that surfaces the current
 * probe + target state. Both items carry `accessibilityInformation` so
 * screen readers announce state transitions correctly.
 */

import * as vscode from 'vscode';
import type { ConnectionInfo } from '../common/types';

export class StatusManager implements vscode.Disposable {
  private readonly probeStatus: vscode.LanguageStatusItem;
  private readonly targetStatus: vscode.LanguageStatusItem;
  private readonly bar: vscode.StatusBarItem;

  constructor() {
    this.probeStatus = vscode.languages.createLanguageStatusItem('freeocd.probe', '*');
    this.probeStatus.name = vscode.l10n.t('FreeOCD Probe');
    this.probeStatus.text = vscode.l10n.t('Probe') + ': ' + vscode.l10n.t('Not connected');
    this.probeStatus.accessibilityInformation = {
      label: vscode.l10n.t('FreeOCD probe not connected')
    };

    this.targetStatus = vscode.languages.createLanguageStatusItem('freeocd.target', '*');
    this.targetStatus.name = vscode.l10n.t('FreeOCD Target');
    this.targetStatus.text = vscode.l10n.t('Target') + ': ' + vscode.l10n.t('Not selected');
    this.targetStatus.accessibilityInformation = {
      label: vscode.l10n.t('FreeOCD target not selected')
    };

    this.bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.bar.text = '$(circuit-board) FreeOCD';
    this.bar.command = 'freeocd.showLog';
    this.bar.accessibilityInformation = {
      label: vscode.l10n.t('FreeOCD status'),
      role: 'button'
    };
    this.bar.show();
  }

  public dispose(): void {
    this.probeStatus.dispose();
    this.targetStatus.dispose();
    this.bar.dispose();
  }

  public setConnection(info: ConnectionInfo): void {
    switch (info.state) {
      case 'connected': {
        const label =
          info.probe?.product ??
          `VID:0x${info.probe?.vendorId.toString(16) ?? '?'} PID:0x${info.probe?.productId.toString(16) ?? '?'}`;
        this.probeStatus.text = vscode.l10n.t('Probe') + ': ' + label;
        this.probeStatus.accessibilityInformation = {
          label: vscode.l10n.t('FreeOCD probe connected: {0}', label)
        };
        this.probeStatus.severity = vscode.LanguageStatusSeverity.Information;
        this.bar.text = `$(plug) FreeOCD: ${label}`;
        break;
      }
      case 'connecting':
        this.probeStatus.text = '$(sync~spin) ' + vscode.l10n.t('Connecting to probe...');
        this.probeStatus.severity = vscode.LanguageStatusSeverity.Information;
        this.bar.text = '$(sync~spin) FreeOCD: ' + vscode.l10n.t('Connecting to probe...');
        break;
      case 'error':
        this.probeStatus.text =
          '$(error) ' + vscode.l10n.t('Probe') + ': ' + vscode.l10n.t('error');
        this.probeStatus.severity = vscode.LanguageStatusSeverity.Error;
        this.probeStatus.accessibilityInformation = {
          label: info.error ?? vscode.l10n.t('Probe error')
        };
        this.bar.text = '$(error) FreeOCD';
        break;
      case 'disconnected':
      default:
        this.probeStatus.text = vscode.l10n.t('Probe') + ': ' + vscode.l10n.t('Not connected');
        this.probeStatus.severity = vscode.LanguageStatusSeverity.Information;
        this.probeStatus.accessibilityInformation = {
          label: vscode.l10n.t('FreeOCD probe not connected')
        };
        this.bar.text = '$(circuit-board) FreeOCD';
        break;
    }
  }

  public setTarget(name: string | undefined): void {
    if (!name) {
      this.targetStatus.text = vscode.l10n.t('Target') + ': ' + vscode.l10n.t('Not selected');
      this.targetStatus.severity = vscode.LanguageStatusSeverity.Warning;
      this.targetStatus.accessibilityInformation = {
        label: vscode.l10n.t('FreeOCD target not selected')
      };
      return;
    }
    this.targetStatus.text = vscode.l10n.t('Target') + ': ' + name;
    this.targetStatus.severity = vscode.LanguageStatusSeverity.Information;
    this.targetStatus.accessibilityInformation = {
      label: vscode.l10n.t('FreeOCD target: {0}', name)
    };
  }
}
