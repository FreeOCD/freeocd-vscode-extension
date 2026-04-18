/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026, FreeOCD. All Rights Reserved.
 */

/**
 * Zod schema for `TargetDefinition`. Used by:
 *   - `validate_target_definition` MCP tool (runtime check for AI-generated
 *     target JSON).
 *   - CI `npm run lint:targets` script (statically validates every bundled
 *     target JSON).
 *
 * Keep the schema permissive enough to accept future platforms (STM32,
 * RP2040, ESP32, NXP, ...) by using a string union for `flashController.type`
 * and an open `quirks` map.
 */

import { z } from 'zod';

const hexString = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/u, 'Expected a hex string like "0x12345678".');

const usbFilter = z
  .object({
    vendorId: z.union([z.string(), z.number()]),
    productId: z.union([z.string(), z.number()]).optional()
  })
  .strict();

const flashControllerRegister = z
  .object({
    offset: hexString,
    enableValue: hexString.optional()
  })
  .passthrough();

const flashController = z
  .object({
    type: z.string(),
    base: hexString,
    registers: z.record(z.string(), flashControllerRegister)
  })
  .passthrough();

const memoryRegion = z
  .object({
    address: hexString,
    size: hexString.optional(),
    workAreaSize: hexString.optional(),
    pageSize: hexString.optional()
  })
  .passthrough();

export const targetDefinitionSchema = z
  .object({
    id: z.string().min(3),
    name: z.string().min(1),
    platform: z.string().min(1),
    cpu: z.string().min(1),
    cputapid: hexString,
    ctrlAp: z
      .object({
        num: z.number().int().min(0).max(255),
        idr: hexString
      })
      .optional(),
    accessPort: z
      .object({
        type: z.enum(['mem-ap', 'ctrl-ap', 'apb-ap']),
        num: z.number().int().min(0).max(255),
        idr: hexString
      })
      .optional(),
    eraseAllStatus: z
      .object({
        ready: z.number().int(),
        readyToReset: z.number().int(),
        busy: z.number().int(),
        error: z.number().int()
      })
      .optional(),
    flashController,
    flash: memoryRegion,
    sram: memoryRegion,
    usbFilters: z.array(usbFilter).optional(),
    capabilities: z.array(z.string()).min(1),
    description: z.string().optional(),
    quirks: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough();

/** Compact JSON-Schema representation exposed via MCP Resources. */
export function targetDefinitionJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'FreeOCD Target Definition',
    type: 'object',
    required: [
      'id',
      'name',
      'platform',
      'cpu',
      'cputapid',
      'flashController',
      'flash',
      'sram',
      'capabilities'
    ],
    properties: {
      id: { type: 'string', pattern: '^[a-z0-9_]+(/[a-z0-9_]+)+$' },
      name: { type: 'string' },
      platform: {
        type: 'string',
        examples: [
          'nordic',
          'stm32',
          'rp2040',
          'esp32',
          'nxp',
          'silicon_labs',
          'renesas'
        ]
      },
      cpu: {
        type: 'string',
        examples: [
          'cortex-m0',
          'cortex-m0plus',
          'cortex-m3',
          'cortex-m4',
          'cortex-m7',
          'cortex-m33',
          'cortex-m55',
          'cortex-m85'
        ]
      },
      cputapid: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
      ctrlAp: {
        type: 'object',
        properties: {
          num: { type: 'integer', minimum: 0, maximum: 255 },
          idr: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' }
        }
      },
      accessPort: {
        type: 'object',
        properties: {
          type: { enum: ['mem-ap', 'ctrl-ap', 'apb-ap'] },
          num: { type: 'integer', minimum: 0, maximum: 255 },
          idr: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' }
        }
      },
      flashController: {
        type: 'object',
        required: ['type', 'base', 'registers'],
        properties: {
          type: {
            type: 'string',
            examples: ['rramc', 'nvmc', 'fmc', 'fpec', 'qspi']
          },
          base: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
          registers: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              required: ['offset'],
              properties: {
                offset: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
                enableValue: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' }
              }
            }
          }
        }
      },
      flash: {
        type: 'object',
        required: ['address'],
        properties: {
          address: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
          size: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
          pageSize: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' }
        }
      },
      sram: {
        type: 'object',
        required: ['address'],
        properties: {
          address: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
          workAreaSize: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' }
        }
      },
      usbFilters: {
        type: 'array',
        items: {
          type: 'object',
          required: ['vendorId'],
          properties: {
            vendorId: { type: ['string', 'integer'] },
            productId: { type: ['string', 'integer'] }
          }
        }
      },
      capabilities: {
        type: 'array',
        items: {
          type: 'string',
          examples: ['flash', 'verify', 'recover', 'rtt', 'erase_page', 'mass_erase']
        }
      },
      description: { type: 'string' },
      quirks: { type: 'object' }
    }
  };
}
