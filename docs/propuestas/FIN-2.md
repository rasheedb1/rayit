# FIN-2 · Pagos y reserva de impuestos

> Historia FIN-2 (sprint 3, talla M, dueño Nicolás). Depende de FIN-1,
> que está en `main`. Sin migraciones: `payment` y `tax_reserve` existen
> desde 0008.

---

## 0 · Plan

### 0.1 Qué hay hoy y qué falta

En `main`, Finanzas sabe crear una factura, numerarla, marcarla enviada
y anularla (FIN-1), y el detalle tiene el botón «Registrar pago»
**deshabilitado** con la nota «Sprint 3 · FIN-2». Los KPI de `/finanzas`
ya leen `payment` (cobrado en el año) y `tax_reserve` (apartado para
impuestos): hoy esas dos tablas solo las llena el seed 0003. FIN-2 es lo
que las llena desde el producto.

Lo que **no** está en `main` y esta historia necesitaría:

| Pieza | Dónde estaría | Estado |
|---|---|---|
| `requirePermission()` | `apps/web/lib/auth/` (Rasheed) | ACC-1 sin mezclar |
| `PERMISOS` / `can()` | `packages/core/src/permisos.ts` | ACC-1 sin mezclar |
| `audit()` | `packages/db/src/audit.ts` | ACC-2 sin mezclar |

> **Actualización del 23 de septiembre, al integrar.** ACC-1, ACC-2,
> FIN-6 y CAM-5 entraron a `main` mientras se construía FIN-2. La tabla
> de arriba y el resto de este §0 son el plan **tal como se escribió**,
> con las tres piezas todavía fuera; lo que se entregó las usa de
> verdad. Qué cambió exactamente, en §0.6 y en §2.
>
> Que el plan apostara por hablar su idioma exacto fue lo que hizo que
> integrarlas costara **una línea y un borrado**: el permiso ya se
> llamaba `finanzas.pago.registrar` y la acción de bitácora ya era
> `invoice.payment_recorded`.

Las dos ramas existen (`nicolas/ACC-1-catalogo-permisos`,
`nicolas/ACC-2-bitacora-obligatoria`) pero no están en `origin/main`, así
que FIN-2 no puede importarlas sin arrastrarlas. Lo que sí hace es
**hablar su idioma exacto**, para que integrarlas sea borrar código, no
reescribirlo:

- El permiso se llama `finanzas.pago.registrar`, que es la clave que
  ACC-1 ya tiene escrita en `PERMISOS` (`packages/core/src/permisos.ts`,
  sensibilidad `sensible`).
- La acción de bitácora se llama `invoice.payment_recorded`, que es la
  que ACC-2 ya tiene en `AUDIT_ACTIONS` — la lista la escribió pensando
  en esta historia («Finanzas (FIN-1; FIN-2 agrega payment.*)»).

### 0.2 Decisión 1 · Las reglas del pago viven en core

`packages/core/src/facturacion.ts` gana `applyPayment(invoice, input)`,
pura, sin base ni red, del mismo corte que `transitionInvoice`: valida y
**calcula** el resultado, no lo persiste.

```ts
applyPayment(
  { status, total, paidAmount },
  { amount, receivedAt },
): { amount, paidAmount, outstanding, status: 'partial' | 'paid', paidAt }
```

Reglas, y por qué cada una:

1. **Estados que admiten pago: `sent`, `partial` y `overdue`.** `overdue`
   no se persiste (se deriva de `due_on < hoy`), pero la máquina de
   estados de FIN-1 ya lo acepta como estado de lectura y de origen, y
   una factura vencida es justo la que más falta hace cobrar. `draft`,
   `paid` y `void` → `InvoiceNotPayable`. Una factura en borrador no se
   ha enviado: cobrarla sería registrar dinero contra un documento que
   la marca no ha visto.
2. **`amount > 0`** → `PaymentAmountInvalid`. Un pago de cero no es un
   hecho; un pago negativo es una devolución, que es fase 2.
