import { z } from 'zod';

export const MODIFIER_OPS = ['override_rate', 'percent_off', 'flat_off', 'percent_add'] as const;
export type ModifierOp = (typeof MODIFIER_OPS)[number];

export const modifierSchema = z.object({
  id: z.string(),
  scope: z.string(),
  whenExpr: z.string().optional(),
  op: z.enum(MODIFIER_OPS),
  value: z.number().int().optional(),
  stackable: z.boolean(),
  priority: z.number().int(),
  version: z.number().int(),
});
export type Modifier = z.infer<typeof modifierSchema>;
