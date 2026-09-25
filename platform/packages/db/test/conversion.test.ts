/**
 * VEN-8 · Conversión por etapa y motivo de pérdida, contra Postgres
 * embebido.
 *
 * «Terminado cuando»: la tasa entre etapas aparece con su número de
 * negocios y cuadra con deal_stage_history. Dos comprobaciones:
 *
 *   1. Un workspace propio (WS_CONV) con cinco negocios cuya historia se
 *      escribe a mano —saltos, retrocesos, una pérdida— y las cifras
 *      esperadas contadas a mano en el comentario de cada caso.
 *   2. El seed de Laura, recontado en TypeScript a partir de las filas
 *      de deal_stage_history que ve su workspace: la consulta y el
 *      recuento independiente tienen que dar lo mismo, etapa por etapa.
 *
 * Y el motivo de pérdida, como regla de la BASE (0043 §4): mover a
 * «Perdido» sin motivo no llega al COMMIT aunque no pase por moveDeal.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getStageConversion, type StageConversion } from '../src/queries/conversion.ts';
import { moveDeal } from '../src/queries/ventas.ts';
import type { WorkspaceTx } from '../src/client.ts';
import { openTestDb, type TestDb, WORKSPACE_LAURA } from './pglite.ts';

const WS_CONV = '00000009-0000-4000-8000-00000000c801';
const EMPRESA = '00000009-0000-4000-8000-0000000c8c01';
const D = (n: number) => `00000009-0000-4000-8000-0000000c8d0${n}`;

let t: TestDb;
const enConv = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WS_CONV, fn);
const laura = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn);

/** Una fila de historia: negocio, de, a, día de septiembre. */
function h(deal: number, from: string | null, to: string, day: number): string {
  return `('${D(deal)}', ${from ? `'${from}'` : 'NULL'}, '${to}', '2026-09-${String(day).padStart(2, '0')} 12:00:00+00')`;
}

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name, kind, currency)
    VALUES ('${WS_CONV}', 'workspace-conversion-ven8', 'Workspace de conversión', 'creator', 'COP')
    ON CONFLICT DO NOTHING;
    INSERT INTO company (id, name, domain, owner_workspace_id)
    VALUES ('${EMPRESA}', 'Marca Embudo', 'marcaembudo.co', '${WS_CONV}') ON CONFLICT DO NOTHING;
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_CONV}', '${EMPRESA}') ON CONFLICT DO NOTHING;

    INSERT INTO deal (id, workspace_id, company_id, name, stage_id, won_at, lost_at, lost_reason) VALUES
      ('${D(1)}', '${WS_CONV}', '${EMPRESA}', 'Gana saltándose conversación', 'ganado', '2026-09-04 12:00:00+00', NULL, NULL),
      ('${D(2)}', '${WS_CONV}', '${EMPRESA}', 'Se pierde en contactado', 'perdido', NULL, '2026-09-03 12:00:00+00', 'precio'),
      ('${D(3)}', '${WS_CONV}', '${EMPRESA}', 'Sigue en nuevo', 'nuevo', NULL, NULL, NULL),
      ('${D(4)}', '${WS_CONV}', '${EMPRESA}', 'Nace en conversación y retrocede', 'contactado', NULL, NULL, NULL),
      ('${D(5)}', '${WS_CONV}', '${EMPRESA}', 'Va y vuelve', 'conversacion', NULL, NULL, NULL)
    ON CONFLICT DO NOTHING;

    INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_at) VALUES
      ${[
        h(1, null, 'nuevo', 1), h(1, 'nuevo', 'contactado', 2), h(1, 'contactado', 'propuesta', 3), h(1, 'propuesta', 'ganado', 4),
        h(2, null, 'nuevo', 1), h(2, 'nuevo', 'contactado', 2), h(2, 'contactado', 'perdido', 3),
        h(3, null, 'nuevo', 1),
        h(4, null, 'conversacion', 1), h(4, 'conversacion', 'nuevo', 2), h(4, 'nuevo', 'contactado', 3),
        h(5, null, 'contactado', 1), h(5, 'contactado', 'conversacion', 2), h(5, 'conversacion', 'contactado', 3),
        h(5, 'contactado', 'conversacion', 4),
      ].join(',\n      ')};
  `);
});

after(async () => {
  await t.close();
});

function porEtapa(rows: StageConversion[]): Record<string, Omit<StageConversion, 'stageId'>> {
  return Object.fromEntries(rows.map(({ stageId, ...rest }) => [stageId, rest]));
}

describe('VEN-8 · conversión por etapa', () => {
  test('cuenta negocios, no movimientos, y solo lo que llegó más lejos sin perderse', async () => {
    const c = porEtapa(await enConv((tx) => getStageConversion(tx)));
    // Nuevo: entraron 1, 2, 3 y 4 (el 4 al retroceder). Avanzaron 1 y 2
    // (a contactado) y 4 (de nuevo a contactado después de entrar). 3/4.
    assert.deepEqual(c.nuevo, { entered: 4, advanced: 3, rate: '0.7500' });
    // Contactado: 1, 2, 4 y 5. Avanzaron 1 (a propuesta, saltándose
    // conversación) y 5 (a conversación). El 2 se perdió: no cuenta. 2/4.
    assert.deepEqual(c.contactado, { entered: 4, advanced: 2, rate: '0.5000' });
    // Conversación: 4 y 5. Ninguno llegó más allá: el 4 retrocedió y el
    // 5 va y vuelve entre contactado y conversación. 0/2, que es 0 %.
    assert.deepEqual(c.conversacion, { entered: 2, advanced: 0, rate: '0.0000' });
    // Propuesta: solo el 1, que ganó. 1/1.
    assert.deepEqual(c.propuesta, { entered: 1, advanced: 1, rate: '1.0000' });
    // Negociación: nadie entró. Sin tasa, no «0 %».
    assert.deepEqual(c.negociacion, { entered: 0, advanced: 0, rate: null });
    // Las etapas cerradas no llevan tasa.
    assert.equal(c.ganado, undefined);
    assert.equal(c.perdido, undefined);
  });

  test('en el seed de Laura cuadra con un recuento independiente de deal_stage_history', async () => {
    const { conversion, historia, etapas } = await laura(async (tx) => ({
      conversion: await getStageConversion(tx),
      historia: (
        await tx.query<{ deal_id: string; to_stage_id: string; changed_at: Date | string }>(
          'SELECT deal_id, to_stage_id, changed_at FROM deal_stage_history',
        )
      ).rows,
      etapas: (
        await tx.query<{ id: string; position: number; is_won: boolean; is_lost: boolean }>(
          'SELECT id, position, is_won, is_lost FROM pipeline_stage',
        )
      ).rows,
    }));
    assert.ok(historia.length >= 40, 'el seed trae la historia de los negocios de Laura');
    const etapa = new Map(etapas.map((e) => [e.id, e]));
    const ms = (v: Date | string) => new Date(v).getTime();

    const esperado: Record<string, { entered: number; advanced: number }> = {};
    for (const st of etapas.filter((e) => !e.is_won && !e.is_lost)) {
      const entradas = new Map<string, number>();
      for (const fila of historia) {
        if (fila.to_stage_id !== st.id) continue;
        const antes = entradas.get(fila.deal_id);
        if (antes === undefined || ms(fila.changed_at) < antes) entradas.set(fila.deal_id, ms(fila.changed_at));
      }
      let advanced = 0;
      for (const [deal, entro] of entradas) {
        const llego = historia.some((f) => {
          const a = etapa.get(f.to_stage_id);
          return f.deal_id === deal && ms(f.changed_at) >= entro && a !== undefined && a.position > st.position && !a.is_lost;
        });
        if (llego) advanced++;
      }
      esperado[st.id] = { entered: entradas.size, advanced };
    }

    const obtenido = Object.fromEntries(conversion.map((c) => [c.stageId, { entered: c.entered, advanced: c.advanced }]));
    assert.deepEqual(obtenido, esperado);
    for (const c of conversion) {
      if (c.entered === 0) assert.equal(c.rate, null);
      else assert.equal(Number(c.rate), Math.round((c.advanced / c.entered) * 10_000) / 10_000, c.stageId);
    }
    // Y una a mano, del seed 0002 §10: diez negocios pasaron por «Nuevo»
    // y nueve salieron hacia adelante (Olla Fácil sigue ahí). Solo en el
    // embebido: con TEST_DATABASE_URL la base se comparte y otras pruebas
    // le suman negocios a Laura.
    if (t.kind === 'pglite') assert.deepEqual(obtenido.nuevo, { entered: 10, advanced: 9 });
  });

  test('la historia de un workspace no entra en la conversión de otro', async () => {
    const c = porEtapa(await enConv((tx) => getStageConversion(tx)));
    assert.equal(c.nuevo?.entered, 4, 'los diez de Laura no se suman');
  });
});

describe('VEN-8 · un negocio perdido lleva motivo, también en la base', () => {
  test('pasar a «Perdido» sin motivo por fuera de moveDeal no llega al COMMIT', async () => {
    await assert.rejects(
      enConv((tx) => tx.query(`SELECT deal_move_stage($1, 'perdido')`, [D(3)])),
      /deal_lost_reason_required/,
    );
    const { rows } = await enConv((tx) => tx.query<{ stage_id: string }>('SELECT stage_id FROM deal WHERE id = $1', [D(3)]));
    assert.equal(rows[0]?.stage_id, 'nuevo', 'la transacción entera se deshizo');
  });

  test('con motivo, sí; y moveDeal lo escribe en la misma transacción', async () => {
    const r = await enConv((tx) => moveDeal(tx, D(3), 'perdido', { lostReason: 'sin_respuesta' }));
    assert.equal(r.toStageId, 'perdido');
    const { rows } = await enConv((tx) =>
      tx.query<{ lost_reason: string | null }>('SELECT lost_reason FROM deal WHERE id = $1', [D(3)]),
    );
    assert.equal(rows[0]?.lost_reason, 'sin_respuesta');
  });

  test('borrar el motivo de un perdido tampoco pasa', async () => {
    await assert.rejects(
      enConv((tx) => tx.query('UPDATE deal SET lost_reason = NULL WHERE id = $1', [D(2)])),
      /deal_lost_reason_required/,
    );
  });
});
