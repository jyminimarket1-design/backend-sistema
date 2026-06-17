import mongoose from 'mongoose';

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  description: {
    type: String
  },
  barcode: {
    type: String,
    trim: true
    // Sin default → el campo no existe en el doc cuando no se envía.
    // Esto es clave para que sparse:true funcione: MongoDB sólo indexa
    // documentos donde el campo existe, por eso null causaría conflicto.
  },
  price: {
    type: Number,
    required: true
  },
  stock: {
    type: Number,
    default: 0
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    required: true
  },
  unit_type: {
    type: String,
    enum: ['unidad', 'kg', 'litro', 'metro'],
    default: 'unidad'
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, { timestamps: true });

// Índice único compuesto: un usuario no puede tener dos productos con el mismo barcode.
// sparse:true → MongoDB sólo indexa docs donde `barcode` existe (no es undefined).
// IMPORTANTE: el campo barcode no debe tener default:null o todos los productos
// sin barcode colisionarían entre sí en el índice.
productSchema.index({ barcode: 1, user: 1 }, { unique: true, sparse: true });
productSchema.index({ user: 1, createdAt: -1 });


export const Product = mongoose.model('Product', productSchema);
