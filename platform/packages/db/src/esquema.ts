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
 * Ahora la pregunta se le hace a la BASE: trae TODAS las tablas de
 * `public` y exige aislamiento en todas, con una lista corta y
 * explícita de excepciones, cada una con su motivo escrito. Una tabla
 * nueva sin política y sin excepción declarada hace fallar la prueba;
 * no pasa en silencio. Y una excepción que ya no corresponde —la tabla
 * desapareció, o alguien le puso política— también se reporta, para que
 * la lista no se pudra.
 *
 * Aislada significa las CUATRO cosas a la vez:
 *   1. ENABLE ROW LEVEL SECURITY (relrowsecurity)
 *   2. FORCE ROW LEVEL SECURITY (relforcerowsecurity), porque sin FORCE
 *      el dueño de la tabla —mc_migrator, que es quien corre los seeds
 *      y las migraciones— se salta la política sin decirlo
 *   3. al menos una política: RLS activado y cero políticas no aísla,
 *      niega, y eso se descubre en producción
 *   4. y que esa política DIGA algo. Contar políticas no basta: una
 *      tabla con `CREATE POLICY p ON t USING (true)` tiene RLS, FORCE y
 *      una política, y no aísla nada. Así que además de contarlas se
 *      leen: al menos una tiene que mencionar current_workspace_id(),
 *      current_user_id() o una subconsulta al padre. Las que son
 *      `true` a propósito se declaran en POLITICAS_ABIERTAS_DECLARADAS,
 *      con su motivo, igual que las tablas sin RLS.
 *
 * Y LAS VISTAS, QUE NO SON TABLAS PERO SE CONSULTAN IGUAL
 * ------------------------------------------------------
 * La ronda 1 preguntó por `relkind IN ('r','p')` y dejó fuera las diez
 * vistas de `public`. En Postgres una vista es SECURITY DEFINER por
 * omisión: lee sus tablas base con los privilegios de su DUEÑO, que
 * aquí es mc_migrator. Medido: `CREATE VIEW v AS SELECT * FROM niche;
 * GRANT ALL ON v TO mc_app;` y desde withWorkspace `UPDATE v SET slug =
 * slug` toca las 12 filas del catálogo que la sección 7 de 0022 acaba
 * de dejar de solo lectura. Es la misma clase que esta guardia vino a
 * cerrar, movida de las tablas a las vistas.
 *
 * Así que las vistas también se traen, y a cada una se le exige
 * `security_invoker = on` —que es lo que 0022 §8 les pone— o su entrada
 * en VISTAS_SIN_INVOCADOR con el motivo escrito.
 *
 * Y LOS PRIVILEGIOS, QUE RLS NO CUBRE
 * -----------------------------------
 * Una tabla SIN política no está protegida por RLS: está protegida por
 * el GRANT. Los revisores midieron 99 relaciones × 4 privilegios para
 * mc_app contra la Supabase real y salieron los cuatro en todas. Un rol
 * de aplicación no necesita escribir catálogos, ni tocar la bitácora
 * cruda de webhooks, ni borrar inquilinos. PRIVILEGIOS_DE_LA_APP dice,
 * tabla por tabla y con su motivo, qué se le deja; la migración 0022
 * revoca el resto y esta guardia comprueba que siga revocado.
 *
 * Comprobaciones, porque responden a cosas distintas:
 *   1. Migraciones aplicadas vs. db/migrations del repositorio. Es la
 *      pregunta directa, pero solo se puede hacer donde estén los
 *      archivos: el despliegue de Vercel excluye /db/migrations/ a
 *      propósito (.vercelignore), así que allí esta parte se salta sola.
 *   2. Que toda tabla esté aislada, salvo excepción declarada. No
 *      necesita los archivos, viaja con el bundle y es exactamente la
 *      promesa que se estaba rompiendo.
 *   3. Que ninguna política sea `true` sin declararlo.
 *   4. Que toda vista corra con security_invoker.
 *   5. Que mc_app no tenga privilegios de más sobre las tablas que
 *      declara de solo lectura.
 *   6. Y que la guardia haya podido PREGUNTAR. Ver abajo.
 *
 * LA GUARDIA NO FALLA ABIERTA
 * ---------------------------
 * La ronda 1 tragaba el error de las consultas del inventario con un
 * `.catch(() => [])`. Con la lista vacía todo lo demás sale vacío
 * —ninguna tabla sin aislar, ninguna excepción obsoleta, ningún
 * privilegio de más— y explicarEsquema devuelve null: el arranque da
 * verde AFIRMANDO que toda tabla está aislada cuando lo que pasó es que
 * no pudo preguntar (un permiso, un statement_timeout, un pooler que
 * corta). Es el mismo silencio que esta guardia declara como causa raíz,
 * con otro disparador. Ahora el error se anota en `inventarioLeido` y
 * se reporta como cualquier otro problema: en producción, lanza.
 */