3. **`amount <= outstanding`** → `PaymentExceedsOutstanding`.
   **DECISIÓN conservadora: sin sobrepago.** Un sobrepago obliga a
   decidir qué es el excedente (saldo a favor, nota crédito, error de
   digitación) y ninguna de las tres respuestas es obvia; rechazarlo con
   un mensaje que dice cuánto falta no pierde información y no inventa
   contabilidad. Va a «fuera de alcance» con su historia destino.
4. **`paid_amount + amount == total` → `paid`, con `paid_at =
   received_at`.** Si no llega al total → `partial`.
5. **`paid_at` solo se fija al quedar pagada.** Aquí FIN-2 se aparta a
   propósito de `transitionInvoice`, que lo fija también en `partial`:
   la columna se lee en la pantalla como «Pagada el …», y poner ahí la
   fecha de un abono del 30 % es decir que la factura se pagó ese día.
   `transitionInvoice` no cambia (es de FIN-1 y su rama `partial` no
   tiene botón en la interfaz).
6. **Tope de monto.** `MONTO_MAXIMO = '999999999999.99'` (el máximo de
   `numeric(14,2)`) y `AmountOutOfRange`, comprobado sobre `amount` y
   sobre `paid_amount + amount`. Sin él, un monto con ceros de más llega
   a Postgres y vuelve como `22003 numeric field overflow`, que la
   pantalla convierte en un genérico sin campo marcado. Es el pendiente
   `MONTO_MAXIMO` de `docs/propuestas/pendientes-pulido.json`; FIN-2 pone
   la constante y el error en `@mc/core` y **solo los aplica en
   `applyPayment`** (aplicarlos a `computeInvoiceTotals`, a Cotizar y a
   Ventas es ese pendiente, no esta historia). Ver §1.1.

El redondeo es el de FIN-1: todo pasa por `toCents` / `fromCents`, nunca
por `number`.

### 0.3 Decisión 2 · La reserva de impuestos, también en core

```ts
taxReserveFor(amount: Decimal, rate: string): Decimal   // mulRateHalfUp
reservePeriod(receivedAtIso: string, timeZone: string): string  // '2026-Q3'
```

- **La tasa es la del momento del cobro.** Sale de
  `workspace.settings.finanzas.reserva_pct` (11 en los seeds 0002 y
  0003) convertido con `pctToRate` → `'0.11'`, y se **guarda en la fila**
  (`tax_reserve.rate`, `numeric(6,4)` → `0.1100`). Cuando FIN-8 cambie el
  porcentaje, los apartados anteriores no se tocan: cada uno lleva la
  tasa con la que se calculó. Es la misma forma del seed.
- **El período es el trimestre del cobro en la zona del workspace**, no
  en UTC. Un cobro del 31 de diciembre a las 20:00 en Bogotá es
  `2027-01-01T01:00Z`: en UTC caería en `2027-Q1` y el creador lo
  declara en `2026-Q4`. Se calcula con `hoyEnZona()` de
  `packages/core/src/zonas.ts`, que ya resuelve husos y cambios de
  horario con `Intl`. Prueba de bordes: 31 mar / 1 abr y 31 dic / 1 ene,
  en Bogotá y en UTC.
- **`currency` es la de la factura** y `released_at` queda en `null`:
  liberarla es FIN-8 o fase 2.

**DECISIÓN PENDIENTE DE NICOLÁS · qué pasa si el workspace no tiene
`reserva_pct`.** `workspace.settings` es `{}` por defecto (0001), así que
un workspace nuevo no lo tiene. Tres opciones:

