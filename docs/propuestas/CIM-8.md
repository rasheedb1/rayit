# CIM-8 · Seed de finanzas y campañas — mapa de cifras y propuestas

Escrito para: Rasheed (dueño de `0002_demo_ventas_metricas.sql`) y
quien revise el PR de CIM-8. Fecha: 21 de septiembre de 2026.

Archivo: `platform/db/seed/0003_demo_finanzas_campanas.sql`.
Verificación: `platform/db/seed/verify/0003.sql` y `run-0003.mjs`.

---

## 1. Lo que necesito de 0002 (y lo que hice mientras tanto)

El seed 0002 todavía no está en `main`. El prompt de CIM-8 decía
"detente" en ese caso; como la sesión corre sin interlocutor, tomé la
salida que el mismo prompt admite para una empresa o un post que falte:
**crearlos en 0003 con id fijo y un comentario que lo diga**, extendida
al workspace, la creadora y las conexiones. Es la sección 0 del seed,
toda con `ON CONFLICT DO NOTHING`.

Contrato: si 0002 crea estas filas **con estos ids**, la sección 0 es un
no-op y se puede borrar. Si 0002 usa otros ids, hay que cambiar los de
0003 (están en el mapa de cabecera del archivo) y borrar la sección 0.

| Fila | id que usa 0003 | Notas |
|---|---|---|
| `workspace` | `00000002-0000-4000-8000-000000000001` | slug `laura-cocina-facil`, COP, `America/Bogota`. `settings.finanzas` con IVA 19, retención 11, reserva 11, plazo 30 (lo leerá FIN-8). |
| `app_user` | `…-000000000002` | `laura@ejemplo.com` |
| `creator_profile` | `…-000000000003` | Laura Méndez, `@laura.cocinafacil`, nicho `cocina` |
| `social_connection` | `…-0000000000c1` instagram · `…c2` tiktok · `…c3` youtube | `secret_ref` ficticio `vault://demo/...` |
| `company` | `…-0000000000e1` Café Alma · `…e2` Fresko Market · `…e3` Hogar Lindo · `…e4` Nutrivé | Con `domain` (índice único) y `socials` |
| `company_link` | (workspace, company) | client · client · past_client · client |
| `post` | `…-000000000d01` reel IG Café Alma · `d02` TikTok Café Alma · `d03`/`d04` TikTok Fresko · `d05` YouTube Nutrivé | `is_branded_content = true` |
| `post_metric_snapshot` | una lectura por post a 720 h | views 412 K + 300 K = 712 K (Café Alma); 140 K + 125 K = 265 K y 1 100 + 840 = 1 940 clics (Fresko); 58 K (Nutrivé). `source = 'manual'`. |

Dos cosas de 0002 que conviene saber antes de escribirlo:

1. **RLS está en modo `FORCE`** (migración 0010). Incluso `mc_migrator`,
   dueño de las tablas, recibe `new row violates row-level security
   policy` al insertar en cualquier tabla con `workspace_id` si la
   sesión no tiene `app.workspace_id`. El seed 0003 abre con
   `SELECT set_config('app.workspace_id', '<ws>', false);` y 0002
   necesita lo mismo. Lo comprobé en Postgres embebido corriendo las
   migraciones como un rol sin `BYPASSRLS` (`run-0003.mjs`).
2. **`make db.check` no corre los seeds** (`migrate.mjs --pglite` sin
   `--seed`) y cada corrida de PGlite es una base nueva, así que
   "dos veces seguidas" no se puede probar con el Makefile. Por eso
   existe `run-0003.mjs`: migra como no superusuario, corre los tres
   seeds dos veces y compara conteos.

Los deals ganados del mock (Fresko 5,2 M, Nutrivé 4,5 M, Café Alma
3,1 M) son de 0002; no los toco. Solo aviso que la factura de Nutrivé
quedó en **4,7 M y no 4,5 M** porque 4,5 M no se puede descomponer en
subtotal + IVA 19 % con dos decimales exactos (ver §3).

---

## 2. Mapa de cifras: mock → filas → consulta que lo verifica

Todas las consultas están en `verify/0003.sql`, con su letra.

### Finanzas