import type { CatalogDb } from './client.ts';

/**
 * Las tablas de `public` que NO llevan aislamiento por fila, y por qué.
 *
 * Es la ÚNICA puerta de salida de la guardia, así que cada línea es una
 * decisión que alguien firmó, no un olvido. Para añadir una entrada hay
 * que poder escribir el motivo; si el motivo no sale, la tabla necesita
 * política.
 *
 * Todas ellas están además en PRIVILEGIOS_DE_LA_APP: sin RLS, lo único
 * que las protege es el GRANT. Eso no es una nota al lector: lo
 * comprueba `excepcionesSinPrivilegios`, porque una excepción nueva sin
 * su entrada de privilegios nacería sin RLS y con los cuatro privilegios
 * de mc_app (ALTER DEFAULT PRIVILEGES se los da al nacer) y las dos
 * mitades de la guardia la darían por buena: la de aislamiento porque
 * está declarada, la de privilegios porque solo recorre
 * PRIVILEGIOS_DE_LA_APP. Es la misma forma del agujero que esta guardia
 * cerró —una lista escrita a mano con una salida que nadie vigila—, así
 * que la salida se vigila.
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
 * Las políticas que dicen `true` a propósito, y por qué.
 *
 * Contar políticas no basta. Una tabla con RLS, FORCE y
 * `CREATE POLICY p ON t USING (true)` cumple las tres primeras
 * condiciones y no aísla nada: está reproducido en esquema.test.ts. Y
 * el patrón tenía un ejemplo vivo en el propio esquema —la primera
 * versión de `company_read`—, así que nada impedía que la siguiente
 * tabla lo copiara «para salir del paso» y la puerta de salida dejara
 * de ser corta y explícita sin que esta lista creciera un renglón.
 *
 * Por eso la guardia LEE las expresiones: una política cuyas
 * expresiones son todas el literal `true` no cuenta como aislamiento y
 * hay que declararla aquí, con su motivo, igual que una tabla sin RLS.
 *
 * La clave es `tabla.politica`. Hoy está vacía: `company_read`, que era
 * la única, se acotó en 0022 §4 (sin dueño, mío, o vinculado por
 * company_link) porque «qué marcas trabaja la competencia, y con qué
 * razón social» no es un catálogo público.
 */
export const POLITICAS_ABIERTAS_DECLARADAS: Readonly<Record<string, string>> = {};

/**
 * Las vistas de `public` que NO corren con los privilegios de quien
 * consulta, y por qué.
 *
 * En Postgres una vista es SECURITY DEFINER por omisión: lee sus tablas
 * base con los privilegios de su dueño —aquí mc_migrator, que puede
 * todo— así que una vista sin `security_invoker = on` rodea el muro de
 * privilegios de PRIVILEGIOS_DE_LA_APP. 0022 §8 se lo pone a las diez
 * que había, en un bucle sobre pg_class y no en una lista de diez
 * nombres; esta lista existe para la vista que alguien añada mañana y
 * tenga una razón para dejar fuera. Por eso está vacía.
 */
