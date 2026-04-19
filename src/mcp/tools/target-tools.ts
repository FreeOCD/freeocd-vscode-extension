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
    schema: listTargetsSchema,
    annotations: {
      title: 'List Targets',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'get_target_info',
    description: 'Return the full target definition JSON for the given id.',
    toolSet: 'freeocd-target',
    schema: getTargetInfoSchema,
    annotations: {
      title: 'Get Target Info',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'select_target',
    description: 'Set the current target MCU. Subsequent flash/verify/rtt calls use this target.',
    toolSet: 'freeocd-target',
    schema: selectTargetSchema,
    annotations: {
      title: 'Select Target MCU',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'create_target_definition',
    description:
      'Create and persist a new target definition. Validates against the FreeOCD target schema before saving to workspaceStorage.',
    toolSet: 'freeocd-target',
    schema: createTargetDefinitionSchema,
    annotations: {
      title: 'Create Target Definition',
      readOnlyHint: false,
      destructiveHint: false,
      // Creating the same target twice overwrites with the same content,
      // so the end state is identical — idempotent.
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'update_target_definition',
    description: 'Shallow-merge a patch into an existing user-defined target.',
    toolSet: 'freeocd-target',
    schema: updateTargetDefinitionSchema,
    annotations: {
      title: 'Update Target Definition',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'delete_target_definition',
    description: 'Delete a user-defined target.',
    toolSet: 'freeocd-target',
    schema: deleteTargetDefinitionSchema,
    annotations: {
      title: 'Delete Target Definition',
      readOnlyHint: false,
      // Deletes are destructive w.r.t. user data — clients should
      // confirm before invoking.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'validate_target_definition',
    description:
      'Run the FreeOCD target schema validator without saving. Returns ok:true or an issues array.',
    toolSet: 'freeocd-target',
    schema: validateTargetDefinitionSchema,
    annotations: {
      title: 'Validate Target Definition',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'test_target_definition',
    description:
      'Dry-run the given target against the connected probe (reads IDR / CTRL-AP). Does not flash.',
    toolSet: 'freeocd-target',
    schema: testTargetDefinitionSchema,
    requiresConnection: true,
    annotations: {
      title: 'Test Target Definition (Dry Run)',
      readOnlyHint: true,
      idempotentHint: true,
      // Does read from physical hardware (IDR / CTRL-AP registers), so
      // open-world even though it does not write.
      openWorldHint: true
    }
  }
];
