import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server'; // ← MIGRADO: ReplSet para transacciones ACID
import app from '../server.js';
import { User } from '../models/User.js';
import { Category } from '../models/Category.js';
import { Product } from '../models/Product.js';
import { Sale } from '../models/Sale.js';
import { SaleDetail } from '../models/SaleDetail.js';
import bcryptjs from 'bcryptjs';

vi.mock('../mailtrap/emails.js', () => ({
  sendPasswordResetEmail: vi.fn(),
  sendResetSuccessEmail: vi.fn(),
}));

// Mock Redis COMPLETO: cubre tanto lib/redis.js como cache.middleware.js
vi.mock('../lib/redis.js', () => ({
  redis: {
    get: vi.fn(async () => null),   // MISS de caché → pasa al controlador
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
  },
  getOrSetCache:    vi.fn(async (_key, fn) => ({ data: await fn(), fromCache: false })),
  invalidateCache:  vi.fn(async () => {}),
  bumpCacheVersion: vi.fn(async () => {}),
  getCacheVersion:  vi.fn(async () => 0),
  buildPaginatedKey: vi.fn((_p, _v, _pg, _l, uid) => `mock:${uid}`),
}));

let mongoReplSet;

beforeAll(async () => {
  mongoReplSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const mongoUri = mongoReplSet.getUri();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(mongoUri);
  await new Promise((r) => setTimeout(r, 1500));
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoReplSet) await mongoReplSet.stop();
});

afterEach(async () => {
  await Sale.deleteMany({});
  await SaleDetail.deleteMany({});
  await mongoose.connection.collection('products').drop().catch(() => {});
  vi.clearAllMocks();
});

