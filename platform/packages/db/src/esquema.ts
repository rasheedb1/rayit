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
 *     FUNCIONES_DEFINER_DECLARADAS.
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
import type { CatalogDb } from './client.ts';
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
  external_account_baseline: 'línea base de cuentas AJENAS que el radar observa: no cuelga de ningún workspace',
  trend_signal: 'tendencias por red y nicho: observación pública, sin dueño',

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
 */
export const FUNCIONES_DEFINER_DECLARADAS: Readonly<Record<string, string>> = {
  'contact_suppression_apply()':
    'la baja global (0026 §3, 0029 §1): mc_app no puede leer contact_suppression, y un contacto que nace con un ' +
    'correo suprimido tiene que nacer dado de baja. Solo LEE la lista y cambia NEW; no escribe ninguna tabla. La ' +
    'lista la llena solo el worker con una baja verificada, así que lo que aplica no lo puede fabricar un workspace',
};

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
  'connection_secret.connection_secret_pkey':
    'la referencia es `enc:<plataforma>:<uuid>` y el uuid lo genera el código (encrypted-secret-store.ts): ' +
    'chocar con una exige conocerla, y conocerla ya es tenerla',
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
export const PRIVILEGIOS_DE_LA_APP: Readonly<Record<string, { permite: readonly Privilegio[]; motivo: string }>> = {
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
  post_metric_snapshot: { permite: ['SELECT'], motivo: 'métrica append-only del worker' },
  audience_breakdown: { permite: ['SELECT'], motivo: 'métrica append-only del worker' },
  post_engagement_curve: { permite: ['SELECT'], motivo: 'métrica append-only del worker' },
  post_retention_curve: { permite: ['SELECT'], motivo: 'métrica append-only del worker' },
  post_impression_source: { permite: ['SELECT'], motivo: 'métrica append-only del worker' },
  post_score: { permite: ['SELECT'], motivo: 'lo calcula el worker a partir de las métricas' },
  creator_baseline: { permite: ['SELECT'], motivo: 'lo calcula el worker a partir de las métricas' },
  campaign_result: { permite: ['SELECT'], motivo: 'lo consolida el worker a partir de las métricas' },
  job_run: { permite: ['SELECT'], motivo: 'bitácora de trabajos: la escribe el worker, la web solo la lee' },
  account_metric_snapshot: {
    permite: ['SELECT', 'INSERT', 'UPDATE'],
    motivo:
      'métrica: nadie la borra. CON-10 (en main) guarda desde la web el snapshot público del día con un upsert; ' +
      'el UPDATE se queda hasta que su dueño lo pase al worker',
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

  // Contabilidad del runner: se lee al arrancar y no se escribe desde la app.
  schema_migrations: { permite: ['SELECT'], motivo: 'la lee la guardia de esquema; escribirla sería mentirle a la base' },

  // Tablas de inquilino con un comando de menos.
  workspace: { permite: ['SELECT', 'INSERT', 'UPDATE'], motivo: 'borrar un inquilino es del worker, no de una pantalla' },
  membership: { permite: ['SELECT'], motivo: 'el alta y la baja de personas son del worker hasta CIM-3' },
  app_user: { permite: ['SELECT', 'INSERT', 'UPDATE'], motivo: 'nadie borra a una persona desde una pantalla' },
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
  /** Disparadores de tablas de `public` que llaman a una función SECURITY DEFINER, sin declarar. */
  disparadoresDefiner: string[];
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
 * TODAS las funciones de `public` que corren con los privilegios de su
 * dueño. No se filtra por EXECUTE a propósito: una función de disparador
 * corre aunque quien escribe no pueda ejecutarla (ver la nota de arriba).
 */
const SQL_FUNCIONES = `
  SELECT p.oid::regprocedure::text AS firma
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
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
  const funciones = await leer<FilaFuncion>(SQL_FUNCIONES);
  const referencias = await leer<FilaReferencia>(SQL_REFERENCIAS);
  const disparadores = await leer<FilaDisparador>(SQL_DISPARADORES, [FUNCION_DE_REFERENCIAS]);
  const inquilinos = await leer<FilaInquilino>(SQL_INQUILINOS, [[...COLUMNAS_DE_INQUILINO]]);
  const unicos = await leer<FilaUnico>(SQL_UNICOS);
  const disparadoresDefinerLeidos = await leer<FilaDisparadorDefiner>(SQL_DISPARADORES_DEFINER);
  const reglasLeidas = await leer<FilaRegla>(SQL_REGLAS);
  const esquemas = await leer<FilaEsquema>(SQL_ESQUEMAS, [APP_ROLE]);
  const rolesDeLaApp = await leer<FilaRol>(SQL_ROL_DE_LA_APP, [APP_ROLE]);

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
  for (const p of privilegios) {
    let roles = privilegiosPorRelacion.get(p.relname);
    if (!roles) privilegiosPorRelacion.set(p.relname, (roles = new Map()));
    let s = roles.get(p.rol);
    if (!s) roles.set(p.rol, (s = new Set()));
    s.add(p.privilegio);
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
    if (restrictivas.some((v) => v.aisla && !v.globales)) return 'estricto';
    let globales = false;
    for (const p of ps.filter((x) => x.permisiva)) {
      const v = veredicto(p.qual, ctx);
      if (!v.aisla) return 'no'; // abierta, declarada o no: lo que cuelgue de ella hereda la apertura
      globales ||= v.globales;
    }
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
    disparadoresDefiner,
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
  disparadoresDefiner: [],
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
  if (estado.disparadoresDefiner.length) {
    partes.push(
      'hay disparadores que llaman a una función SECURITY DEFINER: corren con los privilegios de su dueño para ' +
        `cualquiera que escriba en la tabla, también ${APP_ROLE}, y Postgres no mira EXECUTE al disparar: ` +
        estado.disparadoresDefiner.join(', ') +
        '. Quítalos, haz la función SECURITY INVOKER, o decláralos en DISPARADORES_DEFINER_DECLARADOS',
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
