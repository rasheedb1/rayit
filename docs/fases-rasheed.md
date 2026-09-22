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
   Site URL y Redirect URLs para `localhost:3000` y
   `multicampaign-web.vercel.app`. El agente deja la lista exacta en
   `apps/web/README.md`.
4. **La migración `0014_public_share.sql`** que crea la pieza cotizar
   (funciones `SECURITY DEFINER` para las páginas públicas) la aplica
   Rasheed con `make db.migrate` después de revisarla. Los agentes solo
   la verifican en Postgres embebido.

## 5. Lo que queda para Rasheed después del workflow

1. Revisar `rasheed/integracion`, mergear a `main`.
2. **Vercel en modo monorepo.** Cuando `apps/web` dependa de
   `packages/db`, el despliegue actual (que sube solo `apps/web`) deja
   de servir. Hay que fijar el directorio raíz del proyecto en
   `apps/web` y desplegar desde `platform/`: un cambio en
   `scripts/vercel.sh` y un `PATCH` al proyecto con el token del
   vault. Lo hago yo con un comando cuando toque.
3. Aplicar `0014` con `make db.migrate`, configurar Supabase Auth, y
   `make vercel.deploy PROD=1`.
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
