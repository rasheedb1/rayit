# @mc/web · el dashboard

Next.js 15, React 19, Tailwind 4, Geist. Cada ruta muestra el plan de
construcción de su módulo hasta que llega la pantalla real. Finanzas ya
es real (FIN-1): lee la base por `@mc/db`.

Base de datos: con `DATABASE_URL` en el entorno usa ese Postgres
(Supabase por el pooler, o el Docker de `make up`). Sin ella, en
desarrollo, levanta un Postgres embebido en memoria con las migraciones
y los seeds: es el «modo demo» y no necesita nada instalado. En
producción sin `DATABASE_URL` la app falla a propósito.

```bash
cd platform
pnpm install
pnpm --filter @mc/web dev        # http://localhost:3000
pnpm --filter @mc/web typecheck
pnpm --filter @mc/web lint
pnpm --filter @mc/web build
pnpm --filter @mc/web test        # lib/*.test.ts con node --test
```

Desplegar: `make vercel.deploy` (vista previa) o `make vercel.deploy
PROD=1` (producción). El token vive en el vault; ver el CLAUDE.md de la
raíz.

## Dónde está cada cosa

```
app/(app)/<modulo>/page.tsx   La ruta de cada módulo. Hoy muestra el plan;
                              el dueño la reemplaza por la pantalla real.
app/(app)/finanzas/           Finanzas: lista, factura nueva y detalle.
                              index.ts exporta facturarCampana() para Campañas.
components/ui/                Kit de interfaz compartido (ver su README).
lib/format.ts                 Dinero, fechas y porcentajes en es-CO.
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
