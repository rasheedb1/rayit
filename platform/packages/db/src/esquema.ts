/**
 * Qué esquema espera @mc/db, y cómo se comprueba contra la base a la
 * que acaba de conectarse.
 *
 * El contrato del paquete —«RLS filtra las lecturas: ninguna pantalla
 * pasa el workspace como parámetro»— no lo cumple el paquete: lo
 * cumplen las políticas que db/migrations dejó en la base. Si la base
 * está atrasada, todo compila, todas las rutas responden 200 y el
 * aislamiento simplemente no existe. Pasó: con 15 migraciones aplicadas
 * en Supabase y 19 en el repositorio, `relrowsecurity` era false en
 * outbound_policy, quote_item, rate_card_item, deal_stage_history,
 * campaign_post, membership y contact, y la web no decía nada.
 *
 * LA GUARDIA ESTÁ INVERTIDA, Y ESE ES EL PUNTO
 * --------------------------------------------
 * Hasta la migración 0021 esto era una LISTA DE INCLUIDOS: 53 nombres
 * escritos a mano, y la pregunta era «¿estas tablas tienen RLS?». Con
 * esa forma, una tabla nueva sin política pasa en verde por no estar en
 * ninguna lista, y eso es exactamente lo que pasó cinco rondas
 * seguidas. Se coló `workspace` —la raíz del inquilino, que cualquier
 * transacción de la aplicación podía BORRAR— porque su clave de
 * inquilino se llama `id` y no `workspace_id`; se colaron los catálogos
 * globales, que nadie aislaba pero cualquiera escribía; se colaron
 * api_call_log y api_quota_usage por tener la clave ajena opcional.
 *
 * Ahora la pregunta se le hace a la BASE: trae TODO lo que hay en
 * `public` —tablas, vistas, vistas materializadas, tablas foráneas,
 * funciones, claves ajenas, disparadores y privilegios— y exige
 * aislamiento en todo, con listas cortas y explícitas de excepciones,
 * cada una con su motivo escrito. Un objeto nuevo sin política y sin
 * excepción declarada hace fallar la prueba; no pasa en silencio. Y una
 * excepción que ya no corresponde también se reporta, para que las
 * listas no se pudran.
 *
 * UNA TABLA AISLADA
 * -----------------
 *   1. ENABLE ROW LEVEL SECURITY (relrowsecurity)
 *   2. FORCE ROW LEVEL SECURITY (relforcerowsecurity), porque sin FORCE
 *      el dueño de la tabla —mc_migrator, que es quien corre los seeds
 *      y las migraciones— se salta la política sin decirlo
 *   3. al menos una política: RLS activado y cero políticas no aísla,
 *      niega, y eso se descubre en producción
 *   4. y que CADA política permisiva que alcanza a mc_app aísle por sí
 *      sola, en cada comando que mc_app tiene concedido. Las permisivas
 *      se combinan con OR: basta una abierta para anular las demás. La
 *      ronda 2 aceptaba la tabla si ALGUNA política mencionaba el
 *      inquilino, y así pasaban en verde `USING (1 = 1)` junto a una
 *      buena, `USING (current_workspace_id() IS NOT NULL)` o un
 *      `FOR DELETE USING (workspace_id IS NOT NULL)` con el que B
 *      borraba las filas de A. Qué cuenta como aislar está en
 *      src/politicas.ts; lo que es abierto a propósito se declara en
 *      POLITICAS_ABIERTAS_DECLARADAS con su motivo.
 *
 * LO QUE NO ES UNA TABLA PERO SE CONSULTA IGUAL
 * ---------------------------------------------
 *   · Vistas (relkind 'v'). En Postgres una vista lee sus tablas base
 *     con los privilegios de su DUEÑO salvo `security_invoker = on`; sin
 *     él rodea el muro de privilegios (medido: una vista sobre `niche`
 *     deja hacer UPDATE a mc_app). Se exige security_invoker o entrada
 *     en VISTAS_SIN_INVOCADOR.
 *   · Vistas materializadas ('m') y tablas foráneas ('f'). No admiten
 *     RLS: una materializada guarda las filas que vio quien la refrescó
 *     (el worker, con BYPASSRLS, las ve todas) y ALTER DEFAULT
 *     PRIVILEGES le da SELECT a mc_app al nacer. Medido: `CREATE
 *     MATERIALIZED VIEW mv AS SELECT * FROM webhook_event` y mc_app lee
 *     las cabeceras con firmas. Se exige que mc_app no tenga NINGÚN
 *     privilegio sobre ellas, o entrada en RELACIONES_SIN_RLS_DECLARADAS.
 *   · Funciones SECURITY DEFINER de `public`, TODAS, se puedan ejecutar
 *     o no. Corren con los privilegios de su dueño y rodean los GRANT
 *     igual que una vista. Hasta la ronda 4 solo se miraban las que
 *     mc_app podía EJECUTAR, y ese era el punto ciego: Postgres no
 *     comprueba EXECUTE al disparar, así que una función de disparador
 *     con EXECUTE revocado corre con su dueño cada vez que mc_app
 *     escribe en la tabla (medido: un disparador definer en company
 *     reescribía niche, un catálogo de solo lectura, con la guardia en
 *     verde). Se exige que no haya ninguna, o entrada en
 *     FUNCIONES_DEFINER_DECLARADAS. Y fuera de public, las que mc_app
 *     puede EJECUTAR en un esquema al que llega (extensions incluido):
 *     la comprobación de esquemas deja pasar extensions de oficio, y
 *     una función definer allí rodeaba los GRANT con la guardia en verde.
 *   · Disparadores de tablas de `public` que llaman a una función
 *     SECURITY DEFINER, de cualquier esquema: se exige su entrada en
 *     DISPARADORES_DEFINER_DECLARADOS.
 *   · Reglas (CREATE RULE) que no son el _RETURN de una vista. Su acción
 *     corre con los privilegios del dueño de la tabla, igual que un
 *     disparador definer: medido, `CREATE RULE … ON INSERT TO company DO
 *     ALSO UPDATE niche …` dejaba a B reescribir un catálogo. Se exige
 *     cero, o entrada en REGLAS_DECLARADAS.
 *   · Otros esquemas. La guardia mira `public`; una tabla en un esquema
 *     nuevo con GRANT ALL a mc_app pasaba en silencio. Se exige que
 *     mc_app no tenga USAGE en ningún esquema fuera de public,
 *     information_schema, pg_* y extensions (el de Supabase para las
 *     extensiones), o entrada en ESQUEMAS_DECLARADOS; y que no pueda
 *     CREAR en public.
 *   · El propio rol mc_app. Los privilegios se leen de los GRANT, pero un
 *     rol con BYPASSRLS o SUPERUSER se salta las políticas, y uno que
 *     pertenece a otro hereda lo suyo: con `GRANT mc_worker TO mc_app`,
 *     mc_app hace SET ROLE mc_worker y lo lee todo. Se exige que mc_app
 *     no tenga SUPERUSER, BYPASSRLS ni CREATEROLE, y que no sea miembro
 *     de ningún rol salvo los de ROLES_DE_LA_APP_DECLARADOS.
 *   · El rol de los enlaces públicos, mc_public_share (0030). Es la
 *     frontera de /kit/<slug> y /cotizacion/<slug>, que se abren desde
 *     internet sin sesión, y está en ROLES_CON_ACCESO_DECLARADOS, así
 *     que la comprobación de «otros roles» lo deja pasar. Medido en el
 *     pulido 4: `GRANT UPDATE (total) ON quote`, `GRANT SELECT ON
 *     contact`, una política `TO mc_public_share USING (true)` en invoice
 *     y `ALTER ROLE … BYPASSRLS` dejaban la guardia en verde; lo que 0030
 *     promete del rol solo lo comprobaba 0030 al aplicarse. Ahora se
 *     exige, en cada arranque: sus privilegios y columnas exactamente los
 *     de PRIVILEGIOS_DEL_ENLACE_PUBLICO, sus políticas exactamente las de
 *     POLITICAS_DEL_ENLACE_PUBLICO y con su forma, NOLOGIN, sin
 *     SUPERUSER, BYPASSRLS ni CREATEROLE, sin ser miembro de ningún rol
 *     y sin ser dueño de ninguna relación.
 *
 * BORRAR EL PADRE NO PUBLICA LA FILA
 * ----------------------------------
 * Una lectura «col IS NULL OR <el padre se ve>» dice que NULL es «de
 * todos». Si la clave ajena de esa columna es ON DELETE SET NULL, borrar
 * el padre publica la fila: con company.owner_workspace_id así, borrar un
 * workspace convertía su CRM en catálogo. La guardia cruza las columnas
 * de esas ramas (src/politicas.ts, `nulos`) con la acción de borrado de
 * su clave, y exige CASCADE o RESTRICT, o entrada en
 * BORRADOS_QUE_PUBLICAN_DECLARADOS.
 *
 * LAS REFERENCIAS, QUE LA CLAVE AJENA NO FILTRA
 * ---------------------------------------------
 * Postgres comprueba una clave ajena sin RLS: para él «existe» es
 * «existe en la base», no «existe para quien escribe». Así B nombraba en
 * company_link la empresa de A y una política que abría la empresa «si
 * la tengo vinculada» se la enseñaba. La migración 0025 §3 engancha un
 * disparador (assert_reference_visible) a cada clave ajena hacia una
 * tabla con RLS; esta guardia exige que esté en toda clave de ese tipo
 * en una tabla que mc_app pueda escribir, o su entrada en
 * REFERENCIAS_SIN_COMPROBAR_DECLARADAS.
 *
 * LOS ÍNDICES ÚNICOS, QUE SE COMPRUEBAN CONTRA TODAS LAS FILAS
 * ------------------------------------------------------------
 * Un índice único no pasa por RLS: B choca con la fila de A aunque no
 * la vea, y el 23505 le dice que ese valor ya lo tiene alguien. Medido
 * en la ronda 3 con contact.email: B aprendía que otra agencia tiene a
 * esa persona en su CRM, y no podía guardar la suya. La guardia recorre
 * TODOS los índices únicos y de exclusión de las tablas con RLS que
 * mc_app escribe (unicosSinInquilino) y exige que incluyan la columna de
 * inquilino o una clave ajena hacia una tabla aislada, que se limiten a
 * las filas sin dueño (esas mc_app no las escribe), o que sean la clave
 * primaria uuid de la fila; si no, entrada en UNICOS_GLOBALES_DECLARADOS.
 *
 * Y LOS PRIVILEGIOS, QUE RLS NO CUBRE
 * -----------------------------------
 * Una tabla SIN política no está protegida por RLS: está protegida por
 * el GRANT. PRIVILEGIOS_DE_LA_APP dice, tabla por tabla y con su motivo,
 * qué se le deja a mc_app; las migraciones 0024 y 0025 revocan el resto
 * y esta guardia comprueba que siga revocado. Además:
 *   · TRUNCATE, REFERENCES, TRIGGER y MAINTAIN no los tiene mc_app en
 *     ninguna relación: TRUNCATE se salta la RLS entera.
 *   · Ningún otro rol —PUBLIC incluido— tiene privilegios sobre nada de
 *     `public`, salvo el dueño, mc_app y los de ROLES_CON_ACCESO_DECLARADOS.
 *     En Supabase, anon y authenticated los expone PostgREST a internet.
 *   · Los GRANT POR COLUMNA cuentan como de tabla. Un REVOKE de tabla no
 *     los quita, y la ronda 3 solo leía pg_class.relacl: medido, `GRANT
 *     UPDATE (slug) ON niche TO mc_app` dejaba la guardia en verde y
 *     mc_app reescribía las 12 filas de un catálogo de solo lectura.
 *   · Las SECUENCIAS también. Una secuencia es de la tabla entera, no de
 *     un inquilino: con SELECT, `last_value` de audit_log_id_seq es el
 *     volumen de toda la plataforma. mc_app no tiene SELECT ni UPDATE en
 *     ninguna, y USAGE solo en las de tablas donde inserta.
 *
 * LA GUARDIA NO FALLA ABIERTA
 * ---------------------------
 * La ronda 1 tragaba el error de las consultas del inventario con un
 * `.catch(() => [])`. Con la lista vacía todo lo demás sale vacío y
 * explicarEsquema devuelve null: el arranque da verde AFIRMANDO que toda
 * tabla está aislada cuando lo que pasó es que no pudo preguntar. Ahora
 * el error se anota en `inventarioLeido` y se reporta como cualquier
 * otro problema: en producción, lanza. Y distingue «la base no contesta»
 * de «la base no tiene schema_migrations»: al que opera no se le dice
 * que migre una base que solo está caída.
 */
import { getTableColumns, getTableName, getViewName, getViewSelectedFields, is } from 'drizzle-orm';
import { PgColumn, PgTable, PgView } from 'drizzle-orm/pg-core';
import type { CatalogDb } from './client.ts';
import * as schema from './schema/index.ts';
import {
  COLUMNAS_DE_INQUILINO, terminosDelAnd, veredicto, type AislamientoDeLectura, type ContextoDePolitica, type Lado,
  type ReferenciaDeTabla,
} from './politicas.ts';

/**
 * Las tablas de `public` que NO llevan aislamiento por fila, y por qué.
 *
 * Es la ÚNICA puerta de salida de la guardia de tablas, así que cada
 * línea es una decisión que alguien firmó, no un olvido. Para añadir una
 * entrada hay que poder escribir el motivo; si el motivo no sale, la
 * tabla necesita política.
 *
 * Todas ellas están además en PRIVILEGIOS_DE_LA_APP: sin RLS, lo único
 * que las protege es el GRANT. Lo comprueba `excepcionesSinPrivilegios`,
 * porque una excepción nueva sin su entrada de privilegios nacería sin
 * RLS y con los cuatro privilegios de mc_app (ALTER DEFAULT PRIVILEGES
 * se los da al nacer).
 */
export const EXCEPCIONES_SIN_AISLAMIENTO: Readonly<Record<string, string>> = {
  // ------ catálogos globales: los mismos para todos los inquilinos ---
  platform: 'catálogo de redes (límites y capacidades). Igual para todos; lo llena una migración',
  niche: 'catálogo de nichos. Igual para todos; lo llena una migración',
  niche_cpm_benchmark: 'CPM de referencia por nicho y país: dato público con su fuente',
  signal_source: 'catálogo de fuentes de señales del radar',
  job_definition: 'catálogo de trabajos del worker (cola, reintentos, cron)',
  preflight_rule: 'reglas del preflight de video (0012), versionadas por ruleset',
  benchmark: 'cifras públicas de referencia con su fuente y su nivel de evidencia (0013)',
  blocked_claim: 'afirmaciones que el producto no deja escribir, y qué decir en su lugar (0013)',
  metric_requirement: 'qué exige cada red para entregar cada grupo de métricas (0011)',

  // ------ observación de terceros: no hay inquilino a quien aislar ---
  // OJO, para cuando llegue el radar (fase 2): «sin dueño» no es
  // «anónimo». Estas filas —y las de external_post por su rama «IS
  // NULL»— las llena el worker a partir de los watch_target de CADA
  // inquilino, que son listas privadas. Si una fila existe porque alguien
  // la vigila, publicarla deja a cualquier workspace inferir qué cuentas
  // ajenas vigila la plataforma. Regla: sin dueño solo lo que venga de
  // fuentes públicas (creative_center, hashtag_search); lo que salga de
  // una lista privada (source 'watchlist') lleva el workspace_id de esa
  // lista y su política. Hoy las tablas están vacías y el radar no existe.
  external_account_baseline:
    'línea base de cuentas AJENAS que el radar observa, sin workspace. Solo vale mientras cada fila venga de una ' +
    'fuente pública: la derivada de un watch_target (lista privada de un inquilino) no es anónima por construcción ' +
    'y tiene que llevar su workspace_id y su política (ver la nota de arriba)',
  trend_signal:
    'tendencias por red y nicho, sin dueño. Solo las de fuente pública (creative_center, hashtag_search): una fila ' +
    "con source 'watchlist' sale de la lista privada de un inquilino y dejaría inferir qué vigila; esa tiene que " +
    'llevar workspace_id y política antes de que el radar escriba la primera (ver la nota de arriba)',

  // ------ ni catálogo ni inquilino ------------------------------------
  webhook_event:
    'bitácora cruda de lo que mandan las plataformas (cuerpo y cabeceras, con firmas). Se cierra por privilegio: ' +
    'mc_app no tiene NINGUNO sobre ella. Es del worker',
  contact_suppression:
    'la baja global (0007, 0026 §3, 0029 §1): correos que nadie en la plataforma vuelve a contactar, sin el ' +
    'workspace que la registró. No es de ningún inquilino; se cierra por privilegio (mc_app no tiene ninguno). La ' +
    'llena SOLO el worker con una baja verificable de la propia persona, y la aplica el disparador ' +
    'contact_suppression_apply (declarado en DISPARADORES_DEFINER_DECLARADOS)',
  schema_migrations:
    'contabilidad del runner de migraciones (db/lib/aplicar.mjs), no dato del producto. La lee esta misma guardia',
};

/**
 * Las políticas que NO aíslan a propósito, y por qué. La clave es
 * `tabla.politica`.
 *
 * Una política permisiva abierta anula a todas las demás de su tabla
 * (se combinan con OR), así que la guardia evalúa cada una por separado
 * (src/politicas.ts) y exige que las abiertas estén aquí. Hoy hay una.
 */
export const POLITICAS_ABIERTAS_DECLARADAS: Readonly<Record<string, string>> = {
  'api_call_log.api_call_log_insert':
    'la rama «connection_id IS NULL» del alta: el camino de OAuth que FALLA registra sus llamadas antes de que ' +
    'exista la conexión (conexiones/oauth-handlers.ts). Esas filas no las lee nadie más que el worker ' +
    '(api_call_log_read exige la conexión), así que escribirlas no expone nada de ningún inquilino',
  'outbound_sequence_template.outbound_sequence_template_read':
    'las plantillas de secuencia (0037 §1 y §7.3) son un catálogo GLOBAL sin workspace ni dato de ningún inquilino: ' +
    'las mismas para todos. Lectura abierta y ninguna política de escritura para mc_app (además del REVOKE), así que ' +
    'esta política no abre nada que escribir',
};

/**
 * Las vistas de `public` que NO corren con los privilegios de quien
 * consulta, y por qué. 0024 §8 les pone security_invoker a todas en un
 * bucle; esta lista es para la que alguien añada mañana con una razón
 * para dejarla fuera. Por eso está vacía.
 */
export const VISTAS_SIN_INVOCADOR: Readonly<Record<string, string>> = {};

/**
 * Las vistas materializadas y tablas foráneas de `public` sobre las que
 * mc_app puede tener privilegios, y por qué. No admiten RLS, así que lo
 * único que las cierra es no concederle nada a mc_app. Vacía: hoy no
 * hay ninguna.
 */
export const RELACIONES_SIN_RLS_DECLARADAS: Readonly<Record<string, string>> = {};

