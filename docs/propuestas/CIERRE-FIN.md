# CIERRE-FIN · Cierre del módulo Finanzas (FIN-1 a FIN-8)

Escrito para: Nicolás (dueño de Finanzas), que decide lo que queda
abierto y hace el humo en producción, y Rasheed para §4. Fecha: 23 de
septiembre de 2026. Rama `nicolas/FIN-cierre-modulo`, desde
`origin/main` (`cf90d57`). Sin migración.

**Resumen.** Las ocho historias de Finanzas están en una rama que sale
de `main`, cosidas entre sí y con Campañas, Cotizar y ACC, cada costura
con su prueba. `/finanzas` es la pantalla de cobro, y seis pestañas
(Cobro, Facturas, Gastos, Flujo, Ingresos y Configuración) llevan a las
vistas del módulo, cada una detrás de su permiso. La proyección de
gastos tiene UNA sola regla, la del flujo de caja. Quedan once
decisiones que son tuyas (§3), todas con la opción conservadora en el
código, y una conversación con Rasheed sobre el IVA de Cotizar (§4).

---

## 0. Inventario

### 0.1 La foto, comprobada

| Cosa | Estado al empezar | Cómo se comprobó |
|---|---|---|
| `origin/main` | `cf90d57` (merge de CON-7), igual que el prompt | `git fetch` |
| `nicolas/FIN-integracion` | FIN-3 + FIN-8 (+ FIN-2 y FIN-6 viejos), **190 commits detrás de main** | `git merge-base`, `git log` |
| FIN-3 contra FIN-integracion | faltaban `7fbe8be`, `cb273b1` y `010c2cf` | `git cherry origin/nicolas/FIN-integracion origin/nicolas/FIN-3-cuentas-por-cobrar` |
| FIN-8 contra FIN-integracion | nada falta (`9d2de6e` incluido) | `git cherry … origin/nicolas/FIN-8-configuracion-financiera` |
| FIN-5 | local en `rayit-fin5`, con 6 archivos cambiados y `gastos/page.test.tsx` sin rastrear | `git status` |
| `pnpm verificar` sobre main | rojo en `lib/permisos/paginas.test.ts` (las tres páginas de `/finanzas/ingresos`) | el prompt; P0 no había entrado |
| Migraciones | 0001–0039 en Supabase; ninguna nueva en este cierre | `ls db/migrations` |

**Rescate de FIN-5 (F0).** Los cambios sin commitear se guardaron tal
cual en `476e139` («FIN-5: trabajo en curso rescatado para el cierre del
módulo»). Sus pruebas, en ese estado: **48 de 48 en verde**
(`vista.test.ts` 11, `page.test.tsx` 8, `panel.test.tsx` 12,
`actions.test.ts` 17). La rama está en GitHub.

### 0.2 Cada historia contra su «terminado cuando» (backlog §5)

| Historia | Terminado cuando | Al empezar | Al cerrar |
|---|---|---|---|
| FIN-1 Facturas | Una factura desde una campaña trae nombre, empresa y monto solos | main y producción | igual, más los defaults de FIN-8 y la ruta nueva del archivo |
| FIN-2 Pagos | Un pago parcial deja `partial`; el total pasa a `paid` y aparta el impuesto | main | igual, más la costura con FIN-3 |
| FIN-3 Cobro | Con el seed coincide con el mock; la vencida en rojo con sus días | rama, sin fusionar | main |
| FIN-4 Recordatorios | Una vencida hace 41 días tiene sus tres recordatorios con `reminders_sent = 3` | main; el job no corre en producción (WRK) | igual; el correo lleva los datos de pago de FIN-8 |
| FIN-5 Gastos | Un gasto recurrente aparece proyectado en las ocho semanas siguientes | local, sin commitear, sin permisos ni `audit()` | main, con permisos, `audit()` y la regla del flujo |
| FIN-6 Flujo | El gráfico sale de la función con el seed; un test cubre una semana | main | igual, más la prueba de ocho semanas con FIN-2, FIN-5 y FIN-7 |
| FIN-7 Ingresos | Un CSV de AdSense aparece en su mes | main y producción | igual; las páginas pasan de error a 404 |
| FIN-8 Configuración | Cambiar el porcentaje afecta los pagos siguientes, no los anteriores | ramas, sin fusionar | main |

