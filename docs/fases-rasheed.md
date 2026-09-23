# Plan por fases de Rasheed, y el workflow de agentes

Escrito para: Rasheed, y para los agentes que van a construir cada
pieza (lo leen antes de empezar).

Fecha: 21 de septiembre de 2026. Cubre todo lo pendiente de Rasheed en
[backlog-mvp.md](backlog-mvp.md) **menos Ventas**, que se hará aparte
con otro repositorio como referencia para el outreach.

---

## 1. Qué entra, en qué orden, y por qué así

Lo pendiente de Rasheed sin Ventas son doce historias. Se agrupan en
**cinco piezas**, cada una del tamaño de un módulo, para que cada agente
sea dueño de sus carpetas y no haya dos agentes tocando el mismo
archivo:

| Pieza | Historias | Qué es | Fase |
|---|---|---|---|
| **db** | CIM-1, CIM-2 | `packages/db`: Drizzle, cliente con RLS por transacción, esqueleto del worker, prueba de aislamiento | 1 |
| **seed** | CIM-6 | Datos de demostración de ventas y métricas, deterministas e idempotentes | 1 |
| **auth** | CIM-3 | Supabase Auth con enlace mágico, sincronización de usuario, workspaces y su selector | 2 |
| **resumen** | RES-1, RES-2 | La pantalla Resumen sobre datos reales, y la importación por CSV | 2 |
| **cotizar** | COT-1, COT-2, COT-3, COT-4 | Tarifario, media kit público, cotización con página pública y aceptación | 2 |

Fuera del workflow, porque no son código o dependen de Nicolás:

| Historia | Por qué queda fuera | Quién y cuándo |
|---|---|---|
| CON-9 trámites | Formularios en TikTok, Meta y Google con las cuentas de empresa | Rasheed, día 1 |
| CIM-7 despliegue continuo | Conectar GitHub al proyecto de Vercel es un clic en el panel; el worker se despliega cuando exista (CON-2) | Rasheed, semana 1 |
| RES-3, RES-4 | Leen notificaciones y demografía que produce la cadena de Nicolás (CON-6, CON-7, FIN-4) | Fase 3, cuando exista |
| COT-4, el último paso | Llama a `createCampaignFromQuote()`, que escribe Nicolás (CAM-2) | Se conecta cuando CAM-2 esté en `main` |

**Fase 1 va antes que la 2** porque todo lo demás necesita el cliente
de base (D1). Dentro de cada fase, las piezas corren en paralelo y no
se tocan: db escribe `packages/db` y `apps/worker`; seed escribe
`db/seed`; auth escribe `lib/auth`, `lib/workspace` y `/login`;
resumen escribe `app/(app)/resumen` y `queries/resumen.ts`; cotizar
escribe `app/(app)/cotizar`, `queries/cotizar.ts`, `core/tarifas.ts`,
las páginas públicas y una migración nueva. El único archivo que
comparten es `package.json`, y el integrador lo resuelve.

---

## 2. La puerta de calidad: nadie termina por debajo de 9,5

Cada pieza pasa por el mismo ciclo:

```
construir  →  dos revisores en paralelo  →  ¿mínimo ≥ 9,5?  →  sí: lista
                (técnico · producto)          no: corregir con los findings, y otra vez
```

- **Dos lentes, no una.** El revisor técnico lee el diff, corre los
  cuatro comandos y busca fallos de aislamiento, tipos y pruebas. El
  revisor de producto levanta la aplicación y usa cada flujo como un
  creador que paga: estados vacíos, tema oscuro, 400 píxeles, teclado,
  textos. La nota es el **mínimo** de las dos.
- **La rúbrica es pública** (está en el workflow): funciona (3),
  cumple el «terminado cuando» (2), seguridad de datos (1,5),
  convenciones (1), experiencia (1,5), calidad de código (1). Si un
  comando falla, la nota máxima es 5. Cada punto que se quita lleva un
  finding con lugar y arreglo.
- **Máximo cinco rondas** por pieza. Si a la quinta no llega, se
  entrega igual con su nota y sus findings, señalada en el informe.
  Sin tope, un agente atascado se come el presupuesto sin avisar.
- **Revisión integrada al final:** un revisor recorre el producto
  completo, como usuario nuevo y como la creadora del seed, y da una
  nota del conjunto.