export const VISTAS_SIN_INVOCADOR: Readonly<Record<string, string>> = {};

/** Los cuatro privilegios de fila que concede el esquema. */
export const PRIVILEGIOS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
export type Privilegio = (typeof PRIVILEGIOS)[number];

/**
 * Lo que mc_app puede hacer sobre las tablas que NO son de inquilino
 * puro, y por qué. Lo que no está aquí lleva los cuatro privilegios: es
 * una tabla del inquilino y quien filtra es la política.
 *
 * Esta es la mitad del aislamiento que una política no da. La migración
 * 0022 lo revoca; aquí se comprueba que siga revocado, porque un
 * `GRANT … ON ALL TABLES` de cualquier script posterior lo devolvería
 * entero y en silencio.
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

/** Un privilegio que mc_app tiene y PRIVILEGIOS_DE_LA_APP no le concede. */
export interface PrivilegioDeMas {
  tabla: string;
  privilegios: Privilegio[];
  motivo: string;
}

/** Una política cuyas expresiones son todas `true` y que nadie declaró. */
export interface PoliticaAbierta {
  tabla: string;
  politica: string;
  /** 'tabla.politica', que es como se declara en POLITICAS_ABIERTAS_DECLARADAS. */
  clave: string;
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
   * el preflight del worker; lo que cambió es cómo se calcula: antes
   * era «las de mi lista a las que les falta RLS», ahora es «todas las
   * de la base a las que les falta, menos las que declaré».
   */
  sinRls: string[];
  /** Lo mismo, con el detalle de qué le falta a cada una. */
  sinAislar: TablaSinAislar[];
  /** Excepciones declaradas que ya no corresponden: la tabla no existe, o sí está aislada. */
  excepcionesObsoletas: string[];
  /** Excepciones sin RLS que además no dicen qué puede hacer mc_app con ellas. */
  excepcionesSinPrivilegios: string[];
  /** Políticas que dicen `true` y no están en POLITICAS_ABIERTAS_DECLARADAS. */
  politicasAbiertas: PoliticaAbierta[];
  /** Declaraciones de POLITICAS_ABIERTAS_DECLARADAS que ya no corresponden. */
  politicasAbiertasObsoletas: string[];
  /** Vistas sin `security_invoker = on` y sin excepción declarada. */
  vistasSinInvocador: string[];
  /** Entradas de VISTAS_SIN_INVOCADOR que ya no corresponden. */
  vistasDeclaradasObsoletas: string[];
  /** Privilegios que mc_app conserva y no debería. */
  privilegiosDeMas: PrivilegioDeMas[];
  /** Si la comprobación de archivos se pudo hacer. */
  comparadoConArchivos: boolean;
  /**
   * Si la base contestó al inventario (tablas, políticas y privilegios).
   * En false, TODO lo de arriba está vacío porque no se pudo preguntar,
   * no porque esté bien: es un problema, no un visto bueno.
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
  /** 'r' y 'p' son tablas; 'v', vistas. */
  relkind: string;
  rls: boolean;
  forzada: boolean;
  politicas: number;
  /** Vistas: si llevan `security_invoker = on` en reloptions. */
  invocador: boolean;
}
interface FilaPolitica extends Record<string, unknown> {
  relname: string;
  polname: string;
  qual: string | null;
  with_check: string | null;
}
interface FilaPrivilegio extends Record<string, unknown> {
  relname: string;
  privilegio: string;
}

/**
 * TODAS las relaciones de `public` —tablas y vistas— con su estado de
 * aislamiento. Es la pregunta invertida: la base dice qué hay, no una
 * lista del repositorio.
 *
 * Las vistas van aquí y no en una consulta aparte porque la pregunta es
 * la misma: «¿con los privilegios de quién se lee esto?». Para una
 * tabla lo contesta la política; para una vista, security_invoker.
 */