/**
 * Las funciones SECURITY DEFINER de `public`, por su firma
 * (`nombre(tipos)`), y por qué. TODAS, se puedan ejecutar o no: quitarle
 * EXECUTE a mc_app no cierra nada si la función es de un disparador.
 * Las de otro esquema al que llega mc_app (extensions) se declaran con
 * el esquema delante, `extensions.nombre(tipos)`, y solo si mc_app las
 * puede ejecutar. Hoy no hay ninguna.
 */
export const FUNCIONES_DEFINER_DECLARADAS: Readonly<Record<string, string>> = {
  'contact_suppression_apply()':
    'la baja global (0026 §3, 0029 §1): mc_app no puede leer contact_suppression, y un contacto que nace con un ' +
    'correo suprimido tiene que nacer dado de baja. Solo LEE la lista y cambia NEW; no escribe ninguna tabla. La ' +
    'lista la llena solo el worker con una baja verificada, así que lo que aplica no lo puede fabricar un workspace',
  // Los enlaces públicos de Cotizar (0030, COT-2 a COT-4). La web los abre
  // sin sesión y sin workspace (Db.withPublicShare), y estas tres son lo
  // ÚNICO que esa transacción puede hacer.
  'public_media_kit(text,text,boolean,text)':
    'abre /kit/<slug> sin sesión (0030). Corre como mc_public_share —NOLOGIN, sin BYPASSRLS, sin ninguna tabla ' +
    'entera—, cuyas políticas `TO mc_public_share` abren solo la fila cuyo slug fija la propia función y restaura ' +
    'al salir. Devuelve jsonb recortado, nunca la fila; la contraseña se compara por derivado y los fallos se ' +
    'cuentan por origen (resumen de la IP, nunca la IP) y por enlace, en media_kit_lockout y media_kit. No es de ningún ' +
    'disparador',
  'public_quote(text,boolean)':
    'abre /cotizacion/<slug> sin sesión (0030), con el mismo rol y la misma cerradura que public_media_kit: lee el ' +
    'public_snapshot congelado al enviar y solo escribe los contadores de visita y la fecha de vista o vencida ' +
    '(privilegios de COLUMNA)',
  'public_quote_accept(text,text,text)':
    'acepta la cotización desde el enlace (0030, COT-4): marca la cotización aceptada con la firma y pasa el deal a ' +
    '«Ganado» con su historial por deal_move_stage (0031, SECURITY INVOKER: corre con los permisos de ' +
    'mc_public_share). Ese rol solo tiene UPDATE en esas columnas del deal —etapa, fechas de cierre, probabilidad, ' +
    'motivo de pérdida y el monto con su moneda, que la función copia de la cotización que acaba de leer por su ' +
    'slug— y SELECT de la etapa: no puede tocar el total de la cotización ni el nombre, la empresa o el dueño del ' +
    'negocio; la campaña la crea después la web dentro del workspace de la cotización',
  // La baja desde el enlace de un correo (0037 §9, VEN-9 y VEN-15).
  'public_optout(text)':
    'la baja desde el enlace de un correo (0037 §9, entregabilidad §8): la página se abre sin sesión y la baja vale para el ' +
    'workspace que envió ese correo, en todos sus canales. Corre como mc_public_share, cuyas políticas `TO ' +
    'mc_public_share` abren solo el enlace (outbound_optout_link, que escribe solo el despachador) cuyo sha256 del ' +
    'token fija la función, y después la ficha que recibió el correo y las PROPIAS de ese workspace con la dirección ' +
    'a la que salió. Escribe por COLUMNA: la baja de esas fichas, el estado y el motivo de sus toques pendientes, el ' +
    'estado de sus enrolamientos, la dirección en outbound_workspace_optout y el clic en outbound_optout_event. Nunca ' +
    'contact_suppression (entregabilidad §8). No es de ningún disparador',
  'public_optout_preview(text,uuid[])':
    'lo que la página de baja enseña antes del clic (entregabilidad §5, VEN-15): con el mismo rol y la misma cerradura que ' +
    'public_optout, LEE el enlace por el sha256 del token, si la ficha ya estaba de baja y el nombre del workspace ' +
    'que envió (id y name, por columna, solo esa fila); devuelve la dirección enmascarada y un sí o un no a «quien ' +
    'lo abre es de ese workspace», nunca el id. No escribe nada. No es de ningún disparador',
  // La regla de la baja de outbound_touch mira la lista global (0037 §4.1).
  'address_is_suppressed(citext)':
    'la regla de la baja de outbound_touch (0037 §4.1) compara el correo de la ficha y recipient_address con la ' +
    'baja global, y mc_app no puede leer contact_suppression (0026 §3). Solo LEE la lista y responde sí o no para ' +
    'UNA dirección: lo mismo que un workspace ya aprende creando una ficha con ese correo, que nace dada de baja ' +
    '(contact_suppression_apply). EXECUTE solo para mc_app y mc_worker',
  // El callback de un canal de outreach desde la web (callback_de_canales, VEN-9).
  'outreach_channel_connect(text,text,text,text,text,text[],text)':
    'el callback de la conexión de un canal (callback_de_canales, canales_identidad_y_rotacion con la identidad del perfil): la web es mc_app y el disparador de 0037 §2.1 no le deja escribir ' +
    'un estado autenticado. Es del rol que migra (despachador por ser dueño de outbound_touch) y, como las tablas ' +
    'llevan FORCE ROW LEVEL SECURITY, solo ve el workspace de la transacción: pasa a connected la fila pending de ESE ' +
    'nonce (de un solo uso, nace al empezar la conexión) con la cuenta que devolvió el proveedor, o revive la fila que ' +
    'el espacio ya tenía. Un buzón vivo en otro espacio lo dice el índice global con 23505 y responde taken sin ' +
    'escribir; una fila que sales.channels_release reclamó para soltarla responde releasing sin escribir (canales_reclamar_al_soltar), y al ' +
    'revivir una fila desconectada con una ref nueva borra del vault el token viejo que ya nadie nombra. Con la ' +
    'identidad (canales_identidad_y_rotacion): el mismo perfil ya conectado aquí responde duplicate sin escribir; caído o desconectado, su ' +
    'fila adopta la cuenta nueva y devuelve la vieja para borrarla en Unipile. in_use dice si la cuenta la usa alguien ' +
    '(outreach_channel_live_elsewhere, sin escribir). La llaman las rutas de la web tras verificar el estado firmado y ' +
    'hablar con el proveedor. EXECUTE solo para mc_app. No es de ningún disparador',
  'outreach_resolve_unconfirmed(uuid,text)':
    'una persona resuelve en la ficha un mensaje retenido porque no se supo si un intento salió (0053, VEN-10): ' +
    'was_sent lo anota como enviado y marca el enlace de baja de ese intento; resend lo devuelve a la cola, borra ese ' +
    'enlace y devuelve su plaza. Solo el toque held con unconfirmed_attempt del workspace de la transacción; las ' +
    'columnas del intento y outbound_optout_link son del despachador. Pide ser del equipo (membership_is_team, 0055; ' +
    'sin identidad, solo con app.auth_disabled): las políticas no frenan a una SECURITY DEFINER. EXECUTE a mc_app y ' +
    'mc_worker. No es de ningún disparador',
  // La redacción que pide una persona y el pitch a mano (0057, VEN-12).
  'outbound_generation_request(uuid,text,text,uuid)':
    'una persona pide desde el editor del pitch que la IA redacte o regenere con una pista cerrada (0057, VEN-12): ' +
    'mc_app no escribe outbound_generation (0056). Del rol que migra, con la cerradura de 0053: solo un correo nuevo ' +
    'en draft o held del workspace de la transacción, sin intento sin confirmar y cuya persona no pidió la baja; deja ' +
    'la fila en requested con la pista (del CHECK) y devuelve un held a draft. No escribe texto. EXECUTE solo para ' +
    'mc_app. No es de ningún disparador',
  'outbound_generation_save_manual(uuid,text,text)':
    'el pitch que escribe o edita una persona (0057, VEN-12): guarda su marcado [claim:id] en outbound_generation con ' +
    'outcome manual, o borra la fila si no hay texto, y así ningún job escribe encima de lo suyo. Mismo dueño y misma ' +
    'cerradura: solo un correo del workspace de la transacción en draft o held, sin intento sin confirmar (la misma ' +
    'guardia que outbound_generation_request, 0059); si no, not_editable sin escribir. La llama savePitch después de ' +
    'guardar el borrador con el pre-vuelo del servidor y antes de programarlo. EXECUTE solo para mc_app. No es de ningún disparador',
  'outreach_writer_status()':
    '¿el worker redacta con IA? (0057, VEN-12): la llave de Anthropic vive en el worker y la web lo sabe por la última ' +
    'corrida de outbound.generate en job_run, que de un cron no tiene workspace. Solo LEE esas filas (una política TO ' +
    'CURRENT_USER por job_id) y devuelve una palabra: anthropic, fake, off o unknown. EXECUTE solo para mc_app',
  'outreach_classifier_status()':
    '¿el worker clasifica las respuestas con IA? (0065, VEN-14): la misma forma que outreach_writer_status, con la ' +
    'última corrida de outbound.intent en job_run. Solo LEE esas filas (una política TO CURRENT_USER por job_id) y ' +
    'devuelve una palabra: model, fake, off o unknown. EXECUTE solo para mc_app',
  'outreach_channel_mark_down(uuid,text)':
    'el aviso account_status de Unipile desde la web (callback_de_canales): una cuenta de Unipile connected o error del workspace de ' +
    'la transacción pasa a needs_reconnect con el motivo. Mismo dueño y misma cerradura que outreach_channel_connect; ' +
    'no toca otra columna. EXECUTE solo para mc_app. No es de ningún disparador',
  'outreach_channel_mark_ok(uuid)':
    'el aviso account_status de Unipile de una sesión que volvió (canales_identidad_y_rotacion): una cuenta de Unipile needs_reconnect o error ' +
    'del workspace de la transacción vuelve a connected. La pareja de outreach_channel_mark_down, mismo dueño y misma ' +
    'cerradura; no toca otra columna. EXECUTE solo para mc_app. No es de ningún disparador',
  'outreach_channel_set_webhooks(uuid,text[],text)':
    'los avisos de Unipile que la web acaba de dar de alta para una cuenta conectada (canales_liberar_y_limites, canales_identidad_y_rotacion con la huella del ' +
    'secreto): provider_webhook_ids y provider_webhook_secret_fp son ' +
    'del despachador (sales.channels_release los borra en Unipile al desconectar) y mc_app no la escribe. Mismo dueño ' +
    'y misma cerradura que outreach_channel_connect: solo ve el workspace de la transacción y solo AÑADE ids con ' +
    'forma de id. EXECUTE solo para mc_app. No es de ningún disparador',
};

/**
 * Las funciones SECURITY INVOKER de `public` que el CÓDIGO llama por su
 * nombre, con la migración que las crea. Las DEFINER ya las cubre
 * FUNCIONES_DEFINER_DECLARADAS (si falta una, sale como declaración
 * obsoleta); estas no dejan rastro en ningún otro inventario, y en
 * Vercel —donde el bundle no lleva db/migrations y no hay «pendientes»
 * que comparar— una base sin 0031 pasaba la guardia en verde y el
 * tablero de Ventas, «Enviar» en Cotizar y la aceptación pública caían
 * en el primer clic con «function deal_move_stage does not exist». Se
 * comprueba que existan con esa firma y que mc_app las pueda ejecutar.
 */
export const FUNCIONES_QUE_USA_EL_CODIGO: Readonly<Record<string, string>> = {
  'deal_move_stage(uuid,text,boolean,numeric,text)':
    '0031_mover_negocio: el tablero de Ventas, «Enviar» y «Aceptar» en Cotizar y la aceptación pública',
  'brand_key(text)': '0031_mover_negocio: el radar y las listas de Ventas reconocen una marca por su nombre',
};

/**
 * Las columnas que el CÓDIGO lee y escribe, como `relación.columna`:
 * todas las de las tablas y vistas de src/schema, sacadas del propio
 * esquema Drizzle y no de una lista a mano.
 *
 * Es el mismo punto ciego que FUNCIONES_QUE_USA_EL_CODIGO, con columnas.
 * En Vercel no hay «pendientes» que comparar, y 0032 no crea funciones
 * ni tablas: añade deal.next_action_kind (y su disparador). Una base
 * con 0031 y sin 0032 pasaba la guardia en verde y caía en el primer
 * «Aceptar» del radar, y en cualquier `select().from(deal)`, con
 * «column next_action_kind does not exist». Escrita a mano, la lista
 * volvería a quedarse atrás en la siguiente migración que añada una
 * columna; derivada del esquema, crece sola, y test/schema.test.ts ya
 * exige que src/schema sea exactamente lo que deja db/migrations.
 *
 * Solo se comprueba que existan: lo que mc_app puede hacer con ellas lo
 * miden los privilegios de tabla (PRIVILEGIOS_DE_LA_APP y el aislamiento).
 */
export const COLUMNAS_QUE_USA_EL_CODIGO: readonly string[] = (() => {
  const claves = new Set<string>();
  for (const valor of Object.values(schema) as unknown[]) {
    if (is(valor, PgTable)) {
      const tabla = getTableName(valor);
      for (const col of Object.values(getTableColumns(valor))) claves.add(`${tabla}.${col.name}`);
    } else if (is(valor, PgView)) {
      const vista = getViewName(valor);
      for (const campo of Object.values(getViewSelectedFields(valor))) {
        if (is(campo, PgColumn)) claves.add(`${vista}.${campo.name}`);
      }
    }
  }
  return [...claves].sort();
})();

/**
 * Los disparadores de tablas de `public` que llaman a una función
 * SECURITY DEFINER (de cualquier esquema), como `tabla.disparador`, y por
 * qué. Postgres no comprueba EXECUTE al disparar: el cuerpo corre con los
 * privilegios del dueño de la función para CUALQUIERA que escriba en la
 * tabla. Es la forma de rodear el muro de GRANT que abrió la baja global
 * de 0026 §3 (cualquier workspace escribía en contact_suppression).
 */
export const DISPARADORES_DEFINER_DECLARADOS: Readonly<Record<string, string>> = {
  'contact.contact_suppression_apply':
    'aplica la baja global al contacto que nace o cambia de correo (0029 §1). Lee contact_suppression, que solo ' +
    'escribe el worker; lo que aprende quien escribe es que ese correo pidió no ser contactado, que es justo lo que ' +
    'la baja tiene que decirle, y no quién lo tiene en su CRM',
};

/**
 * Los disparadores que son un CANDADO de seguridad, como
 * `tabla.disparador`, y qué cierran. No hay GRANT que los sustituya (un
 * GRANT por columnas rompería los INSERT de Drizzle, que nombran todas
 * las columnas), así que la guardia exige en cada arranque que existan y
 * que estén activos: `ALTER TABLE … DISABLE TRIGGER` no deja rastro en
 * schema_migrations y abriría el hueco sin que nadie lo viera.
 */
export const DISPARADORES_DE_CANDADO: Readonly<Record<string, string>> = {
  'outbound_touch.outbound_touch_worker_columns':
    'provider_message_id, message_id_rfc y recipient_address solo los escribe el despachador, un toque con esas ' +
    'pruebas no cambia de contacto ni de empresa, un toque en sent no vuelve atrás, y el estado processing solo ' +
    'lo pone y lo quita el despachador (0037 §4.2). Sin él, un workspace movía un envío de verdad a la ficha de ' +
    'otra persona, devolvía a la cola un correo que ya salió (un segundo envío), o ponía un toque en processing ' +
    'para dejarlo fuera de public_optout y de disable_outreach, que no tocan lo reclamado',
  'outbound_touch.outbound_touch_keep_sent':
    'un toque con pruebas de envío, o en processing, no se borra desde la aplicación (0037 §4.2): es el registro ' +
    'de lo que la plataforma envió o está enviando. Las cascadas de empresa y workspace sí pasan; el enlace de ' +
    'baja vive aparte',
  'outbound_touch.outbound_touch_optout_link_required':
    'un correo no queda reclamado (processing) sin el enlace de baja de su intento en outbound_optout_link (0037 ' +
    '§4.5), comprobado al COMMIT. Sin él, un correo podía salir con un token que la base nunca guardó (el ' +
    'despachador cae entre el proveedor y el COMMIT) y la baja respondía not_found',
  'outbound_touch.outbound_touch_optout_link_required_insert':
    'lo mismo que outbound_touch_optout_link_required para un toque que nace en processing',
  'outbound_optout_link.outbound_optout_link_check':
    'un enlace de baja dice lo mismo que su toque al crearse, y después no se reescribe: solo se anota sent_at una ' +
    'vez (0037 §4.5). Sin él, el despachador podía mover a otra dirección la baja de un correo que ya salió',
  'outbound_touch.outbound_touch_enrollment_check':
    'un toque es del mismo workspace y contacto que su enrolamiento, y su paso es de la misma secuencia (0037 ' +
    '§4.4). Sin él, un toque del enrolamiento de X con contact_id Y se saltaba la regla de la baja, que mira ' +
    'el contacto del toque',
  'outreach_channel_account.outreach_channel_account_worker_columns':
    'el estado autenticado, provider_account_id, secret_ref, scopes, warmup_started_at y last_ok_at de una cuenta ' +
    'de canal los escribe solo el callback del proveedor, y channel y provider no cambian desde la web (0037 §2.1, ' +
    '0042). Sin él, un workspace ocupaba el buzón de otra persona en toda la plataforma ' +
    '(outreach_channel_account_live_idx) con una fila «connected» sin OAuth, sacaba un buzón conectado del índice ' +
    'global cambiándole el canal, o se saltaba el calentamiento de VEN-15',
  'outreach_channel_account.outreach_channel_account_keep_live':
    'desde la web solo se borra la fila pendiente de un intento de conexión (0037 §2.1): una cuenta que ya envió se ' +
    'desconecta. Sin él, borrar la cuenta se llevaba en cascada sus contadores del día y de la semana, y reconectar ' +
    'el mismo buzón devolvía la plaza que 7.4 le quita a la aplicación',
  'outbound_policy.outbound_policy_llm_cap':
    'llm_daily_cap_usd lo fija la plataforma (0037 §6.1): la llave de Anthropic es de On Cue, y con un UPDATE un ' +
    'workspace se quitaba su propio techo de gasto',
  'outbound_policy.outbound_policy_optout_link':
    'require_optout_link no lo apaga el workspace (0037 §6.1): es lo único que hace obligatorio el enlace de baja ' +
    'de cada correo (outbound_touch_optout_link_required). Sin él, el mismo workspace que envía se quitaba ' +
    'public_optout y el pie que pide CAN-SPAM con un UPDATE',
  'outbound_enrollment.outbound_enrollment_optout':
    'no se enrola ni se reanuda a quien pidió la baja, por su ficha o por su correo en la lista global (0037 §3.3): ' +
    'sin él, el alta quedaba viva y el motor chocaba con la regla de outbound_touch en cada vuelta',
  'outbound_touch.outbound_touch_optout':
    'no se programa, no se reclama ni se envía a quien pidió la baja (0007, en las transiciones desde 0037 §4.1)',
};

/**
 * Las reglas (CREATE RULE) de `public` que no son el _RETURN de una
 * vista, como `tabla.regla`, y por qué. Su acción corre con los
 * privilegios del dueño de la tabla. Vacía: el esquema no usa ninguna.
 */
