# FIN-3 · Cuentas por cobrar — lo que Rasheed tiene que saber

Escrito para: Rasheed (dueño de `packages/db/src/client.ts`, `schema/`,
`db/migrations/`, `lib/auth/` y `lib/workspace/`) y quien revise el PR.
Fecha: 23 de septiembre de 2026. Rama `nicolas/FIN-3-cuentas-por-cobrar`,
sobre `origin/main` (29460e3).

**Resumen para el impaciente: FIN-3 no necesita nada tuyo.** No hay
migración, no hay columna nueva, no hay cambio de contrato en `@mc/db`.
Lo único que te pido es leer §5 (un índice que propongo y NO creo) y §6
(dos cosas que quedan anotadas para no repetirlas).

---

## 0 · Plan (fase 1)

### 0.1 Qué hay hoy y qué cambia

`/finanzas` es hoy **la portada y la lista de facturas a la vez**: los
cuatro KPIs de `getReceivablesKpis` y debajo `listInvoices` con cinco
filtros por estado persistido (`?estado=todas|por_cobrar|pagadas|
borradores|anuladas`). `/finanzas/facturas` **no existe** como lista:
solo están `facturas/[id]` y `facturas/nueva`.

FIN-3 separa las dos cosas, que son dos preguntas distintas:

| Ruta | Pregunta que responde | Fuente |
|---|---|---|
| `/finanzas` | «¿Quién me debe y qué cobro primero?» | vista `receivables` (0010), ordenada por urgencia |
| `/finanzas/facturas` | «¿Qué facturé?» — el archivo, con borradores y anuladas | `listInvoices` (FIN-1), tal cual está hoy |

Los cuatro KPIs se quedan en `/finanzas`, que es donde estaban.

**Decisión 1 · dónde vive cada cosa.** La alternativa era dejar
`/finanzas` como está y colgar cuentas por cobrar de
`/finanzas/cobros`. Descartada: el mock (`dashboard/local/app.js`,
`renderFinanzas`) pone los KPIs y la tabla CXC en la MISMA pantalla, y
los KPIs son de cobro («Por cobrar», «Vencido»), no de facturación.
Una portada que abre con «vencido 1,1 M» y debajo lista borradores
ordenados por fecha de emisión entierra justo lo que el KPI acaba de
gritar. El archivo, que es lo que se consulta de vez en cuando, es el
que se va a una subruta.

Consecuencia: Finanzas estrena su tira de pestañas (`ModuleTabs`, el
patrón de Ventas) con «Cuentas por cobrar» y «Facturas», y los botones
«Volver a facturas» del detalle, de «Nueva factura» y del formulario
pasan de `/finanzas` a `/finanzas/facturas`, que es donde la factura
vive ahora. `facturas/actions.ts` revalida las dos rutas.

**Decisión 2 · grupos de ruta y `loading.tsx`.** Hoy
`finanzas/loading.tsx` está en la raíz del segmento, así que es el
fallback de Suspense de `/finanzas` **y de todo lo que cuelga**:
`/finanzas/facturas/123` enseña el esqueleto de los cuatro KPIs y la
tabla de facturas antes de saber si esa factura existe. Es exactamente
lo que el pulido r4 corrigió en Cotizar y en Ventas
(`app/(app)/_lib/esqueleto.tsx` lo cuenta). Al partir la pantalla en dos
hay que tocar ese archivo igual, así que se arregla de paso, con el
mismo patrón que Ventas:

```
finanzas/(inicio)/page.tsx      /finanzas          cuentas por cobrar
finanzas/(inicio)/loading.tsx   su esqueleto, que ya no envuelve nada más
finanzas/facturas/(lista)/page.tsx     /finanzas/facturas
finanzas/facturas/(lista)/loading.tsx
finanzas/error.tsx              se queda: la frontera SÍ debe cubrir el módulo
```

Los grupos `(inicio)` y `(lista)` no cambian ninguna URL.

**Decisión 3 · qué es «todas» en esta pantalla.** El Segmented filtra
por `aging_bucket`, y su opción por defecto es **«Por cobrar»**, no
«Todas»: la pantalla es la de cobro y el KPI de arriba dice «3
facturas». Las opciones son `Por cobrar` (las tres abiertas, el
defecto, sin parámetro en la URL), `Vencidas` (`?bucket=vencida`),
`Vence pronto`, `Al día` y `Pagadas`. «Pagadas» está porque la vista la
trae y porque confirmar un cobro reciente no debería obligar a salir de
la pantalla; los borradores y las anuladas NO están, porque la vista
`receivables` los excluye — para eso está `/finanzas/facturas`.

**Decisión 4 · la acción de la fila.** El encargo pide «Registrar
pago», que por ahora llevaría al detalle, y a la vez «no pintes botones
que no hacen nada». Gana lo segundo: el botón dice **«Ver factura»** y
lleva al detalle, que es lo que de verdad hace. Un botón «Registrar
pago» que abre una pantalla donde todavía no se puede registrar un pago
es peor que no tenerlo. FIN-2 le pone el botón de verdad y FIN-4 añade
«Recordar»; los dos tienen sitio reservado en la columna «Acción».

