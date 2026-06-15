import { z } from 'zod';

export const IO_TYPES = ['string', 'number', 'boolean', 'enum', 'file', 'file_list'] as const;
export type IoType = (typeof IO_TYPES)[number];

export const ioFieldSchema = z.object({
  key: z.string().min(1),
  type: z.enum(IO_TYPES),
  label: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  options: z.array(z.string()).optional(),
  maxLength: z.number().int().positive().optional(),
  widget: z.string().optional(),
  render: z.string().optional(),
});
export type IoField = z.infer<typeof ioFieldSchema>;

export const ioSchemaSchema = z.object({
  inputs: z.array(ioFieldSchema),
  outputs: z.array(ioFieldSchema),
});
export type IoSchema = z.infer<typeof ioSchemaSchema>;
