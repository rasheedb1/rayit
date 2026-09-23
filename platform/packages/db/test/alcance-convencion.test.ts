/**
 * ACC-6 · La convención del alcance, como la de la bitácora
 * (audit-convencion.test.ts): toda función EXPORTADA de
 * queries/{campanas,finanzas,conexiones}*.ts que consulta la base pasa
 * por el alcance —compone scopeFilter() (una constante SCOPE_*), llama a
 * assertScopeAllows()/assertUnscoped(), usa UNSCOPED_ONLY, o llama a otra
 * función del mismo archivo que lo hace—, salvo que esté en
 * SIN_ALCANCE_DECLARADAS con su motivo. Una declarada que ya aplica el
 * alcance, o que no existe, también falla: la lista no acumula
 * excepciones muertas.
 *
 * Es de TEXTO a propósito: un filtro olvidado compila igual. La prueba
 * de comportamiento (alcance-<modulo>.test.ts) recorre las mismas
 * funciones con dos creadoras en un workspace; esta es la red para la
 * función nueva que alguien exporta con un caso de prueba 'pura' o
 * 'pasa' por comodidad.
 *
 * Y el worker: mc_worker no filtra por alcance (corre sin persona, así
 * que scope_allows() ve «sin filas» y deja pasar todo; lo demuestra
 * alcance-esquema.test.ts). Aquí se comprueba el otro lado: ningún
 * archivo del worker compone el alcance ni lee membership_scope.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARCHIVOS = ['campanas.ts', 'campanas/reporte.ts', 'campanas/reporte-publico.ts', 'finanzas.ts', 'conexiones.ts'] as const;
type Archivo = (typeof ARCHIVOS)[number];

/**
 * Funciones exportadas que consultan la base SIN alcance, con motivo.
 * Tres clases legítimas: lo que solo corre como mc_worker (sin persona:
 * el alcance es de la web), lo que es de la persona o del espacio y no
 * de un creador (permisos, configuración, catálogos), y lo público por
 * enlace (sin persona ni workspace fijado).
 */
const SIN_ALCANCE_DECLARADAS: Record<Archivo, Record<string, string>> = {
  'campanas.ts': {
    listCampaignsToCompute:
      'solo la llama el worker (apps/worker/src/jobs/campanas/campaign-compute.ts) como mc_worker, sin persona ni alcance, ' +
      'con workspace_id explícito; el resultado que calcula lo lee la web con getCampaignResult, que sí filtra',
    canRecomputeResult:
      'no lee filas: pregunta por el privilegio de mc_app sobre campaign_result (0041) para pintar o no «Recalcular»; ' +
      'la acción que recalcula pasa por getResultInputs/upsertResult, que sí filtran por la campaña',
  },
  'campanas/reporte.ts': {},
  'campanas/reporte-publico.ts': {
    readPublicReport:
      'la lectura pública del reporte por su slug (CAM-6): corre como mc_public sin persona ni workspace fijado; ' +
      'el enlace es el permiso, y solo abre un reporte ENVIADO por quien sí tenía alcance a esa campaña',
  },
  'finanzas.ts': {
    getReserveState:
      'lee settings.finanzas.reserva_pct del workspace fijado: configuración del espacio, no un dato de un creador, una marca ni una campaña',
    getFinanceSettings:
      'la configuración financiera del espacio (FIN-8): moneda, datos de pago, porcentajes. Es de todos; escribirla sí exige ' +
      'no tener alcance (updateFinanceSettings → assertUnscoped)',
    countInvoicesInOtherCurrency:
      'solo la llama updateFinanceSettings, DESPUÉS de assertUnscoped: quien llega aquí no tiene alcance y cuenta todo el espacio, ' +
      'que es lo que el cambio de moneda afecta',
    listPayoutPlatforms: 'el catálogo de plataformas que pagan (AdSense, TikTok…): no cuelga de ningún creador, marca ni campaña',
    getWorkspaceToday: 'la fecha de hoy en la zona horaria del espacio: no lee filas de negocio',
  },
  'conexiones.ts': {
    getSessionMember:
      'la identidad de la persona de la sesión (su membresía y rol), para la evidencia del consentimiento delegado (ACC-8): ' +
      'es de quien pregunta, no de un creador; acotarla sería esconderle a alguien quién es',
    sessionHasPermission:
      'el permiso de la persona de la sesión (role_permission, ACC-5/ACC-8): el permiso y el alcance son capas distintas; ' +
      'la escritura que sigue pasa por su propio filtro',
  },
};

