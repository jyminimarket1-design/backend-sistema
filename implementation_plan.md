# Refactorización del Contexto Multi-Inquilino y Preservación del ID del Actor

Este plan de implementación refactoriza la forma en que se maneja el contexto multi-inquilino (negocio) y la identidad del actor en el backend.

Actualmente, `injectBusinessContext` sobrescribe `req.userId` con el ID del dueño del negocio (`ownerId`), lo que hace que los controladores pierdan la identidad del actor real (el empleado) que realiza la acción. Esto rompe las pistas de auditoría (por ejemplo, saber quién realizó realmente una venta, compra o ajuste de inventario) e introduce una alta carga cognitiva.

---

## Puntos Ciegos de Alto Riesgo Abordados

Para mitigar riesgos estructurales durante la refactorización, hemos integrado estrategias específicas para cinco áreas críticas:

### 1. El Infierno de la Caché Asíncrona
* **Riesgo:** Si alguna función de invalidación o lectura de caché sigue usando `req.userId` por error, causará inconsistencia de datos donde los empleados verán información desactualizada o el dueño verá datos stale.
* **Solución:** Auditaremos y actualizaremos todas las referencias de caché en los controladores y middlewares para usar estrictamente `req.businessOwnerId`. Esto incluye `bumpCacheVersion`, `invalidateCache`, `getCacheVersion` y `buildPaginatedKey`.

### 2. El "Efecto Fantasma" en Datos Históricos
* **Riesgo:** Los registros históricos de `InventoryAdjustment` en la base de datos no tienen el campo `created_by`. Al intentar popular este campo o renderizarlo, el sistema devolverá null, lo que podría hacer fallar el backend o el frontend.
* **Solución:** Implementaremos un fallback defensivo tanto a nivel de consulta como en el controlador/servicio:
  `const createdByActor = adjustment.created_by || adjustment.user_id;`
  (Asumiendo que antes de la refactorización el dueño del negocio era considerado el creador de todos los ajustes).

### 3. La Heterogeneidad de la Base de Datos
* **Advertencia:** Los esquemas de la base de datos mapean el tenant (dueño del negocio) usando nombres de campos heterogéneos. Para evitar errores en consultas, documentamos el mapeo exacto aquí:
  - `Product` → `user`
  - `Category` → `user`
  - `InventoryAdjustment` → `user_id`
  - `Sale` → `customer_id`
  - `Purchase` → `admin_id`
  - `SupplierPayment` → `admin_id`
  - `User` (empleado) → `owner_id`

### 4. La Trampa de los Mocks en la Suite de Tests ⚠️ BLOQUEANTE
* **Riesgo:** Los tests de integración actuales (los 129 que pasaron) fueron escritos asumiendo el comportamiento viejo donde solo existe `req.userId`. En el momento en que migres el Módulo A para que use `req.businessOwnerId`, los tests empezarán a fallar con errores de Mongoose o respuestas vacías no por código incorrecto, sino porque el entorno de simulación no provee la nueva propiedad.
* **Causa raíz:** Los tests usan supertest con el flow completo de Express, por lo que dependen de que `injectBusinessContext` esté correctamente configurado. Sin embargo, el mock de Redis en los tests (`buildPaginatedKey: vi.fn((_p, _v, _pg, _l, uid) => \`mock:${uid}\`)`) usa el 5° argumento como `uid`. Si los controladores empiezan a pasar `req.businessOwnerId` como ese argumento y el test crea usuarios de rol `admin` (sin `owner_id`), el fallback `user.owner_id || user._id` asegura que `businessOwnerId === userId`, por lo que los tests siguen funcionando. Aun así, esto debe verificarse explícitamente.
* **Solución (Fase 1, paso previo a cualquier controlador):**
  1. Actualizar `injectBusinessContext` completo con el Puente de Identidad.
  2. Ejecutar `pnpm test run` inmediatamente para verificar que los 129 tests sigan en verde con el nuevo middleware antes de tocar ningún controlador.
  3. Solo avanzar a la Fase 2 si los tests pasan en su totalidad.

### 5. La Paradoja del Ciclo de Vida del `cache.middleware.js` ⚠️ BLOQUEANTE
* **Riesgo:** `cache.middleware.js` fue planeado para la Fase 3, pero es una bomba de tiempo para la consistencia de datos durante la Fase 2. Si los controladores migrados invalidan caché usando `req.businessOwnerId` (ID del dueño), pero el middleware de caché aún lee `req.userId` (que durante la transición puede ser el ID del empleado en ciertos puntos del pipeline), las llaves de Redis nunca van a coincidir. El resultado: registros huérfanos en caché y el frontend mostrando datos congelados.
* **Solución (mover a Fase 1):** Actualizar `cache.middleware.js` en la Fase 1 junto con los cimientos del Puente. Implementar la lectura con fallback:
  ```javascript
  // Usa el tenant si ya fue resuelto, fallback al userId si el middleware aún no corrió
  const tenantId = req.businessOwnerId || req.userId;
  ```
  Con esto, la caché habla el mismo idioma que los controladores desde el primer día de la migración.

