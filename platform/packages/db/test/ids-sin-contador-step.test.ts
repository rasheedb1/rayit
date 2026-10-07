/**
 * CIM-11 · deal_stage_history.step con los roles que de verdad insertan
 * (0082 §1b).
 *
 * ids-sin-contador.test.ts prueba la conversión y el disparador como
 * superusuario. Aquí, quienes escriben la historia en producción, bajo
 * RLS y con el disparador SECURITY INVOKER:
 *
 *   - mc_app, al mover un negocio de etapa desde Ventas (moveDeal →
 *     deal_move_stage, en withWorkspace);
 *   - mc_public_share, al aceptar una cotización desde su enlace
 *     (acceptPublicQuote → public_quote_accept, 0030, en withPublicShare),
 *     que deja la fila de «Ganado»;
 *
 * que, una vez escrito, step no se mueve (ni como mc_app, que conserva
 * UPDATE en la tabla), y que el índice único (deal_id, step) hace fallar
 * un choque en vez de repetir el número: en PGlite, forzando el número que calcularía un
 * escritor que no bloquea el negocio; contra Postgres real
 * (TEST_DATABASE_URL), con dos transacciones a la vez de verdad.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptPublicQuote, createQuote, sendQuote, type TextosCotizar } from '../src/queries/cotizar.ts';
import { createCompany, createDeal, moveDeal } from '../src/queries/ventas.ts';
import { esperarAviso } from './carrera.ts';
import { openTestDb, SETUP_TIMEOUT, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

const TEXTOS: TextosCotizar = {
  actividadEnviada: ({ quoteNumber }) => `[enviada] ${quoteNumber}`,
  actividadAceptada: ({ quoteNumber }) => `[aceptada] ${quoteNumber}`,
  actividadMonto: ({ quoteNumber }) => `[monto] ${quoteNumber}`,
  avisoAceptada: ({ quoteNumber }) => ({ title: `[aviso] ${quoteNumber}`, body: '-' }),
};
const FIRMA = { name: 'Ana Gómez', email: 'ana@marca-step.co' };

let t: TestDb;
let creadora = '';

before(async () => {
  t = await openTestDb();
  const [c] = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM creator_profile LIMIT 1')).rows);
  creadora = c!.id;
}, SETUP_TIMEOUT);
after(async () => {
  await t.close();
});

/** Los pasos del negocio, en su orden, vistos como mc_app (la RLS de la historia es la del negocio). */
async function pasos(dealId: string): Promise<Array<{ step: number; to: string }>> {
  return t.db.withWorkspace(WORKSPACE_LAURA, async (tx) =>
    (await tx.query<{ step: number; to: string }>(
      'SELECT step, to_stage_id AS to FROM deal_stage_history WHERE deal_id = $1 ORDER BY step', [dealId],
    )).rows);
}

/** Un negocio nuevo de una marca nueva, con su nombre para que la prueba se pueda repetir contra una base que se queda. */
async function negocio(nombre: string): Promise<string> {
  const sufijo = `${nombre}-${Date.now().toString(36)}`;
  return t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
    const companyId = await createCompany(tx, { name: `Marca ${sufijo}`, domain: `${sufijo}.co`, relationship: 'prospect' });
    return createDeal(tx, { companyId, name: `Negocio ${sufijo}` });
  });
}

/** 1, 2, 3… sin huecos ni repetidos. */
function consecutivos(filas: ReadonlyArray<{ step: number }>): void {
  assert.deepEqual(filas.map((f) => Number(f.step)), filas.map((_, i) => i + 1));
}

describe('deal_stage_history.step con quienes insertan de verdad', () => {
  test('mc_app mueve de etapa un negocio con historia: cada paso nuevo es max + 1', async () => {
    const dealId = await negocio('step-mover');
    for (const etapa of ['contactado', 'propuesta', 'negociacion']) {
      const antes = await pasos(dealId);
      await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => moveDeal(tx, dealId, etapa));
      const despues = await pasos(dealId);
      const max = Math.max(0, ...antes.map((p) => Number(p.step)));
      assert.equal(despues.length, antes.length + 1, `${etapa}: una fila más`);
      assert.deepEqual({ step: Number(despues.at(-1)!.step), to: despues.at(-1)!.to }, { step: max + 1, to: etapa });
    }
    consecutivos(await pasos(dealId));
  });

  test('mc_public_share acepta la cotización desde el enlace: la fila de «Ganado» es max + 1', async () => {
    const dealId = await negocio('step-enlace');
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => moveDeal(tx, dealId, 'contactado'));
    const enviada = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const q = await createQuote(tx, {
        dealId, creatorId: creadora, taxRate: '0.19',
        items: [{ deliverable: 'reel', platformId: 'instagram', description: 'Reel', quantity: 1, unitPrice: '2000000' }],
      });
      return sendQuote(tx, q.id, TEXTOS);
    });
    const antes = await pasos(dealId);
    assert.ok(antes.length >= 2, 'el negocio ya tiene historia antes de aceptar');
    const aceptada = await t.db.withPublicShare((tx) => acceptPublicQuote(tx, enviada.slug, FIRMA));
    assert.equal(aceptada.status, 'ok');
    const despues = await pasos(dealId);
    assert.equal(despues.length, antes.length + 1);
    assert.deepEqual(
      { step: Number(despues.at(-1)!.step), to: despues.at(-1)!.to },
      { step: Math.max(...antes.map((p) => Number(p.step))) + 1, to: 'ganado' },
    );
    consecutivos(despues);
  });

  test('después de insertarse, step no cambia: mc_app no puede renumerar la historia de un negocio', async () => {
    const dealId = await negocio('step-fijo');
    for (const etapa of ['contactado', 'propuesta']) await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => moveDeal(tx, dealId, etapa));
    const antes = await pasos(dealId);
    assert.ok(antes.length >= 2);
    // Correr toda la historia (lo que encontró la revisión) e intercambiar
    // dos pasos (el índice único no lo impide si se hace de una vez).
    for (const nuevo of ['step + 100', 'CASE step WHEN 1 THEN 2 WHEN 2 THEN 1 ELSE step END']) {
      await assert.rejects(
        t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(`UPDATE deal_stage_history SET step = ${nuevo} WHERE deal_id = $1`, [dealId])),
        (err: { code?: string; message?: string }) => err.code === '23514' && /step no cambia/.test(err.message ?? ''),
        nuevo,
      );
    }
    assert.deepEqual(await pasos(dealId), antes);
    // Lo demás de la fila sigue como estaba: el cierre es solo sobre step, y
    // un UPDATE que deja step igual pasa.
    const tocadas = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) =>
      (await tx.query('UPDATE deal_stage_history SET step = step WHERE deal_id = $1 RETURNING step', [dealId])).rows.length);
    assert.equal(tocadas, antes.length);
    consecutivos(await pasos(dealId));
  });
});

