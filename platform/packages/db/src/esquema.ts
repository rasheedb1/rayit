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
 * Aislada significa las tres cosas a la vez:
 *   1. ENABLE ROW LEVEL SECURITY (relrowsecurity)
 *   2. FORCE ROW LEVEL SECURITY (relforcerowsecurity), porque sin FORCE
 *      el dueño de la tabla —mc_migrator, que es quien corre los seeds
 *      y las migraciones— se salta la política sin decirlo
 *   3. al menos una política: RLS activado y cero políticas no aísla,
 *      niega, y eso se descubre en producción
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
 * Tres comprobaciones, porque responden a cosas distintas:
 *   1. Migraciones aplicadas vs. db/migrations del repositorio. Es la
 *      pregunta directa, pero solo se puede hacer donde estén los
 *      archivos: el despliegue de Vercel excluye /db/migrations/ a
 *      propósito (.vercelignore), así que allí esta parte se salta sola.
 *   2. Que toda tabla esté aislada, salvo excepción declarada. No
 *      necesita los archivos, viaja con el bundle y es exactamente la
 *      promesa que se estaba rompiendo.
 *   3. Que mc_app no tenga privilegios de más sobre las tablas que
 *      declara de solo lectura.
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
 * que las protege es el GRANT.
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
  /** Qué le falta: 'sin RLS', 'sin FORCE', 'sin políticas'. */
  falta: string;
}

/** Un privilegio que mc_app tiene y PRIVILEGIOS_DE_LA_APP no le concede. */
export interface PrivilegioDeMas {
  tabla: string;
  privilegios: Privilegio[];
  motivo: string;
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
  /** Privilegios que mc_app conserva y no debería. */
  privilegiosDeMas: PrivilegioDeMas[];
  /** Si la comprobación de archivos se pudo hacer. */
  comparadoConArchivos: boolean;
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
interface FilaTabla extends Record<string, unknown> {
  relname: string;
  rls: boolean;
  forzada: boolean;
  politicas: number;
}
interface FilaPrivilegio extends Record<string, unknown> {
  relname: string;
  privilegio: string;
}

/**
 * TODAS las tablas de `public` con su estado de aislamiento. Es la
 * pregunta invertida: la base dice qué tablas hay, no una lista del
 * repositorio.
 */
const SQL_TABLAS = `
  SELECT c.relname AS relname,
         c.relrowsecurity AS rls,
         c.relforcerowsecurity AS forzada,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS politicas
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   ORDER BY c.relname`;

/**
 * Los privilegios de mc_app, leídos de pg_class.relacl con aclexplode.
 *
 * No se usa information_schema.role_table_grants a propósito: esa vista
 * solo enseña las concesiones en las que el usuario actual es parte, y
 * el worker consulta esto como mc_worker. relacl la ve cualquiera, así
 * que la respuesta es la misma se pregunte desde donde se pregunte.
 */
const SQL_PRIVILEGIOS = `
  SELECT c.relname AS relname, a.privilege_type AS privilegio
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') AND r.rolname = $1
   ORDER BY 1, 2`;

/** Qué le falta a una tabla para estar aislada, o null si no le falta nada. */
function queLeFalta(t: FilaTabla): string | null {
  if (!t.rls) return 'sin ENABLE ROW LEVEL SECURITY';
  if (!t.forzada) return 'sin FORCE ROW LEVEL SECURITY (mc_migrator se la salta)';
  if (t.politicas < 1) return 'con RLS y sin ninguna política (niega, no aísla)';
  return null;
}

/** Pregunta a la base qué migraciones tiene, qué tablas no están aisladas y qué puede mc_app. */
export async function estadoDelEsquema(db: CatalogDb): Promise<EstadoDelEsquema> {
  const enElRepo = await migracionesDelRepositorio();
  const aplicadas = await db
    .withCatalogs((tx) => tx.query<FilaMigracion>('SELECT filename FROM schema_migrations ORDER BY filename'))
    .then((r) => r.rows.map((x) => x.filename))
    .catch(() => null); // la tabla no existe: base sin migrar

  const tablas = await db
    .withCatalogs((tx) => tx.query<FilaTabla>(SQL_TABLAS))
    .then((r) => r.rows)
    .catch(() => [] as FilaTabla[]);

  const privilegios = await db
    .withCatalogs((tx) => tx.query<FilaPrivilegio>(SQL_PRIVILEGIOS, [APP_ROLE]))
    .then((r) => r.rows)
    .catch(() => [] as FilaPrivilegio[]);

  const sinAislar: TablaSinAislar[] = [];
  const aisladas = new Set<string>();
  for (const t of tablas) {
    const falta = queLeFalta(t);
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
    privilegiosDeMas,
    comparadoConArchivos: enElRepo.length > 0 && aplicadas !== null,
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
  privilegiosDeMas: [],
  comparadoConArchivos: true,
};

/** El texto del problema, o null si no hay ninguno. */
export function explicarEsquema(estado: EstadoDelEsquema): string | null {
  const partes: string[] = [];
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
  if (estado.privilegiosDeMas.length) {
    partes.push(
      `${APP_ROLE} tiene privilegios que no le tocan: ` +
        estado.privilegiosDeMas.map((p) => `${p.tabla} (${p.privilegios.join(', ')}: ${p.motivo})`).join('; '),
    );
  }
  if (estado.excepcionesObsoletas.length) {
    partes.push(
      'sobran excepciones en EXCEPCIONES_SIN_AISLAMIENTO (la tabla ya no existe, o ya está aislada): ' +
        estado.excepcionesObsoletas.join(', '),
    );
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
