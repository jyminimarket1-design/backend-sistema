import { z } from 'zod';

export const rateSchema = z.object({
  body: z.object({
    rate: z.number().min(0.01, "La tasa debe ser mayor a 0"),
    date: z.string().optional() // Si no se envía, se asume hoy
  })
});