### 0.3 El plan que se siguió

F1 integrar en el orden del prompt (FIN-integracion, los tres commits de
FIN-3, FIN-5) con `pnpm verificar` verde después de cada merge → F2 una
prueba por costura → F3 deuda y esta tabla → F4 verificación completa y
dev con Contadora y Mánager → F5 push a `main` y despliegue.

---

## 1. Integración: los merges y sus conflictos

| Merge | Conflictos | Cómo se resolvieron |
|---|---|---|
| `nicolas/FIN-integracion` (`1e7d761`) | `finanzas/page.tsx` y `loading.tsx` (borrados en la rama; tocados en main por FIN-4, FIN-6, FIN-7 y ACC-5), `_lib/messages.ts`, `facturas/actions.ts`, `queries/finanzas.ts`, `test/finanzas.test.ts`, `content/backlog.ts`, `apps/web/README.md` | Se aceptó la mudanza de FIN-3 y se portó encima lo de main: la puerta de ACC-5 y la bandeja de FIN-4 pasan a `(inicio)/page.tsx`. La sección de flujo de caja de la rama era una copia vieja de la de main (sin FIN-7) y se quitó. `DEFAULT_TAX_RATE` y `DEFAULT_WITHHOLDING_RATE` salen de las consultas: los defaults son los de `settings.finanzas` |
| `nicolas/FIN-3-cuentas-por-cobrar` (`c5c5932`) | `(inicio)/page.tsx`, `facturas/(lista)/page.tsx`, `content/backlog.ts` | La rama abría con `requirePermission("finanzas.factura.ver")` (lanza, error.tsx); main ya tiene `requireModuleAccess("finanzas")`, que pide ESE permiso y da 404. Se quedó el de main y `permiso.test.tsx` espera el 404 |
| `nicolas/FIN-5-gastos` (`d9f6ff3`) | `core/flujo-caja.ts` y su prueba (add/add), `queries/finanzas.ts`, `test/finanzas.test.ts`, `finanzas/page.tsx`, `lib/format.ts`, `core/index.ts`, READMEs, `backlog.ts` | Se quedó el `flujo-caja.ts` de main y encima `proyectarGastos` (§2). Las listas cerradas de FIN-5 se mudaron a `core/src/gastos.ts`; su proyector y `listRecurringExpenses` desaparecieron. `formatMonth` estaba dos veces: queda la de main |

Encima de los merges, para que el módulo quedara coherente:

- **Pestañas con permiso.** `_componentes/pestanas.tsx`: Cobro y Facturas
  (`finanzas.factura.ver`), Gastos (`finanzas.gasto.ver`), Flujo e
  Ingresos (`finanzas.flujo.ver`), Configuración
  (`finanzas.ajustes.configurar`). Quien no tiene el permiso no ve la
  pestaña, y una prueba comprueba que el permiso de cada pestaña es el
  que pide su página.
- **ACC-5 en todas las páginas.** Las tres de `/finanzas/ingresos`
  usaban `requirePermission` y caían en `error.tsx`; configuración
  explicaba en vez de dar 404. Ahora todas abren con
  `requireModuleAccess` + `requirePagePermission`. Esto arregla el rojo
  de `paginas.test.ts` que iba a arreglar P0.
- **`/finanzas/facturas/nueva` pide `finanzas.factura.crear`**, y el
  botón «Nueva factura» solo lo ve quien lo tiene.
- **Deuda de FIN-5 y FIN-8:** los `TODO(ACC-1)` y `TODO(ACC-2)` están
  resueltos (`requirePermission`, `audit()` dentro de cada consulta que
  escribe; acciones nuevas `expense.created`, `expense.updated` y
  `workspace.settings_updated`). La bitácora de la configuración guarda
  la cuenta bancaria enmascarada (`••••8901`) y sin el correo.
