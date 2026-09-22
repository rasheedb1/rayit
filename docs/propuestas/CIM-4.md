# CIM-4 · Propuestas para carpetas de Rasheed

Cambios que CIM-4 necesita fuera de los archivos de Nicolás. No se
aplican aquí; se piden por PR o en el daily.

## 1. Filas nuevas en `feature_flag` (migración futura, `platform/db/migrations/`)

`apps/web/content/flags.ts` usa las llaves de la migración 0009 para que
migrar a la base sea cambiar la fuente, no los nombres. Dos módulos de
fase 2 ya tienen fila (`video_lab`, `agency_workspace`); tres no. Las
llaves propuestas siguen el nombre de la migración de cada módulo:

```sql
INSERT INTO feature_flag (key, enabled) VALUES
  ('content_metrics', false),  -- 0003 · Mis videos
  ('niche_radar', false),      -- 0004 · Tendencias del nicho
  ('ideas_scripts', false);    -- 0006 · Ideas y guiones
```

La bandera `kit` (galería de CIM-5) es de desarrollo y no va a la base.

## 2. Página del plan (`apps/web/app/(app)/page.tsx`, líneas 85-116)

A 390 px la tarjeta "Por persona" mide 464 px y queda recortada (no hay
scroll de página, pero se pierde el borde derecho). Causa probable: el
`<p>` con `{list.length} historias · {formatDays(...)} estimados` y la
cifra en mono no envuelven dentro de `flex justify-between`. Arreglo
sugerido: `flex-wrap` en ese contenedor o `min-w-0` en los hijos.

## 3. Tokens de color

`globals.css` ahora tiene los tokens del mock (`--ink`, `--border`,
`--good`…) y los nombres del primer marco (`--fg`, `--line`, `--ok`…)
como alias. Cuando Rasheed toque sus componentes, conviene pasar a los
nombres nuevos y retirar los alias. No urge.