| | Qué haría | Por qué no |
|---|---|---|
| Bloquear el pago | «Configura el porcentaje antes de cobrar» | Impedir registrar dinero que ya entró por un ajuste que el producto todavía no deja tocar (es FIN-8) es peor que no apartar |
| Suponer 11 % | Apartar con el valor colombiano | Es la constante escondida que el resto del repo lleva cuatro rondas quitando: el producto se vende fuera de Colombia |
| **Tasa 0, sin fila, y decirlo** ← elegida | Se registra el pago, no se crea `tax_reserve`, y la pantalla dice «Este espacio no aparta impuestos todavía» | No pierde el cobro, no inventa un número y deja el hueco visible |

Un `reserva_pct` **presente pero inválido** (texto, negativo, > 100) sí
falla, con `TaxReserveRateInvalid`: una ausencia es una decisión que
nadie ha tomado; un valor roto es un error que hay que ver.

### 0.4 Decisión 3 · Todo en UNA transacción, en `queries/finanzas.ts`

`recordPayment(tx, input)` hace, en este orden y en una sola
transacción:

1. `SELECT … FROM invoice WHERE id = $1 FOR UPDATE`. RLS ya filtró: desde
   otro workspace son cero filas → `InvoiceNotFound`. El `FOR UPDATE`
   serializa dos pagos concurrentes sobre la misma factura, igual que
   `transitionInvoice`.
2. La fila `workspace` (moneda y `settings.finanzas.reserva_pct`) dentro
   de la misma transacción.
3. `applyPayment` y `taxReserveFor` — toda la aritmética, pura.
4. La comprobación de idempotencia (§0.5).
5. `INSERT INTO payment` (`direction 'in'`, moneda de la factura).
6. `UPDATE invoice SET paid_amount, status, paid_at`.
7. `INSERT INTO tax_reserve` si la tasa es mayor que cero.
8. La fila de `audit_log` (§0.6).
9. La `notification` `payment_received`, `severity 'success'`,
   `entity_type 'invoice'`, `action_url` al detalle.

Si algo de esto falla, no queda nada: es una transacción. La prueba del
exceso lo comprueba contando filas de `payment` y `tax_reserve` después
del rechazo.

`listPayments(tx, invoiceId)` devuelve los cobros de una factura y la
suma apartada, para la pantalla. Ninguna de las dos devuelve un
`bigserial` a la web (CIM-2 §3): `payment` y `tax_reserve` tienen `uuid`.

### 0.5 Decisión 4 · Idempotencia: el formulario dice sobre qué estado paga

El requisito es «un doble envío no registra dos pagos». El caso del pago
**total** ya se cae solo: el segundo envío encuentra la factura en `paid`
y `applyPayment` responde `InvoiceNotPayable`. El que hace daño es el
**parcial**: dos abonos idénticos son un estado de la base perfectamente
legal, así que nada los distingue de un doble clic… salvo el estado sobre
el que se calcularon.

La historia proponía dos caminos; los dos tienen un pero:

| Camino | Pero |
|---|---|
| Un id de envío en un campo oculto, buscado «en los últimos minutos» | `payment` **no tiene `created_at`**: solo `received_at`, que la elige la persona. No hay ninguna columna con la que medir «los últimos minutos», así que la ventana no se puede implementar |
| Comparar contenido (monto + método + referencia) | Dos transferencias iguales el mismo día sin referencia son un caso real; rechazarlas es un falso positivo que bloquea un cobro legítimo |
| Un `UNIQUE` parcial sobre una columna nueva | Es exacto, pero pide migración y la historia dice «sin migraciones» |

**Elegido: control de concurrencia optimista sobre la factura.** El
formulario lleva en un campo oculto el `paid_amount` que la pantalla vio
al dibujarse (`expectedPaidAmount`). Ya dentro de la transacción, después
del `FOR UPDATE`, `recordPayment` comprueba que siga siendo ese; si no,
lanza `InvoicePaymentConflict` con el mensaje de recargar.

Por qué es mejor que las tres de arriba:

