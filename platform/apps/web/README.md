# @mc/web · el dashboard

Next.js 15, React 19, Tailwind 4, Geist. Cada ruta muestra el plan de
construcción de su módulo hasta que llega la pantalla real. Resumen
(RES-1, RES-2), Finanzas (FIN-1), Campañas (CAM-1) y Conexiones (CON-3)
ya son reales: leen la base por `@mc/db`.

## Base de datos en local

Con `DATABASE_URL` en el entorno usa ese Postgres (Supabase por el
pooler, o el Docker de `make up`). Sin ella, en desarrollo, levanta un
Postgres embebido en memoria con las migraciones y los seeds: es el
«modo demo» y no necesita nada instalado. En producción sin
`DATABASE_URL` la app falla a propósito.

`make db.unlock` escribe las credenciales en `platform/.env.local`, que
NO es una de las rutas que `next dev` lee por su cuenta (solo mira
`apps/web/.env*`). Por eso el script `dev` de este paquete arranca Next
con `node --env-file-if-exists=../../.env.local`, igual que el worker:
así `make dev` levanta la web y el worker contra LA MISMA base. Si lo
cambias y quitas esa parte, la web vuelve al modo demo sin decirlo más
que en una línea del log:

```
[db] Sin DATABASE_URL: Postgres embebido en memoria con el seed (modo demo).
```

```bash
cd platform
make db.unlock                   # una vez: escribe ../../.env.local
pnpm install
pnpm --filter @mc/web dev --port 3100   # el puerto lo eliges tú
pnpm --filter @mc/web typecheck
pnpm --filter @mc/web lint
pnpm --filter @mc/web build
pnpm --filter @mc/web test        # vitest
```

Y en producción hay que decir qué workspace se sirve: `DEMO_WORKSPACE_ID`
es obligatoria hasta CIM-3 (`lib/workspace/current.ts` lanza si falta).
Se fija con `make vercel.run ARGS="env add DEMO_WORKSPACE_ID production"`
(y otra vez con `preview`). Para servir el workspace del seed a
propósito, `ALLOW_SEED_WORKSPACE=1`.

Desplegar: `make vercel.deploy` (vista previa) o `make vercel.deploy
PROD=1` (producción). El token vive en el vault; ver el CLAUDE.md de la
raíz.

## Dónde está cada cosa

```
app/(app)/<modulo>/page.tsx   La ruta de cada módulo. Mientras no hay pantalla
                              muestra el plan; el dueño la reemplaza por la real.
app/(app)/plan/[modulo]/      El plan de construcción de un módulo que YA tiene
                              pantalla. Se enlaza desde su cabecera.
app/(app)/resumen/            Resumen: KPIs, seguidores por red, visualizaciones
                              por red, frescura por conexión e importación por CSV.
app/(app)/finanzas/           Finanzas: lista, factura nueva y detalle.
                              index.ts exporta facturarCampana() para Campañas.
test/fixtures/csv/            Exportaciones de ejemplo del importador (ver su README).
components/ui/                Kit de interfaz compartido (ver su README).
lib/format.ts                 Dinero, fechas y porcentajes. El locale y la zona
                              llegan del workspace; es-CO solo es el valor por defecto.
lib/workspace/current.ts      El único sitio que sabe cuál es el workspace.
lib/workspace/settings.ts     Su moneda, zona horaria y locale (cacheado por petición).
lib/db/index.ts               withWorkspace(fn): la única forma de abrir una transacción.
app/(app)/page.tsx            El plan completo (inicio).
app/(app)/reglas/page.tsx     Reglas para no pisarse, dependencias, decisiones.
content/backlog.ts            Las historias y SU ESTADO. Es lo que cambia.
content/modules.ts            Los módulos, su dueño y sus carpetas.
content/flags.ts              Qué módulos están encendidos.
content/team.ts               Quién es quién.
components/                   Marco, navegación, tema, tarjetas del plan.
lib/backlog.ts                Cálculos sobre el backlog: avance, días, enlaces.
```

## Marcar avance

Cada uno edita **sus** historias en `content/backlog.ts`:

```ts
status: "en_curso",   // pendiente · en_curso · bloqueada · hecho
note: "Rama abierta, falta el test de RLS.",
```

Va en el mismo PR de la historia. Al mergear a `main`, el despliegue
lo publica: es la forma de ver en la URL lo que cada quien va haciendo.

## Reglas del marco

- El tema se fija en `<html data-theme>` antes de pintar y se guarda
  en `localStorage`. Los colores son variables en `globals.css`; los
  componentes usan `bg-bg`, `text-fg`, `border-line`, nunca un color
  literal.
- Un módulo apagado en `content/flags.ts` desaparece del menú y su
  ruta no existe.
- Nada aquí hace aritmética de métricas. Cuando lleguen los datos, los
  números derivados salen de las vistas de la base.