export const REGLAS_DECLARADAS: Readonly<Record<string, string>> = {};

/**
 * Los esquemas, además de public, information_schema, pg_* y extensions,
 * en los que mc_app puede tener USAGE, y por qué. La guardia solo mira
 * `public`: un esquema nuevo al que llega mc_app es un sitio donde nadie
 * pregunta. Vacía.
 */
export const ESQUEMAS_DECLARADOS: Readonly<Record<string, string>> = {};

/**
 * Los roles de los que mc_app puede ser miembro, y por qué. Un miembro
 * hereda los privilegios del rol —o puede hacer SET ROLE a él—, y esos
 * no salen en los GRANT de mc_app. Vacía: mc_app no pertenece a ninguno.
 */
export const ROLES_DE_LA_APP_DECLARADOS: Readonly<Record<string, string>> = {};

/**
 * Las columnas de tablas CON inquilino en las que `col =
 * current_user_id()` aísla por sí sola, como `tabla.columna`, y por qué.
 * En una tabla con workspace_id, aislar por persona abre a quien está en
 * dos workspaces las filas del otro; aquí se dice dónde eso es lo que se
 * quiere.
 */
export const AISLADAS_POR_PERSONA_DECLARADAS: Readonly<Record<string, string>> = {
  'membership.user_id':
    'cada persona lee SUS membresías en todos sus workspaces: es la lista de a qué workspaces puede entrar (CIM-3). ' +
    'Una membresía dice solo el par persona–workspace, y la persona es la de la sesión',
};

/**
 * Las claves ajenas ON DELETE (o ON UPDATE) SET NULL / SET DEFAULT sobre
 * una columna cuya rama «IS NULL» abre la fila a todos, como
 * `tabla.columna`, y por qué. Borrar el padre publica la fila. Vacía.
 */
export const BORRADOS_QUE_PUBLICAN_DECLARADOS: Readonly<Record<string, string>> = {};

/**
 * Los roles, además del dueño de cada relación y de mc_app, que pueden
 * tener privilegios sobre `public`. Cualquier otro —PUBLIC, anon,
 * authenticated— se reporta: en Supabase, PostgREST expone anon y
 * authenticated a internet con la llave pública.
 */
export const ROLES_CON_ACCESO_DECLARADOS: Readonly<Record<string, string>> = {
  mc_worker: 'el worker (BYPASSRLS): jobs globales y lo que ninguna pantalla escribe. GRANT de 0014',
  service_role:
    'rol de administración de Supabase (BYPASSRLS): se lo concede ALTER DEFAULT PRIVILEGES de mc_migrator. ' +
    'Su llave vive cifrada en el vault y ningún código de este repositorio la usa',
  mc_public_share:
    'dueño de las funciones de los enlaces públicos: las tres de Cotizar (0030) y las dos de la baja (0037 §9 y ' +
    'entregabilidad §5). NOLOGIN, sin ' +
    'BYPASSRLS: ninguna ' +
    'conexión entra con él. Lo que puede, privilegio por privilegio y columna por columna, lo dice ' +
    'PRIVILEGIOS_DEL_ENLACE_PUBLICO; sus políticas, POLITICAS_DEL_ENLACE_PUBLICO; y la guardia comprueba las dos ' +
    'listas y sus atributos en cada arranque, no solo la migración al aplicarse',
};

/** El rol que atiende los enlaces públicos (Cotizar, 0030; la baja, 0037 §9): dueño de sus funciones SECURITY DEFINER. */
export const PUBLIC_SHARE_ROLE = 'mc_public_share';

/** Lo que el rol de los enlaces públicos puede hacer sobre una relación de `public`. */
export interface PrivilegiosDelEnlace {
  /** Privilegios de la relación entera (SELECT, INSERT; USAGE en una secuencia). */
  tabla: readonly string[];
  /** Privilegios que tiene SOLO en esas columnas. */
  columnas?: Readonly<Record<string, readonly string[]>>;
  motivo: string;
}

/**
 * TODO lo que mc_public_share puede hacer en `public`, exacto. Es la
 * promesa de la cabecera de 0030 —«aunque una función tuviera un error,
 * no podría tocar el total de una cotización ni el nombre de un deal:
 * Postgres se lo niega»—, y esa promesa solo vale mientras los GRANT
 * sean estos. La migración comprueba los atributos del rol una vez, al
 * aplicarse; esta lista es lo que la guardia vuelve a mirar en cada
 * arranque y en `make db.guardia`. Un privilegio de más (una tabla, una
 * columna, un GRANT de tabla entera donde se concede por columna) se
 * reporta siempre; uno de menos, solo con la base al día, porque contra
 * una base anterior a 0030/0031 no existe todavía.
 *
 * Un cambio aquí va con la migración que lo concede o lo revoca.
 */
export const PRIVILEGIOS_DEL_ENLACE_PUBLICO: Readonly<Record<string, PrivilegiosDelEnlace>> = {
  media_kit: {
    tabla: ['SELECT'],
    columnas: { UPDATE: ['failed_attempts', 'failed_since', 'locked_until', 'view_count'] },
    motivo: 'abrir /kit/<slug>, sumar la visita y contar las contraseñas fallidas del enlace (0030 §3)',
  },
  media_kit_lockout: {
    tabla: ['DELETE', 'INSERT', 'SELECT'],
    columnas: { UPDATE: ['failed_attempts', 'locked_until', 'updated_at'] },
    motivo:
      'el bloqueo POR ORIGEN del media kit (0030 §2 y §3): contar el fallo, borrar la fila al acertar y podar las ' +
      'viejas. Solo las filas del kit compartido: su política hereda de media_kit, que para este rol es la del slug',
  },
  quote: {
    tabla: ['SELECT'],
    columnas: {
      UPDATE: [
        'accepted_at', 'accepted_by_email', 'accepted_by_name', 'expired_at', 'status', 'superseded_by', 'view_count',
        'viewed_at',
      ],
    },
    motivo:
      'abrir /cotizacion/<slug> y marcarla vista, vencida o aceptada; nunca sus montos ni sus partidas (0030 §3). ' +
      'superseded_by: dejarla sin efecto, apuntando a la aceptada del mismo negocio, si llega tarde (0033 §3)',
  },
  deal: {
    tabla: ['SELECT'],
    columnas: { UPDATE: ['amount', 'currency', 'lost_at', 'lost_reason', 'probability', 'stage_id', 'won_at'] },
    motivo:
      'pasar a «Ganado» el negocio de la cotización aceptada (0030 §3) con deal_move_stage, que escribe también el ' +
      'monto y la moneda de la cotización (0031). Nunca el nombre, la empresa, el dueño ni la siguiente acción',
  },
  deal_stage_history: {
    tabla: ['INSERT', 'SELECT'],
    motivo: 'el paso de etapa de la aceptación queda en el historial (0030 §3)',
  },
  deal_stage_history_id_seq: { tabla: ['USAGE'], motivo: 'el id del INSERT en deal_stage_history (0030 §3)' },
  pipeline_stage: {
    tabla: ['SELECT'],
    motivo: 'leer la etapa del negocio: la pide assert_reference_visible de 0025 al cambiar deal.stage_id (0030 §3)',
  },
  // La baja desde el enlace de un correo (0037 §9). Sus políticas dicen qué filas.
  outbound_touch: {
    tabla: ['SELECT'],
    columnas: { UPDATE: ['blocked_reason', 'status'] },
    motivo:
      'encontrar el toque enviado por el sha256 del token y cancelar lo pendiente del contacto que pide la baja, en ' +
      'cualquier workspace (0037 §9). Nunca el cuerpo, el destinatario ni las fechas',
  },
  outbound_enrollment: {
    tabla: ['SELECT'],
    columnas: { UPDATE: ['finished_at', 'status'] },
    motivo: 'pasar a opted_out los enrolamientos de ese contacto y anotar cuándo terminaron (0037 §9)',
  },
  contact: {
    tabla: ['SELECT'],
    columnas: { UPDATE: ['opted_out', 'opted_out_at', 'opted_out_reason'] },
    motivo:
      'leer si la ficha que recibió el correo ya estaba de baja y marcar la baja en ella y en las fichas con la ' +
      'dirección a la que salió (0037 §9). Nunca el correo, el nombre ni el dueño',
  },
  company: {
    tabla: ['SELECT'],
    motivo:
      'contact_read (0029 §3) pregunta por la empresa del contacto y también le alcanza a este rol: sin SELECT, la ' +
      'baja no podría leer la ficha (0037 §9). company_read le deja ver solo el catálogo compartido (sin dueño)',
  },
  company_link: {
    tabla: ['SELECT'],
    motivo:
      'el WITH CHECK de contact_write (0020) pregunta por company_link al marcar la baja (0037 §9). Su política es ' +
      'la de 0010: sin workspace fijado, este rol no ve ninguna fila',
  },
  outbound_optout_link: {
    tabla: ['SELECT'],
    motivo:
      'encontrar el enlace por el sha256 del token: la dirección a la que salió el correo, la ficha y el workspace ' +
      'que lo envió (0037 §4.5 y §9). No lo escribe',
  },
  outbound_optout_event: {
    tabla: ['INSERT'],
    motivo: 'anotar el clic con el workspace y el toque que lo originaron (0037 §4.6). No lo lee',
  },
  // Lo que la página de baja enseña antes del clic (entregabilidad §5).
  workspace: {
    tabla: [],
    columnas: { SELECT: ['id', 'locale', 'name'] },
    motivo:
      'el nombre del workspace que envió el correo del enlace, para decir quién escribe, y su idioma, para que la ' +
      'página hable el del pie del correo (entregabilidad §5, r5). Solo id, name y locale, y su política solo abre la fila que ' +
      'fija public_optout_preview',
  },
  membership: {
    tabla: [],
    columnas: { SELECT: ['user_id', 'workspace_id'] },
    motivo:
      'workspace_read_member (0028), la política sin TO de workspace, pregunta por membership al leer workspace: sin ' +
      'esto no se podría leer el nombre (entregabilidad §5). No le abre ninguna fila: ninguna política de membership es `TO ' +
      'mc_public_share`',
  },
  // La baja con quien envió (entregabilidad §8).
  outbound_workspace_optout: {
    tabla: ['INSERT'],
    columnas: { SELECT: ['email', 'workspace_id'] },
    motivo:
      'la baja vale para el workspace que envió el correo (el alta, solo con el token, el workspace y la dirección ' +
      'del enlace), y la vista previa y la baja leen si ESE workspace ya la tenía, para decir «ya estabas fuera» ' +
      '(entregabilidad §8). Solo la fila del workspace y la dirección que fija la función',
  },
};

/** Cómo tiene que ser una política `TO mc_public_share`. */
export interface PoliticaDelEnlace {
  /** polcmd: r = SELECT, w = UPDATE, a = INSERT (se mira su WITH CHECK). */
  cmd: string;
  /**
   * Lo que tiene que decir la expresión. USING y, si lo trae, WITH CHECK
   * necesitan un término de su AND de primer nivel, sin ningún OR, que
   * cumpla TODAS estas expresiones. Es una comprobación de forma, no un
   * demostrador: basta para que `USING (true)`, `true OR …` o un EXISTS
   * sin correlación no pasen en verde.
   */
  exige: readonly RegExp[];
  motivo: string;
}