- **Es exacto, no heurístico.** Un doble clic manda dos veces el mismo
  `expectedPaidAmount`; el primero gana y cambia `paid_amount`, el
  segundo ve que cambió y no escribe nada. Cero falsos positivos: dos
  abonos iguales *hechos a propósito* son dos envíos distintos del
  formulario, el segundo con el `paid_amount` ya actualizado.
- **Es atómico sin columna nueva.** La comprobación va después del
  `FOR UPDATE`, así que dos peticiones concurrentes se serializan en la
  fila de la factura: no hay ventana de carrera entre leer y escribir.
- **Cubre además el caso de dos personas.** Con ACC en el piloto, el
  creador y su mánager pueden tener el detalle abierto a la vez; el
  segundo en enviar ve «esta factura cambió», no un cobro duplicado.
- **No necesita migración.**

Lo que no cubre: un cliente externo que reintenta la misma llamada (una
API, un webhook de pasarela). Eso sí pide una clave de idempotencia
propia, y va a §1.2 como propuesta para Rasheed, no a esta historia.

### 0.6 Decisión 5 · Permiso y bitácora desde el primer commit

> **Cómo quedó al integrar (23-sep).** Las dos piezas ya están en `main`,
> así que no queda ningún TODO:
>
> - `registrarPago` abre con
>   `await requirePermission("finanzas.pago.registrar")`, que es la
>   convención que `apps/web/lib/permisos/convencion.test.ts` hace
>   cumplir sin revisión humana.
> - `recordPayment` llama al `audit()` de `packages/db/src/audit.ts` con
>   la acción `invoice.payment_recorded`; la función local
>   `anotarPagoEnBitacora` se borró, como decía el plan.
> - Hay prueba de punta a punta del permiso
>   (`apps/web/lib/db/bitacora-permiso.test.ts`): con el rol **Mánager**
>   —que sí ve el estado de cobro de sus campañas— registrar un cobro
>   lanza `SinPermisoError` y no deja ni pago, ni apartado, ni fila de
>   bitácora; con el Dueño deja exactamente uno de cada.
>
> Lo de abajo es el razonamiento original.

- **Permiso.** `requirePermission()` vive en `apps/web/lib/auth/`, que es
  de Rasheed, y ACC-1 no está en `main`. La Server Action abre con
  `// TODO(ACC-1): requirePermission('finanzas.pago.registrar')`, con el
  nombre del permiso ya escrito. No hay prueba que lo cubra: no hay nada
  que probar todavía, y decirlo es más honesto que una prueba que pasa
  sin comprobar nada.
- **Bitácora.** Aquí sí se escribe la fila, no un TODO. `audit_log` no se
  puede rellenar hacia atrás (es el argumento de ACC-2 §Sprint 3) y esta
  es la primera escritura de dinero del producto después de la factura.
  `queries/finanzas.ts` lleva un `anotarPagoEnBitacora()` **local**, con
  la misma forma exacta que el `audit()` de ACC-2 —
  `current_workspace_id()`, `current_user_id()`, `actor_kind` `'user'` o
  `'system'`, `action` `'invoice.payment_recorded'`, `entity_type`
  `'invoice'`, `before`/`after` con solo los campos de la factura que
  cambian — y un `// TODO(ACC-2)` que dice que al mezclar ACC-2 esta
  función se borra y se importa `audit`. La prueba comprueba la fila de
  verdad, no espera a descomentarse.
  `before`/`after` llevan `status`, `paidAmount`, `paidAt` y el monto y
  el id del pago: ni nombres, ni correos, ni referencias bancarias (la
  `reference` es un dato del banco de la marca; no va a la bitácora).

### 0.7 Decisión 6 · La pantalla

En `/finanzas/facturas/[id]`, una sección **«Pagos»** con:

- La **lista** de cobros (fecha, monto, método, referencia), formateada
  con `formatterFor(await getCurrentWorkspace())`. Sin cobros, una frase
  («Todavía no hay cobros registrados»), no una tabla vacía ni un cero.