| Cifra del mock | Filas que la producen | Consulta | Resultado |
|---|---|---|---|
| Por cobrar **COP 9,4 M · 3 facturas** | `invoice` FV-2026-011 (5,2 M), -010 (3,1 M), -007 (1,1 M), `status = 'sent'`, `paid_amount = 0` | (a) `sum(outstanding), count(*) FROM receivables WHERE status <> 'paid'` | 9 400 000,00 · 3 |
| Fresko Market · Campaña 2 TikTok · sep · 5.200.000 · vence en 23 días · **Al día** | FV-2026-011, `due_on = CURRENT_DATE + 23`, `campaign_id` → Fresko | (b2) | `al_dia`, +23 |
| Café Alma · Lanzamiento cold brew · 3.100.000 · **Vence pronto** | FV-2026-010, `due_on = CURRENT_DATE + 7`, `campaign_id` → Café Alma | (b2) | `vence_pronto`, +7 |
| Hogar Lindo · 3 historias · jun · 1.100.000 · **vencida hace 41 días** · 2 recordatorios | FV-2026-007, `due_on = CURRENT_DATE - 41`, `reminders_sent = 2`, `last_reminder_at = now() - 3 días` | (b) | `vencida`, 41, 2 |
| Cobrado en 2026 **COP 38,6 M (+31 % vs 2025)** | 8 `payment` `direction = 'in'` en 2026 (4,7 + 5,5 + 6,2 + 3,7 + 5,9 + 4,1 + 3,8 + 4,7) y 6 en 2025 (29,5 M) | (c), (c2) | 38 600 000 · 29 500 000 · +30,8 % |
| Apartado para impuestos **COP 4,2 M · 11 %** | 14 `tax_reserve` con `rate = 0.1100`; las de 2025 liberadas (`released_at`), las 8 de 2026 no | (d) `sum(amount) WHERE released_at IS NULL` | 4 246 000 (el mock redondea a un decimal: "4,2 M") |
| Gastos e impuestos 1,1–1,7 M/semana | 15 `expense` recurrentes (`is_recurring`, `recurrence = 'monthly'`): edición 1,8 M, equipo 0,9 M, contabilidad 0,4 M, software 0,38 M, servicios 0,22 M = 3,7 M/mes en jul, ago y sep; más 2 puntuales | (i) | 3 700 000/mes ≈ 0,85 M/semana; con el 11 % de los cobros esperados queda en el rango |
| Cobros esperados S38–S45: 3,1 · 0 · 5,2 · 0 · 2,6 · 1,8 · 0 · 5,0 | Solo 3,1 M (+7 días) y 5,2 M (+23 días) salen de facturas | — | **Cede**: 2,6 · 1,8 · 5,0 no existen (ver §3) |

### Campañas

| Cifra del mock | Filas que la producen | Consulta | Resultado |
|---|---|---|---|
| Café Alma · 1 reel + 1 TikTok · 24–31 ago · Reporte listo · 712 K · COP 8,4 M (318 canjes) | `campaign` ca0001 `status = 'reported'`, `tracking_code = 'LAURA15'`, `brand_baseline_from = 2026-08-10`; `campaign_post` d01 (reel, primary) y d02 (tiktok); `campaign_brand_input` 318 canjes y 8 400 000 `brand_manual` | (f), (g) | reported · 712 000 views · 318 · 8 400 000 |
| Fresko Market · 2 TikTok · 2–9 sep · En curso · 265 K · 1 940 clics | `campaign` ca0002 `status = 'measuring'`; `campaign_post` d03, d04; clics desde `post_metric_snapshot` | (g) | measuring · 265 000 · 1 940 |
| Nutrivé · video dedicado · 15–22 jul · Cobrada · 58 K · sin datos de la marca | `campaign` ca0003 `closed`, factura FV-2026-009 pagada, `campaign_result.missing_inputs = {brand_inputs,brand_followers}` | (g) | closed · 58 000 · 1 factura |
| Hogar Lindo · 3 historias · 5–6 jun · Pendiente de pago · 94 K · 1,1 M (42 canjes) | `campaign` ca0004 `reported`, factura FV-2026-007 vencida, `campaign_result.views = 94000`, brand input 42 canjes y 1,1 M | (g) | reported · 1 factura vencida |
| KPIs: alcance 486 K · views 712 K · 58 % no seguidores · 6 240 clics · 318 canjes · 8,4 M · +1 240 seguidores · 12× · CPM 11 800 · CPA 26 400 | `campaign_result` de ca0001 | (f) | todos, y `veces_ritmo = 12,0` |
| Seguidores de @cafealma: 60 días, desde 18 200, ~1 240 en la ventana | 60 `brand_account_snapshot` con `generate_series(0, 59)` y una función determinista (sin `random()`); `UNIQUE (company_id, platform_id, day)` como clave de idempotencia | (e) | 1 240 exactos · 12,93/día antes · 155/día en campaña · 60 días · 18 200 al inicio |

---

## 3. Los casos ambiguos, decididos

1. **Café Alma "vence en 14 días" contra `vence_pronto ≤ 7`.** Puse
   `due_on = CURRENT_DATE + 7`. Lo que la demo enseña es la pastilla
   "Vence pronto" en ámbar, y esa la calcula la vista `receivables`;
   cambiar la vista es una migración de Rasheed y el número de días es un
   detalle que cambia a diario. Lo que cede: "30 sep / 14 días" del mock.