const SLUG_DE_LA_LLAMADA = /\bslug = NULLIF\(current_setting\('app\.public_share'/;
const DEAL_DE_LA_COTIZACION = [/^EXISTS \(SELECT 1 FROM quote q WHERE/, /\bq\.deal_id = deal\.id\b/, SLUG_DE_LA_LLAMADA];
/** La baja (0037 §9): el sha256 del token, y la lista de contactos que public_optout fija. */
const TOKEN_DE_LA_BAJA = /^\(?token_hash = NULLIF\(current_setting\('app\.public_optout'/;
const CONTACTOS_DE_LA_BAJA = /= ANY \(\(NULLIF\(current_setting\('app\.public_optout_contacts'/;

/**
 * Las políticas `TO mc_public_share`, exactas: las siete de 0030, la de 0033, las nueve de la baja (0037 §9), la de
 * quién envía (entregabilidad §5) y las dos de la baja con quien envió (entregabilidad §8). Una
 * de más —`CREATE POLICY … ON invoice TO mc_public_share USING (true)`—
 * o una de estas reescrita con ALTER POLICY se reporta. Las políticas
 * sin TO (PUBLIC) también le alcanzan, pero alcanzan igual a mc_app y
 * esas ya las mide la guardia de tablas.
 */
export const POLITICAS_DEL_ENLACE_PUBLICO: Readonly<Record<string, PoliticaDelEnlace>> = {
  'media_kit.media_kit_public_share': {
    cmd: 'r',
    exige: [SLUG_DE_LA_LLAMADA],
    motivo: 'el media kit público cuyo slug fija la función',
  },
  'media_kit.media_kit_public_share_views': {
    cmd: 'w',
    exige: [SLUG_DE_LA_LLAMADA],
    motivo: 'sumar la visita y las contraseñas fallidas de ese media kit',
  },
  'quote.quote_public_share': { cmd: 'r', exige: [SLUG_DE_LA_LLAMADA], motivo: 'la cotización enviada de ese slug' },
  'quote.quote_public_share_state': {
    cmd: 'w',
    exige: [SLUG_DE_LA_LLAMADA],
    motivo: 'marcar vista, vencida o aceptada esa cotización',
  },
  'quote.quote_public_share_accepted_sibling': {
    cmd: 'r',
    exige: [/^\(?\(?deal_id\)?::text = NULLIF\(current_setting\('app\.public_share_deal'/],
    motivo:
      'las ACEPTADAS del negocio de esa cotización, cuyo id fija public_quote_accept_impl mientras comprueba que el ' +
      'negocio no esté ya ganado con otra (0033): una aceptación por negocio, también desde el enlace',
  },
  'deal.deal_public_share': { cmd: 'r', exige: DEAL_DE_LA_COTIZACION, motivo: 'el negocio de esa cotización' },
  'deal.deal_public_share_won': {
    cmd: 'w',
    exige: DEAL_DE_LA_COTIZACION,
    motivo: 'pasar a «Ganado» el negocio de esa cotización',
  },
  'pipeline_stage.pipeline_stage_public_share': {
    cmd: 'r',
    exige: [
      /^EXISTS \(SELECT 1 FROM deal d WHERE/,
      /\bd\.stage_id = pipeline_stage\.id\b/,
      /\bd\.workspace_id = pipeline_stage\.workspace_id\b/,
    ],
    motivo: 'la etapa en la que está un negocio que el rol ya ve (deal_public_share decide cuál)',
  },
  // La baja desde el enlace de un correo (0037 §9).
  'outbound_optout_link.outbound_optout_link_public_optout': {
    cmd: 'r',
    exige: [TOKEN_DE_LA_BAJA],
    motivo: 'el enlace cuyo sha256 del token fija public_optout',
  },
  'outbound_optout_event.outbound_optout_event_public_optout': {
    cmd: 'a',
    exige: [TOKEN_DE_LA_BAJA],
    motivo: 'anotar el clic de ese mismo enlace, y ningún otro',
  },
  'outbound_touch.outbound_touch_public_optout_contacts': {
    cmd: 'r',
    exige: [/\bcontact_id = /, CONTACTOS_DE_LA_BAJA],
    motivo: 'los toques de los contactos que se dan de baja',
  },
  'outbound_touch.outbound_touch_public_optout_cancel': {
    cmd: 'w',
    exige: [/\bcontact_id = /, CONTACTOS_DE_LA_BAJA],
    motivo: 'cancelar los toques pendientes de esos contactos',
  },
  'outbound_enrollment.outbound_enrollment_public_optout': {
    cmd: 'r',
    exige: [/\bcontact_id = /, CONTACTOS_DE_LA_BAJA],
    motivo: 'los enrolamientos de los contactos que se dan de baja',
  },
  'outbound_enrollment.outbound_enrollment_public_optout_cancel': {
    cmd: 'w',
    exige: [/\bcontact_id = /, CONTACTOS_DE_LA_BAJA],
    motivo: 'pasar a opted_out los enrolamientos de esos contactos',
  },
  'contact.contact_public_optout': {
    cmd: 'r',
    exige: [/^\(?id = /, CONTACTOS_DE_LA_BAJA],
    motivo: 'las fichas de los contactos que se dan de baja',
  },
  'contact.contact_public_optout_email': {
    cmd: 'r',
    exige: [/^\(?email = \(NULLIF\(current_setting\('app\.public_optout_email'/],
    motivo:
      'las fichas PROPIAS del workspace que envió con la dirección a la que salió el correo del enlace ' +
      '(recipient_address); desde entregabilidad §8, ninguna de otro workspace',
  },
  'contact.contact_public_optout_mark': {
    cmd: 'w',
    exige: [/^\(?id = /, CONTACTOS_DE_LA_BAJA],
    motivo: 'marcar la baja en esas fichas',
  },
  // Lo que la página de baja enseña antes del clic (entregabilidad §5).
  'workspace.workspace_public_optout': {
    cmd: 'r',
    exige: [/^\(?id = \(?NULLIF\(current_setting\('app\.public_optout_workspace'/],
    motivo: 'el workspace que envió el correo del enlace, cuyo id fija public_optout_preview',
  },
  // La baja con quien envió (entregabilidad §8).
  'outbound_workspace_optout.outbound_workspace_optout_public_optout_read': {
    cmd: 'r',
    exige: [/^\(?workspace_id = \(?NULLIF\(current_setting\('app\.public_optout_workspace'/],
    motivo: 'si el workspace que envió el correo del enlace ya tenía de baja esa dirección, y ningún otro workspace',
  },
  'outbound_workspace_optout.outbound_workspace_optout_public_optout': {
    cmd: 'a',
    exige: [TOKEN_DE_LA_BAJA],
    motivo: 'la baja de ese mismo enlace en el workspace que lo envió, y ninguna otra',
  },
};

/**
 * Las claves ajenas hacia una tabla con RLS que NO llevan el disparador
 * assert_reference_visible (0025 §3), como `tabla.columna`, y por qué.
 * Vacía: 0025 §7 lo engancha a todas.
 */
export const REFERENCIAS_SIN_COMPROBAR_DECLARADAS: Readonly<Record<string, string>> = {};

/**
 * Los índices únicos (o de exclusión) GLOBALES de tablas con RLS que
 * mc_app escribe, como `tabla.indice`, y por qué no pueden ser por
 * inquilino. Cada uno es un oráculo aceptado: quien intente el mismo
 * valor sabe que ya existe. Por eso el motivo tiene que decir por qué
 * ese saber no le da nada que no tenga ya.
 */
export const UNICOS_GLOBALES_DECLARADOS: Readonly<Record<string, string>> = {
  'app_user.app_user_email_key':
    'el correo ES la identidad con la que se entra (CIM-3, enlace mágico): una persona es una sola fila en toda ' +
    'la plataforma. Y el alta solo crea la fila propia (0025 §4), así que desde la web no se tantea el correo de nadie',
  'workspace.workspace_slug_key':
    'el slug es la dirección pública del workspace: tiene que resolver a uno solo sin saber de quién es. Que un ' +
    'slug esté tomado es lo mismo que ver que su dirección responde',
  'quote.quote_slug_key':
    'enlace público de la cotización: la URL resuelve sin workspace. Quien lo genere (COT-3) lo hace al azar, ' +
    'nunca a partir del nombre de la marca: así el choque no dice nada',
  'report.report_slug_key': 'enlace público del reporte: mismo motivo que quote.quote_slug_key',
  'media_kit.media_kit_slug_key': 'enlace público del media kit: mismo motivo que quote.quote_slug_key',
  'pipeline_stage.pipeline_stage_pkey':
    'el id de una etapa es su clave primaria (deal.stage_id la referencia) y las globales se llaman por su nombre, ' +
    'que es público. Las PRIVADAS no pueden llevar dato: 0026 §2 las obliga por CHECK a un uuid al azar ' +
    '(pipeline_stage_private_id_random), así que chocar con una exige conocerla',
  'app_user.app_user_auth_user_id_key':
    'el id de la cuenta de Supabase Auth (0027, CIM-3): una cuenta es una persona. Es un uuid que genera Supabase ' +
    'y que la web solo conoce de la sesión verificada; mc_app lo escribe solo en SU fila (la política de UPDATE de ' +
    'app_user es «soy yo»), así que chocar con el de otra persona exige conocer su cuenta, que ya es tenerla',
  'connection_secret.connection_secret_pkey':
    'la referencia es `enc:<plataforma>:<uuid>` y el uuid lo genera el código (encrypted-secret-store.ts): ' +
    'chocar con una exige conocerla, y conocerla ya es tenerla',
  'outreach_channel_account.outreach_channel_account_live_idx':
    'un buzón (el Gmail o la cuenta de Unipile) envía desde UN workspace (0037 §2): los topes son por cuenta y, con ' +
    'dos filas vivas del mismo buzón en dos workspaces, el proveedor recibiría el doble. El índice cubre solo las ' +
    'cuentas AUTENTICADAS (connected, needs_reconnect, error), y a esos estados solo llega el callback del ' +
    'proveedor (outreach_channel_account_worker_columns, en DISPARADORES_DE_CANDADO): chocar exige haber ' +
    'autenticado esa misma cuenta, que ya es tenerla. Una fila pending de la web no ocupa nada',
  'outreach_channel_account.outreach_channel_account_identity_live_idx':
    'el mismo perfil de LinkedIn o de Instagram (connection_params.im.id de Unipile, canales_identidad_y_rotacion) envía desde UN workspace, ' +
    'aunque Unipile le dé un account_id nuevo en cada hosted auth: con dos filas vivas del mismo perfil los topes se ' +
    'sumarían y LinkedIn podría bloquearlo. Mismo criterio que outreach_channel_account_live_idx: cubre solo las ' +
    'cuentas autenticadas y provider_identity la escribe solo el callback del proveedor (candado de 0037 §2.1, canales_identidad_y_rotacion): ' +
    'chocar exige haber autenticado ese perfil',
};

/**
 * Las tablas con inquilino propio (workspace_id, owner_workspace_id) que
 * se aíslan con un EXISTS sobre un padre CON FILAS GLOBALES y heredan a
 * propósito esas filas, y por qué. Vacía: hoy las únicas hijas de un
 * padre con globales (external_post_score y external_post_snapshot, de
 * external_post) no tienen inquilino propio, así que la regla no las
 * alcanza. Ver «LOS PADRES CON FILAS GLOBALES» en src/politicas.ts.
 */
export const HIJAS_CON_GLOBALES_DECLARADAS: Readonly<Record<string, string>> = {};

/**
 * Las secuencias sobre las que mc_app puede tener SELECT, UPDATE, o
 * USAGE sin insertar en su tabla, y por qué. Vacía: 0026 §4 deja a
 * mc_app solo USAGE, y solo donde inserta.
 */
export const SECUENCIAS_DECLARADAS: Readonly<Record<string, string>> = {};

/** La función que comprueba que una referencia nombra una fila visible (0025 §3). */
export const FUNCION_DE_REFERENCIAS = 'assert_reference_visible';

/** Los cuatro privilegios de fila que concede el esquema. */
export const PRIVILEGIOS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
export type Privilegio = (typeof PRIVILEGIOS)[number];

/**
 * Lo que mc_app no tiene en ninguna relación de `public`. TRUNCATE se
 * salta la RLS entera; TRIGGER le deja colgar código de una tabla;
 * REFERENCES, crear claves ajenas hacia ella; MAINTAIN (Postgres 17),
 * bloquearla con LOCK TABLE o refrescar una vista materializada.
 */
export const PRIVILEGIOS_PROHIBIDOS = ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const;

/**
 * Lo que mc_app puede hacer sobre las tablas que NO son de inquilino
 * puro, y por qué. Lo que no está aquí lleva los cuatro privilegios: es
 * una tabla del inquilino y quien filtra es la política.
 *
 * Esta es la mitad del aislamiento que una política no da. Las
 * migraciones 0024 y 0025 lo revocan; aquí se comprueba que siga
 * revocado, porque un `GRANT … ON ALL TABLES` de cualquier script
 * posterior lo devolvería entero y en silencio.
 */
export interface PrivilegiosDeclarados {
  permite: readonly Privilegio[];
  motivo: string;
  /**
   * Los privilegios que mc_app tiene SOLO en esas columnas, nunca de la
   * tabla entera. La política de fila no dice nada de columnas: con
   * UPDATE de tabla, la fila propia se reescribe entera (el plan del
   * workspace, por ejemplo). La guardia exige que no haya GRANT de tabla
   * para ese privilegio y que los de columna no pasen de la lista.
   */
  soloColumnas?: Partial<Record<Privilegio, readonly string[]>>;
}

export const PRIVILEGIOS_DE_LA_APP: Readonly<Record<string, PrivilegiosDeclarados>> = {
  // Catálogos globales: la aplicación los lee, los llena una migración
  // o el worker. Con escritura, una transacción cualquiera de la web
  // cambiaba los límites de TikTok o apagaba un job para TODOS.
  platform: { permite: ['SELECT'], motivo: 'catálogo global de solo lectura' },
  niche: { permite: ['SELECT'], motivo: 'catálogo global de solo lectura' },
  niche_cpm_benchmark: { permite: ['SELECT'], motivo: 'catálogo global de solo lectura' },
  signal_source: { permite: ['SELECT'], motivo: 'catálogo global de solo lectura' },
  job_definition: { permite: ['SELECT'], motivo: 'catálogo global de solo lectura' },
  preflight_rule: { permite: ['SELECT'], motivo: 'catálogo global de solo lectura' },
  benchmark: { permite: ['SELECT'], motivo: 'catálogo global de solo lectura' },
  blocked_claim: { permite: ['SELECT'], motivo: 'catálogo global de solo lectura' },
  metric_requirement: { permite: ['SELECT'], motivo: 'catálogo global de solo lectura' },

  // Observación y métricas de terceros: las calcula y las escribe el
  // worker. Y las métricas se insertan, nunca se actualizan.
  external_account_baseline: { permite: ['SELECT'], motivo: 'lo calcula el worker' },
  external_post: { permite: ['SELECT'], motivo: 'lo escribe el radar (worker)' },
  external_post_score: { permite: ['SELECT'], motivo: 'lo calcula el worker' },
  external_post_snapshot: { permite: ['SELECT'], motivo: 'métrica append-only del worker' },
  trend_signal: { permite: ['SELECT'], motivo: 'lo calcula el worker' },
  trait_lift: { permite: ['SELECT'], motivo: 'lo calcula el worker' },
  brand_account_snapshot: { permite: ['SELECT'], motivo: 'métrica append-only del worker' },

  // Métricas PROPIAS (0025 §5): las mide y las escribe el worker, como
  // mc_worker. Una pantalla no reescribe las vistas de un post.
  post_metric_snapshot: {
    permite: ['SELECT', 'INSERT'],
    motivo:
      'métrica append-only: la mide el worker y la web la AÑADE al importar un CSV de Insights (RES-2, ' +
      'importCsvReadings). Nadie la corrige ni la borra; el INSERT pasa por la política del workspace y por ' +
      'assert_reference_visible en post_id',
  },
  audience_breakdown: { permite: ['SELECT'], motivo: 'métrica append-only del worker' },
  post_engagement_curve: { permite: ['SELECT'], motivo: 'métrica append-only del worker' },
  post_retention_curve: { permite: ['SELECT'], motivo: 'métrica append-only del worker' },
  post_impression_source: { permite: ['SELECT'], motivo: 'métrica append-only del worker' },
  post_score: { permite: ['SELECT'], motivo: 'lo calcula el worker a partir de las métricas' },
  creator_baseline: { permite: ['SELECT'], motivo: 'lo calcula el worker a partir de las métricas' },
  campaign_result: { permite: ['SELECT'], motivo: 'lo consolida el worker a partir de las métricas' },
  job_run: { permite: ['SELECT'], motivo: 'bitácora de trabajos: la escribe el worker, la web solo la lee' },
  account_metric_snapshot: {
    permite: ['SELECT', 'INSERT'],
    motivo:
      'métrica: se inserta, nunca se corrige ni se borra (0025 §5). CON-10 guarda desde la web el snapshot público ' +
      'del día con ON CONFLICT DO NOTHING (recordAccountSnapshot); el recolector diario, como mc_worker, es quien mide',
  },
  audit_log: { permite: ['SELECT', 'INSERT'], motivo: 'bitácora de auditoría: se anota, no se corrige ni se borra' },

  // Cuota y bitácora de llamadas.
  api_quota_usage: { permite: ['SELECT'], motivo: 'la persiste el worker (PostgresQuotaUsageStore)' },
  api_call_log: {
    permite: ['SELECT', 'INSERT'],
    motivo: 'bitácora: la web registra sus llamadas de OAuth, pero nadie las corrige ni las borra',
  },

  // Ni leer.
  webhook_event: { permite: [], motivo: 'cuerpos y cabeceras crudos de las plataformas: solo el worker' },
  contact_suppression: {
    permite: [],
    motivo:
      'la baja global la escribe el worker con una baja verificada y la lee el disparador de contact: la web no la ' +
      'toca. Con escritura, un workspace daba de baja a cualquier correo en toda la plataforma (0029 §1)',
  },

  // Outreach (0037 §7.4).
  outbound_sequence_template: { permite: ['SELECT'], motivo: 'catálogo global de plantillas de solo lectura' },
  outbound_counter: {
    permite: ['SELECT'],
    motivo:
      'los límites diarios y semanales los suma el despachador (worker) con increment_if_under_cap e ' +
      'increment_weekly; con escritura, un workspace se reiniciaría sus propios topes y quemaría su cuenta',
  },
  outbound_breaker: { permite: ['SELECT'], motivo: 'el disyuntor por tipo de paso lo calcula el worker' },
  outbound_review: {
    permite: ['SELECT', 'INSERT'],
    motivo: 'bitácora de la puerta de calidad (nota, tokens y costo): se anota, no se corrige ni se borra',
  },
  outbound_optout_link: {
    permite: [],
    motivo:
      'la prueba del enlace de baja de cada correo (0037 §4.5): la escribe solo el despachador y la lee ' +
      'public_optout. Con escritura, un workspace se fabricaba un enlace para dar de baja a cualquiera',
  },
  outbound_optout_event: {
    permite: [],
    motivo:
      'quién provocó cada baja por enlace (0037 §4.6, con su alcance desde entregabilidad §8): la escribe public_optout y la ' +
      'lee un operador. Con escritura, ' +
      'un workspace borraría su rastro',
  },
  outbound_bounce: {
    permite: ['SELECT'],
    motivo:
      'los rebotes los lee del buzón el worker (entregabilidad, VEN-15) y la web solo los muestra. Con escritura, un ' +
      'workspace se borraría los rebotes que disparan la alerta de entregabilidad',
  },
  outbound_workspace_optout: {
    permite: ['SELECT'],
    motivo:
      'a quién no le vuelve a escribir este workspace porque pulsó el enlace de baja de uno de sus correos (entregabilidad §8). ' +
      'La escribe solo public_optout: con escritura, un workspace se quitaría una baja o se la pondría a otro',
  },
  outbound_generation: {
    permite: ['SELECT'],
    motivo:
      'el borrador generado con sus marcas [claim:id] y el turno de los jobs de VEN-12 (0056): lo escribe el worker y ' +
      'la web lo lee para el editor del pitch. Con escritura, un workspace se fabricaría un borrador «revisado»',
  },
  outbound_llm_reservation: {
    permite: ['SELECT'],
    motivo:
      'lo apartado del tope diario del modelo mientras una llamada está en curso (0072): lo escribe y lo borra el ' +
      'worker. Con escritura, un workspace se borraría las reservas y dos jobs volverían a gastar el mismo saldo',
  },
  outbound_llm_call: {
    permite: ['SELECT', 'INSERT'],
    motivo:
      'bitácora de cada llamada al modelo (tokens y costo): se anota, no se corrige ni se borra. Borrar las de hoy ' +
      'devolvería el presupuesto llm_daily_cap_usd',
  },

  // Contabilidad del runner: se lee al arrancar y no se escribe desde la app.
  schema_migrations: { permite: ['SELECT'], motivo: 'la lee la guardia de esquema; escribirla sería mentirle a la base' },

  // Tablas de inquilino con un comando de menos.
  workspace: {
    permite: ['SELECT', 'INSERT', 'UPDATE'],
    motivo: 'borrar un inquilino es del worker, no de una pantalla',
    // 0024 §7.6: la política de UPDATE aísla la fila, no las columnas.
    // Con UPDATE de tabla un workspace se subía el plan a enterprise.
    soloColumnas: {
      UPDATE: ['name', 'slug', 'country', 'currency', 'timezone', 'locale', 'niche_slugs', 'settings', 'updated_at'],
    },
  },
  membership: {
    permite: ['SELECT', 'INSERT'],
    motivo:
      'el alta propia de CIM-3 (0028): darse de alta a uno mismo en el espacio que se acaba de crear, que es lo ' +
      'único que deja membership_alta. Cambiar roles o echar a alguien sigue siendo del worker',
  },
  app_user: { permite: ['SELECT', 'INSERT', 'UPDATE'], motivo: 'nadie borra a una persona desde una pantalla' },
  media_kit_lockout: {
    permite: ['SELECT', 'DELETE'],
    motivo:
      'el bloqueo por origen del media kit (0030 §2) lo escribe solo public_media_kit(). El creador cuenta los ' +
      'orígenes bloqueados y los borra con «Desbloquear»; no lee el resumen del origen',
    soloColumnas: { SELECT: ['locked_until', 'media_kit_id'] },
  },
};

/** El rol con el que se conecta la aplicación. Es a quien se le miden los privilegios. */
export const APP_ROLE = 'mc_app';

/** Una tabla sin aislamiento que tampoco está declarada como excepción. */
export interface TablaSinAislar {
  tabla: string;
  /** Qué le falta: 'sin RLS', 'sin FORCE', 'sin políticas', 'con políticas que no aíslan'. */
  falta: string;
}

/** Un privilegio que mc_app tiene y no debería. */
export interface PrivilegioDeMas {
  tabla: string;
  privilegios: string[];
  motivo: string;
}

/** Una política permisiva que no aísla y que nadie declaró. */
export interface PoliticaAbierta {
  tabla: string;
  politica: string;
  /** 'tabla.politica', que es como se declara en POLITICAS_ABIERTAS_DECLARADAS. */
  clave: string;
  /** Los comandos de mc_app a los que abre la tabla. */
  comandos: string[];
  /** El trozo de la expresión que no aísla, tal como lo escribió pg_get_expr. */
  trozo: string;
}

/** Un rol que no es el dueño, ni mc_app, ni uno declarado, con privilegios en `public`. */
export interface RolDeMas {
  tabla: string;
  rol: string;
  privilegios: string[];
}

/** Lo que dice la base cuando se le pregunta por el esquema. */
export interface EstadoDelEsquema {
  /** Migraciones registradas en schema_migrations. -1 si la tabla no existe. */
  aplicadas: number;
  /** La última, por nombre de archivo. */
  ultima: string | null;
  /** Archivos de db/migrations que la base no tiene. Vacío si no se pudieron leer (ver arriba). */
  pendientes: string[];
  /**
   * Tablas de `public` sin aislamiento y sin excepción declarada. Se
   * llama así desde la primera versión de la guardia y lo sigue usando
   * el preflight del worker.
   */
  sinRls: string[];
  /** Lo mismo, con el detalle de qué le falta a cada una. */
  sinAislar: TablaSinAislar[];
  /** Las tablas que pasan TODAS las comprobaciones (para las pruebas). */
  aisladas: string[];
  /** Excepciones declaradas que ya no corresponden: la tabla no existe, o sí está aislada. */
  excepcionesObsoletas: string[];
  /** Excepciones sin RLS que además no dicen qué puede hacer mc_app con ellas. */
  excepcionesSinPrivilegios: string[];
  /** Políticas permisivas que no aíslan y no están en POLITICAS_ABIERTAS_DECLARADAS. */
  politicasAbiertas: PoliticaAbierta[];
  /** Declaraciones de POLITICAS_ABIERTAS_DECLARADAS que ya no corresponden. */
  politicasAbiertasObsoletas: string[];
  /** Vistas sin `security_invoker = on` y sin excepción declarada. */
  vistasSinInvocador: string[];
  /** Entradas de VISTAS_SIN_INVOCADOR que ya no corresponden. */
  vistasDeclaradasObsoletas: string[];
  /** Vistas materializadas y tablas foráneas a las que llega mc_app sin declararlo. */
  relacionesSinRls: string[];
  /** Entradas de RELACIONES_SIN_RLS_DECLARADAS que ya no corresponden. */
  relacionesSinRlsObsoletas: string[];
  /** Funciones SECURITY DEFINER de `public` sin declarar, se puedan ejecutar o no. */
  funcionesDefiner: string[];
  /** Entradas de FUNCIONES_DEFINER_DECLARADAS que ya no corresponden. */
  funcionesDefinerObsoletas: string[];
  /** Funciones de FUNCIONES_QUE_USA_EL_CODIGO que no existen o que mc_app no puede ejecutar, con el motivo. */
  funcionesQueFaltan: string[];
  /**
   * Relaciones y columnas de COLUMNAS_QUE_USA_EL_CODIGO que la base no
   * tiene: `tabla.columna`, o `tabla (no existe)` si falta entera.
   */
  columnasQueFaltan: string[];
  /** Disparadores de tablas de `public` que llaman a una función SECURITY DEFINER, sin declarar. */
  disparadoresDefiner: string[];
  /** Disparadores de DISPARADORES_DE_CANDADO que no existen o están desactivados, con lo que cierran. */
  candadosQueFaltan: string[];
  /** Reglas de `public` que no son el _RETURN de una vista, sin declarar. */
  reglas: string[];
  /** Esquemas fuera de public a los que llega mc_app, o CREATE en public. */
  esquemasDeMas: string[];
  /** Lo que el propio rol mc_app no debería tener: atributos que saltan la RLS o roles de los que es miembro. */
  rolDeLaApp: string[];
  /** Claves ajenas SET NULL / SET DEFAULT sobre una columna cuya rama «IS NULL» abre la fila a todos. */
  borradosQuePublican: string[];
  /** Claves ajenas hacia una tabla con RLS, escribibles por mc_app, sin assert_reference_visible. */
  referenciasSinComprobar: string[];
  /** Entradas de REFERENCIAS_SIN_COMPROBAR_DECLARADAS que ya no corresponden. */
  referenciasDeclaradasObsoletas: string[];
  /** Índices únicos o de exclusión sin la columna de inquilino, en tablas con RLS que mc_app escribe. */
  unicosSinInquilino: string[];
  /** Entradas de UNICOS_GLOBALES_DECLARADOS que ya no corresponden. */
  unicosDeclaradosObsoletos: string[];
  /**
   * Entradas de las demás listas (HIJAS_CON_GLOBALES_DECLARADAS,
   * SECUENCIAS_DECLARADAS, DISPARADORES_DEFINER_DECLARADOS,
   * REGLAS_DECLARADAS, ESQUEMAS_DECLARADOS, ROLES_DE_LA_APP_DECLARADOS,
   * AISLADAS_POR_PERSONA_DECLARADAS, BORRADOS_QUE_PUBLICAN_DECLARADOS)
   * que ya no corresponden, con el nombre de la lista delante.
   */
  otrasDeclaracionesObsoletas: string[];
  /** Privilegios que mc_app conserva y no debería (de tabla, de columna o de secuencia). */
  privilegiosDeMas: PrivilegioDeMas[];
  /** Otros roles con privilegios en `public`. */
  rolesDeMas: RolDeMas[];
  /**
   * Lo que mc_public_share tiene y no le promete 0030: privilegios o
   * columnas fuera de PRIVILEGIOS_DEL_ENLACE_PUBLICO, políticas `TO
   * mc_public_share` fuera de POLITICAS_DEL_ENLACE_PUBLICO o reescritas,
   * atributos que saltan la RLS o dejan entrar, membresías y relaciones
   * de las que es dueño. Con la base al día, también lo que le falta.
   */
  enlacePublico: string[];
  /** Si la comprobación de archivos se pudo hacer. */
  comparadoConArchivos: boolean;
  /**
   * Si la base contestó al inventario (migraciones, tablas, políticas,
   * privilegios, funciones y claves). En false, TODO lo de arriba está
   * vacío porque no se pudo preguntar, no porque esté bien: es un
   * problema, no un visto bueno.
   */
  inventarioLeido: boolean;
}

/**
 * Los nombres de db/migrations, o [] si no se pueden leer (el bundle de
 * Vercel no los lleva: .vercelignore excluye /db/migrations/).
 */
export async function migracionesDelRepositorio(): Promise<string[]> {
  try {
    const { listSql, MIGRATIONS_DIR } = await import('../../../db/lib/aplicar.mjs');
    return await listSql(MIGRATIONS_DIR);
  } catch {
    return [];
  }
}

interface FilaMigracion extends Record<string, unknown> {
  filename: string;
}
interface FilaRelacion extends Record<string, unknown> {
  relname: string;
  /** 'r' y 'p' son tablas; 'v', vistas; 'm', vistas materializadas; 'f', tablas foráneas; 'S', secuencias. */
  relkind: string;
  rls: boolean;
  forzada: boolean;
  politicas: number;
  /** Vistas: si llevan `security_invoker = on` en reloptions. */
  invocador: boolean;
  /** El rol dueño: el único, además de los declarados, que puede tener privilegios. */
  dueno: string;
  /** Secuencias: la tabla cuya columna la usa (serial o identity), o null. */
  tabla_duena: string | null;
}
interface FilaPolitica extends Record<string, unknown> {
  relname: string;
  polname: string;
  /** r = SELECT, a = INSERT, w = UPDATE, d = DELETE, * = todos. */
  cmd: string;
  permisiva: boolean;
  /** Si la política alcanza a mc_app (TO PUBLIC, o a un rol del que mc_app es miembro). */
  aplica: boolean;
  qual: string | null;
  with_check: string | null;
}
interface FilaPrivilegio extends Record<string, unknown> {
  relname: string;
  /** 'PUBLIC' para el grantee 0. */
  rol: string;
  privilegio: string;
  /** La columna, si el GRANT es por columna; null si es de la relación entera. */
  columna: string | null;
}
interface FilaInquilino extends Record<string, unknown> {
  tabla: string;
  columna: string;
}
interface FilaUnico extends Record<string, unknown> {
  tabla: string;
  indice: string;
  primaria: boolean;
  /** Las columnas del índice, sin las expresiones. */
  columnas: string[] | null;
  /**
   * Una sola columna que la base rellena sola: identity, o un DEFAULT
   * nextval(…) o gen_random_uuid(). Es la clave sustituta de la fila.
   */
  generada: boolean;
  expresiones: string | null;
  predicado: string | null;
}
interface FilaFuncion extends Record<string, unknown> {
  firma: string;
}
interface FilaFuncionDelCodigo extends Record<string, unknown> {
  firma: string;
  existe: boolean;
  ejecuta: boolean;
}
interface FilaCandado extends Record<string, unknown> {
  clave: string;
  estado: string | null;
}
interface FilaColumnaQueFalta extends Record<string, unknown> {
  relacion: string;
  columna: string;
  existe_relacion: boolean;
}
interface FilaReferencia extends Record<string, unknown> {
  hija: string;
  columna: string;
  padre: string;
  columna_padre: string;
  columnas: number;
  /** confdeltype y confupdtype: a = NO ACTION, r = RESTRICT, c = CASCADE, n = SET NULL, d = SET DEFAULT. */
  al_borrar: string;
  al_actualizar: string;
}
interface FilaDisparadorDefiner extends Record<string, unknown> {
  tabla: string;
  disparador: string;
  funcion: string;
}
interface FilaRegla extends Record<string, unknown> {
  tabla: string;
  regla: string;
}
interface FilaEsquema extends Record<string, unknown> {
  esquema: string;
  uso: boolean;
  crea: boolean;
}
interface FilaRol extends Record<string, unknown> {
  rol: string;
  /** Si es el propio mc_app; si no, un rol del que mc_app es miembro. */
  propio: boolean;
  super: boolean;
  bypass: boolean;
  crea_roles: boolean;
}
interface FilaRolDelEnlace extends Record<string, unknown> {
  super: boolean;
  bypass: boolean;
  entra: boolean;
  crea_roles: boolean;
  /** Los roles de los que mc_public_share es miembro. */
  miembro_de: string[] | null;
}
interface FilaPoliticaDelEnlace extends Record<string, unknown> {
  clave: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
}
interface FilaDisparador extends Record<string, unknown> {
  tabla: string;
  args: string;
  /** BEFORE, FOR EACH ROW, INSERT y UPDATE, y habilitado. */
  completo: boolean;
  /** Las columnas de `UPDATE OF`, o null si dispara en cualquier UPDATE. */
  columnas_update: string[] | null;
}

/**
 * TODAS las relaciones de `public` con su estado de aislamiento. Es la
 * pregunta invertida: la base dice qué hay, no una lista del
 * repositorio.
 */
const SQL_RELACIONES = `
  SELECT c.relname AS relname,
         c.relkind::text AS relkind,
         c.relrowsecurity AS rls,
         c.relforcerowsecurity AS forzada,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS politicas,
         coalesce(c.reloptions @> ARRAY['security_invoker=on'], false) AS invocador,
         pg_get_userbyid(c.relowner)::text AS dueno,
         (SELECT t.relname::text FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid
           WHERE c.relkind = 'S' AND d.classid = 'pg_class'::regclass AND d.objid = c.oid
             AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
           LIMIT 1) AS tabla_duena
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
   ORDER BY c.relname`;

/**
 * Lo que DICE cada política, a qué comando se aplica, si es permisiva y
 * si alcanza a mc_app. Una política `TO mc_migrator` no le abre nada a
 * la aplicación, y así es como 0025 §4 deja las altas de los seeds.
 */
const SQL_POLITICAS = `
  SELECT c.relname AS relname,
         p.polname AS polname,
         p.polcmd::text AS cmd,
         p.polpermissive AS permisiva,
         (0 = ANY (p.polroles) OR EXISTS (
            SELECT 1 FROM pg_roles r WHERE r.oid = ANY (p.polroles) AND pg_has_role($1::name, r.oid, 'MEMBER')
         )) AS aplica,
         pg_get_expr(p.polqual, p.polrelid) AS qual,
         pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
   ORDER BY 1, 2`;

/**
 * Todos los privilegios concedidos en `public`, de todos los roles,
 * leídos de pg_class.relacl y de pg_attribute.attacl con aclexplode.
 *
 * No se usa information_schema.role_table_grants a propósito: esa vista
 * solo enseña las concesiones en las que el usuario actual es parte, y
 * el worker consulta esto como mc_worker. relacl y attacl los ve
 * cualquiera, así que la respuesta es la misma se pregunte desde donde
 * se pregunte. El grantee 0 es PUBLIC.
 *
 * La segunda mitad son los GRANT POR COLUMNA: `GRANT UPDATE (slug) ON
 * niche TO mc_app` no aparece en relacl, un REVOKE de tabla no lo quita,
 * y con él mc_app actualiza la tabla entera en esa columna. Se tratan
 * como si fueran de la relación.
 */
const SQL_PRIVILEGIOS = `
  SELECT c.relname AS relname,
         coalesce(r.rolname::text, 'PUBLIC') AS rol,
         a.privilege_type AS privilegio,
         NULL::text AS columna
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL aclexplode(c.relacl) a
    LEFT JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  UNION ALL
  SELECT c.relname AS relname,
         coalesce(r.rolname::text, 'PUBLIC') AS rol,
         a.privilege_type AS privilegio,
         att.attname::text AS columna
    FROM pg_attribute att
    JOIN pg_class c ON c.oid = att.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL aclexplode(att.attacl) a
    LEFT JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND att.attnum > 0 AND NOT att.attisdropped
   ORDER BY 1, 2, 3`;

/** Qué tablas llevan columna de inquilino propia, y cuál. */
const SQL_INQUILINOS = `
  SELECT c.relname AS tabla, a.attname::text AS columna
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = ANY ($1::text[])
   ORDER BY 1, 2`;

/** Los índices únicos y de exclusión de las tablas de `public`, con sus columnas y su predicado. */
const SQL_UNICOS = `
  SELECT c.relname AS tabla,
         i.relname AS indice,
         x.indisprimary AS primaria,
         (SELECT array_agg(a.attname::text ORDER BY k.n)
            FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, n)
            JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) AS columnas,
         (x.indnatts = 1 AND x.indexprs IS NULL AND EXISTS (
            SELECT 1 FROM pg_attribute a
              LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attrelid = x.indrelid AND a.attnum = x.indkey[0]
               AND (a.attidentity <> '' OR pg_get_expr(d.adbin, d.adrelid) ~ '^(nextval\\(|gen_random_uuid\\(\\))')
         )) AS generada,
         pg_get_expr(x.indexprs, x.indrelid) AS expresiones,
         pg_get_expr(x.indpred, x.indrelid) AS predicado
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND (x.indisunique OR x.indisexclusion)
   ORDER BY 1, 2`;

/**
 * Las funciones que corren con los privilegios de su dueño:
 *
 *   · TODAS las de `public`. No se filtra por EXECUTE a propósito: una
 *     función de disparador corre aunque quien escribe no pueda
 *     ejecutarla (ver la nota de arriba).
 *   · las de cualquier OTRO esquema al que llega mc_app (USAGE), si
 *     mc_app las puede EJECUTAR. Es `extensions` en Supabase, que la
 *     comprobación de esquemas deja pasar de oficio, y cualquiera de
 *     ESQUEMAS_DECLARADOS. Una `extensions.leer_todo() SECURITY DEFINER`
 *     con el EXECUTE que Postgres da a PUBLIC al nacer rodea el muro de
 *     GRANT igual que una de public (medido: la guardia daba verde). Las
 *     de disparador y de evento no se pueden llamar, y un disparador
 *     sobre una tabla de public que las use ya lo nombra
 *     SQL_DISPARADORES_DEFINER. Fuera de public la firma lleva el
 *     esquema delante: `extensions.leer_todo()`.
 */
const SQL_FUNCIONES = `
  SELECT CASE WHEN n.nspname = 'public' THEN p.oid::regprocedure::text
              ELSE n.nspname || '.' || p.proname || '(' ||
                   coalesce((SELECT string_agg(format_type(x.tipo, NULL), ',' ORDER BY x.n)
                               FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY x(tipo, n)), '') || ')'
         END AS firma
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND (n.nspname = 'public'
          OR (n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
              AND has_schema_privilege($1::name, n.oid, 'USAGE')
              AND has_function_privilege($1::name, p.oid, 'EXECUTE')
              AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)))
   ORDER BY 1`;

/**
 * Por cada firma de FUNCIONES_QUE_USA_EL_CODIGO: si existe en public y
 * si mc_app la puede ejecutar. Con el esquema delante, para no depender
 * del search_path de quien pregunta.
 */
const SQL_FUNCIONES_DEL_CODIGO = `
  SELECT f AS firma,
         to_regprocedure('public.' || f) IS NOT NULL AS existe,
         coalesce(has_function_privilege($2::name, to_regprocedure('public.' || f), 'EXECUTE'), false) AS ejecuta
    FROM unnest($1::text[]) AS f
   ORDER BY 1`;

/**
 * De COLUMNAS_QUE_USA_EL_CODIGO, las que NO están en public: la
 * relación, la columna y si al menos la relación existe. Una columna
 * borrada (attisdropped) no cuenta como presente.
 */
const SQL_COLUMNAS_DEL_CODIGO = `
  SELECT x.relacion, x.columna, x.oid IS NOT NULL AS existe_relacion
    FROM (SELECT split_part(k, '.', 1) AS relacion,
                 split_part(k, '.', 2) AS columna,
                 to_regclass('public.' || quote_ident(split_part(k, '.', 1))) AS oid
            FROM unnest($1::text[]) AS k) x
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = x.oid AND a.attname = x.columna
                        AND a.attnum > 0 AND NOT a.attisdropped)
   ORDER BY 1, 2`;

/**
 * Por cada `tabla.disparador` de DISPARADORES_DE_CANDADO: su estado
 * (tgenabled) o NULL si no existe. 'O' y 'A' disparan en una sesión
 * normal; 'D' está desactivado y 'R' solo dispara en réplica.
 */
const SQL_CANDADOS = `
  SELECT k AS clave, t.tgenabled::text AS estado
    FROM unnest($1::text[]) AS k
    LEFT JOIN pg_trigger t
      ON t.tgrelid = to_regclass('public.' || quote_ident(split_part(k, '.', 1)))
     AND t.tgname = split_part(k, '.', 2)
     AND NOT t.tgisinternal
   ORDER BY 1`;

/** Los disparadores de tablas de `public` cuya función es SECURITY DEFINER, sea del esquema que sea. */
const SQL_DISPARADORES_DEFINER = `
  SELECT c.relname::text AS tabla, t.tgname::text AS disparador, f.oid::regprocedure::text AS funcion
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc f ON f.oid = t.tgfoid
   WHERE n.nspname = 'public' AND NOT t.tgisinternal AND f.prosecdef
   ORDER BY 1, 2`;

/** Las reglas de `public` que no son la de una vista (_RETURN). */
const SQL_REGLAS = `
  SELECT c.relname::text AS tabla, r.rulename::text AS regla
    FROM pg_rewrite r
    JOIN pg_class c ON c.oid = r.ev_class
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND r.rulename <> '_RETURN'
   ORDER BY 1, 2`;

/**
 * Los esquemas a los que llega mc_app (USAGE) fuera de los del sistema,
 * y si puede crear en ellos. has_schema_privilege cuenta también lo que
 * hereda de los roles de los que es miembro.
 */
const SQL_ESQUEMAS = `
  SELECT n.nspname::text AS esquema,
         has_schema_privilege($1::name, n.oid, 'USAGE') AS uso,
         has_schema_privilege($1::name, n.oid, 'CREATE') AS crea
    FROM pg_namespace n
   WHERE n.nspname NOT IN ('information_schema', 'extensions') AND n.nspname NOT LIKE 'pg\\_%'
   ORDER BY 1`;

/** El rol mc_app y cada rol del que es miembro, con los atributos que saltan la RLS. */
const SQL_ROL_DE_LA_APP = `
  SELECT r.rolname::text AS rol, (r.rolname = $1::name) AS propio, r.rolsuper AS super,
         r.rolbypassrls AS bypass, r.rolcreaterole AS crea_roles
    FROM pg_roles r
   WHERE r.rolname = $1::name OR pg_has_role($1::name, r.oid, 'MEMBER')
   ORDER BY 2 DESC, 1`;

/**
 * El rol de los enlaces públicos: los atributos que saltan la RLS o
 * dejan abrir una conexión con él, y los roles de los que es miembro
 * (heredaría sus privilegios, o haría SET ROLE a ellos). Sin fila, el
 * rol no existe.
 */
const SQL_ROL_DEL_ENLACE = `
  SELECT r.rolsuper AS super, r.rolbypassrls AS bypass, r.rolcanlogin AS entra, r.rolcreaterole AS crea_roles,
         (SELECT array_agg(b.rolname::text ORDER BY b.rolname)
            FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid
           WHERE m.member = r.oid) AS miembro_de
    FROM pg_roles r
   WHERE r.rolname = $1::name`;

/**
 * Las políticas que nombran al rol de los enlaces públicos en su TO, de
 * cualquier esquema. Fuera de public la clave lleva el esquema delante.
 */
const SQL_POLITICAS_DEL_ENLACE = `
  SELECT CASE WHEN n.nspname = 'public' THEN '' ELSE n.nspname || '.' END || c.relname || '.' || p.polname AS clave,
         p.polcmd::text AS cmd,
         pg_get_expr(p.polqual, p.polrelid) AS qual,
         pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles r ON r.oid = ANY (p.polroles)
   WHERE r.rolname = $1::name
   ORDER BY 1`;

/** Las claves ajenas de `public`, con su primera columna, cuántas tiene y qué hacen al borrar el padre. */
const SQL_REFERENCIAS = `
  SELECT hija.relname AS hija, a.attname::text AS columna, padre.relname AS padre,
         pa.attname::text AS columna_padre, array_length(k.conkey, 1) AS columnas,
         k.confdeltype::text AS al_borrar, k.confupdtype::text AS al_actualizar
    FROM pg_constraint k
    JOIN pg_class hija   ON hija.oid = k.conrelid
    JOIN pg_namespace n  ON n.oid = hija.relnamespace
    JOIN pg_class padre  ON padre.oid = k.confrelid
    JOIN pg_attribute a  ON a.attrelid = hija.oid AND a.attnum = k.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = padre.oid AND pa.attnum = k.confkey[1]
   WHERE n.nspname = 'public' AND k.contype = 'f'
   ORDER BY 1, 2`;

/**
 * Los disparadores que llaman a assert_reference_visible, con sus
 * argumentos. tgtype: 1 = FOR EACH ROW, 2 = BEFORE, 4 = INSERT, 16 = UPDATE.
 */
const SQL_DISPARADORES = `
  SELECT c.relname AS tabla,
         encode(t.tgargs, 'escape') AS args,
         ((t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16
           AND t.tgenabled <> 'D') AS completo,
         (SELECT array_agg(a.attname::text) FROM unnest(t.tgattr::int2[]) x(n)
            JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = x.n) AS columnas_update
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc f ON f.oid = t.tgfoid
   WHERE n.nspname = 'public' AND NOT t.tgisinternal AND f.proname = $1::name`;

/** Qué comandos cubre cada polcmd. */
const COMANDOS_DE: Record<string, readonly Privilegio[]> = {
  r: ['SELECT'],
  a: ['INSERT'],
  w: ['UPDATE'],
  d: ['DELETE'],
  '*': PRIVILEGIOS,
};

/**
 * Las expresiones de una política que deciden un comando, y de qué lado.
 *
 *   SELECT  USING, lectura
 *   INSERT  WITH CHECK (o USING si la política no trae WITH CHECK), escritura
 *   UPDATE  USING (qué filas se tocan) y WITH CHECK (cómo quedan), escritura
 *   DELETE  USING, escritura
 *
 * `null` es una expresión que falta donde Postgres la necesita: una
 * política FOR INSERT sin WITH CHECK admite cualquier fila.
 */
function expresionesPara(p: FilaPolitica, cmd: Privilegio): Array<{ expr: string | null; lado: Lado }> {
  const check = p.with_check ?? p.qual;
  switch (cmd) {
    case 'SELECT':
      return [{ expr: p.qual, lado: 'lectura' }];
    case 'INSERT':
      return [{ expr: check, lado: 'escritura' }];
    case 'UPDATE':
      return [
        { expr: p.qual, lado: 'escritura' },
        { expr: check, lado: 'escritura' },
      ];
    case 'DELETE':
      return [{ expr: p.qual, lado: 'escritura' }];
  }
}

/** El código de error de Postgres, buscado en la cadena de causas (Drizzle y pg lo envuelven). */
function codigoDeError(err: unknown): string | null {
  for (let e = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

/** La tabla no existe: la base nunca se migró. Cualquier otro error es «no se pudo preguntar». */
const TABLA_INEXISTENTE = '42P01';

/** Pregunta a la base qué migraciones tiene, qué no está aislado y qué puede mc_app. */
export async function estadoDelEsquema(db: CatalogDb): Promise<EstadoDelEsquema> {
  const enElRepo = await migracionesDelRepositorio();

  // Las consultas del inventario NO se tragan: si alguna falla, la
  // guardia no comprobó nada y hay que decirlo. Ver la nota de arriba.
  let inventarioLeido = true;
  const noContesto = <T>(): T[] => {
    inventarioLeido = false;
    return [];
  };
  const leer = <T extends Record<string, unknown>>(sql: string, params?: unknown[]) =>
    db
      .withCatalogs((tx) => tx.query<T>(sql, params))
      .then((r) => r.rows)
      .catch(() => noContesto<T>());

  // schema_migrations es la única que puede faltar con la base sana: la
  // crea el runner. Solo ESE error dice «nunca se migró»; un
  // ECONNREFUSED o un timeout dicen que no se pudo preguntar.
  const aplicadas = await db
    .withCatalogs((tx) => tx.query<FilaMigracion>('SELECT filename FROM schema_migrations ORDER BY filename'))
    .then((r) => r.rows.map((x) => x.filename))
    .catch((err: unknown) => {
      if (codigoDeError(err) !== TABLA_INEXISTENTE) inventarioLeido = false;
      return null;
    });

  const relaciones = await leer<FilaRelacion>(SQL_RELACIONES);
  const politicas = await leer<FilaPolitica>(SQL_POLITICAS, [APP_ROLE]);
  const privilegios = await leer<FilaPrivilegio>(SQL_PRIVILEGIOS);
  const funciones = await leer<FilaFuncion>(SQL_FUNCIONES, [APP_ROLE]);
  const delCodigo = await leer<FilaFuncionDelCodigo>(SQL_FUNCIONES_DEL_CODIGO, [
    Object.keys(FUNCIONES_QUE_USA_EL_CODIGO),
    APP_ROLE,
  ]);
  const columnasDelCodigo = await leer<FilaColumnaQueFalta>(SQL_COLUMNAS_DEL_CODIGO, [
    [...COLUMNAS_QUE_USA_EL_CODIGO],
  ]);
  const referencias = await leer<FilaReferencia>(SQL_REFERENCIAS);
  const disparadores = await leer<FilaDisparador>(SQL_DISPARADORES, [FUNCION_DE_REFERENCIAS]);
  const inquilinos = await leer<FilaInquilino>(SQL_INQUILINOS, [[...COLUMNAS_DE_INQUILINO]]);
  const unicos = await leer<FilaUnico>(SQL_UNICOS);
  const disparadoresDefinerLeidos = await leer<FilaDisparadorDefiner>(SQL_DISPARADORES_DEFINER);
  const candados = await leer<FilaCandado>(SQL_CANDADOS, [Object.keys(DISPARADORES_DE_CANDADO)]);
  const reglasLeidas = await leer<FilaRegla>(SQL_REGLAS);
  const esquemas = await leer<FilaEsquema>(SQL_ESQUEMAS, [APP_ROLE]);
  const rolesDeLaApp = await leer<FilaRol>(SQL_ROL_DE_LA_APP, [APP_ROLE]);
  const rolDelEnlace = await leer<FilaRolDelEnlace>(SQL_ROL_DEL_ENLACE, [PUBLIC_SHARE_ROLE]);
  const politicasDelEnlace = await leer<FilaPoliticaDelEnlace>(SQL_POLITICAS_DEL_ENLACE, [PUBLIC_SHARE_ROLE]);

  const tablas = relaciones.filter((r) => r.relkind === 'r' || r.relkind === 'p');
  const vistas = relaciones.filter((r) => r.relkind === 'v');
  const sinRlsPosible = relaciones.filter((r) => r.relkind === 'm' || r.relkind === 'f');
  const secuencias = relaciones.filter((r) => r.relkind === 'S');
  const porNombre = new Map(relaciones.map((r) => [r.relname, r] as const));

  // ---- privilegios: los de mc_app (directos o por PUBLIC) y los de los
  //      demás. Uno POR COLUMNA cuenta como de la relación entera; se
  //      recuerda la columna para decirlo en el mensaje.
  const privilegiosPorRelacion = new Map<string, Map<string, Set<string>>>();
  const porColumna = new Map<string, Map<string, Set<string>>>(); // relación → privilegio → columnas
  const deTablaEntera = new Map<string, Set<string>>(); // relación → privilegios de mc_app sin columna
  for (const p of privilegios) {
    let roles = privilegiosPorRelacion.get(p.relname);
    if (!roles) privilegiosPorRelacion.set(p.relname, (roles = new Map()));
    let s = roles.get(p.rol);
    if (!s) roles.set(p.rol, (s = new Set()));
    s.add(p.privilegio);
    if (!p.columna && (p.rol === APP_ROLE || p.rol === 'PUBLIC')) {
      let enteros = deTablaEntera.get(p.relname);
      if (!enteros) deTablaEntera.set(p.relname, (enteros = new Set()));
      enteros.add(p.privilegio);
    }
    if (p.columna && (p.rol === APP_ROLE || p.rol === 'PUBLIC')) {
      let privs = porColumna.get(p.relname);
      if (!privs) porColumna.set(p.relname, (privs = new Map()));
      let cols = privs.get(p.privilegio);
      if (!cols) privs.set(p.privilegio, (cols = new Set()));
      cols.add(p.columna);
    }
  }
  const deLaApp = (relacion: string): Set<string> => {
    const roles = privilegiosPorRelacion.get(relacion);
    return new Set([...(roles?.get(APP_ROLE) ?? []), ...(roles?.get('PUBLIC') ?? [])]);
  };
  /** «(por columna: slug)» si alguno de esos privilegios le llega a mc_app por columna. */
  const notaDeColumnas = (relacion: string, privs: readonly string[]): string => {
    const cols = privs.flatMap((p) => [...(porColumna.get(relacion)?.get(p) ?? [])]);
    return cols.length
      ? ` — concedido POR COLUMNA (${[...new Set(cols)].sort().join(', ')}): un REVOKE de la tabla no lo quita; ` +
          `hace falta REVOKE … (columna) ON … FROM ${APP_ROLE}`
      : '';
  };

  // ---- claves ajenas de una columna e inquilinos, para leer las políticas
  const claveAjena = new Set(
    referencias.filter((r) => r.columnas === 1).map((r) => `${r.hija}.${r.columna}→${r.padre}.${r.columna_padre}`),
  );
  const padreDe = new Map<string, string>();
  for (const r of referencias) if (r.columnas === 1) padreDe.set(`${r.hija}.${r.columna}`, r.padre);
  const inquilinoPorTabla = new Map<string, string[]>();
  for (const i of inquilinos) {
    const lista = inquilinoPorTabla.get(i.tabla);
    if (lista) lista.push(i.columna);
    else inquilinoPorTabla.set(i.tabla, [i.columna]);
  }
  // Lo que una fila puede NOMBRAR: sus claves ajenas de una columna hacia
  // tablas con RLS. Es lo que la rama «IS NULL» de una lectura tiene que
  // mirar antes de abrir la fila a todos.
  const referenciasConRls = new Map<string, ReferenciaDeTabla[]>();
  for (const r of referencias) {
    if (r.columnas !== 1 || !porNombre.get(r.padre)?.rls) continue;
    const lista = referenciasConRls.get(r.hija);
    const ref = { col: r.columna, padre: r.padre };
    if (lista) lista.push(ref);
    else referenciasConRls.set(r.hija, [ref]);
  }
  // Las declaraciones por persona que alguna política usó de verdad: las
  // demás sobran.
  const personasUsadas = new Set<string>();
  const contexto = (tabla: string, lado: Lado): ContextoDePolitica => ({
    tabla,
    lado,
    aislamientoDe,
    esReferencia: (hija, col, padre, pcol) => claveAjena.has(`${hija}.${col}→${padre}.${pcol}`),
    inquilinoDe: (t) => inquilinoPorTabla.get(t) ?? [],
    hijaConGlobalesDeclarada: (t) => t in HIJAS_CON_GLOBALES_DECLARADAS,
    referenciasConRls: (t) => referenciasConRls.get(t) ?? [],
    personaDeclarada: (t, col) => {
      const clave = `${t}.${col}`;
      if (!(clave in AISLADAS_POR_PERSONA_DECLARADAS)) return false;
      personasUsadas.add(clave);
      return true;
    },
  });

  const politicasPorTabla = new Map<string, FilaPolitica[]>();
  for (const p of politicas) {
    const lista = politicasPorTabla.get(p.relname);
    if (lista) lista.push(p);
    else politicasPorTabla.set(p.relname, [p]);
  }
  const alcanzan = (tabla: string, cmd: Privilegio) =>
    (politicasPorTabla.get(tabla) ?? []).filter((p) => p.aplica && (COMANDOS_DE[p.cmd] ?? []).includes(cmd));

  // ---- cómo aísla cada tabla sus LECTURAS, que es lo que hereda un
  //      EXISTS sobre ella. Punto fijo: empieza en «no» para todas y sube
  //      mientras cambie algo. Un ciclo (A mira a B y B a A) se queda en
  //      «no», que es lo prudente.
  const lectura = new Map<string, AislamientoDeLectura>(tablas.map((t) => [t.relname, 'no']));
  function aislamientoDe(tabla: string): AislamientoDeLectura {
    return lectura.get(tabla) ?? 'no';
  }
  const calcularLectura = (t: FilaRelacion): AislamientoDeLectura => {
    if (!t.rls || !t.forzada) return 'no';
    const ps = alcanzan(t.relname, 'SELECT');
    const ctx = contexto(t.relname, 'lectura');
    const restrictivas = ps.filter((p) => !p.permisiva).map((p) => veredicto(p.qual, ctx));
    if (restrictivas.some((v) => v.aisla && !v.globales && !v.persona)) return 'estricto';
    let globales = false;
    let persona = false;
    for (const p of ps.filter((x) => x.permisiva)) {
      const v = veredicto(p.qual, ctx);
      if (!v.aisla) return 'no'; // abierta, declarada o no: lo que cuelgue de ella hereda la apertura
      globales ||= v.globales;
      persona ||= v.persona;
    }
    // Por persona (app_user, membership, workspace): aísla, pero quien
    // está en dos workspaces ve desde uno lo del otro. Ver «EL PADRE QUE
    // AÍSLA POR PERSONA» en src/politicas.ts.
    if (persona) return 'por-persona';
    return globales ? 'con-globales' : 'estricto';
  };
  for (let vuelta = 0; vuelta <= tablas.length; vuelta++) {
    let cambio = false;
    for (const t of tablas) {
      const nuevo = calcularLectura(t);
      if (nuevo !== lectura.get(t.relname)) {
        lectura.set(t.relname, nuevo);
        cambio = true;
      }
    }
    if (!cambio) break;
  }

  // ---- cada política permisiva, por cada comando que mc_app tiene
  const abiertasPorClave = new Map<string, PoliticaAbierta>();
  for (const t of tablas) {
    if (!t.rls || !t.forzada) continue;
    const suyos = deLaApp(t.relname);
    for (const cmd of PRIVILEGIOS) {
      if (!suyos.has(cmd)) continue; // sin el privilegio, Postgres corta antes que la política
      const ps = alcanzan(t.relname, cmd);
      const aislaEntera = (p: FilaPolitica) =>
        expresionesPara(p, cmd).every(({ expr, lado }) => veredicto(expr, contexto(t.relname, lado)).aisla);
      // Una restrictiva que aísla cierra el comando aunque haya una
      // permisiva abierta: las restrictivas se combinan con AND.
      if (ps.some((p) => !p.permisiva && aislaEntera(p))) continue;
      for (const p of ps.filter((x) => x.permisiva)) {
        for (const { expr, lado } of expresionesPara(p, cmd)) {
          const v = veredicto(expr, contexto(t.relname, lado));
          if (v.aisla) continue;
          const clave = `${t.relname}.${p.polname}`;
          const ya = abiertasPorClave.get(clave);
          if (ya) {
            if (!ya.comandos.includes(cmd)) ya.comandos.push(cmd);
          } else {
            abiertasPorClave.set(clave, { tabla: t.relname, politica: p.polname, clave, comandos: [cmd], trozo: v.trozo });
          }
          break;
        }
      }
    }
  }
  const politicasAbiertas = [...abiertasPorClave.values()].filter((p) => !(p.clave in POLITICAS_ABIERTAS_DECLARADAS));
  const clavesDePoliticas = new Set(politicas.map((p) => `${p.relname}.${p.polname}`));
  const politicasAbiertasObsoletas = politicas.length
    ? Object.keys(POLITICAS_ABIERTAS_DECLARADAS).filter((k) => !clavesDePoliticas.has(k) || !abiertasPorClave.has(k))
    : [];

  // ---- tablas
  const sinAislar: TablaSinAislar[] = [];
  const aisladas: string[] = [];
  for (const t of tablas) {
    let falta: string | null = null;
    if (!t.rls) falta = 'sin ENABLE ROW LEVEL SECURITY';
    else if (!t.forzada) falta = 'sin FORCE ROW LEVEL SECURITY (mc_migrator se la salta)';
    else if (t.politicas < 1) falta = 'con RLS y sin ninguna política (niega, no aísla)';
    else {
      const abiertas = politicasAbiertas.filter((p) => p.tabla === t.relname);
      if (abiertas.length) {
        falta =
          'con políticas que no aíslan: ' +
          abiertas.map((p) => `${p.politica} [${p.comandos.join(', ')}] por «${p.trozo}»`).join('; ');
      }
    }
    if (falta === null) {
      aisladas.push(t.relname);
      continue;
    }
    if (t.relname in EXCEPCIONES_SIN_AISLAMIENTO) continue;
    sinAislar.push({ tabla: t.relname, falta });
  }

  // La lista de excepciones tampoco se pudre: si la tabla ya no existe,
  // o si alguien le puso política, la excepción sobra y hay que
  // borrarla. Solo se mira cuando la base respondió: contra una base a
  // medio migrar, «no existe» no querría decir nada.
  const existen = new Set(tablas.map((t) => t.relname));
  const excepcionesObsoletas = tablas.length
    ? Object.keys(EXCEPCIONES_SIN_AISLAMIENTO).filter((t) => !existen.has(t) || aisladas.includes(t))
    : [];
  // Y una excepción sin RLS que además no dice qué puede hacer mc_app
  // con ella es una tabla sin ninguno de los dos candados. Son dos
  // listas del repositorio, así que se comprueba siempre.
  const excepcionesSinPrivilegios = Object.keys(EXCEPCIONES_SIN_AISLAMIENTO).filter(
    (t) => !(t in PRIVILEGIOS_DE_LA_APP),
  );

  // ---- vistas: sin security_invoker corren con los privilegios de su dueño
  const vistasSinInvocador = vistas
    .filter((v) => !v.invocador && !(v.relname in VISTAS_SIN_INVOCADOR))
    .map((v) => v.relname);
  const conInvocador = new Map(vistas.map((v) => [v.relname, v.invocador] as const));
  const vistasDeclaradasObsoletas = relaciones.length
    ? Object.keys(VISTAS_SIN_INVOCADOR).filter((v) => !conInvocador.has(v) || conInvocador.get(v) === true)
    : [];

  // ---- vistas materializadas y tablas foráneas: sin RLS posible, así
  //      que mc_app no puede tener nada sobre ellas
  const relacionesSinRls = sinRlsPosible
    .filter((r) => deLaApp(r.relname).size > 0 && !(r.relname in RELACIONES_SIN_RLS_DECLARADAS))
    .map((r) => `${r.relname} (${r.relkind === 'm' ? 'vista materializada' : 'tabla foránea'})`);
  const relacionesSinRlsObsoletas = relaciones.length
    ? Object.keys(RELACIONES_SIN_RLS_DECLARADAS).filter((n) => {
        const r = porNombre.get(n);
        return !r || (r.relkind !== 'm' && r.relkind !== 'f') || deLaApp(n).size === 0;
      })
    : [];

  // ---- funciones SECURITY DEFINER: todas, se puedan ejecutar o no
  const firmas = new Set(funciones.map((f) => f.firma));
  const funcionesDefiner = funciones.map((f) => f.firma).filter((f) => !(f in FUNCIONES_DEFINER_DECLARADAS));
  const funcionesDefinerObsoletas = inventarioLeido
    ? Object.keys(FUNCIONES_DEFINER_DECLARADAS).filter((f) => !firmas.has(f))
    : [];

  // ---- funciones que el código llama por su nombre: que existan y que
  //      mc_app las pueda ejecutar. Se cuenta solo lo que la base dijo
  //      que falta; una fila que no llegó no se inventa como falta.
  const funcionesQueFaltan = delCodigo
    .filter((f) => !f.existe || !f.ejecuta)
    .map(
      (f) =>
        `${f.firma} (${f.existe ? `${APP_ROLE} no la puede ejecutar` : 'no existe'}; ` +
        `${FUNCIONES_QUE_USA_EL_CODIGO[f.firma] ?? 'sin motivo declarado'})`,
    );

  // ---- candados: que existan y que disparen.
  const candadosQueFaltan = candados
    .filter((c) => c.estado !== 'O' && c.estado !== 'A')
    .map(
      (c) =>
        `${c.clave} (${c.estado === null ? 'no existe' : 'desactivado'}; ` +
        `${DISPARADORES_DE_CANDADO[c.clave] ?? 'sin motivo declarado'})`,
    );

  // ---- columnas que el código lee y escribe (src/schema): que existan.
  //      Una relación que falta entera se dice una vez, no columna por
  //      columna.
  const relacionesQueFaltan = new Set<string>();
  const columnasQueFaltan: string[] = [];
  for (const c of columnasDelCodigo) {
    if (c.existe_relacion) columnasQueFaltan.push(`${c.relacion}.${c.columna}`);
    else if (!relacionesQueFaltan.has(c.relacion)) {
      relacionesQueFaltan.add(c.relacion);
      columnasQueFaltan.push(`${c.relacion} (no existe)`);
    }
  }

  // ---- disparadores que llaman a una función SECURITY DEFINER: corren
  //      con su dueño para cualquiera que escriba en la tabla, sin que
  //      Postgres mire EXECUTE
  const clavesDeDisparadores = new Set(disparadoresDefinerLeidos.map((d) => `${d.tabla}.${d.disparador}`));
  const disparadoresDefiner = disparadoresDefinerLeidos
    .filter((d) => !(`${d.tabla}.${d.disparador}` in DISPARADORES_DEFINER_DECLARADOS))
    .map((d) => `${d.tabla}.${d.disparador} → ${d.funcion}`);

  // ---- reglas: su acción corre con los privilegios del dueño de la tabla
  const clavesDeReglas = new Set(reglasLeidas.map((r) => `${r.tabla}.${r.regla}`));
  const reglas = [...clavesDeReglas].filter((k) => !(k in REGLAS_DECLARADAS));

  // ---- otros esquemas, y crear en public
  const esquemasDeMas: string[] = [];
  const esquemasConUso = new Set<string>();
  for (const e of esquemas) {
    if (e.esquema === 'public') {
      if (e.crea) esquemasDeMas.push(`public (CREATE: ${APP_ROLE} puede crear tablas, funciones y vistas propias)`);
      continue;
    }
    if (!e.uso && !e.crea) continue;
    esquemasConUso.add(e.esquema);
    if (!(e.esquema in ESQUEMAS_DECLARADOS)) {
      esquemasDeMas.push(`${e.esquema} (${[e.uso ? 'USAGE' : '', e.crea ? 'CREATE' : ''].filter(Boolean).join(', ')})`);
    }
  }

  // ---- el propio rol de la aplicación
  const rolDeLaApp: string[] = [];
  const rolesDeLosQueEsMiembro = new Set<string>();
  if (inventarioLeido && !rolesDeLaApp.some((r) => r.propio)) {
    rolDeLaApp.push(`el rol ${APP_ROLE} no existe en esta base: la guardia no sabe a quién medirle los privilegios`);
  }
  for (const r of rolesDeLaApp) {
    const atributos = [r.super ? 'SUPERUSER' : '', r.bypass ? 'BYPASSRLS' : '', r.crea_roles ? 'CREATEROLE' : ''].filter(Boolean);
    if (r.propio) {
      if (atributos.length) rolDeLaApp.push(`${APP_ROLE} tiene ${atributos.join(', ')}`);
      continue;
    }
    rolesDeLosQueEsMiembro.add(r.rol);
    if (r.rol in ROLES_DE_LA_APP_DECLARADOS) continue;
    rolDeLaApp.push(
      `${APP_ROLE} es miembro de ${r.rol}` +
        (atributos.length ? ` (${atributos.join(', ')})` : '') +
        ': hereda sus privilegios y puede hacer SET ROLE a él',
    );
  }

  // ---- borrar el padre no publica la fila: la columna de una rama
  //      «IS NULL» aceptada en lectura no puede ser ON DELETE SET NULL
  const accionPorColumna = new Map<string, { padre: string; borrar: string; actualizar: string }>();
  for (const r of referencias) {
    if (r.columnas === 1) {
      accionPorColumna.set(`${r.hija}.${r.columna}`, { padre: r.padre, borrar: r.al_borrar, actualizar: r.al_actualizar });
    }
  }
  const ACCIONES_QUE_SUELTAN: Record<string, string> = { n: 'SET NULL', d: 'SET DEFAULT' };
  const borradosQuePublican: string[] = [];
  const borradosQueAplican = new Set<string>();
  for (const t of tablas) {
    if (!t.rls) continue;
    const ctx = contexto(t.relname, 'lectura');
    const nulos = new Set<string>();
    for (const p of alcanzan(t.relname, 'SELECT').filter((x) => x.permisiva)) {
      const v = veredicto(p.qual, ctx);
      if (v.aisla) for (const c of v.nulos) nulos.add(c);
    }
    for (const col of [...nulos].sort()) {
      const clave = `${t.relname}.${col}`;
      const a = accionPorColumna.get(clave);
      if (!a) continue;
      const sueltan = [
        ACCIONES_QUE_SUELTAN[a.borrar] ? `ON DELETE ${ACCIONES_QUE_SUELTAN[a.borrar]}` : '',
        ACCIONES_QUE_SUELTAN[a.actualizar] ? `ON UPDATE ${ACCIONES_QUE_SUELTAN[a.actualizar]}` : '',
      ].filter(Boolean);
      if (!sueltan.length) continue;
      borradosQueAplican.add(clave);
      if (clave in BORRADOS_QUE_PUBLICAN_DECLARADOS) continue;
      borradosQuePublican.push(`${clave} → ${a.padre} (${sueltan.join(', ')})`);
    }
  }

  // ---- referencias: toda clave hacia una tabla con RLS, en una tabla
  //      que mc_app escribe, lleva el disparador de 0025 §3
  const comprobadas = new Set<string>();
  for (const d of disparadores) {
    if (!d.completo) continue;
    const [col, padre, pcol] = String(d.args).split('\\000');
    if (!col || !padre || !pcol) continue;
    if (d.columnas_update && !d.columnas_update.includes(col)) continue;
    comprobadas.add(`${d.tabla}.${col}→${padre}.${pcol}`);
  }
  const referenciasSinComprobar: string[] = [];
  const referenciasQueAplican = new Set<string>();
  for (const r of referencias) {
    const padre = porNombre.get(r.padre);
    const hija = porNombre.get(r.hija);
    if (!padre?.rls || !hija || (hija.relkind !== 'r' && hija.relkind !== 'p')) continue;
    const suyos = deLaApp(r.hija);
    if (!suyos.has('INSERT') && !suyos.has('UPDATE')) continue;
    const clave = `${r.hija}.${r.columna}`;
    referenciasQueAplican.add(clave);
    if (clave in REFERENCIAS_SIN_COMPROBAR_DECLARADAS) continue;
    if (r.columnas > 1) {
      referenciasSinComprobar.push(`${clave} → ${r.padre} (clave compuesta)`);
      continue;
    }
    if (!comprobadas.has(`${r.hija}.${r.columna}→${r.padre}.${r.columna_padre}`)) {
      referenciasSinComprobar.push(`${clave} → ${r.padre}`);
    }
  }
  const referenciasDeclaradasObsoletas = referencias.length
    ? Object.keys(REFERENCIAS_SIN_COMPROBAR_DECLARADAS).filter((k) => !referenciasQueAplican.has(k))
    : [];

  // ---- índices únicos: el 23505 no pasa por RLS. Uno sobre una tabla
  //      con RLS que mc_app escribe tiene que ser por inquilino.
  const unicosSinInquilino: string[] = [];
  const unicosQueAplican = new Set<string>();
  for (const u of unicos) {
    const t = porNombre.get(u.tabla);
    if (!t?.rls) continue;
    const suyos = deLaApp(u.tabla);
    if (!suyos.has('INSERT') && !suyos.has('UPDATE')) continue;
    const clave = `${u.tabla}.${u.indice}`;
    unicosQueAplican.add(clave);
    if (clave in UNICOS_GLOBALES_DECLARADOS) continue;
    const columnas = u.columnas ?? [];
    const propias = inquilinoPorTabla.get(u.tabla) ?? [];
    // La clave primaria sustituta de la fila (uuid al azar o bigserial):
    // la genera la base, no lleva dato, y chocar con ella solo dice que
    // ese id existe, que es lo que ya sabe quien lo escribe.
    const sustituta = u.primaria && u.generada;
    // La columna de inquilino, en las columnas o en una expresión.
    const conInquilino =
      columnas.some((c) => propias.includes(c)) ||
      (u.expresiones !== null && propias.some((c) => new RegExp(`\\b${c}\\b`).test(u.expresiones!)));
    // Una clave ajena hacia una tabla aislada sin filas globales: el
    // disparador de 0025 §3 impide nombrar la fila de otro, así que el
    // choque solo puede ser con lo propio.
    const conPadreAislado = columnas.some((c) => {
      const padre = padreDe.get(`${u.tabla}.${c}`);
      return padre !== undefined && aislamientoDe(padre) === 'estricto';
    });
    // Parcial sobre las filas SIN dueño: esas mc_app no las escribe (la
    // mitad de escritura de la guardia no acepta la rama «IS NULL»).
    const soloSinDueno =
      u.predicado !== null && terminosDelAnd(u.predicado).some((x) => propias.some((c) => x === `${c} IS NULL`));
    if (sustituta || conInquilino || conPadreAislado || soloSinDueno) continue;
    unicosSinInquilino.push(`${clave} (${[...columnas, ...(u.expresiones ? [u.expresiones] : [])].join(', ')})`);
  }
  const unicosDeclaradosObsoletos = unicos.length
    ? Object.keys(UNICOS_GLOBALES_DECLARADOS).filter((k) => !unicosQueAplican.has(k))
    : [];

  // ---- privilegios de mc_app: los declarados y los prohibidos
  const privilegiosDeMas: PrivilegioDeMas[] = [];
  for (const r of relaciones) {
    if (r.relkind === 'S') continue; // abajo, con sus propias reglas
    const tiene = deLaApp(r.relname);
    if (!tiene.size) continue;
    const declarado = PRIVILEGIOS_DE_LA_APP[r.relname];
    const sobran = declarado ? PRIVILEGIOS.filter((p) => tiene.has(p) && !declarado.permite.includes(p)) : [];
    const prohibidos = PRIVILEGIOS_PROHIBIDOS.filter((p) => tiene.has(p));
    if (sobran.length) {
      privilegiosDeMas.push({
        tabla: r.relname,
        privilegios: [...sobran],
        motivo: declarado!.motivo + notaDeColumnas(r.relname, sobran),
      });
    }
    if (prohibidos.length) {
      privilegiosDeMas.push({
        tabla: r.relname,
        privilegios: [...prohibidos],
        motivo:
          'una aplicación no los necesita en ninguna relación: TRUNCATE se salta la RLS entera' +
          notaDeColumnas(r.relname, prohibidos),
      });
    }
    // Los que se permiten solo por columna: ni de tabla entera, ni en
    // una columna que no esté en la lista.
    for (const [priv, columnas] of Object.entries(declarado?.soloColumnas ?? {})) {
      if (!tiene.has(priv) || !columnas) continue;
      const lista = columnas.join(', ');
      if (deTablaEntera.get(r.relname)?.has(priv)) {
        privilegiosDeMas.push({
          tabla: r.relname,
          privilegios: [priv],
          motivo:
            `concedido de TABLA ENTERA, y solo se permite en (${lista}): la política aísla la fila, no las ` +
            `columnas. REVOKE ${priv} ON ${r.relname} FROM ${APP_ROLE} y GRANT ${priv} (${lista}) ON ${r.relname}`,
        });
      }
      const deMas = [...(porColumna.get(r.relname)?.get(priv) ?? [])].filter((c) => !columnas.includes(c)).sort();
      if (deMas.length) {
        privilegiosDeMas.push({
          tabla: r.relname,
          privilegios: [priv],
          motivo: `concedido POR COLUMNA en ${deMas.join(', ')}, que no están en (${lista})`,
        });
      }
    }
  }

  // ---- secuencias: son de la tabla entera, no de un inquilino
  for (const q of secuencias) {
    if (q.relname in SECUENCIAS_DECLARADAS) continue;
    const tiene = deLaApp(q.relname);
    const lee = (['SELECT', 'UPDATE'] as const).filter((p) => tiene.has(p));
    if (lee.length) {
      privilegiosDeMas.push({
        tabla: q.relname,
        privilegios: [...lee],
        motivo:
          'secuencia: con SELECT, last_value es el volumen de TODA la plataforma; UPDATE es setval. ' +
          'nextval y el DEFAULT solo necesitan USAGE',
      });
    }
    if (tiene.has('USAGE') && !(q.tabla_duena && deLaApp(q.tabla_duena).has('INSERT'))) {
      privilegiosDeMas.push({
        tabla: q.relname,
        privilegios: ['USAGE'],
        motivo: q.tabla_duena
          ? `${APP_ROLE} no inserta en ${q.tabla_duena}: nextval() solo le serviría para medir cuánto escribe el worker`
          : 'secuencia suelta, sin tabla: nadie en la aplicación la necesita',
      });
    }
  }
  const nombresDeSecuencias = new Set(secuencias.map((q) => q.relname));
  const otrasDeclaracionesObsoletas: string[] = relaciones.length
    ? [
        ...Object.keys(SECUENCIAS_DECLARADAS)
          .filter((q) => !nombresDeSecuencias.has(q))
          .map((q) => `SECUENCIAS_DECLARADAS: ${q}`),
        ...Object.keys(HIJAS_CON_GLOBALES_DECLARADAS)
          .filter((h) => !(inquilinoPorTabla.get(h) ?? []).length)
          .map((h) => `HIJAS_CON_GLOBALES_DECLARADAS: ${h}`),
      ]
    : [];
  if (inventarioLeido) {
    const sobran = (lista: string, declaradas: Readonly<Record<string, string>>, existen: (k: string) => boolean) =>
      Object.keys(declaradas)
        .filter((k) => !existen(k))
        .map((k) => `${lista}: ${k}`);
    otrasDeclaracionesObsoletas.push(
      ...sobran('DISPARADORES_DEFINER_DECLARADOS', DISPARADORES_DEFINER_DECLARADOS, (k) => clavesDeDisparadores.has(k)),
      ...sobran('REGLAS_DECLARADAS', REGLAS_DECLARADAS, (k) => clavesDeReglas.has(k)),
      ...sobran('ESQUEMAS_DECLARADOS', ESQUEMAS_DECLARADOS, (k) => esquemasConUso.has(k)),
      ...sobran('ROLES_DE_LA_APP_DECLARADOS', ROLES_DE_LA_APP_DECLARADOS, (k) => rolesDeLosQueEsMiembro.has(k)),
      ...(politicas.length
        ? sobran('AISLADAS_POR_PERSONA_DECLARADAS', AISLADAS_POR_PERSONA_DECLARADAS, (k) => personasUsadas.has(k))
        : []),
      ...sobran('BORRADOS_QUE_PUBLICAN_DECLARADOS', BORRADOS_QUE_PUBLICAN_DECLARADOS, (k) => borradosQueAplican.has(k)),
    );
  }

  // ---- los demás roles
  const rolesDeMas: RolDeMas[] = [];
  for (const [relacion, roles] of privilegiosPorRelacion) {
    const dueno = porNombre.get(relacion)?.dueno;
    for (const [rol, privs] of roles) {
      if (rol === dueno || rol === APP_ROLE || rol in ROLES_CON_ACCESO_DECLARADOS) continue;
      rolesDeMas.push({ tabla: relacion, rol, privilegios: [...privs].sort() });
    }
  }

  // ---- el rol de los enlaces públicos. Está en ROLES_CON_ACCESO_DECLARADOS,
  //      así que el bucle de arriba lo deja pasar; lo que puede se mide
  //      aquí, contra su inventario exacto. `deMas` se dice siempre;
  //      `faltan`, solo con la base al día (antes de 0030 no existe nada).
  const enlaceDeMas: string[] = [];
  const enlaceFaltan: string[] = [];
  const rolEnlace = rolDelEnlace[0];
  if (inventarioLeido && !rolEnlace) {
    enlaceFaltan.push(`el rol ${PUBLIC_SHARE_ROLE} no existe: las funciones de los enlaces públicos no tienen dueño`);
  }
  if (rolEnlace) {
    const atributos = [
      rolEnlace.super ? 'SUPERUSER' : '',
      rolEnlace.bypass ? 'BYPASSRLS' : '',
      rolEnlace.entra ? 'LOGIN' : '',
      rolEnlace.crea_roles ? 'CREATEROLE' : '',
    ].filter(Boolean);
    if (atributos.length) {
      enlaceDeMas.push(
        `${PUBLIC_SHARE_ROLE} tiene ${atributos.join(', ')}: tiene que ser NOLOGIN, sin BYPASSRLS, sin SUPERUSER y ` +
          'sin CREATEROLE (0030 §1)',
      );
    }
    const miembroDe = rolEnlace.miembro_de ?? [];
    if (miembroDe.length) {
      enlaceDeMas.push(
        `${PUBLIC_SHARE_ROLE} es miembro de ${miembroDe.join(', ')}: sus funciones heredarían esos privilegios o ` +
          'harían SET ROLE a ellos',
      );
    }
  }
  // Privilegios: los de tabla entera y los de columna, contra el inventario.
  const delEnlace = new Map<string, { tabla: Set<string>; columnas: Map<string, Set<string>> }>();
  for (const p of privilegios) {
    if (p.rol !== PUBLIC_SHARE_ROLE) continue;
    let r = delEnlace.get(p.relname);
    if (!r) delEnlace.set(p.relname, (r = { tabla: new Set(), columnas: new Map() }));
    if (!p.columna) r.tabla.add(p.privilegio);
    else {
      let cols = r.columnas.get(p.privilegio);
      if (!cols) r.columnas.set(p.privilegio, (cols = new Set()));
      cols.add(p.columna);
    }
  }
  for (const [relacion, tiene] of [...delEnlace].sort(([a], [b]) => a.localeCompare(b))) {
    const declarado = PRIVILEGIOS_DEL_ENLACE_PUBLICO[relacion];
    const deTabla = [...tiene.tabla].filter((p) => !declarado?.tabla.includes(p)).sort();
    if (deTabla.length) {
      const porColumnas = deTabla.filter((p) => declarado?.columnas?.[p]);
      enlaceDeMas.push(
        `${relacion}: ${deTabla.join(', ')} de la relación entera` +
          (porColumnas.length ? ` (solo se concede por columna: ${porColumnas.join(', ')})` : ''),
      );
    }
    for (const [priv, cols] of [...tiene.columnas].sort(([a], [b]) => a.localeCompare(b))) {
      // Un GRANT de columna de un privilegio que ya tiene de tabla entera no añade nada.
      if (declarado?.tabla.includes(priv)) continue;
      const permitidas = declarado?.columnas?.[priv] ?? [];
      const deMas = [...cols].filter((c) => !permitidas.includes(c)).sort();
      if (deMas.length) enlaceDeMas.push(`${relacion}: ${priv} en ${deMas.join(', ')}`);
    }
  }
  for (const [relacion, declarado] of Object.entries(PRIVILEGIOS_DEL_ENLACE_PUBLICO)) {
    const tiene = delEnlace.get(relacion);
    const faltaTabla = declarado.tabla.filter((p) => !tiene?.tabla.has(p));
    const faltaColumnas = Object.entries(declarado.columnas ?? {}).flatMap(([priv, cols]) =>
      tiene?.tabla.has(priv) ? [] : cols.filter((c) => !tiene?.columnas.get(priv)?.has(c)).map((c) => `${priv} (${c})`),
    );
    const falta = [...faltaTabla, ...faltaColumnas];
    if (falta.length) enlaceFaltan.push(`${relacion}: le falta ${falta.join(', ')} (${declarado.motivo})`);
  }
  // Dueño de una relación: tendría todos los privilegios sin que salgan
  // en la ACL.
  for (const r of relaciones) {
    if (r.dueno === PUBLIC_SHARE_ROLE) {
      enlaceDeMas.push(`${r.relname}: ${PUBLIC_SHARE_ROLE} es su dueño, y el dueño lo puede todo sin GRANT`);
    }
  }
  // Políticas: exactamente las declaradas, y cada una con su forma.
  const politicasVistas = new Set<string>();
  for (const p of politicasDelEnlace) {
    politicasVistas.add(p.clave);
    const declarada = POLITICAS_DEL_ENLACE_PUBLICO[p.clave];
    if (!declarada) {
      enlaceDeMas.push(
        `política ${p.clave} TO ${PUBLIC_SHARE_ROLE}, que 0030 no crea (USING ${p.qual ?? '—'})`,
      );
      continue;
    }
    if (p.cmd !== declarada.cmd) {
      enlaceDeMas.push(`política ${p.clave}: es para el comando «${p.cmd}» y 0030 la crea para «${declarada.cmd}»`);
      continue;
    }
    const cumple = (expr: string | null) =>
      expr !== null &&
      terminosDelAnd(expr).some((t) => !/ OR /i.test(t) && declarada.exige.every((re) => re.test(t)));
    // Una política de INSERT ('a') no tiene USING: lo que acota la fila
    // es su WITH CHECK, que entonces es obligatorio.
    const alta = p.cmd === 'a';
    const malas = [
      (alta && p.qual === null) || cumple(p.qual) ? '' : `USING ${p.qual ?? '(sin expresión)'}`,
      (!alta && p.with_check === null) || cumple(p.with_check) ? '' : `WITH CHECK ${p.with_check ?? '(sin expresión)'}`,
    ].filter(Boolean);
    if (malas.length) {
      enlaceDeMas.push(`política ${p.clave} ya no abre solo ${declarada.motivo}: ${malas.join('; ')}`);
    }
  }
  for (const [clave, declarada] of Object.entries(POLITICAS_DEL_ENLACE_PUBLICO)) {
    if (!politicasVistas.has(clave)) enlaceFaltan.push(`falta la política ${clave} (${declarada.motivo})`);
  }

  const tiene = new Set(aplicadas ?? []);
  const pendientes = aplicadas === null ? [] : enElRepo.filter((f) => !tiene.has(f));
  // Contra una base a medio migrar, «esa declaración sobra porque el
  // objeto no existe» no quiere decir nada: lo crea una migración
  // pendiente. Medido contra Supabase antes de aplicar 0024: la guardia
  // pedía borrar la declaración de api_call_log_insert, que es la que
  // 0024 crea. Con pendientes, las listas de obsoletas se callan; lo que
  // sí se dice son las pendientes.
  const siAlDia = (xs: string[]) => (pendientes.length ? [] : xs);
  return {
    aplicadas: aplicadas === null ? -1 : aplicadas.length,
    ultima: aplicadas && aplicadas.length ? (aplicadas[aplicadas.length - 1] ?? null) : null,
    pendientes,
    sinRls: sinAislar.map((t) => t.tabla),
    sinAislar,
    aisladas,
    excepcionesObsoletas: siAlDia(excepcionesObsoletas),
    excepcionesSinPrivilegios,
    politicasAbiertas,
    politicasAbiertasObsoletas: siAlDia(politicasAbiertasObsoletas),
    vistasSinInvocador,
    vistasDeclaradasObsoletas: siAlDia(vistasDeclaradasObsoletas),
    relacionesSinRls,
    relacionesSinRlsObsoletas: siAlDia(relacionesSinRlsObsoletas),
    funcionesDefiner,
    funcionesDefinerObsoletas: siAlDia(funcionesDefinerObsoletas),
    funcionesQueFaltan,
    columnasQueFaltan,
    disparadoresDefiner,
    candadosQueFaltan,
    reglas,
    esquemasDeMas,
    rolDeLaApp,
    borradosQuePublican,
    referenciasSinComprobar,
    referenciasDeclaradasObsoletas: siAlDia(referenciasDeclaradasObsoletas),
    unicosSinInquilino,
    unicosDeclaradosObsoletos: siAlDia(unicosDeclaradosObsoletos),
    otrasDeclaracionesObsoletas: siAlDia(otrasDeclaracionesObsoletas),
    privilegiosDeMas,
    rolesDeMas,
    // Lo que falta solo dice algo en una base migrada y al día.
    enlacePublico: [...enlaceDeMas, ...(aplicadas === null ? [] : siAlDia(enlaceFaltan))],
    comparadoConArchivos: enElRepo.length > 0 && aplicadas !== null,
    inventarioLeido,
  };
}

/** Un estado recién construido a mano (pruebas, preflight): todo en orden salvo lo que se sobrescriba. */
export const ESQUEMA_AL_DIA: EstadoDelEsquema = {
  aplicadas: 0,
  ultima: null,
  pendientes: [],
  sinRls: [],
  sinAislar: [],
  aisladas: [],
  excepcionesObsoletas: [],
  excepcionesSinPrivilegios: [],
  politicasAbiertas: [],
  politicasAbiertasObsoletas: [],
  vistasSinInvocador: [],
  vistasDeclaradasObsoletas: [],
  relacionesSinRls: [],
  relacionesSinRlsObsoletas: [],
  funcionesDefiner: [],
  funcionesDefinerObsoletas: [],
  funcionesQueFaltan: [],
  columnasQueFaltan: [],
  disparadoresDefiner: [],
  candadosQueFaltan: [],
  reglas: [],
  esquemasDeMas: [],
  rolDeLaApp: [],
  borradosQuePublican: [],
  referenciasSinComprobar: [],
  referenciasDeclaradasObsoletas: [],
  unicosSinInquilino: [],
  unicosDeclaradosObsoletos: [],
  otrasDeclaracionesObsoletas: [],
  privilegiosDeMas: [],
  rolesDeMas: [],
  enlacePublico: [],
  comparadoConArchivos: true,
  inventarioLeido: true,
};

/** El texto del problema, o null si no hay ninguno. */
export function explicarEsquema(estado: EstadoDelEsquema): string | null {
  const partes: string[] = [];
  if (!estado.inventarioLeido) {
    // Lo primero, porque invalida todo lo demás: con el inventario sin
    // leer, las listas vacías de abajo no dicen «está bien», dicen «no
    // se pudo preguntar». Y tampoco se dice «nunca se migró»: con la
    // base caída, schema_migrations falla igual que si no existiera.
    partes.push(
      'no se pudo leer el inventario de tablas, políticas y privilegios de la base: la guardia no comprobó nada. ' +
        'Puede ser que la base no conteste, un permiso que le falta a la conexión, un statement_timeout o un pooler que cortó',
    );
  } else if (estado.aplicadas === -1) {
    partes.push('la base no tiene schema_migrations: nunca se migró');
  } else if (estado.pendientes.length) {
    partes.push(
      `faltan ${estado.pendientes.length} migración(es) por aplicar (la base va por ${estado.ultima ?? '—'}): ` +
        estado.pendientes.join(', '),
    );
  }
  if (estado.sinRls.length) {
    const detalle = estado.sinAislar.length
      ? estado.sinAislar.map((t) => `${t.tabla} (${t.falta})`).join(', ')
      : estado.sinRls.join(', ');
    partes.push(
      `sin aislamiento por fila, que es lo que separa a cada workspace: ${detalle}. ` +
        'Mientras tanto esas tablas devuelven las filas de TODOS los workspaces. ' +
        'Si alguna es global a propósito, decláralo en EXCEPCIONES_SIN_AISLAMIENTO con su motivo',
    );
  }
  if (estado.politicasAbiertas.length) {
    partes.push(
      'hay políticas permisivas que no aíslan por sí solas, y como se combinan con OR anulan a las demás de su tabla: ' +
        estado.politicasAbiertas.map((p) => `${p.clave} [${p.comandos.join(', ')}] por «${p.trozo}»`).join('; ') +
        '. Si alguna es abierta a propósito, decláralo en POLITICAS_ABIERTAS_DECLARADAS con su motivo',
    );
  }
  if (estado.vistasSinInvocador.length) {
    partes.push(
      'hay vistas sin security_invoker, que leen sus tablas base con los privilegios de su DUEÑO y rodean ' +
        `los GRANT de ${APP_ROLE}: ` +
        estado.vistasSinInvocador.join(', ') +
        '. Ponles ALTER VIEW … SET (security_invoker = on) en una migración, o decláralas en VISTAS_SIN_INVOCADOR',
    );
  }
  if (estado.relacionesSinRls.length) {
    partes.push(
      `${APP_ROLE} tiene privilegios sobre relaciones que no admiten RLS y guardan las filas de todos: ` +
        estado.relacionesSinRls.join(', ') +
        `. Revócaselos a ${APP_ROLE} en una migración, o decláralas en RELACIONES_SIN_RLS_DECLARADAS`,
    );
  }
  if (estado.funcionesDefiner.length) {
    partes.push(
      'hay funciones SECURITY DEFINER en public, que corren con los privilegios de su dueño: ' +
        estado.funcionesDefiner.join(', ') +
        '. Revocar EXECUTE no basta: un disparador la corre igual. Hazlas SECURITY INVOKER, o decláralas en ' +
        'FUNCIONES_DEFINER_DECLARADAS con su motivo',
    );
  }
  if (estado.funcionesQueFaltan.length) {
    partes.push(
      'faltan funciones que el código llama por su nombre, y las pantallas que las usan fallan al primer clic: ' +
        estado.funcionesQueFaltan.join('; '),
    );
  }
  if (estado.columnasQueFaltan.length) {
    partes.push(
      'faltan columnas o relaciones que el código lee y escribe (las declara src/schema), y la primera consulta que ' +
        'las nombre falla: ' +
        estado.columnasQueFaltan.join(', ') +
        '. Aplica las migraciones que faltan con make db.migrate',
    );
  }
  if (estado.disparadoresDefiner.length) {
    partes.push(
      'hay disparadores que llaman a una función SECURITY DEFINER: corren con los privilegios de su dueño para ' +
        `cualquiera que escriba en la tabla, también ${APP_ROLE}, y Postgres no mira EXECUTE al disparar: ` +
        estado.disparadoresDefiner.join(', ') +
        '. Quítalos, haz la función SECURITY INVOKER, o decláralos en DISPARADORES_DEFINER_DECLARADOS',
    );
  }
  if (estado.candadosQueFaltan.length) {
    partes.push(
      'faltan o están desactivados disparadores que cierran un hueco de seguridad, y ningún GRANT lo cierra en ' +
        'su lugar: ' +
        estado.candadosQueFaltan.join('; ') +
        '. Vuelve a activarlos (ALTER TABLE … ENABLE TRIGGER) o aplica la migración que los crea',
    );
  }
  if (estado.reglas.length) {
    partes.push(
      'hay reglas (CREATE RULE) en public: su acción corre con los privilegios del dueño de la tabla y rodea los ' +
        `GRANT de ${APP_ROLE}: ` +
        estado.reglas.join(', ') +
        '. Bórralas (un disparador SECURITY INVOKER hace lo mismo sin rodear nada), o decláralas en REGLAS_DECLARADAS',
    );
  }
  if (estado.esquemasDeMas.length) {
    partes.push(
      `${APP_ROLE} llega a esquemas que la guardia no inspecciona, o puede crear objetos: ` +
        estado.esquemasDeMas.join(', ') +
        `. Revócaselo (REVOKE USAGE ON SCHEMA … FROM ${APP_ROLE}), o declara el esquema en ESQUEMAS_DECLARADOS`,
    );
  }
  if (estado.rolDeLaApp.length) {
    partes.push(
      `el rol ${APP_ROLE} tiene más de lo que dicen sus GRANT: ` +
        estado.rolDeLaApp.join('; ') +
        '. Un atributo o una membresía así se salta la RLS o hereda privilegios que la guardia no ve. Corrígelo con ' +
        './scripts/supabase-admin.sh (mc_migrator no puede alterar roles), o declara el rol en ROLES_DE_LA_APP_DECLARADOS',
    );
  }
  if (estado.borradosQuePublican.length) {
    partes.push(
      'hay claves ajenas que, al borrar el padre, dejan a NULL una columna cuya lectura dice «sin padre, es de ' +
        'todos»: borrar el padre PUBLICA la fila: ' +
        estado.borradosQuePublican.join(', ') +
        '. Cámbialas a ON DELETE CASCADE o RESTRICT en una migración (ver 0029 §2), o decláralas en ' +
        'BORRADOS_QUE_PUBLICAN_DECLARADOS',
    );
  }
  if (estado.referenciasSinComprobar.length) {
    partes.push(
      'hay claves ajenas hacia tablas con RLS sin el disparador assert_reference_visible, así que una fila puede ' +
        'nombrar la de otro workspace si sabe su id: ' +
        estado.referenciasSinComprobar.join(', ') +
        '. Engánchalo en una migración (ver 0025 §7), o decláralas en REFERENCIAS_SIN_COMPROBAR_DECLARADAS',
    );
  }
  if (estado.unicosSinInquilino.length) {
    partes.push(
      'hay índices únicos globales en tablas con dueño: el 23505 no pasa por RLS, así que le dicen a un workspace ' +
        'qué valores tiene otro y le impiden guardar los suyos: ' +
        estado.unicosSinInquilino.join(', ') +
        '. Hazlos por inquilino en una migración (ver 0026 §2), o decláralos en UNICOS_GLOBALES_DECLARADOS',
    );
  }
  if (estado.privilegiosDeMas.length) {
    partes.push(
      `${APP_ROLE} tiene privilegios que no le tocan: ` +
        estado.privilegiosDeMas.map((p) => `${p.tabla} (${p.privilegios.join(', ')}: ${p.motivo})`).join('; '),
    );
  }
  if (estado.rolesDeMas.length) {
    partes.push(
      'hay roles con privilegios en public que no son el dueño, ni la aplicación, ni uno declarado: ' +
        estado.rolesDeMas.map((r) => `${r.rol} en ${r.tabla} (${r.privilegios.join(', ')})`).join('; ') +
        '. Revócalos, o declara el rol en ROLES_CON_ACCESO_DECLARADOS con su motivo',
    );
  }
  if (estado.enlacePublico.length) {
    partes.push(
      `el rol de los enlaces públicos (${PUBLIC_SHARE_ROLE}), que atiende /kit, /cotizacion y la baja sin sesión, ` +
        'no es el que prometen 0030 y 0037: ' +
        estado.enlacePublico.join('; ') +
        '. Revoca lo que sobra (los atributos y las membresías, con ./scripts/supabase-admin.sh), o cambia ' +
        'PRIVILEGIOS_DEL_ENLACE_PUBLICO / POLITICAS_DEL_ENLACE_PUBLICO junto con la migración que lo concede',
    );
  }
  if (estado.excepcionesSinPrivilegios.length) {
    partes.push(
      `declaraste la excepción sin decir qué puede hacer ${APP_ROLE} con ella, y sin RLS el GRANT es lo ` +
        'único que la protege: ' +
        estado.excepcionesSinPrivilegios.join(', ') +
        '. Añádelas a PRIVILEGIOS_DE_LA_APP',
    );
  }
  const sobran = [
    ...estado.excepcionesObsoletas.map((t) => `EXCEPCIONES_SIN_AISLAMIENTO: ${t}`),
    ...estado.politicasAbiertasObsoletas.map((k) => `POLITICAS_ABIERTAS_DECLARADAS: ${k}`),
    ...estado.vistasDeclaradasObsoletas.map((v) => `VISTAS_SIN_INVOCADOR: ${v}`),
    ...estado.relacionesSinRlsObsoletas.map((v) => `RELACIONES_SIN_RLS_DECLARADAS: ${v}`),
    ...estado.funcionesDefinerObsoletas.map((v) => `FUNCIONES_DEFINER_DECLARADAS: ${v}`),
    ...estado.referenciasDeclaradasObsoletas.map((v) => `REFERENCIAS_SIN_COMPROBAR_DECLARADAS: ${v}`),
    ...estado.unicosDeclaradosObsoletos.map((v) => `UNICOS_GLOBALES_DECLARADOS: ${v}`),
    ...estado.otrasDeclaracionesObsoletas,
  ];
  if (sobran.length) {
    partes.push('sobran excepciones declaradas (el objeto ya no existe, o ya está cerrado): ' + sobran.join(', '));
  }
  if (!partes.length) return null;
  // Con el inventario sin leer, «migra» es el consejo equivocado: la
  // base puede estar al día y solo caída.
  const consejo = estado.inventarioLeido
    ? 'Corre: make db.migrate'
    : 'Comprueba primero que la base conteste (make db.info) antes de migrar nada';
  return `[db] La base no tiene el esquema de este repositorio: ${partes.join('; ')}. ${consejo}`;
}

/**
 * ¿Un esquema atrasado impide arrancar?
 *
 * En producción sí: servir pantallas sin el aislamiento que el producto
 * promete es peor que no servirlas. La única salida es explícita y deja
 * rastro —ALLOW_STALE_SCHEMA=1—, para el despliegue que tiene que salir
 * antes de que el integrador corra `make db.migrate`; entonces el aviso
 * sale por stderr en cada arranque. Mismo patrón que
 * ALLOW_SEED_WORKSPACE en la web.
 */
export function esquemaObligatorio(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' && env.ALLOW_STALE_SCHEMA !== '1';
}

/**
 * Comprueba el esquema una vez, al construir el cliente. En producción
 * lanza; en desarrollo avisa y sigue, que es lo que permite trabajar
 * contra una base a medio migrar sabiéndolo.
 */
export async function assertSchemaUpToDate(
  db: CatalogDb,
  opts: { production?: boolean; warn?: (message: string) => void } = {},
): Promise<EstadoDelEsquema> {
  const estado = await estadoDelEsquema(db);
  const problema = explicarEsquema(estado);
  if (problema) {
    if (opts.production) throw new Error(problema);
    // stderr y no console: ver la nota de createPool. La web pasa su
    // logger si quiere otra cosa.
    (opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`)))(problema);
  }
  return estado;
}
