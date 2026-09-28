/**
 * VEN-15 · pulido r5 · la baja por LinkedIn o Instagram vive en el perfil (0077).
 *
 * El hallazgo: la lista del espacio solo guardaba correos. Si alguien que
 * solo tiene LinkedIn pedía «no me escriban más», bastaba crear otra
 * ficha con la misma URL para enrolarla, y el paso de LinkedIn salía.
 * Aquí se comprueba, en las tres puertas:
 *   · la baja por respuesta (el worker) anota la URL normalizada; una
 *     ficha duplicada con la misma URL (otra forma de escribirla) no se
 *     enrola (skipped 'opted_out'), y ni su enrolamiento ni su toque
 *     entran a la base (check_violation);
 *   · la baja a mano desde la web (mc_app, outbound_workspace_optout_record)
 *     anota el Instagram sin @;
 *   · una ficha que queda de baja por otra vía (contact_optout_handles)
 *     anota sus perfiles, y el reclamo cancela lo que otra ficha con el
 *     mismo perfil ya tenía en la cola;
 *   · la lista es del workspace: otro espacio sigue pudiendo escribirle;
 *   · (pulido r6) las formas de una misma URL —m., es., sin esquema, con la
 *     tilde codificada o sin ella, con «/es» detrás— dan una sola clave.
 *
 * Ids nuevos en cada corrida: contra un Postgres que se queda, la prueba
 * se puede repetir.
 */
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceTx } from '../src/client.ts';
import { createSequenceFromTemplate, setSequenceStatus } from '../src/queries/cadencias/index.ts';
import { applyContactOptOut, claimDueTouches } from '../src/queries/outreach.ts';
import { enrollContacts } from '../src/queries/outreach/enroll.ts';
import { openTestDb, SETUP_TIMEOUT, type TestDb } from './pglite.ts';

const WS = randomUUID();
const WS_OTRO = randomUUID();
const MARCA = randomUUID();
const MARCA_OTRA = randomUUID();
const SOFIA = randomUUID();
const SOFIA_BIS = randomUUID();
const ANA_IG = randomUUID();
const ANA_IG_BIS = randomUUID();
const LUIS = randomUUID();
const LUIS_BIS = randomUUID();
const SOFIA_OTRO = randomUUID();
/** Un miércoles a mediodía en Bogotá: dentro de la ventana laboral. */
const CLOCK = new Date('2026-09-23T12:00:00-05:00');

let t: TestDb;
let seq = '';
const enWs = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WS, fn);

/** Espera un check_violation (23514) de la base. */
async function rechaza(p: Promise<unknown>, que: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.equal((e as { code?: string }).code, '23514', `${que}: ${(e as Error).message}`);
    return true;
  });
}

