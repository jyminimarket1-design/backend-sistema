import { z } from 'zod';

export const createProductSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Name is required"),
    description: z.string().optional(),
    barcode: z.string().min(1, "Barcode cannot be empty").optional(),
    price: z.number().min(0, "Price must be a positive number"),
    stock: z.number().min(0, "Stock must be a non-negative number").optional(),
    // stock_inicial: valor de inventario de apertura al crear el producto.
    // Zod lo stripea si no está declarado aquí, por eso el controlador lo recibía como undefined.
    stock_inicial: z.number().min(0, "El stock inicial debe ser >= 0").optional(),
    unit_type: z.enum(['unidad', 'kg', 'litro', 'metro']).optional(),
    category: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Category ID format")
  })
});


export const updateProductSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Product ID format")
  }),
  body: z.object({
    name: z.string().min(1, "Name is required").optional(),
    description: z.string().optional(),
    barcode: z.string().min(1, "Barcode cannot be empty").nullable().optional(),
    price: z.number().min(0, "Price must be a positive number").optional(),
    stock: z.number().min(0, "Stock must be a non-negative number").optional(),
    unit_type: z.enum(['unidad', 'kg', 'litro', 'metro']).optional(),
    category: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Category ID format").optional(),
    // ─── Corrección de stock desde ProductManager ────────────────────────────
    // new_stock: valor absoluto final que el usuario quiere que quede en inventario.
    // stock_reason: motivo del ajuste (enum del modelo InventoryAdjustment).
    // Si se envía new_stock, stock_reason es obligatorio también.
    new_stock: z.number().min(0, "new_stock debe ser >= 0").optional(),
    stock_reason: z.enum(
      ['initial_count', 'damaged', 'stolen', 'expired', 'correction', 'other'],
      { errorMap: () => ({ message: "stock_reason debe ser un motivo válido" }) }
    ).optional()
  }).refine(
    // Regla: si se envía uno de los dos, se deben enviar ambos.
    (body) => {
      const hasStock  = body.new_stock  !== undefined;
      const hasReason = body.stock_reason !== undefined;
      return hasStock === hasReason; // ambos presentes o ambos ausentes
    },
    { message: "Si envías new_stock, debes enviar stock_reason también (y viceversa)" }
  )
});

export const productIdSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Product ID format")
  })
});

export const barcodeParamSchema = z.object({
  params: z.object({
    code: z.string().min(1, "Barcode is required")
  })
});