- El **formulario «Registrar pago»**: `MoneyInput` con el saldo como
  valor sugerido, `DateInput` con hoy, método de una lista cerrada
  (transferencia, efectivo, PSE, tarjeta, otro — `'transferencia'` es lo
  que usa el seed), referencia y notas. Solo se dibuja si la factura
  admite pago.
- En **Montos**, una fila «Apartado para impuestos» con el total
  apartado por esta factura y la tasa con la que se apartó. Si el
  workspace no aparta, la frase de §0.3.
- La cabecera ya dice «Pagada el …» (fila de FIN-1); con FIN-2 deja de
  estar siempre vacía.

**Sin botón «Anular pago».** No existe en el MVP: anular un cobro obliga
a decidir qué pasa con su `tax_reserve` (¿se borra?, ¿se libera?, ¿se
compensa?) y a dejar rastro de la anulación. Es fase 2, y mientras tanto
el camino es no registrar lo que no ocurrió.

### 0.8 Decisión 7 · Las Server Actions de Finanzas migran a `@/lib/forms`

Pendiente heredado de CAM-1 §7 y anotado en `docs/backlog-mvp.md` §9.5
(«`apps/web/lib/forms.ts` unifica lo común de las Server Actions y
Finanzas migra en FIN-2»). `facturas/actions.ts` tiene copias locales de
`firstErrors`, `DECIMAL_RE` y de la forma del estado. Va en un **commit
aparte, antes** del de la acción nueva, y sin cambiar comportamiento:
así el diff de la funcionalidad no se mezcla con el del pulido.
`CrearFacturaState` se conserva como alias de `ActionState` para no
romper `nueva/form.tsx` ni su prueba.

### 0.9 Archivos

| Archivo | Qué |
|---|---|
| `packages/core/src/facturacion.ts` | `MONTO_MAXIMO`, `InvoiceError` y sus cuatro hijos, `applyPayment`, `taxReserveFor`, `reservePeriod`, `PAYMENT_METHODS` |
| `packages/core/test/facturacion.test.ts` | Pruebas de todo lo anterior |
| `packages/db/src/queries/finanzas.ts` | `recordPayment`, `listPayments`, la lectura de `settings.finanzas`, la bitácora local |
| `packages/db/test/finanzas.test.ts` | Pruebas en pglite contra el seed |
| `apps/web/app/(app)/finanzas/facturas/actions.ts` | Migración a `@/lib/forms` + `registrarPago` |
| `apps/web/app/(app)/finanzas/facturas/[id]/pagos.tsx` | La sección «Pagos» (cliente) |
| `apps/web/app/(app)/finanzas/facturas/[id]/pagos.test.tsx` | Pruebas de componente |
| `apps/web/app/(app)/finanzas/facturas/[id]/page.tsx` | Enganche de la sección y la fila de apartado |
| `apps/web/app/(app)/finanzas/_lib/messages.ts` | Textos de la sección |
| `apps/web/content/backlog.ts` | Estado y nota de FIN-2 |
| `packages/db/README.md`, `apps/web/README.md` | Lo que cambie del contrato |

### 0.10 Dudas

Ninguna que bloquee. Las dos decisiones que son de Nicolás están
marcadas: la de §0.3 (workspace sin `reserva_pct`) y, menor, la de §0.2.5
(`paid_at` solo al quedar pagada).

---

## 1 · Lo que necesita Rasheed

Nada de esto bloquea FIN-2, que está terminada y en verde. Son tres
cosas que le tocan a él o que valen para su carril.

### 1.1 `MONTO_MAXIMO` ya está en `@mc/core`

El pendiente `MONTO_MAXIMO` de `docs/propuestas/pendientes-pulido.json`
pedía una constante y un error para que un monto con ceros de más no
llegue a Postgres y vuelva como `22003 numeric field overflow` (que la
pantalla convierte en un genérico sin marcar ningún campo). FIN-2 los
pone:

