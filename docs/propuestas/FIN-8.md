# FIN-8 · Configuración financiera — plan y lo que necesita Rasheed

Escrito para: Nicolás (dueño de Finanzas) y Rasheed (dueño de
`db/migrations/`, `lib/workspace/`, `packages/db/src/{client,schema}` y
de Cotizar).
Fecha: 23 de septiembre de 2026. Rama
`nicolas/FIN-8-configuracion-financiera`, sobre `origin/main` (29460e3).

---

## 0 · Plan

### 0.1 Lo que encontré antes de escribir una línea

Cinco hechos que cambian el plan respecto de lo que dice el encargo:

1. **`settings.finanzas` lo escribe el seed y no lo lee NADIE.** Los
   seeds 0002 y 0003 dejan
   `{"finanzas": {"iva_pct": 19, "retencion_pct": 11, "reserva_pct": 11, "plazo_dias": 30}}`,
   pero FIN-1 no lo toca: `queries/finanzas.ts` y
   `facturas/nueva/form.tsx` usan las constantes `DEFAULT_TAX_RATE`
   (`'0.19'`) y `DEFAULT_WITHHOLDING_RATE` (`'0.11'`) de
   `packages/core/src/facturacion.ts`. Es decir: la configuración existe
   como dato y no como comportamiento. FIN-8 es lo que las une.

2. **Ya hay OTRA llave de impuesto en `settings`, y es de Cotizar.**
   `packages/db/src/queries/cotizar/cotizacion.ts:466` lee
   `settings->>'taxRate'` (camelCase, en la RAÍZ de `settings`, como
   fracción `'0.19'`), con respaldo al IVA general si el país es `CO` y
   `'0'` si no. Son dos fuentes de verdad para el mismo número. Ver
   §2.1: no lo toco en esta historia, pero hay que decidirlo.

3. **La política y los privilegios SÍ alcanzan.** `workspace_update`
   (0024 §2) es `FOR UPDATE USING (id = current_workspace_id()) WITH
   CHECK (id = current_workspace_id())`, y 0024 §7.6 deja a `mc_app`
   con `GRANT UPDATE (name, slug, country, currency, timezone, locale,
   niche_slugs, settings, updated_at) ON workspace`. **`settings` y
   `currency` están las dos en la lista.** No hace falta migración
   ninguna, ni un SQL para Rasheed. (`plan`, `kind` y `deleted_at` NO
   están, a propósito, y esta pantalla no los toca.)

4. **El permiso del encargo no existe con ese nombre.** El encargo dice
   `finanzas.configuracion.editar`; el catálogo de ACC-1
   (`packages/core/src/permisos.ts`, rama `nicolas/ACC-1-catalogo-permisos`,
   todavía FUERA de `main`) lo llama **`finanzas.ajustes.configurar`**.
   Ver §0.3, decisión D.

5. **FIN-2 no existe.** Nadie escribe `tax_reserve` salvo el seed 0003.
   El criterio «cambiar el porcentaje cambia la reserva de los pagos
   siguientes, no de los anteriores» se prueba aquí sobre el contrato
   que FIN-2 va a consumir, no sobre `registrarPago()`. Ver §0.4.

### 0.2 Archivos

| Archivo | Qué | Dueño |
|---|---|---|
| `packages/core/src/facturacion.ts` | `FinanceSettings`, `FINANCE_SETTINGS_DEFAULTS`, `parseFinanceSettings()`, `financeSettingsToJson()` | Nicolás (mío) |
| `packages/core/test/facturacion.test.ts` | parse con defaults, tolerancia a basura, ida y vuelta | Nicolás |
| `packages/db/src/queries/finanzas.ts` | `getFinanceSettings()`, `updateFinanceSettings()` | Nicolás |
| `packages/db/test/finanzas.test.ts` | merge que no borra otras llaves, bitácora, RLS negativa, reserva por fila | Nicolás |
| `apps/web/app/(app)/finanzas/configuracion/{page,form,actions,error,loading}.tsx` | La pantalla | Nicolás |
| `apps/web/app/(app)/finanzas/_lib/messages.ts` | Textos del bloque `configuracion` | Nicolás |
| `apps/web/app/(app)/finanzas/_lib/permiso.ts` | La compuerta de rol, provisional hasta ACC-1 | Nicolás |
| `apps/web/app/(app)/finanzas/page.tsx`, `facturas/nueva/{page,form}.tsx` | Enlace a la pantalla; los defaults del formulario salen de aquí | Nicolás |
| `apps/web/content/backlog.ts` | Estado y nota de FIN-8 | Nicolás (solo mi fila) |

**Ninguna migración.** Ningún archivo de `db/migrations/`, `db/seed/0001`,
`lib/auth/`, `lib/workspace/`, `packages/db/src/{client,schema}`.

### 0.3 Decisiones, con lo descartado

