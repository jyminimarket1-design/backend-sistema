import { z } from 'zod';

const saleItemSchema = z.object({
  product_id: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Product ID format"),
  quantity: z.number().min(0.01, "Quantity must be at least 0.01"),
  unit_price: z.number().min(0, "Unit price must be a positive number")
});

export const createSaleSchema = z.object({
  body: z.object({
    // customer_id es resuelto por injectBusinessContext (req.userId), NO viene del body
    items: z.array(saleItemSchema).min(1, "At least one product item is required"),
    payment_method: z.enum(
      ['Efectivo', 'Divisas', 'Tarjeta', 'BioPago', 'Pago Movil', 'Transferencia', 'Zelle'],
      { errorMap: () => ({ message: "Método de pago no válido. Opciones: Efectivo, Divisas, Tarjeta, Pago Movil, Transferencia, Zelle" }) }
    ),
    exchange_rate: z.number().min(0.01).optional()
  })
});

export const saleIdSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Sale ID format")
  })
});

export const updateSaleSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Sale ID format")
  }),
  body: z.object({
    total_amount: z.number().min(0, "Total amount must be a positive number").optional(),
    payment_method: z.enum(
      ['Efectivo', 'Divisas', 'Tarjeta', 'BioPago', 'Pago Movil', 'Transferencia', 'Zelle'],
      { errorMap: () => ({ message: "Método de pago no válido." }) }
    ).optional(),
    items: z.array(saleItemSchema).min(1, "At least one product item is required").optional()
  })
});