- Un error no previsto al guardar un gasto ya no se le enseña crudo al
  usuario: se registra y se dice una frase.

---

## 2. Las costuras, cada una con su prueba

| Contrato | Qué se garantiza | Prueba |
|---|---|---|
| FIN-5 ↔ FIN-6 (una sola regla) | La vista de gastos y `/finanzas/flujo` dan la misma cifra cada semana: las dos llaman a `proyectarGastos` con `getCashflowInputs` | `core/test/flujo-caja.test.ts` › «una sola regla…»; `db/test/finanzas.test.ts` › «gastos · recurrentes y proyección»; `gastos/page.test.tsx` › «una sola regla con el flujo de caja» |
| FIN-5 + FIN-2 + FIN-7 → FIN-6 | Con el seed 0003, un abono de 1 M a FV-2026-010, un gasto recurrente nuevo de 520 000 y tres meses de AdSense de 300 000: las ocho semanas cifra por cifra (cobros, otros ingresos 69 230,77, gastos 973 846,15, impuestos, neto, acumulado; proyectado −739 923,04) | `db/test/finanzas-costuras.test.ts` › «costura FIN-5 + FIN-2 + FIN-7 → FIN-6» |
| FIN-3 ↔ FIN-2 | Pagar la vencida la saca de «vencida» y del cobro; un abono la deja en su tramo y en `partial`; `receivables` nunca se desfasa de `invoice` | `finanzas-costuras.test.ts` › «costura FIN-3 ↔ FIN-2» |
| FIN-8 → FIN-1 | Una factura nueva (a mano y desde la campaña) nace con el IVA, la retención y el plazo configurados; las viejas no se tocan | `finanzas-costuras.test.ts` › «costura FIN-8 → FIN-1» |
| FIN-8 → FIN-2 | El apartado usa la tasa del momento del cobro y la guarda | `finanzas.test.ts` › «cambiar el porcentaje cambia la reserva de los pagos SIGUIENTES, no la de los anteriores» (de FIN-8) |
| FIN-8 → FIN-4 | El recordatorio lleva titular, NIT, banco, cuenta y enlace configurados; sin banco, cuenta ni enlace, la frase que dice dónde configurarlos | `core/test/recordatorios.test.ts` › «costura FIN-8 → FIN-4» (dos); `worker/test/recordatorios.test.ts` › «costura FIN-8 → FIN-4» (dos workspaces, sin cruzarse, sin banco en metadata ni log) |
| CAM-1 → FIN-1 | «Facturar» lleva al detalle `/finanzas/facturas/<id>`, o a `/finanzas/facturas/nueva?campana=<id>` con el porqué | `facturas/actions.test.ts` |
| URLs guardadas | `notification.action_url` de FIN-2 y FIN-4 apunta a `/finanzas/facturas/<id>`, que existe; `/finanzas?estado=…` (el archivo de antes de FIN-3) redirige a `/finanzas/facturas?estado=…`. `/finanzas/<id>` no existió nunca | `rutas.test.ts`; `(inicio)/cobros.test.tsx` › «los enlaces viejos…» |
| COT → FIN-8 | Hoy son dos IVA: guardar Finanzas no llega a Cotizar ni borra `settings.taxRate` | `finanzas-costuras.test.ts` › «costura COT → FIN-8» (falla a propósito el día que se unifiquen) |
| ACC → FIN | Mánager y Editor: 404 en las 11 funciones de página y `SinPermisoError` en las 9 acciones, antes de leer o escribir; un rol con solo `finanzas.factura.ver` ve dos pestañas y da 404 en el resto | `finanzas/permisos.test.tsx` (58) |

### 2.1 COT → FIN-8: qué ve el usuario si los dos IVA difieren