**A · Las llaves del jsonb se quedan en español y snake_case.**
El bloque queda
`settings.finanzas = { v, iva_pct, retencion_pct, reserva_pct, plazo_dias, razon_social, identificacion, direccion, regimen, correo_facturacion, banco, cuenta, enlace_pago }`.
Descartado renombrarlas a inglés (que es la regla del repo para
identificadores): las cuatro primeras ya están escritas en los seeds
0002 y 0003 y en dos filas de `workspace` de la Supabase real, y
renombrarlas es una migración de datos para ganar coherencia de estilo
en llaves que no son identificadores de código ni columnas. Las nuevas
siguen el estilo de las que ya están, que es peor que empezar en inglés
y mejor que mezclar los dos en el mismo objeto.

**B · Los porcentajes se guardan como STRING decimal, no como número
JSON.** El seed los dejó como números (`19`). `parseFinanceSettings`
acepta las dos formas —el seed sigue leyéndose— pero
`financeSettingsToJson` escribe `"19"`. Motivo: `19.99` no es exacto en
IEEE-754 y la regla del repo es que nada que multiplique dinero pase por
`number`. En SQL no cambia nada: `settings->'finanzas'->>'iva_pct'`
devuelve `"19"` en los dos casos, así que ningún lector existente se
entera. Descartado guardar directamente la fracción (`0.19`): el
formulario, la factura y `tax_reserve.rate` ya conviven con las dos
unidades y `pctToRate`/`rateToPct` de core son la única conversión.

**C · `v: 1` es el número del BLOQUE, y `parseFinanceSettings` nunca
lanza.** Un bloque sin `v` (los seeds) se lee como v1. Un bloque con
`v` mayor se lee igual, con defaults para lo que no entienda, y no
rompe la pantalla: negarse a pintar `/finanzas` porque alguien guardó
un campo del futuro sería peor que ignorarlo. La validación ESTRICTA
(rangos, topes, mensajes por campo) está en el zod de la Server Action,
que es el único camino que escribe. Es la misma división que ya usan
Ventas y Cotizar: lenient al leer, estricto al escribir.

**D · El permiso se llama `finanzas.ajustes.configurar`, no
`finanzas.configuracion.editar`. «DECISIÓN PENDIENTE DE NICOLÁS».**
El catálogo de ACC-1 ya lo tiene escrito así
(`permisos.ts:113`), el rol `finance` («Contador») lo trae por
`permisosDelModulo('finanzas')` y el rol `manager` («Mánager») NO
—solo lleva `finanzas.cobro.ver`—, que es exactamente lo que pide el
criterio de terminado. Escribir aquí una llave que el catálogo no
conoce sería un error de tipos el día que ACC-1 entre a `main`. Tomé la
opción conservadora: usar la llave que ya existe. Si prefieres el otro
nombre, se cambia en ACC-1 y aquí es una línea.

**E · ACC-1 y ACC-2 no están en `main`, así que la compuerta es
provisional y está marcada.** La regla del repo dice `// TODO(ACC-1)`
cuando `requirePermission` no existe todavía. Pero «el Mánager no puede
abrir la pantalla» es un criterio de TERMINADO de esta historia, y un
comentario no se puede probar. Solución: `finanzas/_lib/permiso.ts`, 30
líneas, con el mismo patrón que `lib/auth/reglas.ts` ya usa para
`PUEDEN_RENOMBRAR` —un `ReadonlySet<MembershipRole>`—, más el `TODO(ACC-1)`
encima diciendo qué línea lo reemplaza. Hoy los roles de `membership`
(0001) son `owner · admin · member · viewer · client`: no hay `finance`
ni `manager` hasta ACC-3. El mapeo de hoy es **owner + admin** pueden;
`member` (que es el Mánager de hoy), `viewer` y `client` no. La prueba
usa `member`.
Lo mismo con la bitácora: `updateFinanceSettings` escribe su fila de
`audit_log` con SQL directo en la misma transacción, con
`// TODO(ACC-2): audit(tx, {...})` encima. No toco
`packages/db/src/audit.ts`, que se está escribiendo ahora mismo en la
rama `nicolas/ACC-2-bitacora-obligatoria`: tocarlo desde aquí es un
conflicto seguro. Lo que ACC-2 tiene que agregar: la acción
`workspace.settings_updated` a `AUDIT_ACTIONS` (§2.2).

**F · Cambiar la moneda no convierte nada, y se avisa antes de
guardar.** Es la opción conservadora del encargo, y la pantalla la hace
visible: si hay facturas en otra moneda, el formulario dice cuántas y
qué significa (los KPI de `/finanzas` suman sin convertir, y
`createInvoice` rechaza una factura en una moneda que no sea la del
workspace). Descartado bloquear el cambio —deja a un workspace mal
configurado sin salida— y descartado convertir —es multimoneda, que
está fuera de alcance—.

