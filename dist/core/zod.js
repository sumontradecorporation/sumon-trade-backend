import { z } from 'zod';
import { Types } from 'mongoose';
export const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'Invalid id');
export const optionalId = z.union([objectId, z.literal(''), z.null()]).optional().transform((v) => (v ? v : undefined));
export const money = z.coerce.number().finite().min(0).default(0);
export const optStr = z.string().trim().max(5000).optional().nullable().transform((v) => v ?? undefined);
export const optDate = z
    .union([z.coerce.date(), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v : undefined));
export const email = z.union([z.string().trim().toLowerCase().email(), z.literal(''), z.null()]).optional().transform((v) => v || undefined);
export const phone = z.string().trim().max(20).optional().nullable().transform((v) => v || undefined);
//# sourceMappingURL=zod.js.map