/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

import { z } from 'zod';
import type { ToolDefinition } from './tool-registry';

export const listTargetsSchema = z.object({}).strict();
export const getTargetInfoSchema = z.object({ id: z.string().min(1) }).strict();
export const selectTargetSchema = z.object({ id: z.string().min(1) }).strict();
export const createTargetDefinitionSchema = z
  .object({
    target: z.record(z.string(), z.unknown())
  })
  .strict();
export const updateTargetDefinitionSchema = z
  .object({
    id: z.string().min(1),
    patch: z.record(z.string(), z.unknown())
  })
  .strict();
export const deleteTargetDefinitionSchema = z.object({ id: z.string().min(1) }).strict();
export const validateTargetDefinitionSchema = z
  .object({
    target: z.record(z.string(), z.unknown())
  })
  .strict();
export const testTargetDefinitionSchema = z
  .object({
    id: z.string().min(1)
  })
  .strict();

export const targetTools: ToolDefinition[] = [
  {
    name: 'list_targets',
    description: 'List all built-in and user-defined targets.',
    toolSet: 'freeocd-target',
    schema: listTargetsSchema
  },
  {
    name: 'get_target_info',
    description: 'Return the full target definition JSON for the given id.',
    toolSet: 'freeocd-target',
    schema: getTargetInfoSchema
  },
  {
    name: 'select_target',
    description: 'Set the current target MCU. Subsequent flash/verify/rtt calls use this target.',
    toolSet: 'freeocd-target',
    schema: selectTargetSchema
  },
  {
    name: 'create_target_definition',
    description:
      'Create and persist a new target definition. Validates against the FreeOCD target schema before saving to workspaceStorage.',
    toolSet: 'freeocd-target',
    schema: createTargetDefinitionSchema
  },
  {
    name: 'update_target_definition',
    description: 'Shallow-merge a patch into an existing user-defined target.',
    toolSet: 'freeocd-target',
    schema: updateTargetDefinitionSchema
  },
  {
    name: 'delete_target_definition',
    description: 'Delete a user-defined target.',
    toolSet: 'freeocd-target',
    schema: deleteTargetDefinitionSchema
  },
  {
    name: 'validate_target_definition',
    description:
      'Run the FreeOCD target schema validator without saving. Returns ok:true or an issues array.',
    toolSet: 'freeocd-target',
    schema: validateTargetDefinitionSchema
  },
  {
    name: 'test_target_definition',
    description:
      'Dry-run the given target against the connected probe (reads IDR / CTRL-AP). Does not flash.',
    toolSet: 'freeocd-target',
    schema: testTargetDefinitionSchema,
    requiresConnection: true
  }
];