const SQL_RELACIONES = `
  SELECT c.relname AS relname,
         c.relkind::text AS relkind,
         c.relrowsecurity AS rls,
         c.relforcerowsecurity AS forzada,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS politicas,
         coalesce(c.reloptions @> ARRAY['security_invoker=on'], false) AS invocador
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')
   ORDER BY c.relname`;

/**
 * Lo que DICE cada política, no cuántas hay.
 *
 * pg_get_expr devuelve la expresión tal como Postgres la guardó, así
 * que un `USING (true)` sale literalmente como `true` y se reconoce sin
 * interpretar SQL.
 */
const SQL_POLITICAS = `
  SELECT c.relname AS relname,
         p.polname AS polname,
         pg_get_expr(p.polqual, p.polrelid) AS qual,
         pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
   ORDER BY 1, 2`;

/**
 * Los privilegios de mc_app, leídos de pg_class.relacl con aclexplode.
 *
 * No se usa information_schema.role_table_grants a propósito: esa vista
 * solo enseña las concesiones en las que el usuario actual es parte, y
 * el worker consulta esto como mc_worker. relacl la ve cualquiera, así
 * que la respuesta es la misma se pregunte desde donde se pregunte.
 *
 * Incluye las vistas: sus GRANT también cuentan, aunque desde 0022 §8
 * una vista con security_invoker ya no puede dar más de lo que el
 * invocador tiene sobre las tablas base.
 */
const SQL_PRIVILEGIOS = `
  SELECT c.relname AS relname, a.privilege_type AS privilegio
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') AND r.rolname = $1
   ORDER BY 1, 2`;

/** Las expresiones que una política tiene de verdad (USING y WITH CHECK). */
const expresiones = (p: FilaPolitica): string[] =>
  [p.qual, p.with_check].filter((e): e is string => typeof e === 'string' && e.trim() !== '');

/**
 * Una política «abierta» es la que no filtra nada: todas sus
 * expresiones son el literal `true`. Postgres normaliza `USING (true)`
 * a exactamente eso.
 */
function esAbierta(p: FilaPolitica): boolean {
  const exprs = expresiones(p);
  return exprs.length > 0 && exprs.every((e) => e.trim().toLowerCase() === 'true');
}

/**
 * Y una política aísla si al menos una de sus expresiones nombra el
 * workspace de la transacción, la persona de la transacción, o mira al
 * padre con una subconsulta (que es la forma de 0018 y de la sección 6
 * de 0022: `fk IS NULL OR EXISTS (SELECT 1 FROM padre …)`).
 *
 * No pretende demostrar que la política sea correcta —eso lo prueban
 * los ataques de test/rls.test.ts, workspace por workspace—: pretende
 * que `true` no pase por aislamiento.
 */
const MENCIONA_EL_INQUILINO = /current_workspace_id\(\)|current_user_id\(\)|\bSELECT\b/i;
function aisla(p: FilaPolitica): boolean {
  return expresiones(p).some((e) => MENCIONA_EL_INQUILINO.test(e));
}

/** Qué le falta a una tabla para estar aislada, o null si no le falta nada. */
function queLeFalta(t: FilaRelacion, politicas: FilaPolitica[]): string | null {
  if (!t.rls) return 'sin ENABLE ROW LEVEL SECURITY';
  if (!t.forzada) return 'sin FORCE ROW LEVEL SECURITY (mc_migrator se la salta)';
  if (t.politicas < 1) return 'con RLS y sin ninguna política (niega, no aísla)';
  // Contar no basta: hay que leer lo que dicen. Si la consulta de
  // políticas no contestó, esto no se puede exigir y quien lo dice es
  // inventarioLeido.
  if (politicas.length && !politicas.some(aisla)) {
    return 'con políticas que no aíslan (ninguna menciona current_workspace_id(), current_user_id() ni una subconsulta al padre)';
  }
  return null;
}

