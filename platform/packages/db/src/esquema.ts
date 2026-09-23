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
 *   · Funciones SECURITY DEFINER de `public` que mc_app puede ejecutar.
 *     Corren con los privilegios de su dueño y rodean los GRANT igual que
 *     una vista. Se exige que no haya ninguna, o entrada en
 *     FUNCIONES_DEFINER_DECLARADAS.
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
import { veredicto, type AislamientoDeLectura, type Lado } from './politicas.ts';

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
 * Las funciones SECURITY DEFINER de `public` que mc_app puede ejecutar,
 * por su firma (`nombre(tipos)`), y por qué. Vacía: ninguna función del
 * esquema es SECURITY DEFINER.
 */
export const FUNCIONES_DEFINER_DECLARADAS: Readonly<Record<string, string>> = {};

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
  /** Funciones SECURITY DEFINER de `public` que mc_app puede ejecutar sin declararlo. */
  funcionesDefiner: string[];
  /** Entradas de FUNCIONES_DEFINER_DECLARADAS que ya no corresponden. */
  funcionesDefinerObsoletas: string[];
  /** Claves ajenas hacia una tabla con RLS, escribibles por mc_app, sin assert_reference_visible. */
  referenciasSinComprobar: string[];
  /** Entradas de REFERENCIAS_SIN_COMPROBAR_DECLARADAS que ya no corresponden. */
  referenciasDeclaradasObsoletas: string[];
  /** Privilegios que mc_app conserva y no debería. */
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
  /** 'r' y 'p' son tablas; 'v', vistas; 'm', vistas materializadas; 'f', tablas foráneas. */
  relkind: string;
  rls: boolean;
  forzada: boolean;
  politicas: number;
  /** Vistas: si llevan `security_invoker = on` en reloptions. */
  invocador: boolean;
  /** El rol dueño: el único, además de los declarados, que puede tener privilegios. */
  dueno: string;
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
         pg_get_userbyid(c.relowner)::text AS dueno
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
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
 * leídos de pg_class.relacl con aclexplode.
 *
 * No se usa information_schema.role_table_grants a propósito: esa vista
 * solo enseña las concesiones en las que el usuario actual es parte, y
 * el worker consulta esto como mc_worker. relacl la ve cualquiera, así
 * que la respuesta es la misma se pregunte desde donde se pregunte. El
 * grantee 0 es PUBLIC.
 */
const SQL_PRIVILEGIOS = `
  SELECT c.relname AS relname,
         coalesce(r.rolname::text, 'PUBLIC') AS rol,
         a.privilege_type AS privilegio
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL aclexplode(c.relacl) a
    LEFT JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
   ORDER BY 1, 2, 3`;

/** Las funciones de `public` que corren con los privilegios de su dueño y mc_app puede llamar. */
const SQL_FUNCIONES = `
  SELECT p.oid::regprocedure::text AS firma
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege($1::name, p.oid, 'EXECUTE')
   ORDER BY 1`;

/** Las claves ajenas de `public`, con su primera columna y cuántas tiene. */
const SQL_REFERENCIAS = `
  SELECT hija.relname AS hija, a.attname::text AS columna, padre.relname AS padre,
         pa.attname::text AS columna_padre, array_length(k.conkey, 1) AS columnas
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
  const referencias = await leer<FilaReferencia>(SQL_REFERENCIAS);
  const disparadores = await leer<FilaDisparador>(SQL_DISPARADORES, [FUNCION_DE_REFERENCIAS]);

  const tablas = relaciones.filter((r) => r.relkind === 'r' || r.relkind === 'p');
  const vistas = relaciones.filter((r) => r.relkind === 'v');
  const sinRlsPosible = relaciones.filter((r) => r.relkind === 'm' || r.relkind === 'f');
  const porNombre = new Map(relaciones.map((r) => [r.relname, r] as const));

  // ---- privilegios: los de mc_app (directos o por PUBLIC) y los de los demás
  const privilegiosPorRelacion = new Map<string, Map<string, Set<string>>>();
  for (const p of privilegios) {
    let roles = privilegiosPorRelacion.get(p.relname);
    if (!roles) privilegiosPorRelacion.set(p.relname, (roles = new Map()));
    let s = roles.get(p.rol);
    if (!s) roles.set(p.rol, (s = new Set()));
    s.add(p.privilegio);
  }
  const deLaApp = (relacion: string): Set<string> => {
    const roles = privilegiosPorRelacion.get(relacion);
    return new Set([...(roles?.get(APP_ROLE) ?? []), ...(roles?.get('PUBLIC') ?? [])]);
  };

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
  const aislamientoDe = (tabla: string): AislamientoDeLectura => lectura.get(tabla) ?? 'no';
  const calcularLectura = (t: FilaRelacion): AislamientoDeLectura => {
    if (!t.rls || !t.forzada) return 'no';
    const ps = alcanzan(t.relname, 'SELECT');
    const ctx = { tabla: t.relname, lado: 'lectura' as const, aislamientoDe };
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
        expresionesPara(p, cmd).every(({ expr, lado }) => veredicto(expr, { tabla: t.relname, lado, aislamientoDe }).aisla);
      // Una restrictiva que aísla cierra el comando aunque haya una
      // permisiva abierta: las restrictivas se combinan con AND.
      if (ps.some((p) => !p.permisiva && aislaEntera(p))) continue;
      for (const p of ps.filter((x) => x.permisiva)) {
        for (const { expr, lado } of expresionesPara(p, cmd)) {
          const v = veredicto(expr, { tabla: t.relname, lado, aislamientoDe });
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

  // ---- funciones SECURITY DEFINER
  const firmas = new Set(funciones.map((f) => f.firma));
  const funcionesDefiner = funciones.map((f) => f.firma).filter((f) => !(f in FUNCIONES_DEFINER_DECLARADAS));
  const funcionesDefinerObsoletas = inventarioLeido
    ? Object.keys(FUNCIONES_DEFINER_DECLARADAS).filter((f) => !firmas.has(f))
    : [];

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

  // ---- privilegios de mc_app: los declarados y los prohibidos
  const privilegiosDeMas: PrivilegioDeMas[] = [];
  for (const r of relaciones) {
    const tiene = deLaApp(r.relname);
    if (!tiene.size) continue;
    const declarado = PRIVILEGIOS_DE_LA_APP[r.relname];
    const sobran = declarado ? PRIVILEGIOS.filter((p) => tiene.has(p) && !declarado.permite.includes(p)) : [];
    const prohibidos = PRIVILEGIOS_PROHIBIDOS.filter((p) => tiene.has(p));
    if (sobran.length) privilegiosDeMas.push({ tabla: r.relname, privilegios: [...sobran], motivo: declarado!.motivo });
    if (prohibidos.length) {
      privilegiosDeMas.push({
        tabla: r.relname,
        privilegios: [...prohibidos],
        motivo: 'una aplicación no los necesita en ninguna relación: TRUNCATE se salta la RLS entera',
      });
    }
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
    referenciasSinComprobar,
    referenciasDeclaradasObsoletas: siAlDia(referenciasDeclaradasObsoletas),
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
  referenciasSinComprobar: [],
  referenciasDeclaradasObsoletas: [],
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
      `${APP_ROLE} puede ejecutar funciones SECURITY DEFINER, que corren con los privilegios de su dueño: ` +
        estado.funcionesDefiner.join(', ') +
        '. Hazlas SECURITY INVOKER, revócale EXECUTE, o decláralas en FUNCIONES_DEFINER_DECLARADAS',
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
