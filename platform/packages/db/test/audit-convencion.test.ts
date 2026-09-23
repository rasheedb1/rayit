/**
 * ACC-2 · La convención que no se puede olvidar: toda función de
 * queries/{finanzas,campanas,conexiones}.ts que escribe (INSERT INTO,
 * UPDATE … SET, DELETE FROM o tx.db.insert/update/delete) llama a
 * audit() o auditAsJob(), salvo que esté en SIN_BITACORA_DECLARADAS con
 * su motivo. Y una función declarada ahí que ya no escriba, o que no
 * exista, también falla: la lista no acumula excepciones muertas.
 *
 * Es una prueba de TEXTO a propósito, no de tipos: un audit() olvidado
 * compila igual. Recorre funciones exportadas y privadas, porque un
 * helper privado que escribe y lo llama una exportada también cuenta.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Los archivos de consultas de Nicolás. Los de Rasheed entran cuando él adopte la convención (docs/propuestas/ACC-2.md §3). */
const ARCHIVOS = ['finanzas.ts', 'campanas.ts', 'conexiones.ts'] as const;

/**
 * Escrituras sin bitácora, con motivo. Lo que no es un hecho del negocio
 * (dinero, publicación, cuenta conectada) no se audita.
 */
const SIN_BITACORA_DECLARADAS: Record<(typeof ARCHIVOS)[number], Record<string, string>> = {
  'finanzas.ts': {
    markReminderSent:
      'read_at de una notificación es «ya lo despaché», el mismo gesto que marcar cualquier aviso como leído: no es dinero, ' +
      'ni publicación, ni cuenta conectada (FIN-4). El hecho del negocio —que existe un recordatorio y con qué texto— lo ' +
      'escribe el job finance.reminders, y la propia fila de notification es su constancia, con su fecha',
  },
  'campanas.ts': {
    upsertResult:
      'campaign_result es la métrica derivada de la campaña (CAM-5): se recalcula entera desde snapshots y aportes cada mañana ' +
      'y con «Recalcular»; lo que cambia su valor (aportes de la marca, posts asociados) ya deja su fila, y la tabla no es un hecho del negocio',
    recordBrandSnapshot:
      'métrica append-only de un perfil PÚBLICO de la marca (CAM-3): brand_account_snapshot es su propia bitácora (0035: mc_app solo ' +
      'inserta, nunca corrige ni borra; la fila guarda día, fuente y hora). No es dinero, ni publicación, ni cuenta conectada',
  },
  'conexiones.ts': {
    recordAccountSnapshot:
      'métrica append-only: account_metric_snapshot es su propia bitácora (0025 §5: mc_app ni la corrige ni la borra); ' +
      'el UPDATE de last_synced_at que la acompaña es frescura del dato, no un hecho del negocio',
    markAccountLookupFailure:
      'salud técnica de la lectura pública (consecutive_failures, status_detail, status error si es definitivo): lo mismo ' +
      'que anota el recolector como mc_worker sin bitácora; el estado visible sale de connection_health',
  },
};