/** Pregunta a la base qué migraciones tiene, qué no está aislado y qué puede mc_app. */
export async function estadoDelEsquema(db: CatalogDb): Promise<EstadoDelEsquema> {
  const enElRepo = await migracionesDelRepositorio();
  const aplicadas = await db
    .withCatalogs((tx) => tx.query<FilaMigracion>('SELECT filename FROM schema_migrations ORDER BY filename'))
    .then((r) => r.rows.map((x) => x.filename))
    .catch(() => null); // la tabla no existe: base sin migrar

  // Las tres consultas del inventario NO se tragan: si alguna falla, la
  // guardia no comprobó nada y hay que decirlo. Ver la nota de arriba.
  let inventarioLeido = true;
  const noContesto = <T>(): T[] => {
    inventarioLeido = false;
    return [];
  };
  const relaciones = await db
    .withCatalogs((tx) => tx.query<FilaRelacion>(SQL_RELACIONES))
    .then((r) => r.rows)
    .catch(() => noContesto<FilaRelacion>());

  const politicas = await db
    .withCatalogs((tx) => tx.query<FilaPolitica>(SQL_POLITICAS))
    .then((r) => r.rows)
    .catch(() => noContesto<FilaPolitica>());

  const privilegios = await db
    .withCatalogs((tx) => tx.query<FilaPrivilegio>(SQL_PRIVILEGIOS, [APP_ROLE]))
    .then((r) => r.rows)
    .catch(() => noContesto<FilaPrivilegio>());

  const politicasPorTabla = new Map<string, FilaPolitica[]>();
  for (const p of politicas) {
    const lista = politicasPorTabla.get(p.relname);
    if (lista) lista.push(p);
    else politicasPorTabla.set(p.relname, [p]);
  }

  const tablas = relaciones.filter((r) => r.relkind === 'r' || r.relkind === 'p');
  const vistas = relaciones.filter((r) => r.relkind === 'v');

  const sinAislar: TablaSinAislar[] = [];
  const aisladas = new Set<string>();
  for (const t of tablas) {
    const falta = queLeFalta(t, politicasPorTabla.get(t.relname) ?? []);
    if (falta === null) {
      aisladas.add(t.relname);
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
    ? Object.keys(EXCEPCIONES_SIN_AISLAMIENTO).filter((t) => !existen.has(t) || aisladas.has(t))
    : [];
  // Y una excepción sin RLS que además no dice qué puede hacer mc_app
  // con ella es una tabla sin ninguno de los dos candados. No necesita
  // la base: son dos listas del repositorio, y por eso se comprueba
  // siempre.
  const excepcionesSinPrivilegios = Object.keys(EXCEPCIONES_SIN_AISLAMIENTO).filter(
    (t) => !(t in PRIVILEGIOS_DE_LA_APP),
  );

  // Políticas que dicen `true`: o están declaradas con su motivo, o se
  // reportan. Con el mismo mecanismo de «declaración obsoleta».
  const politicasAbiertas: PoliticaAbierta[] = [];
  const abiertas = new Set<string>();
  for (const p of politicas) {
    if (!esAbierta(p)) continue;
    const clave = `${p.relname}.${p.polname}`;
    abiertas.add(clave);
    if (clave in POLITICAS_ABIERTAS_DECLARADAS) continue;
    politicasAbiertas.push({ tabla: p.relname, politica: p.polname, clave });
  }
  const politicasAbiertasObsoletas = politicas.length
    ? Object.keys(POLITICAS_ABIERTAS_DECLARADAS).filter((k) => !abiertas.has(k))
    : [];

  // Vistas: sin security_invoker corren con los privilegios de su dueño
  // (mc_migrator) y rodean PRIVILEGIOS_DE_LA_APP.
  const vistasSinInvocador = vistas
    .filter((v) => !v.invocador && !(v.relname in VISTAS_SIN_INVOCADOR))
    .map((v) => v.relname);
  const conInvocador = new Map(vistas.map((v) => [v.relname, v.invocador] as const));
  const vistasDeclaradasObsoletas = vistas.length
    ? Object.keys(VISTAS_SIN_INVOCADOR).filter((v) => !conInvocador.has(v) || conInvocador.get(v) === true)
    : [];

  const porTabla = new Map<string, Set<string>>();
  for (const p of privilegios) {
    let s = porTabla.get(p.relname);
    if (!s) {
      s = new Set();
      porTabla.set(p.relname, s);
    }
    s.add(p.privilegio);
  }
  const privilegiosDeMas: PrivilegioDeMas[] = [];
  for (const [tabla, { permite, motivo }] of Object.entries(PRIVILEGIOS_DE_LA_APP)) {
    if (!existen.has(tabla) && tablas.length) continue;
    const tiene = porTabla.get(tabla);
    if (!tiene) continue;
    const sobran = PRIVILEGIOS.filter((p) => tiene.has(p) && !permite.includes(p));
    if (sobran.length) privilegiosDeMas.push({ tabla, privilegios: sobran, motivo });
  }

  const tiene = new Set(aplicadas ?? []);
  return {
    aplicadas: aplicadas === null ? -1 : aplicadas.length,
    ultima: aplicadas && aplicadas.length ? (aplicadas[aplicadas.length - 1] ?? null) : null,
    pendientes: enElRepo.filter((f) => !tiene.has(f)),
    sinRls: sinAislar.map((t) => t.tabla),
    sinAislar,
    excepcionesObsoletas,
    excepcionesSinPrivilegios,
    politicasAbiertas,
    politicasAbiertasObsoletas,
    vistasSinInvocador,
    vistasDeclaradasObsoletas,
    privilegiosDeMas,
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
  excepcionesObsoletas: [],
  excepcionesSinPrivilegios: [],
  politicasAbiertas: [],
  politicasAbiertasObsoletas: [],
  vistasSinInvocador: [],
  vistasDeclaradasObsoletas: [],
  privilegiosDeMas: [],
  comparadoConArchivos: true,
  inventarioLeido: true,
};

/** El texto del problema, o null si no hay ninguno. */
export function explicarEsquema(estado: EstadoDelEsquema): string | null {
  const partes: string[] = [];
  if (!estado.inventarioLeido) {
    // Lo primero, porque invalida todo lo demás: con el inventario sin
    // leer, las listas vacías de abajo no dicen «está bien», dicen «no
    // se pudo preguntar».
    partes.push(
      'no se pudo leer el inventario de tablas, políticas y privilegios de la base: la guardia no comprobó nada. ' +
        'Puede ser un permiso que le falta a la conexión, un statement_timeout o un pooler que cortó',
    );
  }
  if (estado.aplicadas === -1) {
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
      'hay políticas que no filtran nada (USING/WITH CHECK `true`), así que su tabla tiene RLS y no aísla: ' +
        estado.politicasAbiertas.map((p) => p.clave).join(', ') +
        '. Si alguna es global a propósito, decláralo en POLITICAS_ABIERTAS_DECLARADAS con su motivo',
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
  if (estado.privilegiosDeMas.length) {
    partes.push(
      `${APP_ROLE} tiene privilegios que no le tocan: ` +
        estado.privilegiosDeMas.map((p) => `${p.tabla} (${p.privilegios.join(', ')}: ${p.motivo})`).join('; '),
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
  ];
  if (sobran.length) {
    partes.push('sobran excepciones declaradas (el objeto ya no existe, o ya está cerrado): ' + sobran.join(', '));
  }
  if (!partes.length) return null;
  return `[db] La base no tiene el esquema de este repositorio: ${partes.join('; ')}. Corre: make db.migrate`;
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