/** El INSERT de un escritor que NO bloquea el negocio antes (sin el FOR UPDATE de deal_move_stage). */
const PASO_SIN_BLOQUEO =
  'INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id) SELECT id, stage_id, stage_id FROM deal WHERE id = $1 RETURNING step';

describe('un choque de step falla, nunca repite el número (índice único deal_id, step)', () => {
  test('el índice es único y por negocio', async () => {
    const filas = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) =>
      (await tx.query<{ def: string }>(
        "SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index WHERE indexrelid = 'deal_stage_history_deal_id_step_key'::regclass",
      )).rows);
    assert.match(filas[0]?.def ?? '', /CREATE UNIQUE INDEX deal_stage_history_deal_id_step_key ON public\.deal_stage_history USING btree \(deal_id, step\)/);
  });

  test('el número que calcularía quien no vio el último paso choca (23505) y no queda escrito', async () => {
    // Lo que haría la segunda de dos transacciones sin bloqueo, o un rol
    // cuya RLS viera solo parte de la historia: max(step) + 1 sobre lo que
    // ve, que ya existe. Se fuerza ese número con el disparador apagado,
    // dentro de un bloque que deshace todo si NO choca.
    const dealId = await negocio('step-choque');
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => moveDeal(tx, dealId, 'contactado'));
    const antes = await pasos(dealId);
    await t.admin(`
      DO $$
      BEGIN
        ALTER TABLE deal_stage_history DISABLE TRIGGER deal_stage_history_step;
        BEGIN
          INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, step)
          SELECT id, stage_id, stage_id, (SELECT max(step) FROM deal_stage_history WHERE deal_id = '${dealId}')
            FROM deal WHERE id = '${dealId}';
          RAISE EXCEPTION 'el step repetido se escribió: falta el índice único';
        EXCEPTION WHEN unique_violation THEN
          NULL;
        END;
        ALTER TABLE deal_stage_history ENABLE TRIGGER deal_stage_history_step;
      END $$;
    `);
    assert.deepEqual(await pasos(dealId), antes);
    consecutivos(antes);
  });

  test('dos transacciones a la vez sin bloqueo: la segunda espera a la primera y falla (solo Postgres real)', async (ctx) => {
    if (t.kind !== 'postgres') {
      return ctx.skip('PGlite serializa las transacciones; con TEST_DATABASE_URL (packages/db/README.md) sí corre');
    }
    const dealId = await negocio('step-carrera');
    const antes = await pasos(dealId);
    let avisar!: () => void;
    const aviso = new Promise<void>((r) => { avisar = r; });
    let soltar!: () => void;
    const suelta = new Promise<void>((r) => { soltar = r; });
    const primera = t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ step: number }>(PASO_SIN_BLOQUEO, [dealId]);
      avisar();
      await suelta;
      return Number(rows[0]!.step);
    });
    await esperarAviso(aviso, primera);
    const segunda = t.db
      .withWorkspace(WORKSPACE_LAURA, async (tx) => Number((await tx.query<{ step: number }>(PASO_SIN_BLOQUEO, [dealId])).rows[0]!.step))
      .then((step) => ({ step }), (err: { code?: string }) => ({ code: err.code }));
    const resuelta = await Promise.race([segunda.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
    assert.equal(resuelta, false, 'la segunda espera a que la primera confirme (el índice único la retiene)');
    soltar();
    assert.equal(await primera, antes.length + 1);
    assert.deepEqual(await segunda, { code: '23505' }, 'la segunda falla en vez de repetir el step');
    consecutivos(await pasos(dealId));
  });
});
