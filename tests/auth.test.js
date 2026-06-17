import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../server.js';
import { User } from '../models/User.js';
import bcryptjs from 'bcryptjs';

// Mocking external email delivery API
vi.mock('../mailtrap/emails.js', () => ({
  sendPasswordResetEmail: vi.fn(),
  sendResetSuccessEmail: vi.fn(),
}));

let mongoServer;

beforeAll(async () => {
  // Asegurar que exista una clave secreta para los tests
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_key';
  
  mongoServer = await MongoMemoryServer.create({
    instance: {
      launchTimeout: 60000, // 60s para que mongod arranque
    },
  });
  const mongoUri = mongoServer.getUri();
  
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(mongoUri);
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    const collection = collections[key];
    await collection.deleteMany({});
  }
  vi.clearAllMocks();
});

describe('Auth Controllers Integration', () => {

  describe('POST /api/auth/create-user', () => {
    let adminCookie;

    beforeEach(async () => {
      // 1. Inyectar un admin directo a la BD para las pruebas
      const hashedPassword = await bcryptjs.hash('admin123', 10);
      await User.create({
        email: 'admin@test.com',
        password: hashedPassword,
        name: 'Admin User',
        role: 'admin'
      });
      
      // 2. Loguearse como admin para obtener la cookie protegida
      const loginRes = await request(app).post('/api/auth/login').send({
        email: 'admin@test.com',
        password: 'admin123'
      });
      adminCookie = loginRes.headers['set-cookie'];
    });

    it('should allow admin to create a new customer successfully', async () => {
      const response = await request(app)
        .post('/api/auth/create-user')
        .set('Cookie', adminCookie)
        .send({
          email: 'test@example.com',
          password: 'password123',
          name: 'Test Customer'
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.user).toBeDefined();
      expect(response.body.user.email).toBe('test@example.com');
      
      // verify DB directly
      const userInDb = await User.findOne({ email: 'test@example.com' });
      expect(userInDb).toBeTruthy();
      expect(userInDb.subscriptionExpiresAt).toBeDefined();
    });

    it('should reject unauthenticated request without admin token', async () => {
      const response = await request(app)
        .post('/api/auth/create-user')
        // No le mandamos la Cookie de Admin
        .send({
          email: 'hacker@example.com',
          password: 'password123',
          name: 'Hacker'
        });

      expect(response.status).toBe(401); // Unauthorized
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      const hashedPassword = await bcryptjs.hash('password123', 10);
      await User.create({
        email: 'login@example.com',
        password: hashedPassword,
        name: 'Login User'
      });
    });

    it('should login with correct credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'login@example.com',
          password: 'password123'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.headers['set-cookie']).toBeDefined();
    });

    it('should reject invalid credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'login@example.com',
          password: 'wrongpassword'
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Invalid credentials');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should clear the token cookie', async () => {
      const response = await request(app).post('/api/auth/logout');
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.headers['set-cookie']).toBeDefined();
    });
  });

  describe('GET /api/auth/check-auth', () => {
    let userCookie;
    
    beforeEach(async () => {
      const hashedPassword = await bcryptjs.hash('password123', 10);
      await User.create({
        email: 'check@example.com',
        password: hashedPassword,
        name: 'Check User'
      });
      const loginRes = await request(app).post('/api/auth/login').send({
        email: 'check@example.com',
        password: 'password123'
      });
      userCookie = loginRes.headers['set-cookie'];
    });

    it('should return user info when authenticated', async () => {
      const response = await request(app)
        .get('/api/auth/check-auth')
        .set('Cookie', userCookie);
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user.email).toBe('check@example.com');
    });

    it('should return 401 if unauthenticated (no token)', async () => {
      const response = await request(app).get('/api/auth/check-auth');
      expect(response.status).toBe(401);
      expect(response.body.message).toBe('Unauthorized - no token provided');
    });
  });
});