```ts
import { MONTO_MAXIMO, AmountOutOfRange, compareDecimal } from '@mc/core';
// MONTO_MAXIMO === '999999999999.99'  (el máximo de numeric(14,2))
```

y los aplica **solo** en `applyPayment`, que es lo que cabe en esta
historia. Cuando toques ese pendiente en Cotizar y en Ventas, impórtalos
de ahí en vez de definir otra constante: el tope de la columna es uno
solo y tres copias terminan divergiendo, que es exactamente lo que
acabamos de arreglar con `DECIMAL_RE`.

Los sitios que lo esperan, según el pendiente: `tarifas.ts`
(`calcularTotalesCotizacion`, `validarRangoPrecio`), `cotizar/actions.ts`
(`itemSchema.unitPrice`, `discount`, `rangoCpmSchema`) y
`ventas/actions.ts` (`moverOptsSchema.amount`). `computeInvoiceTotals` y
`createInvoice` de Finanzas **no** lo usan todavía: es el mismo pendiente
y lo atiendo con el resto, no dentro de FIN-2.

### 1.2 La clave de idempotencia de `payment`, cuando haya API

El doble envío del formulario lo resuelve el control de concurrencia
optimista de §0.5 sin tocar el esquema, y con eso basta para el MVP: el
único cliente es una pantalla que sabe qué saldo vio.

No basta el día que un cliente **externo** reintente la misma llamada (la
API de la fase 2, el webhook de una pasarela): ahí no hay «lo que vio la
pantalla», hay una petición repetida. Para eso sí hace falta una clave
propia, y como `payment` **no tiene `created_at`** tampoco se puede
acotar por tiempo:

