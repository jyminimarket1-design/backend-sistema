import { User } from '../models/User.js';
import { Sale } from '../models/Sale.js';
import bcryptjs from 'bcryptjs';

// Venezuela = UTC-4. Misma lógica de corrección de timezone que sale.controller.js
const VE_OFFSET_MS = 4 * 60 * 60 * 1000;

function dayRangeVE(offsetDays = 0) {
  const nowVE = new Date(Date.now() - VE_OFFSET_MS);
  const y = nowVE.getUTCFullYear();
  const m = nowVE.getUTCMonth();
  const d = nowVE.getUTCDate() + offsetDays;
  const start = new Date(Date.UTC(y, m, d,  0,  0,  0,   0) + VE_OFFSET_MS);
  const end   = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) + VE_OFFSET_MS);
  return { start, end };
}

/**
 * Crea un nuevo empleado asociado al dueño del negocio.
 */
export const createEmployee = async (req, res) => {
  try {
    const { email, password, name, permissions } = req.body;

    // req.userRole ya fue resuelto por injectBusinessContext — sin DB query extra
    if (req.userRole !== 'customer' && req.userRole !== 'admin') {
      return res.status(403).json({ success: false, message: "Solo los dueños de negocio pueden crear empleados." });
    }

    const userAlreadyExists = await User.findOne({ email });
    if (userAlreadyExists) {
      return res.status(400).json({ success: false, message: "El correo ya está registrado." });
    }

    const hashedPassword = await bcryptjs.hash(password, 10);

    const employee = new User({
      email,
      password: hashedPassword,
      name,
      role: 'employee',
      owner_id: req.userId, // req.userId ya es el ownerId (resuelto por injectBusinessContext)
      permissions: permissions || []
    });

    await employee.save();

    res.status(201).json({
      success: true,
      message: "Empleado creado exitosamente.",
      employee: {
        _id: employee._id,
        email: employee.email,
        name: employee.name,
        permissions: employee.permissions
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Devuelve todos los empleados del negocio.
 * Para cada uno adjunta salesStats: { salesCount, totalAmount } calculado
 * sobre el período indicado por dateFilter (ventas del empleado, no su fecha
 * de registro). Si dateFilter = 'all' o se omite, cuenta todo el historial.
 *
 *   dateFilter = today | ayer | 7days | 30days | month | all (default)
 *   dateFrom   = YYYY-MM-DD  (rango personalizado, requiere también dateTo)
 *   dateTo     = YYYY-MM-DD
 */
export const getEmployees = async (req, res) => {
  try {
    const ownerId = req.userId;

    // ── 1. Resolver rango de fechas para las VENTAS (no para el registro) ──
    const { dateFrom, dateTo } = req.query;
    const dateFilterParam = req.query.dateFilter;
    let salesDateFilter = null; // null = sin restricción de fecha

    if (dateFilterParam && dateFilterParam !== 'all' && dateFilterParam !== 'custom') {

      if (dateFilterParam === 'today') {
        const { start, end } = dayRangeVE(0);
        salesDateFilter = { $gte: start, $lte: end };

      } else if (dateFilterParam === 'ayer') {
        const { start, end } = dayRangeVE(-1);
        salesDateFilter = { $gte: start, $lte: end };

      } else if (dateFilterParam === '7days') {
        const { start } = dayRangeVE(-6);
        const { end }   = dayRangeVE(0);
        salesDateFilter = { $gte: start, $lte: end };

      } else if (dateFilterParam === '30days') {
        const { start } = dayRangeVE(-29);
        const { end }   = dayRangeVE(0);
        salesDateFilter = { $gte: start, $lte: end };

      } else if (dateFilterParam === 'month') {
        const nowVE    = new Date(Date.now() - VE_OFFSET_MS);
        const firstDay = new Date(Date.UTC(nowVE.getUTCFullYear(), nowVE.getUTCMonth(), 1, 0, 0, 0, 0) + VE_OFFSET_MS);
        const { end }  = dayRangeVE(0);
        salesDateFilter = { $gte: firstDay, $lte: end };
      }

    } else if (dateFrom || dateTo) {
      // Rango personalizado
      salesDateFilter = {};
      if (dateFrom) {
        const from = new Date(dateFrom + 'T04:00:00.000Z'); // medianoche VE → UTC
        if (!isNaN(from)) salesDateFilter.$gte = from;
      }
      if (dateTo) {
        const to = new Date(dateTo + 'T04:00:00.000Z');
        if (!isNaN(to)) {
          to.setUTCHours(to.getUTCHours() + 23, 59, 59, 999); // fin del día VE
          salesDateFilter.$lte = to;
        }
      }
    }

    // ── 2. Obtener lista completa de empleados (sin filtrar por fecha) ────
    const employees = await User.find({ owner_id: ownerId, role: 'employee' })
      .select('-password')
      .sort({ createdAt: -1 })
      .lean();

    // ── 3. Agregar ventas por empleado en el período solicitado ───────────
    // Filtramos el scope del negocio (customer_id = ownerId) y la fecha.
    const salesMatchStage = { customer_id: ownerId };
    if (salesDateFilter) salesMatchStage.createdAt = salesDateFilter;

    const salesAgg = await Sale.aggregate([
      { $match: salesMatchStage },
      {
        $group: {
          _id: '$sold_by',
          salesCount:  { $sum: 1 },
          totalAmount: { $sum: '$total_amount' },
        },
      },
    ]);

    // Convertir array a mapa para O(1) lookup
    const statsMap = Object.fromEntries(
      salesAgg.map(({ _id, salesCount, totalAmount }) => [
        String(_id),
        { salesCount, totalAmount },
      ])
    );

    // ── 4. Adjuntar salesStats a cada empleado ────────────────────────────
    const employeesWithStats = employees.map((emp) => ({
      ...emp,
      salesStats: statsMap[String(emp._id)] ?? { salesCount: 0, totalAmount: 0 },
    }));

    res.status(200).json({
      success: true,
      employees: employeesWithStats,
      total: employeesWithStats.length,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Actualiza los permisos de un empleado.
 */
export const updateEmployeePermissions = async (req, res) => {
  try {
    const { id } = req.params;
    const { permissions } = req.body;

    const employee = await User.findOne({ _id: id, owner_id: req.userId });
    
    if (!employee) {
      return res.status(404).json({ success: false, message: "Empleado no encontrado o no te pertenece." });
    }

    employee.permissions = permissions;
    await employee.save();

    res.status(200).json({ success: true, message: "Permisos actualizados.", employee });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Elimina un empleado.
 */
export const deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    
    const deleted = await User.findOneAndDelete({ _id: id, owner_id: req.userId });
    
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Empleado no encontrado o no te pertenece." });
    }

    res.status(200).json({ success: true, message: "Empleado eliminado." });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
