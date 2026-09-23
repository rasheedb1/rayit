/**
 * Escenario y arnés compartidos de las pruebas de alcance (ACC-6): DOS
 * creadoras en el workspace de Laura y miembros con alcance acotado.
 *
 *   Laura   la creadora del seed (0002/0003), con sus campañas, posts,
 *           cuentas y facturas.
 *   Sofía   una segunda creadora del MISMO workspace, con una marca
 *           propia, una cuenta por @, un post, una campaña con ese post,
 *           una factura con su pago y su reserva, una cotización aceptada
 *           y sus consentimientos y snapshots.
 *   Dueña   la persona del seed (Laura, owner), SIN filas de alcance:
 *           ve todo el workspace. Es el control de cada prueba: si la
 *           dueña no ve lo de Sofía, el escenario está mal, no el filtro.
 *   Miembro una persona nueva con membresía y UNA fila de alcance:
 *           creator = Laura. No puede ver ni tocar nada de Sofía.
 *   Y dos miembros más, uno con alcance por campaña (Café Alma) y otro
 *   por marca (la de Sofía), para las pruebas propias de cada módulo.
 *
 * Todo lo de Sofía lleva el prefijo 0000000a-…, y SOFIA_IDS los reúne:
 * la prueba de cada módulo serializa el resultado de cada función y
 * exige que ninguno aparezca.
 *
 * El arnés (`definirPruebasDeAlcance`) es el mismo para los tres
 * módulos: recorre `Object.entries(import * as m)` y exige un caso por
 * función exportada, de modo que exportar una función nueva sin caso
 * hace fallar la prueba con su nombre. Cada caso se corre dos veces: como
 * el miembro (nada de Sofía, o rechazo sin escribir) y como la dueña
 * (control: sí ve o sí escribe). Entre medias, una huella de las tablas
 * demuestra que la pasada del miembro no dejó ni una fila.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceTx } from '../src/client.ts';
import { openTestDb, WORKSPACE_LAURA, COMPANY_CAFE_ALMA, CAMPAIGN_CAFE_ALMA, type TestDb } from './pglite.ts';

export const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';
/** La persona del seed: dueña del workspace, sin alcance. */
export const USER_LAURA = '00000002-0000-4000-8000-000000000002';
/** Una campaña de Laura en planned, para asociar y quitar posts. */
export const CAMPAIGN_LAURA_PRUEBA = '0000000b-0000-4000-8000-000000ca0001';

/** Alcance creator = Laura. */
export const USER_MIEMBRO = '0000000a-0000-4000-8000-000000000002';
/** Alcance campaign = la campaña de Café Alma (de Laura). */
export const USER_MIEMBRO_CAMPANA = '0000000a-0000-4000-8000-000000000012';
/** Alcance company = la marca de Sofía. */
export const USER_MIEMBRO_MARCA = '0000000a-0000-4000-8000-000000000022';

export const CREATOR_SOFIA = '0000000a-0000-4000-8000-000000000003';
export const EMPRESA_SOFIA = '0000000a-0000-4000-8000-0000000000e1';
export const CONEXION_SOFIA = '0000000a-0000-4000-8000-0000000000c1';
export const POST_SOFIA = '0000000a-0000-4000-8000-000000000d01';
export const CAMPAIGN_SOFIA = '0000000a-0000-4000-8000-000000ca0001';
export const INVOICE_SOFIA = '0000000a-0000-4000-8000-0000fac26001';
export const PAYMENT_SOFIA = '0000000a-0000-4000-8000-00000fa90001';
export const TAX_RESERVE_SOFIA = '0000000a-0000-4000-8000-0000007a0001';
export const QUOTE_SOFIA = '0000000a-0000-4000-8000-0000c0700001';
export const CONSENT_SOFIA = '0000000a-0000-4000-8000-0000c0a50001';
export const HANDLE_SOFIA = 'sofia.viaja';
export const EXTERNAL_ACCOUNT_SOFIA = 'sofia.viaja';

/** Todo lo que un resultado filtrado NO puede nombrar. */
export const SOFIA_IDS: readonly string[] = [
  CREATOR_SOFIA, EMPRESA_SOFIA, CONEXION_SOFIA, POST_SOFIA, CAMPAIGN_SOFIA, INVOICE_SOFIA, PAYMENT_SOFIA,
  TAX_RESERVE_SOFIA, QUOTE_SOFIA, CONSENT_SOFIA,
];