```sql
-- Migración de la fase 2, cuando exista el primer cliente externo.
ALTER TABLE payment ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS payment_idempotency
  ON payment (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

No la escribo ahora porque la historia dice «sin migraciones» y porque
una columna sin cliente que la llene es una columna muerta. Queda aquí
para que la decisión esté tomada cuando haga falta.

Si al mirarlo prefieres que entre ya, dímelo: son diez líneas de
migración y tres de `recordPayment`.

### 1.3 `payment` sin `created_at`, anotado

Merece una línea en su propio inventario: `payment` guarda `received_at`
—el día que la persona dice que entró el dinero— y nada más. No hay
forma de saber **cuándo se registró** una fila, así que no se puede:

- ordenar dos cobros del mismo día por orden de captura (hoy desempata
  `received_at`, que para un cobro de hoy es `now()` con microsegundos, y
  para un cobro pasado es el comienzo del día);
- acotar una comprobación a «los últimos minutos»;
- auditar la latencia entre el cobro real y su registro.

Lo tapa a medias la bitácora (`audit_log.created_at` con la acción
`invoice.payment_recorded`), que sí lleva la hora de captura. Si algún
día `payment` gana `created_at`, la columna de la bitácora deja de ser
el único sitio donde está.

---

## 2 · Lo que queda listo para otras historias

### FIN-6 · Flujo de caja proyectado

`tax_reserve` por fin se llena desde el producto, con `period`
('2026-Q3') y `released_at NULL`, que es lo que `flujo-caja.ts` necesita
para restar la reserva de la semana. `listPayments` devuelve el apartado
por cobro y el total por factura; `getReceivablesKpis` ya suma el
apartado vivo (`released_at IS NULL`).

### FIN-8 · Configurar el porcentaje

La tasa se guarda **en cada apartado** (`tax_reserve.rate`), así que
FIN-8 puede cambiar `settings.finanzas.reserva_pct` sin recalcular nada:
los apartados anteriores conservan la tasa con la que se hicieron. Lo que
FIN-8 tiene que resolver, y FIN-2 deja escrito pero sin pantalla:

- **El espacio sin porcentaje** (`settings` es `{}` por defecto). Hoy
  cobra igual y la ficha dice «Este espacio todavía no aparta un
  porcentaje para impuestos». La decisión está en §0.3 y está marcada
  como pendiente de Nicolás.
- **Liberar la reserva** (`released_at`), que el seed 0003 ya usa para
  las de 2025 y que ninguna pantalla toca todavía.

### FIN-4 · Recordatorios

`invoice.reminders_sent` y `last_reminder_at` siguen sin escribirse.
`recordPayment` no los toca a propósito: un cobro no cancela el contador
de recordatorios, lo cancela el estado de la factura.

### ACC-1 y ACC-2 · ya integrados

Entraron a `main` durante la historia y FIN-2 los usa de verdad
(detalle en §0.6). Lo que queda anotado para quien venga:

- El permiso `finanzas.pago.registrar` es **sensible** en el catálogo y
  el rol **Mánager** no lo tiene, a propósito: en el piloto el mánager
  ve el estado de cobro de sus campañas y no toca el dinero. Si esa
  decisión cambia, se cambia en `packages/core/src/permisos.ts` y la
  prueba de punta a punta lo dice.
- `invoice.payment_recorded` se usa tanto si el cobro deja la factura en
  `partial` como si la deja en `paid`: el hecho es «entró un cobro», y
  el `after` de la fila lleva el estado en que quedó. `invoice.paid`
  queda para la transición manual de FIN-1.

---

## 3 · Fuera de alcance, con su historia

| Qué | Por qué | Dónde va |
|---|---|---|
| Sobrepagos | Obligan a decidir qué es el excedente (saldo a favor, nota crédito, error); ninguna respuesta es obvia | Fase 2 |
| Pagos sin factura (`payment.invoice_id` es nullable) | Un ingreso suelto es otro flujo, no este formulario | Fase 2 |
| Anular un cobro | Obliga a decidir qué pasa con su `tax_reserve` y a dejar rastro de la anulación. La ficha lo dice en vez de esconderlo | Fase 2 |
| Liberar la reserva (`released_at`) y su pantalla | Es el otro lado de FIN-8 | FIN-8 o fase 2 |
| Recordatorios de cobro | — | FIN-4 |
| Configurar `reserva_pct` | — | FIN-8 |
| `MONTO_MAXIMO` en Cotizar, Ventas y `computeInvoiceTotals` | Es el pendiente de pulido, no esta historia (§1.1) | `pendientes-pulido.json` |

---

## 4 · Integración con lo que entró a `main` durante la historia

`origin/main` avanzó 20 commits mientras FIN-2 se construía: ACC-1,
ACC-2, FIN-6 y CAM-5. El merge tocó cinco archivos y ninguno fue una
sorpresa de diseño:

| Archivo | Qué pasó |
|---|---|
| `queries/finanzas.ts` | Los dos apéndices —FIN-2 y el flujo de caja de FIN-6— caían al final del archivo. Se conservan los dos; la bitácora local se cambia por `audit()` |
| `test/finanzas.test.ts` | **FIN-6 va primero.** Sus pruebas leen FV-2026-010 con las cifras del seed y las de FIN-2 la cobran; `node:test` corre el archivo en orden |
| `facturas/actions.ts` | Los imports y el `requirePermission` de las tres acciones de FIN-1; `registrarPago` estrena el suyo |
| `_lib/messages.ts` | Los textos de FIN-6 (`flujo`) y los de FIN-2 conviven |
| `packages/db/README.md` | La viñeta de la bitácora la escribió ACC-2; queda la suya, más la de «este paquete no tiene idioma» |

**Una cosa que FIN-6 daba por hecha y ahora es verdad.** Su comentario
decía «El monto es `total − paid_amount`, que es lo que FIN-2 mantendrá
al registrar pagos». Ya lo mantiene: un abono parcial baja el monto que
el flujo de caja proyecta para esa semana, y una factura cobrada por
completo sale de la proyección. Las pruebas de FIN-6 sobre el seed
siguen en verde porque corren antes de que las de FIN-2 cobren.