2. **Cobros esperados 2,6 · 1,8 · 5,0 M.** No los creé. Facturas `sent`
   contarían en "Por cobrar 3 facturas" y romperían el KPI; facturas
   `draft` no cuentan en `receivables` pero ensuciarían la lista de
   Finanzas con tres borradores que nadie pidió. FIN-6 (sprint 4) toma
   los cobros esperados de las facturas por `due_on` **y de los deals
   ganados sin factura** (`deal_pipeline`, D7): si 0002 quiere que el
   flujo de caja del mock cuadre, esos tres montos son deals ganados con
   `expected_close_date` en las semanas 5, 6 y 8. Lo que cede: tres
   barras del gráfico de flujo de caja, que hoy no tiene pantalla.
3. **Fechas fijas o relativas.** Facturas abiertas y sus pagos
   pendientes: relativas a `CURRENT_DATE` (−41, +7, +23). Campañas,
   snapshot de @cafealma, facturas pagadas y pagos: fijas. Razón: son
   hechos del pasado que el reporte y el KPI anual citan; y una serie de
   60 días relativa dejaría la ventana 24–31 ago fuera del rango en dos
   meses. Consecuencia conocida: FV-2026-007 (relativa) va numerada
   entre 006 (8 jun) y 008 (20 jul), coherente hoy y hasta noviembre.
4. **Total de la factura.** `total = subtotal + IVA 19 %`. La retención
   en la fuente (11 %, servicios) queda en `withholding` como lo que la
   marca retendrá al pagar; no se resta del total. Es el total que va en
   la factura electrónica, y así `paid_amount = total` marca `paid`
   (FIN-1). Los subtotales están elegidos para que el total dé la cifra
   redonda del mock con redondeo exacto a dos decimales; los montos que
   no admiten esa descomposición (4,5 M, 4,8 M, 4,2 M, 3,9 M) no se
   usaron.
5. **"12× su ritmo normal".** Con 1 240 seguidores en 8 días (155/día)
   el 12× pide una línea base de 12,9/día, así que la ganancia previa va
   de 12 a 14 por día (el prompt pedía "~12–18"): 181 seguidores en los
   14 días de línea base. `brand_followers_baseline_rate = 12.9286`,
   `campaign_rate = 155.0000`. El ritmo posterior sale en 25,8/día, que
   coincide con la nota del mock ("26 por día").
6. **CPM 11 800 y CPA 26 400.** Van tal cual del mock a
   `campaign_result`. No se derivan de `amount / views` (daría 4 354) ni
   de `amount / canjes` (9 748). Está anotado en el seed; CAM-5 los
   recalcula desde los datos.
7. **Cuatro campañas y no dos.** El prompt pedía dos (Café Alma y Fresko
   con posts, snapshot y resultado); la tabla "Campañas" del mock tiene
   cuatro. Nutrivé y Hogar Lindo van sin snapshot de marca y con
   resultado parcial (`missing_inputs`), para que CAM-1 liste lo mismo
   que el mock y las facturas pagada y vencida tengan su campaña.

---

## 4. Idempotencia y conteos

`node db/seed/verify/run-0003.mjs` (Postgres embebido, migraciones como
`mc_migrator_test` sin `BYPASSRLS`, seeds 0001 + 0003 dos veces):

| tabla | pasada 1 | pasada 2 |
|---|---|---|
| app_user | 1 | 1 |
| brand_account_snapshot | 60 | 60 |
| campaign | 4 | 4 |
| campaign_brand_input | 4 | 4 |
| campaign_post | 5 | 5 |
| campaign_result | 3 | 3 |
| company | 4 | 4 |
| company_link | 4 | 4 |
| creator_profile | 1 | 1 |
| expense | 17 | 17 |
| invoice | 17 | 17 |
| membership | 1 | 1 |
| payment | 14 | 14 |
| post | 5 | 5 |
| post_metric_snapshot | 5 | 5 |
| social_connection | 3 | 3 |
| tax_reserve | 14 | 14 |
| workspace | 1 | 1 |

(Las tablas del catálogo —niche, platform, job_definition, etc.— también
quedan iguales; se omiten de la tabla.) `node db/migrate.mjs --pglite
--seed` y `make db.check` pasan.

---

## 5. Contrato con FIN-1

- Numeración: `'FV-' || año || '-' || secuencia` con al menos tres
  dígitos, por workspace y año. La última de 2026 es `FV-2026-011`; la
  primera que cree la app es `FV-2026-012`.
- La factura abierta de Café Alma (`FV-2026-010`) apunta a la campaña
  "Lanzamiento cold brew" (`00000003-0000-4000-8000-000000ca0001`),
  que es la que FIN-1 usa para "crear factura desde campaña".