describe('Sale Controllers — Extended Tests (Cache + Edge Cases)', () => {
  let authCookie;
  let userId;
  let categoryId;
  let productId;

  beforeAll(async () => {
    const hashedPassword = await bcryptjs.hash('password123', 10);
    const user = await User.create({
      email: `salesext_${Date.now()}@example.com`,
      password: hashedPassword,
      name: 'Sales Extended Admin',
      role: 'admin',
    });
    userId = user._id.toString();

    const loginRes = await request(app).post('/api/auth/login').send({
      email: user.email,
      password: 'password123',
    });
    authCookie = loginRes.headers['set-cookie'];

    const category = new Category({ name: 'Sales Test Category', user: userId });
    await category.save();
    categoryId = category._id.toString();
  });

  beforeEach(async () => {
    // Producto limpio con stock = 20 antes de cada test
    const product = new Product({
      name: 'Agua Mineral 1L',
      price: 15,
      stock: 20,
      unit_type: 'unidad',
      category: categoryId,
      user: userId,
    });
    await product.save();
    productId = product._id.toString();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Respuesta incluye fromCache
  // ─────────────────────────────────────────────────────────────────────
  describe('GET /api/sales — campo fromCache', () => {
    it('GET /api/sales debe incluir el campo fromCache en la respuesta', async () => {
      const response = await request(app)
        .get('/api/sales')
        .set('Cookie', authCookie);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('fromCache');
    });

    it('GET /api/sales/:id debe incluir el campo fromCache en la respuesta', async () => {
      // Crear venta primero
      const createRes = await request(app)
        .post('/api/sales')
        .set('Cookie', authCookie)
        .send({
          customer_id: userId,
          payment_method: 'Efectivo',
          items: [{ product_id: productId, quantity: 1, unit_price: 15 }],
        });
      const saleId = createRes.body.sale._id;

      const response = await request(app)
        .get(`/api/sales/${saleId}`)
        .set('Cookie', authCookie);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('fromCache');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Una venta debe disminuir el stock del producto
  // ─────────────────────────────────────────────────────────────────────
  describe('POST /api/sales — el stock del producto se descuenta correctamente', () => {
    it('el stock debe reducirse exactamente en la cantidad vendida', async () => {
      await request(app)
        .post('/api/sales')
        .set('Cookie', authCookie)
        .send({
          customer_id: userId,
          payment_method: 'Efectivo',
          items: [{ product_id: productId, quantity: 7, unit_price: 15 }],
        });

      const updatedProduct = await Product.findById(productId);
      expect(updatedProduct.stock).toBe(13); // 20 - 7 = 13
    });

    it('dos ventas consecutivas deben descontar stock acumulativamente', async () => {
      // Primera venta: -5
      await request(app)
        .post('/api/sales')
        .set('Cookie', authCookie)
        .send({
          customer_id: userId,
          payment_method: 'Efectivo',
          items: [{ product_id: productId, quantity: 5, unit_price: 15 }],
        });

      // Segunda venta: -3 más
      await request(app)
        .post('/api/sales')
        .set('Cookie', authCookie)
        .send({
          customer_id: userId,
          payment_method: 'Efectivo',
          items: [{ product_id: productId, quantity: 3, unit_price: 15 }],
        });

      const updatedProduct = await Product.findById(productId);
      expect(updatedProduct.stock).toBe(12); // 20 - 5 - 3 = 12
    });

    it('stock se queda intacto si la venta falla por stock insuficiente', async () => {
      await request(app)
        .post('/api/sales')
        .set('Cookie', authCookie)
        .send({
          customer_id: userId,
          payment_method: 'Efectivo',
          items: [{ product_id: productId, quantity: 999, unit_price: 15 }], // excede stock
        });

      const updatedProduct = await Product.findById(productId);
      expect(updatedProduct.stock).toBe(20); // sin cambio
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Aislamiento por usuario
  // ─────────────────────────────────────────────────────────────────────
  describe('GET /api/sales — aislamiento por usuario', () => {
    it('un usuario NO debe ver las ventas de otro usuario', async () => {
      // Crear segunda cuenta
      const hashedPwd = await bcryptjs.hash('pass123', 10);
      const otherUser = await User.create({
        email: `other_sales_${Date.now()}@example.com`,
        password: hashedPwd,
        name: 'Other Seller',
        role: 'admin',
      });
      const otherLoginRes = await request(app).post('/api/auth/login').send({
        email: otherUser.email,
        password: 'pass123',
      });
      const otherCookie = otherLoginRes.headers['set-cookie'];

      // El usuario original crea una venta
      await request(app)
        .post('/api/sales')
        .set('Cookie', authCookie)
        .send({
          customer_id: userId,
          payment_method: 'Efectivo',
          items: [{ product_id: productId, quantity: 1, unit_price: 15 }],
        });

      // El otro usuario consulta → debe ver 0 ventas
      const response = await request(app)
        .get('/api/sales')
        .set('Cookie', otherCookie);

      expect(response.status).toBe(200);
      expect(response.body.sales).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // GET /api/sales/:id — integridad de la respuesta
  // ─────────────────────────────────────────────────────────────────────
  describe('GET /api/sales/:id — estructura de la respuesta', () => {
    it('debe retornar sale con items, product_id populated y precio correcto', async () => {
      const createRes = await request(app)
        .post('/api/sales')
        .set('Cookie', authCookie)
        .send({
          customer_id: userId,
          payment_method: 'Tarjeta',
          items: [{ product_id: productId, quantity: 4, unit_price: 15 }],
        });
      const saleId = createRes.body.sale._id;

      const response = await request(app)
        .get(`/api/sales/${saleId}`)
        .set('Cookie', authCookie);

      expect(response.status).toBe(200);
      expect(response.body.sale.total_amount).toBe(60); // 4 * 15 = 60
      expect(response.body.sale.status).toBe('completed');
      expect(response.body.sale.payment_method).toBe('Tarjeta');

      // items con product_id populated (nombre y precio)
      const items = response.body.sale.items;
      expect(items).toHaveLength(1);
      expect(items[0].product_id.name).toBe('Agua Mineral 1L');
      expect(items[0].product_id.price).toBe(15);
      expect(items[0].quantity).toBe(4);
    });

    it('debe retornar 401 si no está autenticado', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const response = await request(app).get(`/api/sales/${fakeId}`);
      expect(response.status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Venta con múltiples items
  // ─────────────────────────────────────────────────────────────────────
  describe('POST /api/sales — venta con múltiples productos', () => {
    it('debe crear venta con varios productos y descontar stock de cada uno', async () => {
      // Crear segundo producto
      const product2 = new Product({
        name: 'Galletas María',
        price: 8,
        stock: 10,
        unit_type: 'unidad',
        category: categoryId,
        user: userId,
      });
      await product2.save();
      const product2Id = product2._id.toString();

      const response = await request(app)
        .post('/api/sales')
        .set('Cookie', authCookie)
        .send({
          customer_id: userId,
          payment_method: 'Efectivo',
          items: [
            { product_id: productId,  quantity: 3, unit_price: 15 }, // Agua: 45
            { product_id: product2Id, quantity: 2, unit_price: 8  }, // Galletas: 16
          ],
        });

      expect(response.status).toBe(201);
      expect(response.body.sale.total_amount).toBe(61); // 45 + 16

      const agua    = await Product.findById(productId);
      const galleta = await Product.findById(product2Id);
      expect(agua.stock).toBe(17);   // 20 - 3
      expect(galleta.stock).toBe(8); // 10 - 2
    });
  });
});