**Decisión 5 · el orden.** `ORDER BY` por urgencia, en SQL:
vencidas → vence pronto → al día → pagadas, y dentro de cada grupo
`due_on ASC` (lo que venció hace más tiempo, primero) y `number DESC`
para desempatar. `due_on ASC` es *exactamente* `days_overdue DESC`
(`days_overdue = CURRENT_DATE - due_on`), pero `due_on` no cambia al
pasar la medianoche: el cursor de paginación es estable y no se salta
ni repite filas si la página se pide a las 23:59 y la siguiente a las
00:01.

Esto invierte el orden del mock (que lista Fresko, Café Alma y Hogar
Lindo, de la más lejana a la más vencida). Es a propósito y es lo que
pide el encargo: la primera fila de una pantalla de cobro tiene que ser
la que hay que cobrar hoy.

**Decisión 6 · la búsqueda.** `ILIKE` sobre `company_name` (que la
vista ya trae) y `number`, con `%` y `_` del usuario escapados, desde
el tercer carácter. NO usa `similarity()` ni `brand_key()` como
`listCompanies` de Ventas: `brand_key` nace en la migración **0031**,
que está en `main` pero **no aplicada en Supabase** (la cola va por
0022). Una pantalla nueva que dependa de la cola no se puede desplegar.
Cuando 0024–0033 estén aplicadas se puede subir a la búsqueda de Ventas
en un PR de una línea; queda en §5.

El umbral de tres caracteres y el helper `searchTerm` se repiten en
`queries/finanzas.ts` en vez de importarse de `queries/ventas.ts`: son
dos módulos con dueños distintos y no quiero que un cambio de criterio
en Ventas mueva el de Finanzas sin que nadie lo note. Son cuatro
líneas.

**Decisión 7 · el KPI «cobrado en el año».** `getReceivablesKpis` (FIN-1)
ya devuelve `collectedDelta: number | null` y `collectedPrevYtd`, y la
pantalla ya usa `Kpi` con `delta` + `deltaLabel`. No se duplica nada.
Con el seed: 38,6 M contra 29,5 M → `0.308` → «+31 % · vs. mismo
período 2025», que es la cifra del mock. Sin cobros el año anterior,
`collectedDelta` es `null` y en vez del delta va la frase «Sin cobros
en 2025 para comparar» — ya está así desde FIN-1 y se conserva.

### 0.2 DECISIÓN PENDIENTE DE NICOLÁS · los KPIs de un workspace vacío

El encargo pide que, con otro workspace, los KPIs salgan «en null, no
en 0,00». `getReceivablesKpis` hace hoy `coalesce(sum(...), 0)` y
devuelve `'0'`, y es el contrato de FIN-1, ya en `main`, con su prueba
y con la pantalla que lo consume.

Tomo la opción conservadora: **no cambio la firma de
`getReceivablesKpis`**. Razón: la suma de lo que te deben cuando no
tienes facturas es un cero de verdad («no te deben nada»), no una
ausencia («no lo sabemos»), que es lo que la regla del repositorio
protege. Lo que sí hago es que la PANTALLA no presente nunca un cero
desnudo: con `openCount === 0` el KPI «Por cobrar» lleva la nota
«Ninguna factura por cobrar», con `overdueCount === 0` «Ninguna
vencida», con `taxRate === null` «Sin reservas todavía» y la tabla cae
en su estado vacío con una frase y un enlace para crear la primera
factura. Los dos campos que sí son ausencias —`collectedDelta` y
`taxRate`— ya son `null` y se dicen con una frase.

Si prefieres que las sumas viajen como `null`, es un cambio de FIN-1
(firma, prueba y pantalla) y lo hago en un PR aparte de dos archivos.

### 0.3 Archivos

Nuevos:

- `packages/db/src/queries/finanzas.ts` → `listReceivables`,
  `ReceivableRow`, `RECEIVABLE_BUCKETS`, `searchTerm`, `MIN_SEARCH`
  (añadidos al archivo, que ya es mío).
- `apps/web/app/(app)/finanzas/(inicio)/page.tsx` y `loading.tsx`.
- `apps/web/app/(app)/finanzas/facturas/(lista)/page.tsx` y `loading.tsx`.
- `apps/web/app/(app)/finanzas/_componentes/pestanas.tsx`,
  `filtro-bucket.tsx`, `buscador.tsx`, `celda-vacia.tsx`.
- Pruebas: `packages/db/test/finanzas.test.ts` (ampliada),
  `apps/web/app/(app)/finanzas/_lib/estado.test.ts`,
  `apps/web/app/(app)/finanzas/cobros.test.tsx`,
  `apps/web/app/(app)/finanzas/facturas/lista.test.tsx`.

Cambiados: `_lib/estado.ts`, `_lib/messages.ts`, `facturas/actions.ts`
(revalidar las dos rutas), `facturas/[id]/page.tsx`,
`facturas/nueva/page.tsx` y `nueva/form.tsx` (el «Volver»),
`apps/web/README.md`, `apps/web/content/backlog.ts`.

Borrados: `finanzas/page.tsx` y `finanzas/loading.tsx` (se mueven a sus
grupos de ruta).

### 0.4 Dudas que no bloquean

1. ¿«Pagadas» dentro del Segmented, o solo en el archivo? Va dentro,
   por la razón de la decisión 3; quitarlo es borrar una línea.
2. El mock enseña también «Adelanto de cobro» (`adv-kv`) en Finanzas.
   No es FIN-3 ni está en el backlog: fuera de alcance, sin historia
   destino todavía.

---