**G · El `UPDATE` es un merge por llave, no un reemplazo.**
`SET settings = settings || $1::jsonb` con `$1 = {"finanzas": {...}}`.
`||` en `jsonb` es superficial: reemplaza la llave `finanzas` entera y
deja intactas las hermanas, que hoy son `taxRate` (Cotizar) y las que
vengan. Descartado `jsonb_set` (falla si el camino no existe) y
descartado escribir `settings` entero desde JavaScript (una pantalla de
Finanzas borraría lo que guarde Cotizar en la petición de al lado).
El `UPDATE` comprueba que tocó exactamente una fila: cero filas
significa que la política de 0024 no está aplicada en esa base, y
fallar en voz alta es mejor que un «Guardado» que no guardó.

### 0.4 Cómo se prueba «los pagos anteriores no cambian»

`tax_reserve.rate` es `numeric(6,4)` y se guarda POR FILA (0008). El
contrato que FIN-8 le deja a FIN-2 es: la tasa que se estampa en la
fila es `pctToRate(getFinanceSettings(tx).reservaPct)` en el momento del
pago. La prueba de `packages/db/test/finanzas.test.ts` hace el recorrido
completo sin inventar `registrarPago()` (que es de FIN-2):

1. Lee la configuración → `reserva_pct` = 11 (seed).
2. Inserta una fila de `tax_reserve` con esa tasa → `0.1100`.
3. Guarda `reserva_pct` = 15 con `updateFinanceSettings`.
4. Inserta otra fila con la tasa que ahora devuelve la consulta → `0.1500`.
5. Comprueba que la fila del paso 2 **sigue en `0.1100`**.

Y la garantía no es solo de disciplina: 0025 §5 no revoca `UPDATE` sobre
`tax_reserve`, así que lo que la sostiene es que ninguna consulta de
`queries/finanzas.ts` la actualiza nunca. Eso se dice en el JSDoc y es
una nota para ACC/CIM (§2.3).

### 0.5 Orden de trabajo

1. Core + sus pruebas (commit).
2. Consulta + sus pruebas: merge, bitácora, RLS negativa, la reserva por fila (commit).
3. Pantalla + acción + compuerta de permiso + pruebas (commit).
4. Los defaults de «factura nueva» salen de la configuración (commit aparte).
5. README, backlog, esta propuesta (commit).

---

## 1 · Lo que NO necesito de ti

Nada bloqueante. Ni migración, ni SQL, ni cambio en `lib/workspace/`.
`getCurrentWorkspace()` sigue sirviendo para moneda/zona/locale y esta
pantalla no lo duplica: la configuración financiera es otro bloque y
otra consulta.

## 2 · Lo que sí tenemos que decidir entre los dos

### 2.1 `settings.taxRate` (tuyo, Cotizar) vs `settings.finanzas.iva_pct` (mío)

`getDefaultTaxRate()` en `queries/cotizar/cotizacion.ts` lee
`settings->>'taxRate'` como fracción. FIN-8 escribe
`settings.finanzas.iva_pct` como porcentaje. Un creador que ponga su IVA
en `/finanzas/configuracion` va a ver que sus cotizaciones nuevas siguen
saliendo con el respaldo por país, y no va a entender por qué.

No lo cambio en esta historia porque `cotizar/` es tuyo. Mi propuesta,
en orden de preferencia:

1. `getDefaultTaxRate()` pasa a leer `settings.finanzas.iva_pct` (con
   `pctToRate`) y deja `settings->>'taxRate'` como respaldo para las
   filas que ya lo tengan. Son ~4 líneas y una prueba.
2. Si prefieres que la fuente sea `taxRate`, FIN-8 escribe las dos
   llaves en el mismo `UPDATE` y yo leo de ahí.

Lo que no quiero es dejar las dos vivas sin dueño.

### 2.2 Para ACC-2 (rama `nicolas/ACC-2-bitacora-obligatoria`)

`AUDIT_ACTIONS` necesita una acción más:

```ts
// Cimientos / Finanzas (FIN-8)
'workspace.settings_updated',
```

`entity_type` = `'workspace'`, `entity_id` = el id del workspace,
`before`/`after` = el bloque `finanzas` y la moneda, que no llevan
secretos ni PII de terceros (los datos fiscales son del propio
workspace, y son exactamente lo que la factura imprime). Cuando ACC-2
entre a `main`, `updateFinanceSettings` cambia sus 8 líneas de SQL por
una llamada a `audit(tx, …)`.

### 2.3 Para ACC-3 / CIM (cuando toque endurecer)

`tax_reserve` conserva `UPDATE` y `DELETE` para `mc_app`. Lo que hace
que «cambiar el porcentaje no cambie los pagos anteriores» sea cierto
es hoy una convención del código, no un privilegio. Un
`REVOKE UPDATE, DELETE ON tax_reserve FROM mc_app` lo volvería
estructural, igual que hicimos con `account_metric_snapshot` en 0025.
No lo meto aquí porque una migración por una historia talla S que no la
necesita es alcance que no me toca.
