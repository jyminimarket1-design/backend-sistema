import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../server.js';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { User } from '../models/User.js';
import { Product } from '../models/Product.js';
import { Category } from '../models/Category.js';
import { InventoryAdjustment } from '../models/InventoryAdjustment.js';
import { Sale } from '../models/Sale.js';
import bcryptjs from 'bcryptjs';

describe('Flujo Cruzado: Multi-Inquilino y Auditoría (Fase 3)', () => {
  let employeeCookie;
  let employeeId;
  let productId;
  let categoryId;
  let ownerId;

  let mongoReplSet;

  beforeAll(async () => {
    mongoReplSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const mongoUri = mongoReplSet.getUri();
    
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(mongoUri);
    await new Promise((r) => setTimeout(r, 1500));

    const hashedPassword = await bcryptjs.hash('password123', 10);

    // 1. Crear dueño
    const owner = await User.create({
      name: 'Owner',
      email: `owner_${Date.now()}@test.com`,
      password: hashedPassword,
      role: 'customer'
    });
    ownerId = owner._id.toString();

    // 2. Crear empleado
    const employeeEmail = `employee_${Date.now()}@test.com`;
    const employee = await User.create({
      name: 'Employee',
      email: employeeEmail,
      password: hashedPassword,
      role: 'employee',
      owner_id: ownerId,
      permissions: ['create_sale', 'edit_products']
    });
    employeeId = employee._id.toString();

    // Iniciar sesión con empleado para obtener cookie
    const loginRes = await request(app).post('/api/auth/login').send({
      email: employeeEmail,
      password: 'password123'
    });
    employeeCookie = loginRes.headers['set-cookie'];

    // 3. Crear categoría y producto por el dueño
    const category = await Category.create({ name: 'Test Cat', user: ownerId });
    categoryId = category._id.toString();

    const product = await Product.create({
      name: 'Test Product',
      price: 100,
      stock: 10,
      category: categoryId,
      user: ownerId
    });
    productId = product._id.toString();
  });

  afterAll(async () => {
    await User.deleteMany({ _id: { $in: [ownerId, employeeId] } });
    await Category.deleteMany({ _id: categoryId });
    await Product.deleteMany({ _id: productId });
    await InventoryAdjustment.deleteMany({ user_id: ownerId });
    await Sale.deleteMany({ customer_id: ownerId });

    await mongoose.disconnect();
    if (mongoReplSet) {
      await mongoReplSet.stop();
    }
  });

  it('Empleado crea ajuste → created_by === empleadoId, user_id === dueñoId', async () => {
    const res = await request(app)
      .post('/api/adjustments')
      .set('Cookie', employeeCookie)
      .send({
        product_id: productId,
        new_stock: 15,
        reason: 'correction'
      });

    expect(res.status).toBe(201);
    
    // Verificar en BD
    const adj = await InventoryAdjustment.findById(res.body.adjustment._id).lean();
    expect(adj).not.toBeNull();
    expect(adj.user_id.toString()).toBe(ownerId);
    expect(adj.created_by.toString()).toBe(employeeId);
    expect(adj.new_stock).toBe(15);
  });

  it('Empleado registra venta → sold_by === empleadoId, customer_id === dueñoId', async () => {
    const res = await request(app)
      .post('/api/sales')
      .set('Cookie', employeeCookie)
      .send({
        payment_method: 'Efectivo',
        items: [{ product_id: productId, quantity: 2, unit_price: 100 }]
      });

    expect(res.status).toBe(201);
    
    // Verificar en BD
    const sale = await Sale.findById(res.body.sale._id).lean();
    expect(sale).not.toBeNull();
    expect(sale.customer_id.toString()).toBe(ownerId);
    expect(sale.sold_by.toString()).toBe(employeeId);
    expect(sale.total_amount).toBe(200);
  });
});