const ESCRITURA_RE = /\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\btx\.db\.(?:insert|update|delete)\(/;
const BITACORA_RE = /\baudit(?:AsJob)?\(/;
/** Declaraciones de nivel superior: `function x(`, y `const x = async (` / `const x = (` / `const x = async x =>`. */
const FUNCION_RE = /^(?:export\s+)?(?:(?:async\s+)?function\s+(\w+)|const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\b|\(|\w+\s*=>))/gm;

interface Funcion {
  nombre: string;
  cuerpo: string;
}

/**
 * Quita los comentarios (bloque y de línea entera): un JSDoc que dice
 * «audit(» no cuenta como bitácora. Los `//` dentro de una cadena
 * (https://…) no empiezan línea, así que no se tocan.
 */
function sinComentarios(fuente: string): string {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Parte el fuente por declaración de función; el cuerpo llega hasta la siguiente declaración. */
function funcionesDe(fuenteConComentarios: string): Funcion[] {
  const fuente = sinComentarios(fuenteConComentarios);
  const inicios = [...fuente.matchAll(FUNCION_RE)].map((m) => ({ nombre: (m[1] ?? m[2])!, at: m.index }));
  return inicios.map((f, i) => ({ nombre: f.nombre, cuerpo: fuente.slice(f.at, inicios[i + 1]?.at ?? fuente.length) }));
}

function leer(archivo: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/queries/${archivo}`, import.meta.url)), 'utf8');
}

describe('toda escritura de queries/ deja bitácora (ACC-2)', () => {
  for (const archivo of ARCHIVOS) {
    test(archivo, () => {
      const funciones = funcionesDe(leer(archivo));
      assert.ok(funciones.length > 0, `${archivo}: no se encontró ninguna función; la expresión de búsqueda se rompió`);
      const escriben = funciones.filter((f) => ESCRITURA_RE.test(f.cuerpo));
      const declaradas = SIN_BITACORA_DECLARADAS[archivo];

      const sinBitacora = escriben.filter((f) => !BITACORA_RE.test(f.cuerpo) && !(f.nombre in declaradas)).map((f) => f.nombre);
      assert.deepEqual(sinBitacora, [], `${archivo}: escriben sin audit() y sin motivo en SIN_BITACORA_DECLARADAS: ${sinBitacora.join(', ')}`);

      const sobran = Object.keys(declaradas).filter((nombre) => !escriben.some((f) => f.nombre === nombre));
      assert.deepEqual(sobran, [], `${archivo}: declaradas sin bitácora pero ya no escriben (o no existen): ${sobran.join(', ')}`);

      const declaradasQueAuditan = escriben.filter((f) => f.nombre in declaradas && BITACORA_RE.test(f.cuerpo)).map((f) => f.nombre);
      assert.deepEqual(declaradasQueAuditan, [], `${archivo}: auditan y a la vez están declaradas sin bitácora: ${declaradasQueAuditan.join(', ')}`);

      for (const [nombre, motivo] of Object.entries(declaradas)) {
        assert.ok(motivo.trim().length > 20, `${archivo}: ${nombre} necesita un motivo de verdad`);
      }
    });
  }

  test('una escritura en función flecha detrás de una que audita no se esconde, y un comentario no cuenta como audit(', () => {
    const fuente = [
      'export async function transitionInvoice(tx) {',
      "  await tx.query('UPDATE invoice SET status = $2 WHERE id = $1');",
      '  await audit(tx, {});',
      '}',
      '/** Marca pagada. Aquí iría audit( pero no está. */',
      'export const markPaid = async (tx, id) => {',
      "  await tx.query('UPDATE invoice SET status = 1 WHERE id = $1', [id]);",
      '};',
      'const quiet = (tx) => tx.db.delete(invoice);',
    ].join('\n');
    const escriben = funcionesDe(fuente).filter((f) => ESCRITURA_RE.test(f.cuerpo));
    assert.deepEqual(escriben.map((f) => f.nombre), ['transitionInvoice', 'markPaid', 'quiet']);
    assert.deepEqual(escriben.filter((f) => !BITACORA_RE.test(f.cuerpo)).map((f) => f.nombre), ['markPaid', 'quiet']);
  });

  test('la búsqueda reconoce las cuatro formas de escribir y no confunde FOR UPDATE ni DO UPDATE', () => {
    assert.ok(ESCRITURA_RE.test('INSERT INTO invoice (a) VALUES (1)'));
    assert.ok(ESCRITURA_RE.test('UPDATE invoice\n     SET status = $2'));
    assert.ok(ESCRITURA_RE.test('DELETE FROM campaign_post'));
    assert.ok(ESCRITURA_RE.test('await tx.db.insert(deal).values({})'));
    assert.equal(ESCRITURA_RE.test('SELECT status FROM campaign WHERE id = $1 FOR UPDATE'), false);
    assert.equal(ESCRITURA_RE.test('ON CONFLICT (a) DO UPDATE\n       SET b = 1'), false);
  });

  test('hoy se reconocen al menos las trece escrituras que auditan', () => {
    const escriben = ARCHIVOS.flatMap((a) => funcionesDe(leer(a)).filter((f) => ESCRITURA_RE.test(f.cuerpo)).map((f) => `${a}:${f.nombre}`));
    const esperadas = [
      'finanzas.ts:createInvoice', 'finanzas.ts:transitionInvoice',
      'campanas.ts:linkPost', 'campanas.ts:unlinkPost', 'campanas.ts:setPrimaryPost', 'campanas.ts:updateCampaign',
      'campanas.ts:transitionCampaign', 'campanas.ts:createCampaignFromQuote',
      'conexiones.ts:upsertConnection', 'conexiones.ts:recordConsent', 'conexiones.ts:disconnectConnection',
      'conexiones.ts:addPublicAccount', 'conexiones.ts:upgradePublicAccountToOAuth',
    ];
    for (const e of esperadas) assert.ok(escriben.includes(e), `${e} debería contarse como escritura`);
  });
});