/** Siembra el escenario como superusuario, fuera de toda transacción. Idempotente. */
export async function sembrarAlcance(t: TestDb): Promise<void> {
  const miembro = (userId: string, email: string, scopeType: string, scopeId: string) => `
    INSERT INTO app_user (id, email, name, locale) VALUES ('${userId}', '${email}', 'Miembro con alcance', 'es-CO') ON CONFLICT DO NOTHING;
    INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WORKSPACE_LAURA}', '${userId}', 'member') ON CONFLICT DO NOTHING;
    INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
    VALUES ('${WORKSPACE_LAURA}', '${userId}', '${scopeType}', '${scopeId}') ON CONFLICT DO NOTHING;
  `;
  await t.admin(`
    ${miembro(USER_MIEMBRO, 'miembro.alcance@ejemplo.com', 'creator', CREATOR_LAURA)}
    ${miembro(USER_MIEMBRO_CAMPANA, 'miembro.campana@ejemplo.com', 'campaign', CAMPAIGN_CAFE_ALMA)}
    ${miembro(USER_MIEMBRO_MARCA, 'miembro.marca@ejemplo.com', 'company', EMPRESA_SOFIA)}

    INSERT INTO campaign (id, workspace_id, company_id, creator_id, name, status, starts_on, ends_on, amount, currency)
    VALUES ('${CAMPAIGN_LAURA_PRUEBA}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}', '${CREATOR_LAURA}', 'Campaña de prueba de Laura', 'planned',
            DATE '2026-10-01', DATE '2026-10-08', 1000000.00, 'COP')
    ON CONFLICT DO NOTHING;

    INSERT INTO creator_profile (id, workspace_id, display_name, handle, country, languages, niche_slugs)
    VALUES ('${CREATOR_SOFIA}', '${WORKSPACE_LAURA}', 'Sofía Rojas', '${HANDLE_SOFIA}', 'CO', '{es}', '{viajes}')
    ON CONFLICT DO NOTHING;

    INSERT INTO company (id, name, domain, owner_workspace_id, socials)
    VALUES ('${EMPRESA_SOFIA}', 'Marca de Sofía', 'marcasofia.co', '${WORKSPACE_LAURA}', '{"instagram": "marcasofia"}')
    ON CONFLICT DO NOTHING;
    INSERT INTO company_link (workspace_id, company_id, relationship)
    VALUES ('${WORKSPACE_LAURA}', '${EMPRESA_SOFIA}', 'client')
    ON CONFLICT DO NOTHING;

    INSERT INTO social_connection
      (id, workspace_id, creator_id, platform_id, external_account_id, handle, display_name, profile_url,
       account_type, secret_ref, scopes, access_mode, status, connected_at, last_synced_at)
    VALUES ('${CONEXION_SOFIA}', '${WORKSPACE_LAURA}', '${CREATOR_SOFIA}', 'tiktok', '${EXTERNAL_ACCOUNT_SOFIA}', '${HANDLE_SOFIA}',
            'Sofía viaja', 'https://www.tiktok.com/@${HANDLE_SOFIA}', 'creator', 'public:tiktok:${HANDLE_SOFIA}', '{}',
            'public_profile', 'active', now() - interval '10 days', now() - interval '1 day')
    ON CONFLICT DO NOTHING;
    INSERT INTO data_consent (id, workspace_id, creator_id, connection_id, purpose, granted, policy_version, evidence)
    VALUES ('${CONSENT_SOFIA}', '${WORKSPACE_LAURA}', '${CREATOR_SOFIA}', '${CONEXION_SOFIA}', 'analytics', true, 'v1', '{}')
    ON CONFLICT DO NOTHING;
    INSERT INTO account_metric_snapshot (connection_id, workspace_id, day, followers, following, media_count, views, source)
    VALUES ('${CONEXION_SOFIA}', '${WORKSPACE_LAURA}', CURRENT_DATE - 8, 9000, 100, 40, 500000, 'public_profile'),
           ('${CONEXION_SOFIA}', '${WORKSPACE_LAURA}', CURRENT_DATE - 1, 9500, 100, 42, 520000, 'public_profile')
    ON CONFLICT DO NOTHING;

    INSERT INTO post (id, workspace_id, creator_id, connection_id, platform_id, external_post_id, url, media_type, surface,
                      title, caption, mentions, published_at)
    VALUES ('${POST_SOFIA}', '${WORKSPACE_LAURA}', '${CREATOR_SOFIA}', '${CONEXION_SOFIA}', 'tiktok', 'sofia-d01',
            'https://www.tiktok.com/@${HANDLE_SOFIA}/video/1', 'video', 'feed',
            'Cold brew en la playa', 'Probé el cold brew de @cafealma en la playa. Código LAURA15.', '{cafealma}',
            TIMESTAMPTZ '2026-08-12 15:00:00+00')
    ON CONFLICT DO NOTHING;
    INSERT INTO post_metric_snapshot (post_id, workspace_id, captured_at, age_hours, views, reach, likes, comments, shares, saves, source)
    SELECT '${POST_SOFIA}', '${WORKSPACE_LAURA}', TIMESTAMPTZ '2026-09-11 15:00:00+00', 720, 88000, 60000, 4000, 120, 300, 900, 'api'
    WHERE NOT EXISTS (SELECT 1 FROM post_metric_snapshot WHERE post_id = '${POST_SOFIA}');

    INSERT INTO campaign (id, workspace_id, company_id, creator_id, name, status, starts_on, ends_on, amount, currency)
    VALUES ('${CAMPAIGN_SOFIA}', '${WORKSPACE_LAURA}', '${EMPRESA_SOFIA}', '${CREATOR_SOFIA}', 'Playa con Marca de Sofía', 'planned',
            DATE '2026-08-10', DATE '2026-08-20', 2000000.00, 'COP')
    ON CONFLICT DO NOTHING;
    INSERT INTO campaign_post (campaign_id, post_id, deliverable, is_primary)
    VALUES ('${CAMPAIGN_SOFIA}', '${POST_SOFIA}', 'tiktok', true)
    ON CONFLICT DO NOTHING;

    INSERT INTO invoice (id, workspace_id, company_id, campaign_id, number, currency, subtotal, tax, withholding, total,
                         issued_on, due_on, status, paid_amount)
    VALUES ('${INVOICE_SOFIA}', '${WORKSPACE_LAURA}', '${EMPRESA_SOFIA}', '${CAMPAIGN_SOFIA}', 'FV-2026-901', 'COP',
            1000000.00, 190000.00, 0.00, 1190000.00, DATE '2026-09-01', CURRENT_DATE + 30, 'sent', 400000.00)
    ON CONFLICT DO NOTHING;
    INSERT INTO payment (id, workspace_id, invoice_id, direction, amount, currency, method, received_at)
    VALUES ('${PAYMENT_SOFIA}', '${WORKSPACE_LAURA}', '${INVOICE_SOFIA}', 'in', 400000.00, 'COP', 'transferencia', now() - interval '3 days')
    ON CONFLICT DO NOTHING;
    INSERT INTO tax_reserve (id, workspace_id, payment_id, rate, amount, currency, period)
    VALUES ('${TAX_RESERVE_SOFIA}', '${WORKSPACE_LAURA}', '${PAYMENT_SOFIA}', 0.1100, 44000.00, 'COP', '2026-Q3')
    ON CONFLICT DO NOTHING;

    INSERT INTO quote (id, workspace_id, company_id, creator_id, number, slug, currency, subtotal, tax, total,
                       agreed_metrics, report_cuts_hours, payment_terms_days, status)
    VALUES ('${QUOTE_SOFIA}', '${WORKSPACE_LAURA}', '${EMPRESA_SOFIA}', '${CREATOR_SOFIA}', 'COT-2026-901', 'cot-sofia-901', 'COP',
            1000000.00, 190000.00, 1190000.00, '{views}', '{168}', 30, 'accepted')
    ON CONFLICT DO NOTHING;
    INSERT INTO quote_item (quote_id, deliverable, platform_id, description, quantity, unit_price, total, position)
    SELECT '${QUOTE_SOFIA}', 'tiktok', 'tiktok', '1 TikTok en la playa', 1, 1000000.00, 1000000.00, 0
    WHERE NOT EXISTS (SELECT 1 FROM quote_item WHERE quote_id = '${QUOTE_SOFIA}');
  `);
}

