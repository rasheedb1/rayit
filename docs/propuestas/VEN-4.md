# VEN-4 · Siguiente acción y seguimientos

Rama: `rasheed/VEN-5-ficha-empresa-r5` (VEN-4 y VEN-5 viajan juntas).
La nota corta vive en `platform/apps/web/content/backlog.ts`; aquí va el
detalle.

---

## Qué hace

- **Una línea por negocio abierto**: qué, cuándo y quién, editable en su
  sitio (Enter guarda, Esc cancela). «Hecha» deja la acción en la
  historia y abre el formulario de la siguiente, vacía y para mañana. Sin
  acción, la línea dice «Sin siguiente acción» en ámbar. La montan la
  ficha, el tablero, la lista del pipeline y «Para hoy».
- **«Para hoy»** arriba de `/ventas`: lo vencido primero, lo de hoy
  después, con enlaces a la lista filtrada en SQL
  (`?seguimiento=sin_accion|para_hoy`).
- **Job `sales.follow_ups`** (`apps/worker/src/jobs/ventas/seguimientos.ts`):
  `runSeguimientos(db, now)` deja en `notification` un `deal_due` («Vence
  hoy») y un `deal_overdue` («Seguimiento vencido»), una sola vez por
  vencimiento, en la mañana de cada espacio (desde las 7:00 locales).
  A mano: `pnpm --filter @mc/worker run job:seguimientos` (`--ya` para no
  esperar la mañana).

## Dónde está cada cosa

| Pieza | Archivo |
|---|---|
| Línea y editor | `apps/web/app/(app)/ventas/_seguimiento/siguiente-accion.tsx` |
| «Para hoy» | `_seguimiento/para-hoy.tsx`, `para-hoy-lista.tsx` |
| «¿Era…? Marcarla hecha» | `_seguimiento/cerrar-pendiente.tsx` |
| Server Actions | `ventas/empresas/actions.ts` (`fijarSiguienteAccion`, `marcarHecha`) |
| Consultas | `packages/db/src/queries/ventas-ficha.ts` (`setNextAction`, `completeNextAction`, `listDueToday`, `getLocalDates`) |
| Esquema | `0034_seguimientos.sql` (job + `deal_pipeline` con «hoy» en la zona del espacio), `0035_zona_del_espacio_valida.sql`, `0036_siguiente_accion_fijada.sql` |

## Pruebas

- `packages/db/test/ventas-ficha.test.ts`: fijar con día y hora en la zona
  del espacio, «Hecha», `ActionChanged`, «Para hoy», y 0035 corrigiendo
  zonas mal escritas sobre una base reconstruida hasta 0034.
- `apps/worker/test/seguimientos.test.ts`: el «terminado cuando» (un
  vencido crea su aviso y volver a correr no lo duplica), la mañana de
  cada espacio, zonas mal escritas, el caso de las 6:59.
- `apps/web/app/(app)/ventas/_seguimiento/*.test.tsx` y
  `empresas/actions.test.ts`: la línea, el editor, «Para hoy» y las
  acciones.

## Pendiente humano

1. Aplicar **0034, 0035 y 0036** en Supabase con el próximo deploy
   (`make db.migrate`). 0035 corrige las zonas mal escritas que haya y lo
   dice en un NOTICE («slug: «antes» → después»): léelo.
2. `make db.seed` para refrescar `next_action` y `next_action_due` del
   seed 0002 (la demo en Supabase conserva vencimientos a las 6:59 p. m.).
3. `./scripts/supabase-admin.sh sql "GRANT mc_worker TO mc_migrator"`,
   para que el comando manual y el worker puedan hacer `SET ROLE` contra
   Supabase.
4. Revisión de Nicolás en el PR de integración: la rama toca
   `apps/worker/test/runner.test.ts` (cuenta desde `job_definition`) y la
   línea de montaje de `apps/worker/src/jobs/index.ts`.

---

## Historia por rondas

### r1 (203ac61, e05e5dc)
Línea editable, «Para hoy», job de seguimientos y sus pruebas; pulido r8
de Ventas.

### r2 (c452df6)
«Para hoy» no suelta la fila que se toca y dice «Guardada para el…»; una
acción no nace vencida (`PastDueTime`, la próxima en punto);
`deal_pipeline` cuenta «hoy» en la zona del espacio (0034); enlaces a la
lista filtrada en SQL; `runner.test.ts` cuenta `job_definition`.

### r3 (9005ea0)
El job resuelve cada zona contra `pg_timezone_names`; `deal_overdue` solo
para lo de un día anterior (la mañana siguiente, nunca la misma noche);
`deal_due` no avisa lo escrito hoy después de la hora de aviso. 0035: el
disparador que no deja guardar una zona desconocida. `listPipeline` trae
la acción entera (`nextActionOf`) y el tablero pierde su lectura aparte.

### r4 (beacad8)
0036 `deal.next_action_set_at` (solo lo mueven el texto o la fecha de la
acción): una llamada a las 8:00 ya no borra el «Vence hoy» de una corrida
atrasada. El aviso va al responsable o al dueño solo si siguen en el
espacio. «¿Era…?» al registrar un contacto. `isIsoDate`/`isClockTime`.

### r5
- **«Marcarla hecha» ya no cierra una acción que nadie hizo.** El aviso
  «¿Era X?» del registro seguía en pantalla después de cerrar o cambiar X
  desde la línea del mismo negocio, y pulsarlo cerraba la acción NUEVA.
  Ahora la línea y el aviso mandan `expectedAction`;
  `completeNextAction(tx, dealId, doneText, expected)` compara con la fila
  ya bloqueada (`FOR UPDATE`) y, si no coincide, lanza `ActionChanged`
  con la acción de ahora («Esa acción ya cambió: ahora es «…». No se
  marcó nada»), sin tocar el negocio; la acción revalida la ficha. El
  aviso se esconde solo cuando la acción del negocio cambia (se esconde
  y no se desmonta, para no perder el resultado que llega en el mismo
  render).
- **«Guardada para el…» ya no convive con «Sin siguiente acción».** El
  aviso de la línea lleva lo que se guardó (`saved: {action, dueText}`,
  escrito con el mismo `textoDeVencimiento`) y solo se enseña mientras la
  línea pinte eso. No se limpia en un efecto al cambiar `data`: guardar y
  revalidar llegan en el mismo render y el efecto borraría justo el aviso
  de guardarla.
- **Editor a 1280 px.** La rejilla mide el formulario (`@container`), no
  la ventana: hasta 448 px una columna; desde 448, «Qué» y «Quién» a lo
  ancho y «Cuándo»/«Hora» juntos; desde 672, las cuatro en fila.
- **6:59.** Lo que vence hoy antes de la hora del aviso sale como
  «Seguimiento vencido», no «Vence hoy»: «Para hoy» y el tablero ya lo
  pintan «Vencido». Una sola vez.
- **Zonas.** 0035 corrige las filas que ya estaban mal (la IANA única que
  quiso decir, o UTC) quitando un momento la RLS forzada de `workspace`
  —sin eso el dueño no veía ninguna fila y el UPDATE no hacía nada, igual
  que el NOTICE de r3—. Con el dato corregido y el disparador, la vista
  y `WORKSPACE_TZ` no necesitan validar la zona fila a fila. Función y
  disparador renombrados a `workspace_timezone_check` (identificadores en
  inglés).
- `formatDaysRelative` es un envoltorio obsoleto de `formatRelativeDays`
  (Intl y el locale del espacio). La columna «Vence» de Finanzas pasa de
  «en 23 días» a «dentro de 23 días» sin tocar su carpeta.