---

## 3. Cómo se aplica «profesional y escalable» en cada pieza

Lo que todos los agentes tienen que respetar (va en su prompt):

- **Aislamiento por fila desde el primer commit.** El workspace lo
  fija el cliente de base en cada transacción; ninguna pantalla lo
  manda. Un usuario sin membresía no obtiene datos.
- **Listo para más países.** Los textos de cada módulo en un solo
  archivo (`messages.ts`), moneda y zona horaria del workspace, fechas
  y montos con `Intl`. Colombia es el valor por defecto, no una
  constante.
- **Nada de aritmética de métricas en React.** Si falta un número
  derivado, se agrega en SQL (vista o consulta tipada).
- **Estados completos.** Vacío con una acción, cargando con esqueleto,
  error con qué hacer. Tema claro y oscuro con los tokens que ya
  existen. Móvil a 400 píxeles sin scroll horizontal. Foco visible.
- **Datos de demostración creíbles**, como el modo de prueba de Stripe
  o el workspace de ejemplo de Linear. Nunca «lorem» ni «test1».

### Referencias externas por pieza

| Pieza | De quién copiamos qué |
|---|---|
| auth | **Vercel** y **Linear**: un solo campo de correo, «Revisa tu correo» con reenviar, nada más en la pantalla. **Notion**: selector de workspace arriba a la izquierda con nombre, inicial y «Crear espacio». |
| resumen | **Vercel Analytics**: una página, periodo arriba a la derecha, comparación con el periodo anterior como pastilla de delta. **Stripe Dashboard**: KPIs con sparkline y «últimos 30 días». **Plausible**: nada que no sea el dato. **Linear Insights**: tooltips con el número exacto. Y las palabras de **TikTok Studio** e **Instagram Insights**, que son el modelo mental del creador. |
| importar CSV | **Flatfile** y **OneSchema**: subir → detectar columnas → mapear con sugerencias → validar fila por fila → previsualizar → resumen de lo importado. |
| cotizar | **Stripe Quotes**: ciclo borrador → enviada → aceptada y página alojada con botón de aceptar. **Stripe hosted invoice**: limpieza de la página pública. El desglose de comisiones de **Stripe** para «cómo se calcula». **Bonsai** y **HoneyBook**: propuestas para freelancers. **Beacons** y **Passionfroot**: media kit en una columna, cifras grandes, tarifas al final. **Notion**: compartir con enlace, contraseña y vencimiento. |
| db | El patrón de Supabase para RLS con `set_config` por transacción; la organización de los starters de Drizzle. |

---

## 4. Lo que tiene que estar antes de lanzar

1. **Árbol limpio y en `main`.** Los worktrees de los agentes nacen del
   commit actual; lo que no esté commiteado no existe para ellos. Hoy
   ya está limpio.
2. **Decisiones tomadas que los agentes asumen:** autenticación con
   Supabase Auth y enlace mágico; la base de Supabase es la base de
   desarrollo (no hay usuarios reales) y los seeds se pueden aplicar
   ahí; las carpetas de Nicolás no se tocan salvo la línea de montaje
   del selector de workspace en `shell.tsx` y la instalación de shadcn
   en `components/ui`, que es código generado.
