import { z } from 'zod';
import mongoose from 'mongoose';

const objectIdValidator = z.string().refine((val) => mongoose.Types.ObjectId.isValid(val), {
  message: "ID no válido",
});

export const createAdjustmentSchema = z.object({
  body: z.object({
    product_id: objectIdValidator,
    new_stock: z
      .number({
        required_error: "El stock nuevo es obligatorio",
        invalid_type_error: "El stock debe ser un número",
      })
      .min(0, "El stock no puede ser negativo"),
    reason: z.enum(['initial_count', 'damaged', 'stolen', 'expired', 'correction', 'other'], {
      errorMap: () => ({ message: "Motivo no válido. Opciones: initial_count, damaged, stolen, expired, correction, other" })
    }),
    notes: z.string().optional()
  })
});
