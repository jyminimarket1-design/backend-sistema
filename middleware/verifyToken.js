import jwt from "jsonwebtoken";

// ─── OPTIMIZACIÓN CRÍTICA ───────────────────────────────────────────────────
// Leer el secreto UNA SOLA VEZ al cargar el módulo.
// Antes: process.env.JWT_SECRET se leía en CADA request (lectura OS + V8 reparse).
// El profiler mostró que createPublicKey/verify consumía ticks masivos porque
// jsonwebtoken reconstruía la clave criptográfica internamente en cada llamada.
const JWT_SECRET = process.env.JWT_SECRET;

export const verifyToken = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ success: false, message: "Unauthorized - no token provided" });

  // Usar la versión con callback de jwt.verify para liberar el Event Loop
  // mientras V8 procesa la verificación criptográfica
  jwt.verify(token, JWT_SECRET, (error, decoded) => {
    if (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({ success: false, message: "Unauthorized - Token expired" });
      }
      // JsonWebTokenError, NotBeforeError, etc. → token inválido o manipulado
      if (error.name === "JsonWebTokenError" || error.name === "NotBeforeError") {
        return res.status(401).json({ success: false, message: "Unauthorized - invalid token" });
      }
      console.error("Unexpected error in verifyToken:", error);
      return res.status(500).json({ success: false, message: "Server error" });
    }

    if (!decoded) return res.status(401).json({ success: false, message: "Unauthorized - invalid token" });

    req.userId = decoded.userId;
    next();
  });
};