3. **En el panel de Supabase**, cuando la pieza auth esté lista:
   Site URL, Redirect URLs (para `on-cue-web.vercel.app`, sus vistas
   previas y `localhost`), plantillas y *Confirm email*. La lista exacta
   vive en un solo sitio:
   [`platform/apps/web/README.md#autenticación`](../platform/apps/web/README.md#autenticación).
4. **Las migraciones `0030_public_share.sql` y `0031_mover_negocio.sql`**,
   detrás de `0024`–`0029` y con el rol `mc_public_share` creado antes
   con `supabase-admin.sh`. 0030 crea las funciones `SECURITY DEFINER`
   de las páginas públicas de Cotizar; 0031, `deal_move_stage`, que
   usan Ventas, Cotizar y la aceptación pública, y va la última porque
   reescribe `public_quote_accept_impl` de 0030. Las aplica Rasheed con
   `make db.migrate` después de revisarlas, y `make db.guardia` en
   verde antes de desplegar; el orden exacto está en la nota de CIM-2
   de `platform/apps/web/content/backlog.ts`. Los agentes solo las
   verifican en Postgres embebido.

## 5. Lo que queda para Rasheed después del workflow

1. Revisar `rasheed/integracion`, mergear a `main`.
2. **Vercel en modo monorepo.** Cuando `apps/web` dependa de
   `packages/db`, el despliegue actual (que sube solo `apps/web`) deja
   de servir. Hay que fijar el directorio raíz del proyecto en
   `apps/web` y desplegar desde `platform/`: un cambio en
   `scripts/vercel.sh` y un `PATCH` al proyecto con el token del
   vault. Lo hago yo con un comando cuando toque.
3. Aplicar `0024`–`0032` con `make db.migrate` (la cola única está en
   la nota de CIM-2), `make db.guardia` en verde, configurar Supabase Auth
   ([`apps/web/README.md#autenticación`](../platform/apps/web/README.md#autenticación))
   y `make vercel.deploy PROD=1`.
4. Iniciar los trámites (CON-9) y conectar GitHub a Vercel (CIM-7).

---

## 6. El workflow

Está en `.claude/workflows/rasheed-fase-1.js`. Se lanza desde la raíz
del repositorio diciéndole a Claude «corre el workflow
rasheed-fase-1». Acepta tres argumentos opcionales:

| Argumento | Por defecto | Qué hace |
|---|---|---|
| `umbral` | 9,5 | Nota mínima para aprobar una pieza |
| `maxRondas` | 5 | Rondas de corrección por pieza antes de entregarla señalada |
| `fases` | `[1, 2]` | Qué fases correr; `[1]` para solo cimientos |

Qué hace, paso a paso:

1. **Preparación.** Comprueba que el árbol está limpio y en `main`,
   crea o actualiza la rama `rasheed/integracion`, y corre los cuatro
   comandos de CI para partir de verde.
2. **Fase 1.** Dos constructores en paralelo, cada uno en su worktree y
   su rama. Cada uno pasa por la puerta de calidad.
3. **Integración 1.** Un agente mergea las ramas en
   `rasheed/integracion`, resuelve `package.json` y el lockfile, corre
   el CI.
4. **Fase 2.** Tres constructores en paralelo sobre la integración 1.
   Puerta de calidad para cada uno.
5. **Integración 2 y revisión integrada.** Merge, CI, y un revisor
   final recorre el producto completo.

Nunca hace push, nunca toca `main`, nunca despliega. Todo queda en
`rasheed/integracion` para que una persona lo revise.

**Cuántos agentes.** Cinco constructores, dos revisores por ronda, un
corrector por ronda extra, dos integradores y un revisor final. Con
dos rondas por pieza son unos treinta agentes; el peor caso, con cinco
rondas en todas, son unos ochenta. Solo los constructores y los
correctores escriben código; los revisores no modifican nada.

**Cuánto tarda.** La fase 1 la marca la pieza db; la fase 2, la pieza
cotizar. Cada ronda de revisión suma el tiempo de levantar la app y
recorrerla. Es un trabajo de horas, no de minutos, y se puede seguir
con `/workflows`.

---

## 7. Ventas: el outreach automático

Ventas se planifica aparte, en [ventas-outreach.md](ventas-outreach.md),
a partir del análisis del repositorio `CadenceV1.0`. En resumen:

- Se reutiliza su infraestructura buena (la cola con reclamo atómico,
  los límites atómicos por acción, el cliente de Unipile, el envío por
  Gmail, la guardia de placeholders, el detector de baja, la QA en dos
  niveles con rúbrica por paso) y se descarta el resto: el monolito,
  el contenido de pagos, la prospección B2B, la aprobación por
  WhatsApp y la capa de agentes.
- Se construye lo que allá no existe: aislamiento por workspace,
  entregabilidad y baja, Instagram como canal opcional, el perfil
  comercial del creador con afirmaciones verificables, la bandeja de
  aprobación y la bandeja unificada, y la clasificación de la
  respuesta.
- Son ocho historias nuevas (VEN-9 a VEN-16) en cuatro fases con
  diez piezas para agentes. Van después de los cimientos y en
  paralelo con Cotizar. Ventas completo son 48 a 55 días de una
  persona: es el módulo más grande del producto.

Cuando Rasheed confirme el alcance y las cinco decisiones del
documento, las piezas entran al catálogo del workflow como fases 3 a
6, con los mismos revisores y el mismo umbral.

## 8. Resumen (RES-1, RES-2): las decisiones que importan

El detalle ronda a ronda está en los commits de la rama; aquí queda lo
que hace falta saber para tocar el módulo sin romperlo.

**La pantalla (RES-1).**

- Toda la aritmética está en SQL (`packages/db/src/queries/resumen.ts`):
  los cuatro KPIs, el periodo anterior, la **variación relativa** y las
  sparklines de doce ventanas deslizantes (la primera ES el periodo
  anterior, así que la línea y el delta no se contradicen). React solo
  formatea.
- El **reloj del módulo** es el último día cerrado con lecturas, no
  `now()`, y mira las dos fuentes: la serie de cuenta y las lecturas de
  contenido (una lectura tomada el día D, en UTC, cubre hasta D-1). El
  aviso de frescura usa la misma regla y devuelve días, no instantes,
  para que ninguna fecha de la página se corra por la zona horaria.
- Pero las **sumas de la cuenta** (visualizaciones, seguidores, sus dos
  gráficos) terminan en el último día que cerró la serie de cuenta *de
  las conexiones del filtro*, no en el reloj: una lectura de contenido
  de madrugada adelantaba el reloj y la ventana perdía un día (una caída
  falsa de ~14 % con 7 días). Cuando va por detrás, la tarjeta lo dice.
- La **comparación es entre las mismas cuentas**: la cifra suma todas,
  pero el periodo anterior, la variación y la sparkline salen solo de
  las que ya se medían al empezar el tramo comparado. Conectar un canal
  de 300 000 seguidores no es crecer un 79 %; la tarjeta dice cuántas
  cuentas nuevas quedan fuera.
- Los días son **días cerrados en UTC**, por convención del repositorio:
  `account_metric_snapshot.day` es el día de la plataforma y no se puede
  pasar a otra zona. La pantalla lo dice **una sola vez**, en el aviso de
  frescura y con palabras de creador («Las cifras llegan hasta el final
  del día anterior»), no junto a cada fecha.
- Las tarjetas llevan **solo el dato**: cifra, delta y sparkline. Lo que
  explica de dónde sale (la base de videos, las cuentas nuevas, hasta
  qué día suma la cuenta) va detrás de un botón (i) por tarjeta
  (`resumen/kpi-con-info.tsx`, que envuelve al Kpi del kit sin cambiar
  su API). En la tarjeta solo queda, si hace falta, una línea que dice
  por qué no hay flecha.
- Los dos KPIs de contenido no se comparan con **menos de 3 videos**
  (`MIN_SAMPLE`) en alguno de los dos periodos: la tarjeta dice «Pocos
  videos para comparar» en vez de una flecha roja sobre un video.
- El alcance en no seguidores ya es un porcentaje: su variación va en
  **puntos** («+2,1 puntos»), no relativa. Los guardados por mil siguen
  en variación relativa.
- Una ventana que la historia no cubre sale **NULL, no cero**. Un
  workspace sin conexiones ve el estado vacío; uno conectado sin
  lecturas, el que ofrece importar. Lo prueba `resumen/page.test.tsx`.
- Las razones (alcance en no seguidores, guardados por mil) se calculan
  solo sobre los videos que traen sus dos términos y con la última
  lectura de cada video: `post_metrics_at_cut` no trae alcance en no
  seguidores y un video importado tiene una sola lectura.
- Las barras son **12 semanas de siete días, como el mock** (RES-5,
  cerrada en el pulido): `getViewsByWeek` no recibe el periodo, y la
  tarjeta dice en una línea que no es la suma del periodo elegido. Son
  semanas contadas hacia atrás desde el último día cerrado, no semanas
  ISO: con la ISO cerrada el gráfico dejaría fuera hasta seis días que
  la tarjeta sí cuenta, y con la ISO en curso la última barra saldría a
  medias. La última semana termina el mismo día que las cifras de la
  cuenta y su barra ES la tarjeta de 7 días. Cada semana lleva su rango
  («15–21/9») en el tooltip y en la tabla, con el guion unido a sus
  lados, y bajo la barra solo el día final (`axisLabels`). La etiqueta
  que la rejilla del kit pintaría pegada a la última se deja vacía
  (`resumen/_lib/eje.ts`, probado contra el BarChart de verdad): no
  hacía falta cambiar el kit otra vez. `axisLabels` y `Kpi.deltaText`
  **sí son un cambio de API del kit**, compatible (props opcionales): van
  aislados en la rama `rasheed/kit-axislabels-deltatext` sobre
  origin/main para el PR que revisa Nicolás.
- La frescura señala la conexión que no está sana (vencida, revocada,
  con error, pausada) y la que va más de dos días por detrás del resto.
- «Con datos» es con alguna **lectura**: una conexión que descubrió sus
  videos y no midió nada ve el vacío «conectadas pero sin lecturas».

**La importación (RES-2).**

- Ninguna plataforma documenta la cabecera exacta de su exportación, y
  las tres la cambian según informe, idioma y columnas visibles. El
  detector solo adivina la red; el mapeo va por alias en español e
  inglés, y **el mapeo manual es el camino**, no la excepción.
- El parser lee fechas ISO (con o sin fracción), numéricas (con año de
  dos o cuatro cifras, en reloj de 12 o 24 h) y con el mes en texto en
  inglés y en español («Sep 5, 2026», «5 de septiembre de 2026»), que es
  lo que escribe YouTube Studio. La tabla de meses la escribe Intl.
- El orden día/mes se decide **para el archivo entero**. Si el archivo
  no lo demuestra, se propone el del formato reconocido (Meta escribe
  mes/día en cualquier idioma) y después el del workspace, y el paso 3
  avisa cuando en el otro orden las fechas se juntarían en días.
- La lectura lleva la **fecha de la exportación**, no la de la
  importación: se propone desde la columna del día del informe, desde
  el nombre del archivo o hoy, y se valida contra las fechas del propio
  archivo. Una lectura más vieja que la última del video no se escribe
  (se cuenta y se dice), así que subir un archivo viejo nunca hace
  retroceder las cifras ni el reloj.
- Las celdas tienen techo: cifras hasta 10^15 y enteros seguros,
  duración hasta lo que cabe en `numeric(8,2)`, enlaces solo http(s),
  títulos de 2 200 caracteres e ids de 256. La fila «Total» se descarta
  sin contarse como error.
- Sin formato reconocido, **la red no se da por supuesta**: la elige la
  persona antes de seguir, igual que las columnas obligatorias.
- Un archivo sin ninguna columna de interacción deja
  `total_interactions` en NULL, no en 0.
- La escritura va por un **route handler POST con su propio techo**
  (`resumen/importar/lote/route.ts` → `_lib/lote.ts`, RES-6): el
  archivo viaja tal cual en multipart, el cuerpo se lee con un contador
  que corta en 5 MB + 64 KiB (413) sin fiarse del Content-Length, y la
  ruta comprueba Origin contra Host como hacen las server actions. Las
  server actions vuelven al 1 MB de Next: el techo de 6 MB era global y
  subía el de todas.
- El archivo se lee como bytes: UTF-8 estricto y, si no lo es,
  **Windows-1252** (lo que escribe Excel para Windows en español), con un
  aviso en el paso 2. Leído a la fuerza como UTF-8, «Duración» pasaba a
  «Duraci�n» y los alias no casaban.
- El paso 3 distingue el video que **recibe una lectura nueva** del que
  **ya tiene una de esa fecha o posterior** (y no la recibirá), con la
  misma regla que la base; el paso 4 no cuenta dos veces a los mismos.
  Enseña además una columna por cada cifra mapeada.
- Un nombre de cuenta que ya existe en esa red (también por OAuth) no
  crea otra conexión: el asistente lo propone y `ensureCsvConnection`
  devuelve la que existe. Crear otra contaba cada video dos veces.
- La frescura enseña la **fecha de exportación** del CSV tal cual
  («CSV exportado el 12 sep»), la misma que el creador escribió.
- El archivo se valida en el navegador para la vista previa y otra vez
  en el servidor, que no se fía del navegador. `importCsvReadings`
  se protege sola: valida la cuenta, la fecha y los duplicados, y los
  rechazos viajan como código para que el texto lo ponga la pantalla.