| Lo que hace el creador | Factura nueva | Cotización nueva | Qué se le dice |
|---|---|---|---|
| Nada (seed, Colombia) | 19 % (`settings.finanzas.iva_pct`) | 19 % (respaldo por país de `getDefaultTaxRate`) | nada: coinciden |
| Cambia el IVA en `/finanzas/configuracion` a 16 % | 16 % | sigue en 19 % (o en su `settings.taxRate`) | la ayuda del campo IVA: «Se usa en las facturas; las cotizaciones todavía llevan el suyo» |
| Tiene `settings.taxRate` de Cotizar y nunca abrió Finanzas | el de `settings.finanzas` o 19 % | su `taxRate` | nada: la pantalla de Finanzas enseña el suyo |

**Propuesta a Rasheed** (la de FIN-8 §2.1, sin cambios): que
`getDefaultTaxRate()` lea `settings.finanzas.iva_pct` con `pctToRate` y
deje `settings->>'taxRate'` como respaldo. Son ~4 líneas en
`queries/cotizar/cotizacion.ts` y la prueba de COT → FIN-8 de aquí se
invierte. La alternativa es que FIN-8 escriba las dos llaves en el
mismo `UPDATE`.

---

## 3. Decisiones pendientes de Nicolás

Todas las «DECISIÓN PENDIENTE DE NICOLÁS» de `docs/propuestas/FIN-*.md`,
más las dos que tomó este cierre. En el código se quedó la opción
conservadora; no cambié ninguna.

| # | Dónde | La pregunta | Lo que quedó en el código | Recomiendo | Si dices lo contrario |
|---|---|---|---|---|---|
| 1 | `FIN-2.md:126` | ¿Qué hace un pago si el espacio no tiene `reserva_pct`? | Se registra, no se aparta nada y la pantalla lo dice (`queries/finanzas.ts:1298`, `reserveRateFrom`) | Dejarlo | Bloquear el pago: `recordPayment` lanza sin tasa, la acción y `messages.ts` dan la frase; ~30 líneas y 2 pruebas |
| 2 | `FIN-3.md:150` | ¿Los KPI de un espacio sin facturas viajan como `null` o como `'0'`? | `'0'`, y la pantalla lo dice con una frase (`queries/finanzas.ts:464`) | Dejarlo: «no te deben nada» es un cero de verdad | `getReceivablesKpis`, su tipo, `(inicio)/page.tsx` y 3 pruebas; ~40 líneas |
| 3 | `FIN-4.md:60` | ¿Una corrida emite todos los pasos pendientes o solo el último? | Todos, y `reminders_sent` = cuántos hay (`worker/…/recordatorios.ts:189` y `:153`) | Dejarlo hasta el SMTP (CIM-10); ahí, solo el último | `pendientes.slice(-1)`; 1 línea y 3 pruebas del worker |
| 4 | `FIN-5.md:52` | ¿La categoría `otros` existe? | Sí (`core/src/gastos.ts:38`) | Dejarla | Quitar `'otros'` de la tupla; 1 línea y 1 prueba |
| 5 | `FIN-5.md:57` | ¿Permiso `finanzas.gasto.crear` (enunciado) o `finanzas.gasto.registrar` (catálogo)? | `registrar`, para crear y corregir (`gastos/actions.ts:60`) | Dejarlo | Clave nueva: migración con la semilla del catálogo (no se puede tocar 0034), `permisos.ts`, 3 archivos |
| 6 | `FIN-6.md:102` (§0.2.4) | ¿El cobro esperado es el bruto de la factura o el neto de retención? | Bruto: `total − paid_amount` (`queries/finanzas.ts:1514`) | Dejarlo: cuadra con la factura, el cobro y el mock | `total − withholding − paid_amount` en esa línea; 1 línea y 2 pruebas del seed |
| 7 | `FIN-7.md:123` | ¿AdSense se guarda como `youtube` o como plataforma aparte? | `youtube` (`ingresos/_lib/csv.ts:65`) | Dejarlo | Migración de catálogo (`platform`) y el mapa de `csv.ts`; decisión de producto |
| 8 | `FIN-7.md:187` (§0.5.8, §0.8.3) | ¿El estimado de plataformas entra en la base de la reserva de impuestos? | No (`core/src/flujo-caja.ts:519`) | Dejarlo: sería apartar sobre una cifra estimada | Sumar `otrosIngresosSemanal` a la base de `impuestos`; 1 línea y ~4 pruebas |
| 9 | `FIN-7.md:200` (§0.5.9, §0.8.4) | ¿Se crean `finanzas.ingreso.*` o se quedan `flujo.ver` / `pago.registrar`? | Reutilizados (`ingresos/actions.ts:89`, `pestanas.tsx`) | Dejarlo hasta ACC-4 | Migración de catálogo + `permisos.ts` + 5 archivos de ingresos + pestañas |
| 10 | `FIN-7.md:258` (§0.8.2 y §0.8.5) | ¿Ventana de 3 o 6 meses? ¿El mes en curso se rechaza? | 3 meses (`ingresos-plataformas.ts:40`); el mes en curso se rechaza | Dejarlo | 6 meses: 1 constante y 3 pruebas. Mes en curso parcial: nuevo estado en la lista, ~60 líneas |
| 11 | `FIN-8.md:104` | ¿Permiso `finanzas.ajustes.configurar` o `finanzas.configuracion.editar`? | `ajustes.configurar`, el del catálogo (`configuracion/actions.ts:91`) | Dejarlo | Migración de catálogo; 3 archivos |
| 12 | este cierre, §1 | Una serie recurrente que aparece por primera vez en el mes en curso, ¿entra ya al ritmo o espera a que cierre el mes (como FIN-6 antes)? | Entra ya (`core/src/flujo-caja.ts`, `proyectarGastos`), si la consulta trae la serie | Dejarlo: es lo que hace cierto «un gasto recurrente aparece proyectado» | Quitar el bloque `entra()` de las series nuevas; ~15 líneas y 3 pruebas |
| 13 | este cierre, §1 | `/finanzas/configuracion` sin permiso: ¿404 o explicación? | 404, como el resto (ACC-5) | Dejarlo | Volver a la explicación de FIN-8 (el texto está en su historial); rompe la regla de `paginas.test.ts` |