/** ¿El resultado serializado nombra algo de Sofía? Devuelve los ids que aparecen. */
export function idsDeSofiaEn(resultado: unknown): string[] {
  const texto = JSON.stringify(resultado ?? null);
  return SOFIA_IDS.filter((id) => texto.includes(id));
}

/** Las funciones exportadas de un módulo de consultas, sin las clases de error. */
export function funcionesExportadas(modulo: Record<string, unknown>): string[] {
  return Object.entries(modulo)
    .filter(([, v]) => typeof v === 'function' && !((v as { prototype?: unknown }).prototype instanceof Error))
    .map(([name]) => name)
    .sort();
}

/**
 * Una huella de lo que el miembro no puede tocar: el texto de cada fila
 * de las tablas que escriben los tres módulos. Igual antes y después de
 * la pasada del miembro = no escribió ni una fila.
 */
export async function huella(t: TestDb): Promise<Record<string, string | null>> {
  const tablas = ['campaign', 'campaign_post', 'invoice', 'payment', 'tax_reserve', 'social_connection', 'data_consent', 'account_metric_snapshot', 'connection_secret'];
  const out: Record<string, string | null> = {};
  for (const tabla of tablas) {
    const [fila] = await t.raw<{ h: string | null }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${tabla} x`);
    out[tabla] = fila?.h ?? null;
  }
  return out;
}

type ClaseDeError = abstract new (...args: never[]) => Error;

/** Cómo se comporta una función exportada con ids de Sofía. */
export type CasoDeAlcance =
  | 'pura'
  | {
      /** Llama a la función apuntando a lo de Sofía. */
      run: (tx: WorkspaceTx) => Promise<unknown>;
      /**
       * Como la dueña (sin alcance). 'nombra': el resultado cita algún id
       * de Sofía. 'pasa': basta con que no lance. O un predicado.
       */
      duena: 'nombra' | 'pasa' | ((resultado: unknown) => boolean);
      /**
       * Como el miembro con alcance a Laura. 'nada': no lanza y el
       * resultado no cita a Sofía. O la clase de error con la que rechaza,
       * o un predicado sobre el error.
       */
      miembro: 'nada' | { rechaza: ClaseDeError } | { rechazaSi: (error: unknown) => boolean };
    };

export interface ArnesDeAlcance {
  t: () => TestDb;
  duena: <T>(fn: (tx: WorkspaceTx) => Promise<T>) => Promise<T>;
  miembro: <T>(fn: (tx: WorkspaceTx) => Promise<T>) => Promise<T>;
  como: <T>(userId: string, fn: (tx: WorkspaceTx) => Promise<T>) => Promise<T>;
}

/**
 * Registra, para un módulo de consultas, las pruebas de alcance: una por
 * función exportada como miembro, la huella, y la pasada de control como
 * dueña. `extra` recibe el arnés para añadir pruebas propias del módulo
 * DENTRO del mismo describe (misma base), y va antes de la pasada de
 * control para que las escrituras de la dueña no cambien el escenario.
 */
export function definirPruebasDeAlcance(
  nombre: string,
  modulo: Record<string, unknown>,
  casos: Readonly<Record<string, CasoDeAlcance>>,
  extra?: (arnes: ArnesDeAlcance) => void,
): void {
  let t: TestDb;
  const como = <T>(userId: string, fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn, { userId });
  const arnes: ArnesDeAlcance = {
    t: () => t,
    duena: (fn) => como(USER_LAURA, fn),
    miembro: (fn) => como(USER_MIEMBRO, fn),
    como,
  };
  const funciones = funcionesExportadas(modulo);
  const conConsulta = Object.entries(casos).filter((e): e is [string, Exclude<CasoDeAlcance, 'pura'>] => e[1] !== 'pura');

  // El límite de 120 s del script (--test-timeout) también se aplica al
  // describe ENTERO, y este agrupa más de treinta pruebas sobre una base:
  // con la máquina cargada pasó de 120 s, se canceló y arrastró el resto
  // de la suite (--test-isolation=none). Cada prueba sigue con el suyo.
  describe(`alcance en queries/${nombre}.ts`, { timeout: 900_000 }, () => {
    let antes: Record<string, string | null>;

    before(async () => {
      t = await openTestDb();
      await sembrarAlcance(t);
      antes = await huella(t);
    }, { timeout: 600_000 });

    after(async () => {
      await t.close();
    });

    test('cada función exportada tiene su caso, y ningún caso sobra', () => {
      const sinCaso = funciones.filter((f) => !(f in casos));
      assert.deepEqual(sinCaso, [], `funciones exportadas sin caso de alcance en test/alcance-${nombre}.test.ts: ${sinCaso.join(', ')}`);
      const sobran = Object.keys(casos).filter((f) => !funciones.includes(f));
      assert.deepEqual(sobran, [], `casos de funciones que ya no se exportan: ${sobran.join(', ')}`);
    });

    for (const [fn, caso] of conConsulta) {
      test(`${fn}: el miembro con alcance a Laura no ve ni toca nada de Sofía`, async () => {
        const esperado = caso.miembro;
        if (esperado === 'nada') {
          const resultado = await arnes.miembro(caso.run);
          assert.deepEqual(idsDeSofiaEn(resultado), [], `${fn} devolvió algo de Sofía al miembro`);
          return;
        }
        await assert.rejects(
          arnes.miembro(caso.run),
          (e: unknown) => ('rechaza' in esperado ? e instanceof esperado.rechaza : esperado.rechazaSi(e)),
          `${fn} debería rechazar al miembro`,
        );
      });
    }

    test('la pasada del miembro no escribió ni una fila', async () => {
      assert.deepEqual(await huella(t), antes);
    });

    if (extra) extra(arnes);

    for (const [fn, caso] of conConsulta) {
      test(`${fn}: la dueña sí ve (o sí escribe) lo de Sofía (control del escenario)`, async () => {
        const resultado = await arnes.duena(caso.run);
        if (caso.duena === 'nombra') {
          assert.ok(idsDeSofiaEn(resultado).length > 0, `${fn}: la dueña debería ver algo de Sofía; el escenario no la nombra`);
        } else if (typeof caso.duena === 'function') {
          assert.ok(caso.duena(resultado), `${fn}: el resultado de la dueña no es el esperado: ${JSON.stringify(resultado)}`);
        }
      });
    }
  });
}
