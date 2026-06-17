import { User } from '../models/User.js';

/**
 * Middleware Global para rutas protegidas.
 * Obtiene el contexto del negocio e inyecta el req.ownerId.
 * Magia: Sobrescribe req.userId para que todos los controladores
 * operen bajo el ID del dueño del negocio sin modificar código.
 */
export const injectBusinessContext = async (req, res, next) => {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user) {
      return res.status(401).json({ success: false, message: "Usuario no encontrado." });
    }

    // Guardar contexto en req para middlewares posteriores
    req.realUserId = user._id.toString(); // ID real de quien hizo login (ej. empleado)
    req.userRole = user.role;
    req.userPermissions = user.permissions || [];

    // Determinar el dueño del negocio
    const ownerId = user.owner_id ? user.owner_id.toString() : user._id.toString();

    // ESTADO FINAL (Fase 3)
    req.businessOwnerId = ownerId; // Se queda como el estándar de inquilino
    req.userId = req.userId;       // El actor real se queda en su lugar original (verifyToken)

    // 🧠 El truco de magia para no tocar los controladores:
    req.actorId = req.userId;      // Mantienes este alias vivo en el middleware

    next();
  } catch (error) {
    console.error("Error en injectBusinessContext:", error);
    res.status(500).json({ success: false, message: "Error cargando contexto del negocio." });
  }
};

/**
 * Middleware para Control de Acceso (RBAC).
 * Solo se aplica a las rutas que requieran un permiso específico.
 */
export const requirePermission = (requiredPermission) => {
  return (req, res, next) => {
    // Dueños y Admins pasan directo
    if (req.userRole === 'customer' || req.userRole === 'admin') {
      return next();
    }

    // Empleados deben tener el permiso
    if (req.userRole === 'employee') {
      if (req.userPermissions.includes(requiredPermission)) {
        return next();
      } else {
        return res.status(403).json({
          success: false,
          message: `Acceso denegado. Requiere permiso: ${requiredPermission}`
        });
      }
    }

    return res.status(403).json({ success: false, message: "Rol no autorizado." });
  };
};