before(async () => {
  t = await openTestDb({ seeds: false });
  const slug = `perfil-${WS.slice(0, 8)}`;
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES
      ('${WS}', '${slug}', 'Baja por perfil', 'America/Bogota'),
      ('${WS_OTRO}', '${slug}-otro', 'Otro espacio', 'America/Bogota');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${MARCA}', 'Vitalé', '${WS}'), ('${MARCA_OTRA}', 'Vitalé', '${WS_OTRO}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS}', '${MARCA}'), ('${WS_OTRO}', '${MARCA_OTRA}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, linkedin_url, instagram_handle, source) VALUES
      ('${SOFIA}', '${MARCA}', '${WS}', 'Sofía Cárdenas', 'https://www.linkedin.com/in/sofia-cardenas-${slug}/', NULL, 'user_provided'),
      ('${ANA_IG}', '${MARCA}', '${WS}', 'Ana Ríos', NULL, '@Ana.Rios.${slug}', 'user_provided'),
      ('${LUIS}', '${MARCA}', '${WS}', 'Luis Mora', 'https://co.linkedin.com/in/luis-mora-${slug}', NULL, 'user_provided'),
      ('${LUIS_BIS}', '${MARCA}', '${WS}', 'Luis Mora (otra ficha)', 'linkedin.com/in/luis-mora-${slug}?trk=x', NULL, 'user_provided'),
      ('${SOFIA_OTRO}', '${MARCA_OTRA}', '${WS_OTRO}', 'Sofía Cárdenas', 'https://www.linkedin.com/in/sofia-cardenas-${slug}', NULL, 'user_provided');
    INSERT INTO outbound_policy (workspace_id, enabled, postal_address, require_human_review, max_touches_per_company, min_days_between_touches)
    VALUES ('${WS}', true, 'Calle 93 # 11-26, Bogotá', false, 10, 0), ('${WS_OTRO}', true, 'Calle 93 # 11-26, Bogotá', false, 10, 0);
  `);
  seq = await enWs((tx) => createSequenceFromTemplate(tx, 'marca-con-campana-activa'));
  await enWs((tx) => setSequenceStatus(tx, seq, 'active'));
}, SETUP_TIMEOUT);

after(async () => {
  await t?.close();
});

async function claves(ws: string): Promise<Array<{ channel: string; address_key: string; source: string }>> {
  const { rows } = await t.db.asWorker((tx) =>
    tx.query<{ channel: string; address_key: string; source: string }>(
      `SELECT channel, address_key, source FROM outbound_workspace_optout_handle WHERE workspace_id = $1::uuid ORDER BY 1, 2`,
      [ws],
    ),
  );
  return rows.map((r) => ({ ...r }));
}

test('una baja por respuesta de alguien sin correo no se esquiva con una segunda ficha con la misma URL', async () => {
  const slug = `perfil-${WS.slice(0, 8)}`;
  // La baja llega respondiendo por LinkedIn: la aplica el worker (sin RLS, workspace explícito).
  await t.db.asWorker((tx) => applyContactOptOut(tx, SOFIA, WS, 'Pidió no recibir más mensajes', CLOCK));
  assert.deepEqual(
    (await claves(WS)).filter((k) => k.channel === 'linkedin' && k.address_key.includes('sofia')),
    [{ channel: 'linkedin', address_key: `linkedin.com/in/sofia-cardenas-${slug}`, source: 'contact' }],
    'la URL normalizada: sin esquema, sin www. ni barra final',
  );

  // Otra ficha con la misma URL, escrita de otra forma.
  await enWs((tx) =>
    tx.query(
      `INSERT INTO contact (id, company_id, owner_workspace_id, full_name, linkedin_url, source)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Sofía C.', $4, 'user_provided')`,
      [SOFIA_BIS, MARCA, WS, `HTTPS://LinkedIn.com/in/Sofia-Cardenas-${slug}/?utm_source=x`],
    ),
  );
  const r = await enWs((tx) => enrollContacts(tx, { sequenceId: seq, contactIds: [SOFIA_BIS], now: CLOCK }));
  assert.deepEqual(r.skipped, [{ contactId: SOFIA_BIS, reason: 'opted_out' }]);
  assert.deepEqual(r.enrolled, []);

  // Y la base tampoco lo deja entrar por otro camino: ni el enrolamiento ni el toque de LinkedIn.
  await rechaza(
    enWs((tx) =>
      tx.query(
        `INSERT INTO outbound_enrollment (workspace_id, sequence_id, contact_id, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'active')`,
        [WS, seq, SOFIA_BIS],
      ),
    ),
    'el enrolamiento',
  );
  await rechaza(
    enWs((tx) =>
      tx.query(
        `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'linkedin', 'Hola, Sofía.', 'scheduled', $4::timestamptz)`,
        [WS, MARCA, SOFIA_BIS, CLOCK.toISOString()],
      ),
    ),
    'el toque de LinkedIn',
  );
  // Ni un toque sin ficha a esa misma URL como dirección (recipient_address la escribe el despachador: el worker).
  await rechaza(
    t.db.asWorker((tx) =>
      tx.query(
        `INSERT INTO outbound_touch (workspace_id, company_id, channel, body, status, scheduled_for, recipient_address)
         VALUES ($1::uuid, $2::uuid, 'linkedin', 'Hola.', 'scheduled', $3::timestamptz, $4)`,
        [WS, MARCA, CLOCK.toISOString(), `https://www.linkedin.com/in/sofia-cardenas-${slug}`],
      ),
    ),
    'un toque sin ficha a la misma URL',
  );

  // La lista es de ESTE espacio: el otro sigue pudiendo escribirle a su propia ficha.
  const otro = await t.db.withWorkspace(WS_OTRO, async (tx) => {
    const s = await createSequenceFromTemplate(tx, 'marca-con-campana-activa');
    await setSequenceStatus(tx, s, 'active');
    return enrollContacts(tx, { sequenceId: s, contactIds: [SOFIA_OTRO], now: CLOCK });
  });
  assert.deepEqual(otro.skipped, []);
});

test('la baja a mano desde la web anota el Instagram sin @, y la ficha duplicada no se enrola', async () => {
  const slug = `perfil-${WS.slice(0, 8)}`;
  await enWs((tx) => applyContactOptOut(tx, ANA_IG, WS, 'Lo pidió por teléfono', CLOCK));
  assert.ok(
    (await claves(WS)).some((k) => k.channel === 'instagram_dm' && k.address_key === `ana.rios.${slug}`),
    'el usuario en minúsculas, sin @',
  );
  await enWs((tx) =>
    tx.query(
      `INSERT INTO contact (id, company_id, owner_workspace_id, full_name, instagram_handle, source)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Ana', $4, 'user_provided')`,
      [ANA_IG_BIS, MARCA, WS, `https://instagram.com/ana.rios.${slug}/`],
    ),
  );
  const r = await enWs((tx) => enrollContacts(tx, { sequenceId: seq, contactIds: [ANA_IG_BIS], now: CLOCK }));
  assert.deepEqual(r.skipped, [{ contactId: ANA_IG_BIS, reason: 'opted_out' }]);
});

