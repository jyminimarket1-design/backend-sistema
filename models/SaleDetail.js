import mongoose from 'mongoose';
import { Product } from './Product.js';

const saleDetailSchema = new mongoose.Schema({
    sale_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Sale',
        required: true
    },
    product_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true
    },
    quantity: {
        type: Number,
        required: true,
        min: 0.01
    },
    unit_price: {
        type: Number,
        required: true,
        min: 0
    }
}, { timestamps: true });

// Middleware pre-save: Defensa en profundidad — valida stock dentro de la transacción.
// IMPORTANTE: usa this.$session() para leer el estado del producto dentro del mismo
// snapshot de la transacción, evitando lecturas stale en escenarios de alta concurrencia.
saleDetailSchema.pre('save', async function () {
    try {
        const session = this.$session();
        const query = Product.findById(this.product_id);
        // Adjuntar la sesión solo si existe (la clave es que sea la misma transacción)
        if (session) query.session(session);

        const product = await query;
        if (!product) {
            throw new Error('Producto no encontrado.');
        }

        // Validación de segunda línea: el servicio ya lo verificó antes de decrementar,
        // pero si por algún motivo el stock quedó negativo, lo bloqueamos aquí.
        if (product.stock < 0) {
            throw new Error(`Inventario insuficiente. El stock de "${product.name}" quedó en negativo.`);
        }
    } catch (error) {
        // Re-throw para que Mongoose aborte el save y la transacción
        throw error;
    }
});

saleDetailSchema.index({ sale_id: 1 });

export const SaleDetail = mongoose.model('SaleDetail', saleDetailSchema);
