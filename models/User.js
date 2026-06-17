import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['admin', 'customer', 'employee'],
    required: true,
    default: 'customer'
  },
  owner_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  permissions: {
    type: [String],
    default: []
  },
  av_inventory_cost: {
    type: Number,
    default: 0
  },
  lastLogin: {
    type: Date,
    default: Date.now,
  },
  resetPasswordToken: String,
  resetPasswordExpiresAt: Date,
  subscriptionExpiresAt: {
    type: Date
  }
}, { timestamps: true });

export const User = mongoose.model('User', userSchema);