---

## Estrategia de Ejecución: El Puente de Identidad Transicional

Para evitar el cortocircuito lógico en el ciclo de vida del request durante la transición modular, utilizaremos una estrategia de puente de identidad en `injectBusinessContext` durante las Fases 1 y 2.

```javascript
// REGLA DE TRANSICIÓN (Solo durante Fase 1 y Fase 2)
req.businessOwnerId = ownerId; // 🎯 El nuevo estándar para inquilinos
req.actorId = req.userId;      // 👤 El nuevo estándar para auditoría (reemplaza a realUserId)

// 👁️ EL ANCLA DE COMPATIBILIDAD (Se elimina en la Fase 3)
req.userId = ownerId;          // Mantiene vivos los controladores no migrados
```

### Fase 1: Cimientos y Configuración del Puente ⛔ Precondición: Todo esto debe completarse ANTES de tocar cualquier controlador
1. **Modelo:** Modificar el esquema de `InventoryAdjustment` en Mongoose para incluir `created_by` (ObjectId opcional).
2. **Middleware Central — El Puente:** Actualizar `injectBusinessContext` en `requirePermission.js`:
   - Guardar `req.actorId = req.userId` (actor real logueado, antes de sobrescribir).
   - Guardar `req.businessOwnerId = ownerId`.
   - Mantener el ancla de compatibilidad `req.userId = ownerId` (la eliminamos en Fase 3).
   - Mantener temporalmente `req.realUserId` hasta migrar el controlador de ventas.
3. **Middleware de Caché — Adelantar de Fase 3 a Fase 1:** Actualizar `cache.middleware.js` para usar `req.businessOwnerId || req.userId` como clave de tenant. Esto garantiza que la caché hable el mismo idioma que los controladores desde el primer commit.
4. **Validación del Puente — Ejecución de Tests:** Ejecutar `pnpm test run` con el puente activado pero SIN haber tocado ningún controlador. Los 129 tests deben seguir en verde. Si alguno falla aquí, se corrige antes de avanzar. **No se migra ningún módulo de la Fase 2 hasta obtener 129/129 verde.**

### Fase 2: Migración Modular (Módulo a Módulo)
Migraremos cada módulo de forma aislada. Los controladores migrados ignorarán `req.userId` y utilizarán estrictamente `req.businessOwnerId` para el ámbito de inquilino (queries y caché) y `req.actorId` para auditoría (creador del registro).

* **Módulo A: Categorías y Tipos de Cambio**
  - Migrar `category.controller.js` y `rate.controller.js`.
  - Reemplazar `req.userId` por `req.businessOwnerId`.
  - Ejecutar pruebas: `vitest run category.test.js`.
* **Módulo B: Productos y Ajustes**
  - Migrar `product.controller.js`, `adjustment.controller.js` y `adjustment.service.js`.
  - Reemplazar `req.userId` por `req.businessOwnerId` en consultas y operaciones de producto.
  - Pasar `req.actorId` como creador a `createAdjustmentProcess` y guardar en `created_by`.
  - Ejecutar pruebas: `vitest run product.test.js` y `vitest run adjustment.test.js`.
* **Módulo C: Compras e Historial**
  - Migrar `purchase.controller.js` y `purchase.service.js`.
  - Reemplazar `req.userId` por `req.businessOwnerId` en consultas, detalles y pagos.
  - Ejecutar pruebas: `vitest run purchase.test.js`.
* **Módulo D: Ventas y Auditoría**
  - Migrar `sale.controller.js` y `sale.service.js`.
  - Usar `req.businessOwnerId` para el inquilino y `req.actorId` para `sold_by`.
  - Remover definitivamente las referencias a `req.realUserId`.
  - Ejecutar pruebas: `vitest run sale.test.js` y `vitest run sale.extended.test.js`.

### Fase 3: Desconexión del Puente y Saneamiento Estructural
1. **Desconexión del Ancla:** En `injectBusinessContext`, remover la sobrescritura `req.userId = ownerId` y aplicar el truco de magia para no tocar los controladores.

   ```javascript
   // ESTADO FINAL (Fase 3)
   req.businessOwnerId = ownerId; // Se queda como el estándar de inquilino
   req.userId = req.userId;       // El actor real se queda en su lugar original (verifyToken)

   // 🧠 El truco de magia para no tocar los controladores:
   req.actorId = req.userId;      // Mantienes este alias vivo en el middleware
   ```
   *Nota: Mantener `req.actorId` como un alias en el middleware central evita tener que hacer un "Buscar y Reemplazar" masivo en 9 controladores, reduciendo el riesgo de error humano a cero.*

2. **Limpieza Final en Middleware:**
   - Asegurar que `checkSubscription.js` utilice únicamente `req.businessOwnerId` (ya sin fallback, porque el ancla fue eliminada).
   - Actualizar `cache.middleware.js` para remover el fallback `|| req.userId` y usar únicamente `req.businessOwnerId`.