/** Lo que cuenta como «pasa por el alcance». */
const MARCA_ALCANCE_RE = /\bSCOPE_[A-Z_]+\b|\bscopeFilter\(|\bassertScopeAllows\(|\bassertUnscoped\(|\bUNSCOPED_ONLY\b/;
/** Lo que cuenta como «consulta la base». */
const CONSULTA_RE = /\.query\s*[<(]|\btx\.db\.|\bq\.query\b/;
/** Declaraciones de nivel superior: cada una corta el cuerpo de la anterior. */
const DECL_RE = /^(export\s+)?(?:(async\s+)?function\s+(\w+)|const\s+(\w+)\s*(?::[^=]+)?=\s*(async\b)?|class\s+(\w+)|interface\s+(\w+)|type\s+(\w+))/gm;

interface Declaracion {
  nombre: string;
  exportada: boolean;
  esFuncion: boolean;
  cuerpo: string;
}

/** Quita comentarios de bloque y de línea entera: un JSDoc que dice «SCOPE_» no cuenta. */
function sinComentarios(fuente: string): string {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function declaracionesDe(fuenteConComentarios: string): Declaracion[] {
  const fuente = sinComentarios(fuenteConComentarios);
  const inicios = [...fuente.matchAll(DECL_RE)].map((m) => {
    const nombre = (m[3] ?? m[4] ?? m[6] ?? m[7] ?? m[8])!;
    const resto = fuente.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const esFuncion = m[3] !== undefined || (m[4] !== undefined && (m[5] !== undefined || /^\s*\(/.test(resto)));
    return { nombre, exportada: m[1] !== undefined, esFuncion, at: m.index };
  });
  return inicios.map((d, i) => ({
    nombre: d.nombre,
    exportada: d.exportada,
    esFuncion: d.esFuncion,
    cuerpo: fuente.slice(d.at, inicios[i + 1]?.at ?? fuente.length),
  }));
}

/**
 * Punto fijo: una declaración cumple `directo` si su cuerpo lo cumple, o
 * si nombra (con límite de palabra) otra declaración del archivo que lo
 * cumple. Así un helper privado que filtra cuenta para quien lo llama, y
 * una constante SQL que compone SCOPE_* cuenta para quien la interpola.
 */
function cierre(decls: Declaracion[], directo: RegExp): Set<string> {
  const si = new Set(decls.filter((d) => directo.test(d.cuerpo)).map((d) => d.nombre));
  let cambio = true;
  while (cambio) {
    cambio = false;
    for (const d of decls) {
      if (si.has(d.nombre)) continue;
      const cuerpoSinNombre = d.cuerpo.slice(d.cuerpo.indexOf(d.nombre) + d.nombre.length);
      if ([...si].some((n) => new RegExp(`\\b${n}\\b`).test(cuerpoSinNombre))) {
        si.add(d.nombre);
        cambio = true;
      }
    }
  }
  return si;
}

function leer(archivo: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/queries/${archivo}`, import.meta.url)), 'utf8');
}

/** Las exportadas que consultan, y cuáles de ellas pasan por el alcance. */
function inventario(fuente: string): { consultan: string[]; conAlcance: Set<string> } {
  const decls = declaracionesDe(fuente);
  const consultanSet = cierre(decls, CONSULTA_RE);
  const conAlcance = cierre(decls, MARCA_ALCANCE_RE);
  const consultan = decls.filter((d) => d.exportada && d.esFuncion && consultanSet.has(d.nombre)).map((d) => d.nombre);
  return { consultan, conAlcance };
}

describe('toda consulta exportada de Campañas, Finanzas y Conexiones pasa por el alcance (ACC-6)', () => {
  for (const archivo of ARCHIVOS) {
    test(archivo, () => {
      const { consultan, conAlcance } = inventario(leer(archivo));
      assert.ok(consultan.length > 0, `${archivo}: no se encontró ninguna función que consulte; la expresión de búsqueda se rompió`);
      const declaradas = SIN_ALCANCE_DECLARADAS[archivo];

      const sinAlcance = consultan.filter((f) => !conAlcance.has(f) && !(f in declaradas));
      assert.deepEqual(
        sinAlcance, [],
        `${archivo}: consultan sin scopeFilter()/assertScopeAllows()/assertUnscoped() y sin motivo en SIN_ALCANCE_DECLARADAS: ${sinAlcance.join(', ')}`,
      );

      const sobran = Object.keys(declaradas).filter((f) => !consultan.includes(f));
      assert.deepEqual(sobran, [], `${archivo}: declaradas sin alcance pero ya no existen o no consultan: ${sobran.join(', ')}`);

      const declaradasConAlcance = consultan.filter((f) => f in declaradas && conAlcance.has(f));
      assert.deepEqual(declaradasConAlcance, [], `${archivo}: aplican el alcance y a la vez están declaradas sin él: ${declaradasConAlcance.join(', ')}`);

      for (const [nombre, motivo] of Object.entries(declaradas)) {
        assert.ok(motivo.trim().length > 40, `${archivo}: ${nombre} necesita un motivo de verdad`);
      }
    });
  }

  test('la búsqueda muerde: una consulta sin filtro sale; un helper con filtro, una constante SQL con SCOPE_ y un comentario se leen bien', () => {
    const fuente = [
      "const SCOPE_X = scopeFilter({ creator: 'x.creator_id', company: null, campaign: null });",
      'const SELECT_X = `SELECT * FROM x WHERE ${SCOPE_X}`;',
      'async function privada(tx) { return tx.query(`SELECT 1 FROM x WHERE ${SCOPE_X}`); }',
      'export async function porHelper(tx) { return privada(tx); }',
      'export async function porConstante(tx) { return tx.query(SELECT_X); }',
      '/** Aquí iría SCOPE_X, pero no está. */',
      "export async function olvidada(tx) { return tx.query('SELECT 1 FROM x'); }",
      "export const flecha = async (tx) => tx.query('SELECT 1 FROM y');",
      'export function pura(a) { return a + 1; }',
      'export class XError extends Error {}',
    ].join('\n');
    const { consultan, conAlcance } = inventario(fuente);
    assert.deepEqual(consultan, ['porHelper', 'porConstante', 'olvidada', 'flecha']);
    assert.deepEqual(consultan.filter((f) => !conAlcance.has(f)), ['olvidada', 'flecha']);
  });

  test('hoy se reconocen como consultas con alcance, al menos, las 32 que acotó la rama de ACC-6 (sus 34 funciones menos publicSecretRef, pura, y una que main quitó)', () => {
    const conAlcance = ARCHIVOS.flatMap((a) => {
      const inv = inventario(leer(a));
      return inv.consultan.filter((f) => inv.conAlcance.has(f)).map((f) => `${a}:${f}`);
    });
    const esperadas = [
      'campanas.ts:listCampaigns', 'campanas.ts:getCampaign', 'campanas.ts:listCampaignPosts', 'campanas.ts:listLinkablePosts',
      'campanas.ts:suggestPosts', 'campanas.ts:linkPost', 'campanas.ts:unlinkPost', 'campanas.ts:setPrimaryPost',
      'campanas.ts:updateCampaign', 'campanas.ts:transitionCampaign', 'campanas.ts:createCampaignFromQuote',
      'finanzas.ts:listInvoices', 'finanzas.ts:getInvoice', 'finanzas.ts:listCompanies', 'finanzas.ts:listCampaignsForInvoice',
      'finanzas.ts:getReceivablesKpis', 'finanzas.ts:createInvoice', 'finanzas.ts:transitionInvoice', 'finanzas.ts:createInvoiceFromCampaign',
      'conexiones.ts:listConnections', 'conexiones.ts:findConnectionByAccount', 'conexiones.ts:getDefaultCreatorId',
      'conexiones.ts:listConsents', 'conexiones.ts:upsertConnection', 'conexiones.ts:recordConsent', 'conexiones.ts:disconnectConnection',
      'conexiones.ts:addPublicAccount', 'conexiones.ts:recordAccountSnapshot', 'conexiones.ts:listAccounts',
      'conexiones.ts:markAccountLookupFailure', 'conexiones.ts:findPublicAccountByHandle', 'conexiones.ts:upgradePublicAccountToOAuth',
    ];
    for (const e of esperadas) assert.ok(conAlcance.includes(e), `${e} debería pasar por el alcance`);
  });
});

describe('el worker no filtra por alcance (ACC-6)', () => {
  /** Todos los .ts de apps/worker/src, recursivo. */
  function fuentesDelWorker(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const ruta = join(dir, n);
      if (statSync(ruta).isDirectory()) return fuentesDelWorker(ruta);
      return n.endsWith('.ts') ? [ruta] : [];
    });
  }

  test('ningún archivo de apps/worker/src compone el alcance ni lee membership_scope: corre como mc_worker, sin persona', () => {
    const raiz = fileURLToPath(new URL('../../../apps/worker/src', import.meta.url));
    const archivos = fuentesDelWorker(raiz);
    assert.ok(archivos.length > 0, 'no se encontró el código del worker');
    const usan = archivos.filter((f) => /\bscopeFilter\b|\bassertScopeAllows\b|\bmembership_scope\b|\bscope_allows\b/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(usan, [], 'el alcance es de la web (mc_app con persona); el worker trabaja con workspace_id explícito y sin alcance');
  });
});
