/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * MCP Resources (VSCode 1.101+).
 *
 * Resources are retrievable, content-addressable documents that the host
 * exposes to the LLM (either directly as chat context or as tool response
 * attachments). We bundle a small set of immutable resources:
 *
 *   - `schema://target-definition` — The Zod/JSON schema for target JSON.
 *   - `reference://targets/nrf54l15` — A complete reference target.
 *   - `docs://mcu-workflow` — The "Adding a new MCU" playbook (markdown).
 *   - `docs://dap-glossary` — Embedded terminology glossary.
 *   - `docs://arm-cortex-m-registers` — Standard Cortex-M register reference.
 *   - `logs://session-log` — Dynamic view of recent MCP activity.
 */

import { targetDefinitionJsonSchema } from '../../target/target-schema';
import { DAP_GLOSSARY } from './dap-glossary';
import { ARM_CORTEX_M_REGISTERS } from './arm-cortex-m-registers';
import { MCU_WORKFLOW } from './mcu-workflow';
import { NRF54L15_REFERENCE } from './nrf54l15-reference';

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  /** Resolve the resource content (called on each read). */
  read(): Promise<string>;
}

export function buildStaticResources(): ResourceDefinition[] {
  return [
    {
      uri: 'schema://target-definition',
      name: 'Target Definition JSON Schema',
      description: 'JSON Schema for FreeOCD target definitions (used by validate_target_definition).',
      mimeType: 'application/schema+json',
      read: async () => JSON.stringify(targetDefinitionJsonSchema(), null, 2)
    },
    {
      uri: 'reference://targets/nrf54l15',
      name: 'nRF54L15 Reference Target',
      description: 'Complete, validated target definition for the Nordic nRF54L15.',
      mimeType: 'application/json',
      read: async () => NRF54L15_REFERENCE
    },
    {
      uri: 'docs://mcu-workflow',
      name: 'Adding a New MCU Workflow',
      description: 'Step-by-step playbook for contributing a new MCU to FreeOCD.',
      mimeType: 'text/markdown',
      read: async () => MCU_WORKFLOW
    },
    {
      uri: 'docs://dap-glossary',
      name: 'DAP / CMSIS-DAP / RTT Glossary',
      description: 'Concise glossary of terms used by FreeOCD and the ARM debug subsystem.',
      mimeType: 'text/markdown',
      read: async () => DAP_GLOSSARY
    },
    {
      uri: 'docs://arm-cortex-m-registers',
      name: 'ARM Cortex-M Register Reference',
      description: 'Standard Cortex-M core register set (R0-R15, xPSR, CONTROL, etc.).',
      mimeType: 'text/markdown',
      read: async () => ARM_CORTEX_M_REGISTERS
    }
  ];
}

export { targetDefinitionJsonSchema };