4. **Verificación Completa:**
   - Ejecutar la suite de tests completa: `pnpm test run` (13 archivos de prueba, incluyendo `subscription.test.js`).
   - Verificar manualmente el flujo cruzado en desarrollo local: empleado crea venta/ajuste → el campo `sold_by`/`created_by` tiene el ID del empleado, mientras que `customer_id`/`user_id` tiene el ID del dueño.

---

## Cambios Propuestos

### Middlewares

#### [MODIFY] [requirePermission.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/middleware/requirePermission.js)
- Implementar la regla de transición en `injectBusinessContext` durante las fases de migración.
- Mapear `req.businessOwnerId` y `req.actorId`.

#### [MODIFY] [checkSubscription.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/middleware/checkSubscription.js)
- Leer y verificar el estado de suscripción de `req.businessOwnerId` en lugar de `req.userId`.
- Usar clave de caché `sub:${req.businessOwnerId}`.

#### [MODIFY] [cache.middleware.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/middleware/cache.middleware.js)
- Usar `req.businessOwnerId` para delimitar claves de caché por inquilino.

---

### Modelos

#### [MODIFY] [InventoryAdjustment.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/models/InventoryAdjustment.js)
- Agregar el campo `created_by` (ObjectId con referencia a `User`) para registrar el actor.

---

### Servicios

#### [MODIFY] [adjustment.service.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/services/adjustment.service.js)
- Actualizar `createAdjustmentProcess` para recibir `actorId` y `businessOwnerId`.
- Guardar `user_id: businessOwnerId` y `created_by: actorId`.
- Implementar fallback en la recuperación: `created_by: adj.created_by || adj.user_id`.
- Buscar productos bajo `{ _id: product_id, user: businessOwnerId }`.
- Usar `businessOwnerId` para consultas de conteo y listados.

#### [MODIFY] [purchase.service.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/services/purchase.service.js)
- Actualizar todas las operaciones de compras a `businessOwnerId` para el ámbito de inquilino.

#### [MODIFY] [sale.service.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/services/sale.service.js)
- Usar `businessOwnerId` para el inquilino, y `actorId` (luego `userId`) para `sold_by`.

---

### Controladores

#### [MODIFY] [category.controller.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/controllers/category.controller.js)
- Cambiar `req.userId` por `req.businessOwnerId` en queries, caché e invalidaciones.

#### [MODIFY] [product.controller.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/controllers/product.controller.js)
- Cambiar `req.userId` por `req.businessOwnerId` en la capa de datos y gestión de caché.
- Pasar `req.actorId` (luego `req.userId`) y `req.businessOwnerId` a `createAdjustmentProcess`.

#### [MODIFY] [adjustment.controller.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/controllers/adjustment.controller.js)
- Usar `req.actorId` (luego `req.userId`) y `req.businessOwnerId` al crear ajustes.
- Usar `req.businessOwnerId` para invalidar y recuperar listados de ajustes.

#### [MODIFY] [purchase.controller.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/controllers/purchase.controller.js)
- Cambiar `req.userId` por `req.businessOwnerId`.

#### [MODIFY] [sale.controller.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/controllers/sale.controller.js)
- Cambiar `ownerId` a `req.businessOwnerId` y `soldBy` a `req.actorId` (luego `req.userId`).
- Eliminar toda referencia a `req.realUserId`.

#### [MODIFY] [staff.controller.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/controllers/staff.controller.js)
- Usar `req.businessOwnerId` para verificar y administrar los miembros de personal.

#### [MODIFY] [rate.controller.js](file:///c:/Users/Consultorio/Documents/proyectosCarlos/BACKEND---INVENTORY-SYSTEM/controllers/rate.controller.js)
- Cambiar `req.userId` por `req.businessOwnerId`.

---

### Plan de Verificación

#### Checkpoint de la Fase 1 (Bloqueante)
- Ejecutar `pnpm test run` con el Puente y el caché actualizados pero sin tocar controladores.
- **Criterio de éxito:** 129/129 tests en verde. Si hay fallos, se corrigen antes de avanzar.

#### Checkpoint por Módulo (Fase 2)
- Ejecutar el test específico del módulo recién migrado tras cada commit.
- **Criterio de éxito:** El módulo pasa su test suite y no regresiona ningún test de otro módulo.

#### Checkpoint Final (Fase 3)
- Ejecutar la suite completa: `pnpm test run` (13 archivos).
- Agregar casos de prueba en `subscription.test.js` o un nuevo archivo para el flujo cruzado:
  - Empleado crea ajuste → `created_by === empleadoId`, `user_id === dueñoId`.
  - Empleado registra venta → `sold_by === empleadoId`, `customer_id === dueñoId`.
- **Criterio de éxito:** Todos los tests en verde + flujo cruzado validado.
