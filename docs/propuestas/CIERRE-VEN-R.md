# Ventas, lo que faltaba (R3-VEN) · 10-oct-2026

Escrito para: Rasheed y Nicolás. Lo que del pulido final de Ventas se
cerró con código, y lo que de VEN-9 y VEN-14 solo puede hacer una persona
con las cuentas reales.

## 1. Pulido final (pendientes-pulido-final.json)

| Hallazgo | Estado |
|---|---|
| La narrativa con un creador sin datos arma frases de relleno para la marca («Todavía no tengo videos con puntaje…») | **Hecho**: `narrativeHasData(perfil)` en `@mc/core` (mediana, video con puntaje, campaña medida, tarifario o audiencia); sin nada de eso, `/ventas/perfil` enseña un estado vacío propio con enlaces a Conexiones y a importar un CSV en vez de la narrativa. Una narrativa editada a mano se respeta siempre |
| «views» en la guía de los pasos de las cadencias (0067 y 0046 §303) | **Hecho** con la migración **0086**: `regexp_replace` sobre `guidance_es` en las plantillas (`steps` jsonb) y en las cadencias ya instanciadas (`outbound_step`); las migraciones aplicadas no se tocan. `packages/db/test/guia-sin-anglicismos.test.ts` exige que ninguna guía diga «views» |
| «captions» en la narrativa y en el perfil | **Hecho**: «descripciones» en `narrativa.ts` (la plantilla y los porqués) y en `perfil/messages.ts`; la prueba de la narrativa cambia con ellos. La palabra «captions» sigue en la lista de términos que el verificador reconoce: quien la escriba a mano no se queda sin verificar |
| «Activar y escribir a…» enseña «Cadencia activa» con la cabecera todavía en «Borrador» | **Hecho**: el aviso y el enlace esperan a que termine la transición (`!pending`), así la cabecera refrescada y el aviso llegan juntos |
| `UUID_RE` por triplicado (connectors `state.ts`, `unipile-webhook.ts`, `@mc/db/client.ts`) | **Pendiente**: `@mc/connectors` no depende de `@mc/core` (el hallazgo lo daba por hecho); unificarlo es añadir esa dependencia o mover la expresión a un paquete que los tres compartan. Decisión de Rasheed |

## 2. VEN-9 y VEN-14: lo que es de una persona

Las llaves ya están en Vercel (`GOOGLE_OUTREACH_CLIENT_ID/SECRET`,
`UNIPILE_DSN`, `UNIPILE_ACCESS_TOKEN`, `UNIPILE_WEBHOOK_SECRET`). Falta:

1. **La sesión real** (`docs/ventas-outreach.md` §9.3): un túnel hacia la
   web local, un buzón de pruebas y un LinkedIn de pruebas;
   `pnpm --filter @mc/connectors record:outreach -- avisos | google | unipile`;
   después `outreach-grabacion.test.ts` en verde. Es lo que convierte a
   VEN-9 de «bloqueada» en «hecha»: hasta entonces todo está probado
   contra dobles.
2. **`ANTHROPIC_API_KEY`** en Vercel (production y preview) para que
   `outbound.replies` clasifique con el modelo (VEN-14); sin ella el job
   termina «no configurado» y la demo usa el clasificador falso.
3. En producción, conectar un Gmail y un LinkedIn reales en
   `/ventas/canales` y ver la fila en verde, el keepalive escribiendo
   `last_ok_at` y una cuenta caída en rojo con «Reconectar».

## 4. VEN-17 · por qué un job sale «agotado» en los turnos, y qué mirar

Desde esta máquina no se ve `job_run` (`mc_app` no lo lee) ni corre
`make cron.status` (pide el token de administración), así que esto es
lectura del código, no de producción:

- `retries_exhausted` lo decide `verdict()` en `apps/worker/src/runner/once.ts`
  dentro de la ventana del cron del job: cuando `attempts ≥ max_attempts`
  (fallos reales) **o** `cuts ≥ MAX_TICK_CUTS` (cortes por el presupuesto
  de 45 s del turno, `metadata.tick_cut = true`). «Agotado en cada turno»
  es lo mismo que «ya falló o se cortó el máximo en esta ventana y
  espera a la siguiente»: no vuelve a intentarlo cada minuto.
- `outbound.replies` fallaba por `citext` fuera del `search_path` del rol
  del worker: resuelto el 7-oct en caliente y con 0084 (aplicada el
  9-oct).
- `collect.account_metrics`: hasta el 9-oct, la cuenta de Instagram
  autorizada (@nicolasduartea) hacía fallar la lectura con el error 100
  de Meta («link_clicks is not available»), que `classifyFailure`
  tomaba por permanente (`cuenta` → corrida `failed`), y cada ventana
  gastaba sus intentos. Los dos commits de Nicolás del 9-oct (`00c49413`,
  `58359739`: las métricas por tipo de medio sin `link_clicks` ni
  `reposts`, hasta cuatro reintentos quitando lo que Meta rechaza, y el
  100 de Meta como transitorio y no como fallo de la cuenta) están en
  producción desde `23f72cd9`. Lo esperable es que desde el 10-oct ese
  job cierre en `ok`.
- Cómo comprobarlo (Rasheed): `make cron.status` siete días seguidos sin
  `exhausted` ni `failed`; y, como `mc_worker`, `SELECT job_id, status,
  attempt, error, metadata->>'tick_cut' FROM job_run WHERE started_at >
  now() - interval '1 day' ORDER BY started_at DESC`. Si aparece
  `tick_cut`, es el presupuesto (hay que subir a Pro o partir el job);
  si aparece `error`, es el conector y toca a Nicolás (CON-2).

## 3. Decisiones

| Pregunta | Lo que quedó | Si se quiere lo contrario |
|---|---|---|
| ¿Qué pasa con la narrativa guardada de un creador sin datos? | Se guarda igual (la plantilla) pero no se enseña: el estado vacío la tapa hasta que haya cifras. Una narrativa editada se enseña siempre | Vaciar el texto al guardar cuando `narrativeHasData` sea falso |
| ¿Se corrige el texto de 0067 en su archivo? | No: una migración aplicada es inmutable. 0086 corrige las filas; una plantilla nueva con «views» la caza la prueba | — |