test('el reclamo cancela lo que otra ficha con el mismo perfil ya tenía en la cola', async () => {
  // Dos fichas de Luis con la misma URL (una con subdominio de país, otra sin esquema y con parámetros).
  const toque = randomUUID();
  await t.admin(`
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, scheduled_for)
    VALUES ('${toque}', '${WS}', '${MARCA}', '${LUIS_BIS}', 'linkedin', 'Hola, Luis.', 'scheduled',
            '${new Date(CLOCK.getTime() - 60_000).toISOString()}');
  `);
  // La primera queda de baja desde la ficha (un UPDATE, como la marca «No contactar»): el disparador anota su perfil.
  await enWs((tx) => tx.query(`UPDATE contact SET opted_out = true, opted_out_at = now() WHERE id = $1::uuid`, [LUIS]));
  const r = await t.db.asWorker((tx) => claimDueTouches(tx, { now: CLOCK, channels: ['linkedin'], workspaceId: WS, limit: 5 }));
  assert.ok(!r.claimed.some((c) => c.id === toque));
  const { rows } = await t.db.asWorker((tx) =>
    tx.query<{ status: string; blocked_reason: string | null }>('SELECT status, blocked_reason FROM outbound_touch WHERE id = $1', [toque]),
  );
  assert.deepEqual({ ...rows[0] }, { status: 'canceled', blocked_reason: 'opted_out' });
});

test('pulido r6: las formas de una misma URL de LinkedIn dan una sola clave, y ninguna variante se enrola ni recibe', async () => {
  const slug = `perfil-${WS.slice(0, 8)}`;
  // La forma que muestra el navegador (con tildes) y las que se copian de él.
  const base = `https://www.linkedin.com/in/sofía-cárdenas-${slug}`;
  const variantes = [
    `https://m.linkedin.com/in/sofía-cárdenas-${slug}`,
    `linkedin.com/in/sofía-cárdenas-${slug}`,
    `https://www.linkedin.com/in/sof%C3%ADa-c%C3%A1rdenas-${slug}/`,
    `https://es.linkedin.com/in/sofía-cárdenas-${slug}/es`,
  ];
  const { rows: ks } = await t.db.asWorker((tx) =>
    tx.query<{ k: string }>(`SELECT outreach_handle_key('linkedin', a) AS k FROM unnest($1::text[]) AS a`, [[base, ...variantes]]),
  );
  assert.deepEqual(
    [...new Set(ks.map((r) => r.k))],
    [`linkedin.com/in/sofía-cárdenas-${slug}`],
    'una sola clave: sin subdominio, decodificada y sin lo que sigue al slug',
  );
  // Un % suelto o bytes que no son UTF-8 no rompen la clave; de una página, solo /company/<slug>.
  const { rows: raras } = await t.db.asWorker((tx) =>
    tx.query<{ a: string; b: string; c: string }>(
      `SELECT outreach_handle_key('linkedin', 'linkedin.com/in/ana%') AS a,
              outreach_handle_key('linkedin', 'linkedin.com/in/ana%FF') AS b,
              outreach_handle_key('linkedin', 'https://www.linkedin.com/company/vitale/posts/?x=1') AS c`,
    ),
  );
  assert.deepEqual({ ...raras[0] }, { a: 'linkedin.com/in/ana%', b: 'linkedin.com/in/ana%ff', c: 'linkedin.com/company/vitale' });

  // Queda de baja la ficha con la forma del navegador.
  const original = randomUUID();
  await t.admin(`
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, linkedin_url, source)
    VALUES ('${original}', '${MARCA}', '${WS}', 'Sofía Cárdenas (tildes)', '${base}', 'user_provided');
  `);
  await t.db.asWorker((tx) => applyContactOptOut(tx, original, WS, 'Pidió no recibir más mensajes', CLOCK));

  // Cada variante, en otra ficha: no se enrola, y su toque de LinkedIn no entra.
  for (const url of variantes) {
    const bis = randomUUID();
    await enWs((tx) =>
      tx.query(
        `INSERT INTO contact (id, company_id, owner_workspace_id, full_name, linkedin_url, source)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Sofía (otra ficha)', $4, 'user_provided')`,
        [bis, MARCA, WS, url],
      ),
    );
    const r = await enWs((tx) => enrollContacts(tx, { sequenceId: seq, contactIds: [bis], now: CLOCK }));
    assert.deepEqual(r.skipped, [{ contactId: bis, reason: 'opted_out' }], url);
    await rechaza(
      enWs((tx) =>
        tx.query(
          `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'linkedin', 'Hola, Sofía.', 'scheduled', $4::timestamptz)`,
          [WS, MARCA, bis, CLOCK.toISOString()],
        ),
      ),
      `el toque de LinkedIn a ${url}`,
    );
  }
});
