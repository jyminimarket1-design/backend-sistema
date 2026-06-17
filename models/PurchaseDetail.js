import mongoose from 'mongoose';
import { Product } from './Product.js';
import { User } from './User.js';
import { Purchase } from './Purchase.js';

const purchaseDetailSchema = new mongoose.Schema({
  purchase_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Purchase',
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
  unit_cost: {
    type: Number,
    required: true,
    min: 0
  }
}, { timestamps: true });

// Middleware pre-save: Integridad de Compra y Control de Stock
purchaseDetailSchema.pre('save', async function () {
  try {
    const session = this.$session();

    // 1. Incrementar el stock del producto (dentro de la transacción)
    const product = await Product.findByIdAndUpdate(
      this.product_id,
      { $inc: { stock: this.quantity } },
      { returnDocument: 'after', session }
    );

    if (!product) {
      throw new Error('Producto referenciado no encontrado.');
    }

    // 2. Obtener la compra para localizar al Admin
    const purchase = await Purchase.findById(this.purchase_id).session(session);
    if (!purchase) {
      throw new Error('Compra asociada no encontrada.');
    }

    // 3. Recálculo del av_inventory_cost SOLO para el admin actual.
    //    BUG FIX: el pipeline anterior no filtraba por admin_id → sumaba costos
    //    de TODOS los tenants del sistema, corrompiendo el costo promedio.
    const adminId = purchase.admin_id;
    const resultAggr = await mongoose.model('PurchaseDetail').aggregate([
      {
        // Unir con Purchase para filtrar por admin_id del propietario
        $lookup: {
          from: 'purchases',
          localField: 'purchase_id',
          foreignField: '_id',
          as: 'purchase'
        }
      },
      { $unwind: '$purchase' },
      {
        $match: { 'purchase.admin_id': adminId }
      },
      {
        $group: {
          _id: null,
          totalCost:  { $sum: { $multiply: ['$quantity', '$unit_cost'] } },
          totalItems: { $sum: '$quantity' }
        }
      }
    ]).session(session);

    let newAvgCost = 0;
    if (resultAggr.length > 0 && resultAggr[0].totalItems > 0) {
      // Incluir el item actual (aún no guardado) en el cálculo
      const currentCost = resultAggr[0].totalCost + (this.quantity * this.unit_cost);
      const currentQty  = resultAggr[0].totalItems + this.quantity;
      newAvgCost = currentCost / currentQty;
    } else {
      // Primer detalle del admin → su costo unitario es el promedio inicial
      newAvgCost = this.unit_cost;
    }

    // 4. Actualizar el costo promedio de inventario del admin
    await User.findByIdAndUpdate(
      adminId,
      { av_inventory_cost: newAvgCost },
      { session }
    );
  } catch (error) {
    throw error;
  }
});

purchaseDetailSchema.index({ purchase_id: 1 });

export const PurchaseDetail = mongoose.model('PurchaseDetail', purchaseDetailSchema);
