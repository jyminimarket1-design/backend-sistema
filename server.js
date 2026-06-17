// ⚠️ DEBE ser el primer import: carga .env antes que cualquier otro módulo
import "dotenv/config";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import hpp from "hpp";
import cookieParser from "cookie-parser";
import path from "path";
import mongoose from "mongoose";

// Configuraciones y Libs
import { connectDB } from "./lib/db.js";
import { sanitizeNoSQL } from "./middleware/sanitize.js";
import { globalLimiter, authLimiter } from "./middleware/rateLimiter.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { verifyToken } from "./middleware/verifyToken.js";
import { checkSubscription } from "./middleware/checkSubscription.js";
import { injectBusinessContext } from "./middleware/requirePermission.js";
import { slaTimeout } from "./middleware/sla.middleware.js";

// Rutas
import authRoutes from "./routes/auth.route.js";
import categoryRoutes from "./routes/category.route.js";
import productRoutes from "./routes/product.route.js";
import purchaseRoutes from "./routes/purchase.route.js";
import saleRoutes from "./routes/sale.route.js";
import adjustmentRoutes from "./routes/adjustment.route.js";
import aiRoutes from "./routes/ai.route.js";
import staffRoutes from "./routes/staff.route.js";
import rateRoutes from "./routes/rate.route.js";

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.resolve();

// Confiar en el proxy de Vercel para rate limiting correcto
app.set('trust proxy', 1);

// 0. HEALTH CHECK (Antes del Rate Limiter y de la inicialización de BD)
// Un health check no debe bloquearse por IP ni esperar a la base de datos para responder.
app.get("/api/health", (req, res) => res.status(200).json({ status: "ok", uptime: process.uptime() }));

// Ruta raíz para evitar errores 403/404 al visitar la URL del backend directamente
app.get("/", (req, res) => {
  res.status(200).send("🚀 CastillaWeb Backend API está funcionando correctamente.");
});

// Bloqueo rápido de favicons para ahorrar costos de Serverless Functions en Vercel
app.get(["/favicon.ico", "/favicon.png", "/apple-touch-icon.png"], (req, res) => res.status(204).end());

// 1. CORS Y PARSING
const whitelist = [
  'https://jyminimarket1.vercel.app',
  'http://localhost:5173'
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests without origin (e.g., server-to-server, Postman)
    if (!origin) return callback(null, true);
    // Allow explicitly whitelisted origins
    if (whitelist.includes(origin)) return callback(null, true);
    // Allow any subdomain of vercel.app (covers other Vercel deployments)
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    // Reject otherwise
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// 1.5 SLA TIMEOUT (Fail Fast: corta cualquier request que exceda 1.5s)
app.use(slaTimeout);

// 3. SEGURIDAD (Filtros de entrada)
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(hpp());
app.use(sanitizeNoSQL);
app.use(globalLimiter);

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser());

// 3. LAZY DB CONNECTION (para Vercel serverless: conectar antes de cada request si no está conectado)
app.use(async (req, res, next) => {
  if (mongoose.connection.readyState === 0) {
    try {
      await connectDB();
    } catch (err) {
      return res.status(503).json({ success: false, message: "Service temporarily unavailable" });
    }
  }
  next();
});

// 4. RUTAS PÚBLICAS Y MONITOREO

// Auth: Rate limit específico para evitar fuerza bruta
app.use("/api/auth", authLimiter, authRoutes);

// 4. RUTAS PROTEGIDAS (Middleware de flujo)
// Aplicamos el middleware a nivel de prefijo para no repetirlo en cada línea
const protectedRouter = express.Router();
protectedRouter.use(verifyToken, injectBusinessContext, checkSubscription);

app.use("/api/categories", protectedRouter, categoryRoutes);
app.use("/api/products", protectedRouter, productRoutes);
app.use("/api/purchases", protectedRouter, purchaseRoutes);
app.use("/api/sales", protectedRouter, saleRoutes);
app.use("/api/adjustments", protectedRouter, adjustmentRoutes);
app.use("/api/ai", protectedRouter, aiRoutes);
app.use("/api/staff", protectedRouter, staffRoutes);
app.use("/api/rates", protectedRouter, rateRoutes);

// 5. FRONTEND (Producción local únicamente — en Vercel el frontend es una app separada)
if (process.env.NODE_ENV === "production" && !process.env.VERCEL) {
  app.use(express.static(path.join(__dirname, "/frontend/dist")));
  app.get(/(.*)/, (req, res) => {
    res.sendFile(path.resolve(__dirname, "frontend", "dist", "index.html"));
  });
}

// 6. MANEJO DE ERRORES (Debe ser el último)
app.use(errorHandler);
// 7. ARRANQUE CONTROLADO (Optimizado para Vercel)
const startApp = async () => {
  try {
    // En Vercel, es mejor que la conexión se gestione dentro de los handlers
    // pero para mantener tu estructura, solo llamamos a listen si NO es Vercel
    if (process.env.NODE_ENV !== "test" && !process.env.VERCEL) {
      await connectDB();
      app.listen(PORT, () => {
        console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
      });
    }
  } catch (error) {
    if (process.env.NODE_ENV !== "test") {
      console.error("❌ Error fatal al iniciar:", error.message);
      process.exit(1);
    }
  }
};

startApp();

// IMPORTANTE: Exportar para Vercel
export default app;

