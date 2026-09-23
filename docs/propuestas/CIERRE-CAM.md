# CIERRE-CAM · Cierre del módulo Campañas (CAM-1 a CAM-6)

Escrito para: Nicolás (dueño del módulo, aplica la migración y hace la
prueba de humo), Rasheed (dueño de `db/migrations/` y de
`packages/db/src/esquema.ts`, que esta rama toca) y quien revise el PR.
Rama `nicolas/CAM-cierre-modulo`, worktree `../rayit-cierre-cam`, desde
`origin/main`. Fecha: 23 de septiembre de 2026.

---

## 0. Inventario (foto del 23-sep por la tarde)

### 0.1 Git

- `origin/main` = `098b25a` (P0 entró mientras se hacía la foto: arregla
  las tres pruebas rojas de `lib/permisos/paginas.test.ts` en
  `finanzas/ingresos/*`). La rama parte de ahí por avance rápido.
- Producción (`on-cue-web`) sirve `7737b62` (FIN-7).
- Supabase: 0001–0039 aplicadas (0023 es hueco). 0040 reservada para
  ACC-6; **0041 reservada para esta rama**.
- Ramas de CAM frente a `main` (`git cherry origin/main <rama>`):

| Rama | Commits que main no tiene | Qué hacer |
|---|---|---|
| `nicolas/CAM-1-ficha-campana` | 0 | nada |
| `nicolas/CAM-2-campana-desde-cotizacion` | 0 | nada |
| `nicolas/CAM-3-seguidores-marca` | 0 | nada |
| `nicolas/CAM-4-aporte-marca` | 1: `0bfa72c` (una fila en `CAM-4.md` §2 sobre el rojo de `resumen/importar/lote.test.ts`) | **No se trae**: ya no aplica. `pnpm verificar` sobre `cf90d57` ya no da ese rechazo de `undici` (el log de esta foto no tiene ningún «Unhandled»); los únicos rojos eran los tres de `finanzas/ingresos`, que P0 arregló. Traerlo metería en la propuesta una afirmación falsa. |
| `nicolas/CAM-5-resultado-campana` | 0 | nada |
| `nicolas/CAM-6-reporte-marca` | 0 | nada |

No hay integración que hacer: F1 es solo la migración 0041.

### 0.2 Cada historia frente a su «terminado cuando» (`docs/backlog-mvp.md` §5)

| Historia | Terminado cuando | En main | Lo que falta |
|---|---|---|---|
| CAM-1 | Se asocian dos posts a una campaña y aparecen con sus views. | Sí, desde el 22-sep, y en producción. | Visto bueno al `loading.tsx` de Rasheed (F3). Costura con FIN-1 sin prueba propia de la ruta (F2). |
| CAM-2 | Rasheed la llama desde COT-4 sin pedir cambios. | Sí; COT-4 la llama desde el panel y el enlace. | Nada de código; la costura entra en la prueba del ciclo. |
| CAM-3 | La curva sale del snapshot con su línea base de dos semanas. | Sí, con 0035 aplicada. | La lectura diaria (`brand.snapshot`) espera al worker (WRK); «Actualizar ahora» funciona. Nota vieja del tablero («falta aplicar 0035»). |
| CAM-4 | Un CSV de ventas diarias aparece en la ficha. | Sí. | Dos `TODO(ACC-2)` viejos en `actions.ts` (ACC-2 ya está en main). |
| CAM-5 | Los seis KPIs salen de la tabla; sin datos de la marca dice «sin datos», no cero. | Sí. | **«Recalcular» apagado**: `mc_app` no tiene INSERT/UPDATE sobre `campaign_result` (0025 §5). El cálculo de cada mañana espera al worker. Nota vieja («rama encadenada sobre CAM-4»). |
| CAM-6 | El reporte no cambia aunque lleguen snapshots nuevos. | Sí, con 0037 aplicada. | Nota vieja («falta aplicar 0037»). |

Además: **nunca se probó el ciclo entero en una sola prueba**, y las
decisiones pendientes están repartidas en cinco propuestas.

### 0.3 Plan

1. **F1** · `0041_campaign_result_escritura_web.sql`: GRANT INSERT,
   UPDATE a `mc_app`, política que ata cada fila a una campaña visible
   de su mismo workspace, disparador de referencias en las dos claves
   ajenas; `PRIVILEGIOS_DE_LA_APP` en `esquema.ts` (de Rasheed, anotado
   en §3). «Recalcular» ya se enciende solo con `has_table_privilege`;
   se añade que la ficha tampoco lo enseñe a un rol sin
   `campanas.resultado.calcular` (ni «Generar» sin
   `campanas.reporte.generar`).
2. **F2** · Costuras con su prueba y la **prueba del ciclo** en
   `packages/db/test/campanas-ciclo.test.ts`.
3. **F3** · `TODO(ACC-2)`, notas del tablero, tabla de decisiones.
4. **F4** · verificar completo, build, db.check, guardia, dev a 400 px y
   oscuro con Mánager y Contador, `/code-review` alto y
   `/security-review` (toca privilegios de la base).
5. **F5** · PARADA 1 con la 0041; tras CONTINUAR-DESPLIEGUE, push a main
   y despliegue desde `../rayit-deploy`.