---

## 4. Lo que necesita Rasheed

| Qué | Por qué | Tamaño |
|---|---|---|
| Unificar el IVA de Cotizar con el de Finanzas (§2.1) | Hoy un creador cambia su IVA y sus cotizaciones no se enteran; la pantalla lo avisa, pero son dos fuentes | ~4 líneas en `queries/cotizar/cotizacion.ts` |
| El worker en producción (WRK: esquema `pgboss`, `GRANT mc_worker TO mc_migrator`, hosting) | Sin él, `finance.reminders` no corre y la bandeja de `/finanzas` queda vacía en producción | lo cierra el prompt WRK |
| Un Contador en el seed (propuesto ya en ACC-5) | Para ver Finanzas con el rol `finance` en dev sin un archivo temporal, como se hizo aquí | 1 `INSERT` en el seed |

---

## 5. Fuera de alcance, con su historia

| Qué | Por qué no | Historia |
|---|---|---|
| Envío de correo (SMTP) de los recordatorios | Fuera por el prompt | CIM-10 |
| Unificar el IVA con Cotizar | `cotizar/` es de Rasheed | §2.1, Rasheed |
| Permisos nuevos (`finanzas.ingreso.*`, `finanzas.gasto.crear`) | Exigen tocar la semilla de 0034 | ACC-4 / decisión 5 y 9 |
| «Redactar ahora» para la bandeja de recordatorios | El job es del worker; hasta WRK la bandeja dice que se redacta cada día | WRK |
| Una redirección 307 de verdad para `/finanzas?estado=` | `loading.tsx` hace que Next redirija en el cliente (meta refresh + `NEXT_REDIRECT`); funciona, pero no es un 307. Un 307 real va en `middleware.ts` o `next.config.ts` | marco, si hace falta |
| Recibo de gasto como archivo | FIN-5 guarda un enlace | fase 2 |

---

## 6. Verificación

_(se completa al final: §6.1 conteos, §6.2 dev, §6.3 revisión)_

## 7. Producción y guion de humo

_(se completa después del despliegue)_
