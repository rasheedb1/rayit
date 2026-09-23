/**
 * Las consultas de Ventas contra Postgres embebido con las migraciones
 * y el seed aplicados: VEN-1 (empresas y contactos), VEN-2 (radar) y
 * VEN-3 (pipeline).
 *
 * Lo que estas pruebas cuidan, además del «terminado cuando» de cada
 * historia:
 *   - el aislamiento por workspace de TODO lo que se lee y se escribe,
 *     incluida la parte del esquema que no lo hace igual (company es un
 *     catálogo global, contact se aísla por owner_workspace_id);
 *   - que la baja de un contacto no se pueda deshacer;
 *   - que una señal descartada no vuelva a entrar por el mismo camino
 *     por el que entró.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompanyNotFound,
  ContactNotOwned,
  DuplicateDomain,
  PITCH_ACTION,
  PITCH_DUE_DAYS,
  SignalAlreadyReviewed,
  VentasError,
  acceptSignal,
  buildDedupeKey,
  countPendingSignals,
  createCompany,
  createContact,
  createSignal,
  discardSignal,
  getCompany,
  getSalesKpis,
  importSignals,
  listCompanies,
  listContacts,
  listPipeline,
  listSignals,
  listStages,
  moveDeal,
  normalizeDomain,
  optOutContact,
  searchTerm,
  updateCompany,
  updateContact,
} from '../src/queries/ventas.ts';
import type { WorkspaceTx } from '../src/client.ts';
import { openTestDb, type TestDb, WORKSPACE_LAURA, COMPANY_CAFE_ALMA } from './pglite.ts';

/** Empresas del seed 0002 que estas pruebas nombran. */
const COMPANY_FRESKO = '00000002-0000-4000-8000-0000000000e2';
const COMPANY_GRANOS = '00000002-0000-4000-8000-0000000000e6';
/** Mateo Giraldo, el contacto del seed que pidió la baja. */
const CONTACT_BAJA = '00000002-0000-4000-8000-0000000c0010';
/** Camila Rojas (Fresko), de fuente pública. */
const CONTACT_CAMILA = '00000002-0000-4000-8000-0000000c0001';
/** Señales pendientes del seed: la bandeja de hoy. */
const SIGNAL_VITALE = '00000002-0000-4000-8000-00000005e007';
const SIGNAL_FRESKO = '00000002-0000-4000-8000-00000005e008';
/** El deal de Olla Fácil, en «nuevo». */
const DEAL_OLLA = '00000002-0000-4000-8000-0000000dea01';

/** Un workspace ajeno, para comprobar que nada se cruza. */
const WORKSPACE_AJENO = '00000009-0000-4000-8000-00000000be01';
const COMPANY_AJENA = '00000009-0000-4000-8000-0000000000f1';
const CONTACT_AJENO = '00000009-0000-4000-8000-0000000c00f1';
const CONTACT_AJENO_PUBLICO = '00000009-0000-4000-8000-0000000c00f2';

let t: TestDb;
const laura = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn);
const ajeno = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_AJENO, fn);

before(async () => {
  t = await openTestDb();
  // Como superusuario: un workspace vecino con su propia empresa, su
  // contacto privado y un deal, para que las pruebas de aislamiento
  // tengan algo real que NO deba verse desde el de Laura.
  await t.admin(`
    INSERT INTO workspace (id, slug, name, kind, currency)
    VALUES ('${WORKSPACE_AJENO}', 'workspace-ajeno-ventas', 'Workspace ajeno', 'creator', 'COP')
    ON CONFLICT DO NOTHING;

    INSERT INTO company (id, name, domain, country, industry)
    VALUES ('${COMPANY_AJENA}', 'Marca Ajena', 'marcaajena.co', 'CO', 'moda')
    ON CONFLICT DO NOTHING;

    INSERT INTO company_link (workspace_id, company_id, relationship)
    VALUES ('${WORKSPACE_AJENO}', '${COMPANY_AJENA}', 'prospect')
    ON CONFLICT DO NOTHING;

    -- Privado (user_provided) y del workspace ajeno: Laura no debe verlo.
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
    VALUES ('${CONTACT_AJENO}', '${COMPANY_AJENA}', '${WORKSPACE_AJENO}', 'Persona Ajena', 'persona@marcaajena.co', 'user_provided')
    ON CONFLICT DO NOTHING;

    INSERT INTO deal (id, workspace_id, company_id, name, stage_id, amount, currency)
    VALUES ('00000009-0000-4000-8000-0000000dea01', '${WORKSPACE_AJENO}', '${COMPANY_AJENA}', 'Deal ajeno', 'propuesta', 99000000.00, 'COP')
    ON CONFLICT DO NOTHING;

    -- Público (public_website) pero guardado por el vecino: Laura DEBE
    -- verlo (la política de lectura de 0020 deja pasar lo público) y NO
    -- debe poder editarlo.
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source, source_url)
    VALUES ('${CONTACT_AJENO_PUBLICO}', '${COMPANY_AJENA}', '${WORKSPACE_AJENO}', 'Vocera Ajena',
            'prensa@marcaajena.co', 'public_website', 'https://marcaajena.co/prensa')
    ON CONFLICT DO NOTHING;

    INSERT INTO signal (id, workspace_id, company_id, source_id, headline_es, dedupe_key, status, fit_score)
    VALUES ('00000009-0000-4000-8000-00000005e001', '${WORKSPACE_AJENO}', '${COMPANY_AJENA}', 'manual',
            'Señal ajena', 'manual:marcaajena.co', 'pending', 0.99)
    ON CONFLICT DO NOTHING;
  `);
}, { timeout: 180_000 });

after(async () => {
  await t.close();
});

// =====================================================================
// Ayudantes puros
// =====================================================================

describe('normalización de entradas', () => {
  test('un dominio se guarda como el host, venga como venga', () => {
    for (const escrito of ['cafealma.co', 'CafeAlma.co', 'https://cafealma.co', 'https://www.cafealma.co/tienda?x=1', '  www.CAFEALMA.co  ']) {
      assert.equal(normalizeDomain(escrito), 'cafealma.co', `«${escrito}» debería normalizar a cafealma.co`);
    }
    assert.equal(normalizeDomain(''), null);
    assert.equal(normalizeDomain(null), null);
  });

  test('la búsqueda no consulta con menos de tres caracteres', () => {
    assert.equal(searchTerm('ca'), null);
    assert.equal(searchTerm('  c '), null);
    assert.equal(searchTerm('caf'), 'caf');
    assert.equal(searchTerm('  Café Alma '), 'Café Alma');
    assert.equal(searchTerm(undefined), null);
  });

  test('la clave de deduplicación es estable y no lleva la fecha', () => {
    const a = buildDedupeKey('meta_ad_library', 'Café Alma');
    const b = buildDedupeKey('meta_ad_library', '  café alma  ');
    assert.equal(a, b, 'la misma marca escrita distinto da la misma clave');
    assert.equal(a, 'meta_ad_library:café-alma');
    assert.equal(buildDedupeKey('manual', 'x.co', 'ref-1'), 'manual:x.co:ref-1');
  });
});

// =====================================================================
// VEN-1 · Empresas y contactos
// =====================================================================

describe('VEN-1 · empresas', () => {
  test('la lista solo trae las empresas de MI workspace, con sus cifras ya contadas', async () => {
    const mias = await laura((tx) => listCompanies(tx, { limit: 200 }));
    const nombres = mias.map((c) => c.name);
    assert.ok(nombres.includes('Café Alma'), 'las del seed están');
    assert.ok(!nombres.includes('Marca Ajena'), 'la del vecino no se ve, aunque company sea un catálogo global');

    const alma = mias.find((c) => c.id === COMPANY_CAFE_ALMA);
    assert.ok(alma, 'Café Alma está en la lista');
    assert.equal(alma.relationship, 'client');
    assert.ok(alma.contactCount >= 2, 'trae sus contactos contados');
    assert.ok(Number(alma.openDealAmount) > 0, 'y la suma de sus negocios abiertos');
    // La suma llega como string decimal: nunca como number.
    assert.equal(typeof alma.openDealAmount, 'string');
  });

  test('el vecino tampoco ve las de Laura', async () => {
    const suyas = await ajeno((tx) => listCompanies(tx, { limit: 200 }));
    assert.deepEqual(suyas.map((c) => c.name), ['Marca Ajena']);
  });

  test('la búsqueda encuentra al tercer carácter, y con dos no filtra', async () => {
    const tres = await laura((tx) => listCompanies(tx, { search: 'caf' }));
    assert.ok(tres.some((c) => c.name === 'Café Alma'), '«caf» encuentra Café Alma');
    assert.ok(!tres.some((c) => c.name === 'Hogar Lindo'), 'y deja fuera lo que no se parece');

    const dos = await laura((tx) => listCompanies(tx, { search: 'ca', limit: 200 }));
    const todas = await laura((tx) => listCompanies(tx, { limit: 200 }));
    assert.equal(dos.length, todas.length, 'con dos caracteres no se busca: se muestran todas');
  });

  test('la búsqueda también entiende un dominio pegado', async () => {
    const porDominio = await laura((tx) => listCompanies(tx, { search: 'freskomarket' }));
    assert.ok(porDominio.some((c) => c.id === COMPANY_FRESKO));
  });

  test('un comodín escrito por el usuario se busca como texto, no como comodín', async () => {
    const conPorcentaje = await laura((tx) => listCompanies(tx, { search: '%%%' }));
    assert.equal(conPorcentaje.length, 0, '«%%%» no puede devolver todas las empresas');
  });

  test('crear una empresa la deja vinculada a mi workspace y visible en la búsqueda', async () => {
    const id = await laura((tx) =>
      createCompany(tx, { name: 'Panadería Trigal', domain: 'https://www.trigal.co/nosotros', country: 'co', city: 'Bogotá', industry: 'alimentos' }),
    );
    const creada = await laura((tx) => getCompany(tx, id));
    assert.ok(creada);
    assert.equal(creada.name, 'Panadería Trigal');
    assert.equal(creada.domain, 'trigal.co', 'el dominio se guarda normalizado');
    assert.equal(creada.country, 'CO');
    assert.equal(creada.relationship, 'prospect');

    const buscada = await laura((tx) => listCompanies(tx, { search: 'tri' }));
    assert.ok(buscada.some((c) => c.id === id), 'aparece al tercer carácter');

    // Y el vecino no la ve, aunque la fila de `company` sea global.
    const desdeElVecino = await ajeno((tx) => getCompany(tx, id));
    assert.equal(desdeElVecino, null);
  });

  test('un dominio ya vinculado se avisa en vez de duplicar la empresa', async () => {
    await assert.rejects(
      () => laura((tx) => createCompany(tx, { name: 'Cafe Alma otra vez', domain: 'cafealma.co' })),
      (err: unknown) => err instanceof DuplicateDomain && /Café Alma/.test((err as VentasError).messageEs),
    );
  });

  test('una empresa que no es mía no se puede editar', async () => {
    await assert.rejects(
      () => laura((tx) => updateCompany(tx, COMPANY_AJENA, { name: 'Renombrada por Laura' })),
      CompanyNotFound,
    );
    const intacta = await t.raw<{ name: string }>(`SELECT name FROM company WHERE id = '${COMPANY_AJENA}'`);
    assert.equal(intacta[0]?.name, 'Marca Ajena');
  });

  test('editar cambia el catálogo y la relación en una sola llamada', async () => {
    await laura((tx) => updateCompany(tx, COMPANY_GRANOS, { relationship: 'client', city: 'Palmira', notes: 'Segundo intento cerrado.' }));
    const despues = await laura((tx) => getCompany(tx, COMPANY_GRANOS));
    assert.equal(despues?.relationship, 'client');
    assert.equal(despues?.city, 'Palmira');
    assert.equal(despues?.notes, 'Segundo intento cerrado.');
    // Deshacer para no alterar a las demás pruebas.
    await laura((tx) => updateCompany(tx, COMPANY_GRANOS, { relationship: 'contacted', city: 'Cali' }));
  });

  test('un id imposible devuelve null, no un error 500', async () => {
    assert.equal(await laura((tx) => getCompany(tx, 'no-soy-un-uuid')), null);
  });
});

describe('VEN-1 · contactos', () => {
  test('un contacto exige procedencia', async () => {
    await assert.rejects(
      () => laura((tx) => createContact(tx, { companyId: COMPANY_CAFE_ALMA, fullName: 'Sin fuente', source: 'inventada' as never })),
      (err: unknown) => err instanceof VentasError && /de dónde salió/.test((err as VentasError).messageEs),
    );
  });

  test('se crean dos contactos y quedan en la empresa, con su dueño puesto por la base', async () => {
    const id = await laura((tx) => createCompany(tx, { name: 'Mercado del Sol', domain: 'mercadodelsol.co' }));
    await laura((tx) => createContact(tx, { companyId: id, fullName: 'Ana Ruiz', roleTitle: 'Marketing', email: 'ana@mercadodelsol.co', source: 'public_website' }));
    await laura((tx) => createContact(tx, { companyId: id, fullName: 'Luis Peña', instagramHandle: '@luis.pena', source: 'public_profile' }));

    const contactos = await laura((tx) => listContacts(tx, id));
    assert.equal(contactos.length, 2);
    assert.deepEqual(contactos.map((c) => c.fullName).sort(), ['Ana Ruiz', 'Luis Peña']);
    assert.ok(contactos.every((c) => c.isOwn), 'los guardó este workspace');
    assert.equal(contactos.find((c) => c.fullName === 'Luis Peña')?.instagramHandle, 'luis.pena', 'la arroba se quita');

    // El candado lo pone la base, no la consulta.
    const dueños = await laura(async (tx) =>
      (await tx.query<{ owner_workspace_id: string }>(
        'SELECT owner_workspace_id FROM contact WHERE company_id = $1', [id],
      )).rows,
    );
    assert.equal(dueños.length, 2);
    assert.ok(dueños.every((d) => d.owner_workspace_id === WORKSPACE_LAURA));

    const lista = await laura((tx) => listCompanies(tx, { search: 'mercado' }));
    assert.equal(lista.find((c) => c.id === id)?.contactCount, 2);
  });

  test('un contacto sin nombre, correo ni usuario no se guarda', async () => {
    await assert.rejects(
      () => laura((tx) => createContact(tx, { companyId: COMPANY_CAFE_ALMA, source: 'press' })),
      (err: unknown) => err instanceof VentasError && /al menos nombre/.test((err as VentasError).messageEs),
    );
  });

  test('no se puede guardar un contacto en una empresa que no es mía', async () => {
    await assert.rejects(
      () => laura((tx) => createContact(tx, { companyId: COMPANY_AJENA, fullName: 'Intruso', source: 'user_provided' })),
      CompanyNotFound,
    );
  });

  test('el contacto privado del vecino no se ve desde aquí', async () => {
    const suyos = await laura((tx) => listContacts(tx, COMPANY_AJENA));
    assert.ok(!suyos.some((c) => c.id === CONTACT_AJENO), 'user_provided del vecino: ni se lista');
    const desdeSuCasa = await ajeno((tx) => listContacts(tx, COMPANY_AJENA));
    assert.equal(desdeSuCasa.length, 2, 'en su casa ve el privado y el público');
    assert.ok(desdeSuCasa.some((c) => c.id === CONTACT_AJENO));
  });

  test('un contacto ajeno de fuente pública se ve pero no se edita', async () => {
    const contactos = await laura((tx) => listContacts(tx, COMPANY_AJENA));
    const vocera = contactos.find((c) => c.id === CONTACT_AJENO_PUBLICO);
    assert.ok(vocera, 'se ve porque su fuente es pública, aunque la empresa no sea mía');
    assert.equal(vocera.isOwn, false, 'y no es de este workspace');
    await assert.rejects(
      () => laura((tx) => updateContact(tx, CONTACT_AJENO_PUBLICO, { roleTitle: 'Cambiado' })),
      ContactNotOwned,
    );
    // Y la baja de un contacto ajeno tampoco la registra la pantalla:
    // eso lo hace el worker con asWorker (ver 0020).
    await assert.rejects(() => laura((tx) => optOutContact(tx, CONTACT_AJENO_PUBLICO, 'x')), ContactNotOwned);
  });

  test('los contactos del seed son de Laura: los guardó su workspace', async () => {
    const contactos = await laura((tx) => listContacts(tx, COMPANY_FRESKO));
    assert.ok(contactos.find((c) => c.id === CONTACT_CAMILA)?.isOwn, 'el seed corre con el workspace fijado');
  });

  test('la baja es de una sola dirección: se registra y no se puede deshacer', async () => {
    const id = await laura((tx) => createCompany(tx, { name: 'Tienda Nube', domain: 'tiendanube.test' }));
    const contactId = await laura((tx) => createContact(tx, { companyId: id, fullName: 'Pedro Baja', email: 'pedro@tiendanube.test', source: 'inbound' }));

    await laura((tx) => optOutContact(tx, contactId, 'Pidió no recibir más correos.'));
    const [contacto] = await laura((tx) => listContacts(tx, id));
    assert.equal(contacto?.optedOut, true);
    assert.ok(contacto?.optedOutAt, 'queda la fecha');
    assert.equal(contacto?.optedOutReason, 'Pidió no recibir más correos.');

    // El trigger de 0020 impide devolverla, se intente por donde se intente.
    await assert.rejects(
      () => t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query('UPDATE contact SET opted_out = false WHERE id = $1', [contactId])),
      /opted_out|baja/i,
    );
  });

  test('la baja del seed se respeta tal cual llega', async () => {
    const contactos = await laura((tx) => listContacts(tx, COMPANY_GRANOS));
    const mateo = contactos.find((c) => c.id === CONTACT_BAJA);
    assert.ok(mateo, 'Mateo Giraldo está en la ficha');
    assert.equal(mateo.optedOut, true);
    // Y la lista de empresas lo cuenta aparte, para que la pantalla
    // pueda avisar sin recorrer los contactos uno por uno.
    const empresas = await laura((tx) => listCompanies(tx, { search: 'granos' }));
    assert.equal(empresas.find((c) => c.id === COMPANY_GRANOS)?.optedOutCount, 1);
  });
});

// =====================================================================
// VEN-2 · Radar
// =====================================================================

describe('VEN-2 · radar', () => {
  test('la bandeja trae solo mis señales pendientes, de mayor a menor encaje', async () => {
    const bandeja = await laura((tx) => listSignals(tx, {}));
    assert.ok(bandeja.length > 0);
    assert.ok(bandeja.every((s) => s.status === 'pending'));
    assert.ok(!bandeja.some((s) => s.headlineEs === 'Señal ajena'), 'la del vecino no entra, aunque su encaje sea 0,99');

    const scores = bandeja.map((s) => Number(s.fitScore ?? 0));
    const ordenados = [...scores].sort((a, b) => b - a);
    assert.deepEqual(scores, ordenados, 'ordenadas por fit_score descendente');

    const contadas = await laura((tx) => countPendingSignals(tx));
    assert.equal(contadas, bandeja.length);
  });

  test('aceptar una señal abre el negocio con «Enviar pitch» a tres días', async () => {
    const antes = await laura((tx) => getSalesKpis(tx));
    const { dealId, companyId } = await laura((tx) => acceptSignal(tx, SIGNAL_VITALE));

    const pipeline = await laura((tx) => listPipeline(tx));
    const nuevo = pipeline.find((d) => d.id === dealId);
    assert.ok(nuevo, 'el deal aparece en el pipeline');
    assert.equal(nuevo.stageId, 'nuevo');
    assert.equal(nuevo.nextAction, PITCH_ACTION);
    assert.ok(nuevo.nextActionDue, 'con fecha');
    const dias = Math.round((Date.parse(nuevo.nextActionDue) - Date.now()) / 86_400_000);
    assert.ok(Math.abs(dias - PITCH_DUE_DAYS) <= 1, `la fecha cae a ~${PITCH_DUE_DAYS} días (fue ${dias})`);
    assert.equal(nuevo.dueState, 'futuro');

    // La señal queda revisada y sale de la bandeja.
    const bandeja = await laura((tx) => listSignals(tx, {}));
    assert.ok(!bandeja.some((s) => s.id === SIGNAL_VITALE));

    // Historia y actividad, para que la ficha pueda contarlo.
    const { historia, actividad } = await laura(async (tx) => ({
      historia: (await tx.query<{ to_stage_id: string }>(
        'SELECT to_stage_id FROM deal_stage_history WHERE deal_id = $1', [dealId],
      )).rows,
      actividad: (await tx.query<{ kind: string }>(
        'SELECT kind FROM activity WHERE deal_id = $1', [dealId],
      )).rows,
    }));
    assert.deepEqual(historia.map((h) => h.to_stage_id), ['nuevo']);
    assert.deepEqual(actividad.map((a) => a.kind), ['signal_detected']);

    // La empresa ya existía (Vitalé): se reutiliza, no se duplica.
    assert.equal(companyId, '00000002-0000-4000-8000-0000000000e7');

    const despues = await laura((tx) => getSalesKpis(tx));
    assert.equal(despues.pendingSignals, antes.pendingSignals - 1, 'una señal menos por revisar');
    assert.equal(despues.openDeals, antes.openDeals + 1, 'un negocio abierto más');
  });

  test('aceptar dos veces la misma señal no abre dos negocios', async () => {
    await assert.rejects(() => laura((tx) => acceptSignal(tx, SIGNAL_VITALE)), SignalAlreadyReviewed);
  });

  test('descartar con motivo la saca de la bandeja y no vuelve a entrar', async () => {
    const señal = await laura((tx) => listSignals(tx, {}));
    const original = señal.find((s) => s.id === SIGNAL_FRESKO);
    assert.ok(original, 'la de Fresko está pendiente');

    await laura((tx) => discardSignal(tx, SIGNAL_FRESKO, 'No encaja con la audiencia.'));
    const bandeja = await laura((tx) => listSignals(tx, {}));
    assert.ok(!bandeja.some((s) => s.id === SIGNAL_FRESKO), 'sale de la bandeja');

    const descartadas = await laura((tx) => listSignals(tx, { status: 'discarded' }));
    assert.equal(descartadas.find((s) => s.id === SIGNAL_FRESKO)?.discardReason, 'No encaja con la audiencia.');

    // Y el radar, al volver a detectar lo mismo, no la reabre: la clave
    // sigue ocupada. Es lo que impide que reaparezca cada mañana.
    const otraVez = await laura((tx) =>
      createSignal(tx, { companyId: COMPANY_FRESKO, headlineEs: original.headlineEs, sourceId: original.sourceId, domain: 'freskomarket.co' }),
    );
    assert.equal(otraVez.duplicate, false, 'con otra clave sí entra (fuente distinta o referencia distinta)');

    const mismaClave = await laura((tx) =>
      tx.query(
        `INSERT INTO signal (workspace_id, company_id, source_id, headline_es, dedupe_key, status)
         VALUES (current_workspace_id(), $1, $2, $3, $4, 'pending')
         ON CONFLICT (workspace_id, dedupe_key) DO NOTHING
         RETURNING id`,
        [COMPANY_FRESKO, original.sourceId, original.headlineEs, original.dedupeKey],
      ),
    );
    assert.equal(mismaClave.rows.length, 0, 'la clave de la descartada sigue ocupada: no reentra');
  });

  test('descartar exige motivo', async () => {
    const bandeja = await laura((tx) => listSignals(tx, {}));
    const alguna = bandeja[0];
    assert.ok(alguna, 'queda alguna pendiente');
    await assert.rejects(
      () => laura((tx) => discardSignal(tx, alguna.id, '   ')),
      (err: unknown) => err instanceof VentasError && /por qué/.test((err as VentasError).messageEs),
    );
  });

  test('una lista de marcas entra como señales y la segunda pasada no duplica', async () => {
    const filas = [
      { name: 'Arepas del Parque', domain: 'arepasdelparque.co', country: 'CO', industry: 'alimentos', note: 'Abrió sede nueva' },
      { name: 'Jugos Vivo', domain: 'jugosvivo.co', country: 'CO', industry: 'bebidas', note: null },
    ];
    const primera = await laura((tx) => importSignals(tx, filas));
    assert.equal(primera.created, 2);
    assert.equal(primera.duplicated, 0);

    const segunda = await laura((tx) => importSignals(tx, filas));
    assert.equal(segunda.created, 0, 'el mismo archivo dos veces no crea nada nuevo');
    assert.equal(segunda.duplicated, 2);

    const bandeja = await laura((tx) => listSignals(tx, { limit: 200 }));
    const arepas = bandeja.filter((s) => s.headlineEs.includes('Arepas del Parque') || s.headlineEs === 'Abrió sede nueva');
    assert.equal(arepas.length, 1);
    assert.equal(arepas[0]?.via, 'csv', 'la bandeja dice que entró por una lista');

    // Y una señal escrita a mano sobre la MISMA marca no crea otra: el
    // camino cambia, la marca no, y el radar no repite marcas.
    const aMano = await laura((tx) =>
      createSignal(tx, { companyName: 'Arepas del Parque', domain: 'arepasdelparque.co', headlineEs: 'La vi en una feria' }),
    );
    assert.equal(aMano.duplicate, true);
  });

  test('aceptar una señal de una marca que aún no existe crea la empresa y la vincula', async () => {
    const creada = await laura((tx) =>
      createSignal(tx, { companyName: 'Té Sereno', domain: 'tesereno.co', country: 'CO', industry: 'bebidas', headlineEs: 'Pauta nueva en Meta' }),
    );
    const signalId = creada.id;
    if (signalId === null) throw new Error('la señal debería haberse creado');

    // Antes de aceptarla no hay empresa todavía, pero la bandeja dice de
    // qué marca es: el nombre y el dominio que se escribieron.
    const enBandeja = (await laura((tx) => listSignals(tx, { limit: 200 }))).find((s) => s.id === signalId);
    assert.equal(enBandeja?.companyId, null);
    assert.equal(enBandeja?.companyName, 'Té Sereno');
    assert.equal(enBandeja?.companyDomain, 'tesereno.co');

    const { companyId, companyCreated, dealId } = await laura((tx) => acceptSignal(tx, signalId));
    assert.equal(companyCreated, true);

    const empresa = await laura((tx) => getCompany(tx, companyId));
    assert.equal(empresa?.name, 'Té Sereno');
    assert.equal(empresa?.domain, 'tesereno.co');
    assert.equal(empresa?.relationship, 'prospect');

    const pipeline = await laura((tx) => listPipeline(tx));
    assert.ok(pipeline.some((d) => d.id === dealId && d.companyName === 'Té Sereno'));
  });

  test('una señal sin marca no se puede guardar', async () => {
    await assert.rejects(
      () => laura((tx) => createSignal(tx, { headlineEs: 'Algo pasó' })),
      (err: unknown) => err instanceof VentasError && /de qué marca/.test((err as VentasError).messageEs),
    );
  });
});

// =====================================================================
// VEN-3 · Pipeline
// =====================================================================

describe('VEN-3 · pipeline', () => {
  test('las etapas llegan en orden y con su probabilidad', async () => {
    const etapas = await laura((tx) => listStages(tx));
    assert.deepEqual(etapas.map((e) => e.id), ['nuevo', 'contactado', 'conversacion', 'propuesta', 'negociacion', 'ganado', 'perdido']);
    assert.equal(etapas.find((e) => e.id === 'ganado')?.isWon, true);
    assert.equal(etapas.find((e) => e.id === 'perdido')?.isLost, true);
  });

  test('el pipeline solo trae mis negocios y ya viene ponderado', async () => {
    const mios = await laura((tx) => listPipeline(tx));
    assert.ok(mios.length > 0);
    assert.ok(!mios.some((d) => d.name === 'Deal ajeno'), 'el del vecino no se cuela por la vista');

    const conMonto = mios.find((d) => d.amount && Number(d.amount) > 0 && !d.isWon && !d.isLost);
    assert.ok(conMonto, 'hay al menos un negocio abierto con monto');
    const esperado = Number(conMonto.amount) * Number(conMonto.probability);
    assert.ok(
      Math.abs(Number(conMonto.weightedAmount) - esperado) < 0.01,
      'el ponderado lo calcula la vista, no la pantalla',
    );
    assert.ok(conMonto.daysInStage >= 0, 'y trae los días en la etapa');
  });

  test('un negocio sin siguiente acción se puede señalar desde los datos', async () => {
    const kpis = await laura((tx) => getSalesKpis(tx));
    const pipeline = await laura((tx) => listPipeline(tx));
    const sinAccion = pipeline.filter((d) => !d.isWon && !d.isLost && d.nextAction === null);
    assert.equal(kpis.noNextActionCount, sinAccion.length, 'el KPI y las filas dicen lo mismo');
    assert.ok(pipeline.some((d) => d.dueState === 'sin_fecha' || d.dueState === 'vencido'), 'el seed trae casos que marcar');
  });

  test('mover a «Ganado» fija won_at, escribe los días en la etapa y cambia el cierre ponderado', async () => {
    const antes = await laura((tx) => getSalesKpis(tx));
    const antesDeal = await laura(async (tx) => (await listPipeline(tx)).find((d) => d.id === DEAL_OLLA));
    assert.ok(antesDeal);
    assert.equal(antesDeal.stageId, 'nuevo');

    const res = await laura((tx) => moveDeal(tx, DEAL_OLLA, 'ganado'));
    assert.equal(res.isWon, true);
    assert.ok(res.daysInStage !== null, 'se anotan los días que pasó en «Nuevo»');
    assert.ok(Number(res.daysInStage) >= 0);

    const fila = await laura(async (tx) =>
      (await tx.query<{ won_at: string | null; stage_id: string }>(
        'SELECT won_at, stage_id FROM deal WHERE id = $1', [DEAL_OLLA],
      )).rows,
    );
    assert.equal(fila[0]?.stage_id, 'ganado');
    assert.ok(fila[0]?.won_at, 'won_at queda fijado');

    const historia = await laura(async (tx) =>
      (await tx.query<{ from_stage_id: string; to_stage_id: string; days_in_stage: string | null }>(
        `SELECT from_stage_id, to_stage_id, days_in_stage FROM deal_stage_history
         WHERE deal_id = $1 ORDER BY changed_at DESC LIMIT 1`, [DEAL_OLLA],
      )).rows,
    );
    assert.equal(historia[0]?.from_stage_id, 'nuevo');
    assert.equal(historia[0]?.to_stage_id, 'ganado');
    assert.ok(historia[0]?.days_in_stage !== null, 'con los días en la etapa que deja');

    const despues = await laura((tx) => getSalesKpis(tx));
    assert.equal(despues.openDeals, antes.openDeals - 1, 'deja de estar abierto');
    assert.ok(
      Number(despues.weightedAmount) !== Number(antes.weightedAmount),
      'el cierre ponderado cambia al mover entre etapas',
    );
    assert.equal(despues.wonQuarterCount, antes.wonQuarterCount + 1);
    assert.ok(Number(despues.wonQuarter) > Number(antes.wonQuarter));
  });

  test('sacarlo de «Ganado» limpia won_at: el trimestre no puede contar un negocio reabierto', async () => {
    const antes = await laura((tx) => getSalesKpis(tx));
    await laura((tx) => moveDeal(tx, DEAL_OLLA, 'negociacion'));
    const fila = await laura(async (tx) =>
      (await tx.query<{ won_at: string | null }>('SELECT won_at FROM deal WHERE id = $1', [DEAL_OLLA])).rows,
    );
    assert.equal(fila[0]?.won_at, null);
    const despues = await laura((tx) => getSalesKpis(tx));
    assert.equal(despues.wonQuarterCount, antes.wonQuarterCount - 1);
    assert.equal(despues.openDeals, antes.openDeals + 1);
  });

  test('mover a la etapa en la que ya está no escribe historial', async () => {
    const contar = () =>
      laura(async (tx) =>
        (await tx.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM deal_stage_history WHERE deal_id = $1', [DEAL_OLLA],
        )).rows[0]?.n,
      );
    const antes = await contar();
    await laura((tx) => moveDeal(tx, DEAL_OLLA, 'negociacion'));
    assert.equal(await contar(), antes);
  });

  test('cada cambio de etapa deja su actividad, para la línea de tiempo de la ficha', async () => {
    await laura((tx) => moveDeal(tx, DEAL_OLLA, 'propuesta'));
    const act = await laura(async (tx) =>
      (await tx.query<{ kind: string; subject: string }>(
        `SELECT kind, subject FROM activity WHERE deal_id = $1 AND kind = 'stage_change'
         ORDER BY occurred_at DESC LIMIT 1`, [DEAL_OLLA],
      )).rows,
    );
    assert.equal(act[0]?.kind, 'stage_change');
    assert.equal(act[0]?.subject, 'Negociación → Propuesta enviada');
  });

  test('un negocio del vecino no se mueve desde aquí', async () => {
    await assert.rejects(
      () => laura((tx) => moveDeal(tx, '00000009-0000-4000-8000-0000000dea01', 'ganado')),
      (err: unknown) => (err as Error).name === 'DealNotFound',
    );
  });

  test('una etapa inventada se rechaza', async () => {
    await assert.rejects(
      () => laura((tx) => moveDeal(tx, DEAL_OLLA, 'etapa-que-no-existe')),
      (err: unknown) => err instanceof VentasError && /etapa no existe/.test((err as VentasError).messageEs),
    );
  });

  test('los KPI salen en la moneda del workspace y como texto decimal', async () => {
    const kpis = await laura((tx) => getSalesKpis(tx));
    assert.equal(kpis.currency, 'COP');
    assert.equal(typeof kpis.openAmount, 'string');
    assert.equal(typeof kpis.weightedAmount, 'string');
    assert.ok(Number(kpis.weightedAmount) <= Number(kpis.openAmount), 'lo ponderado nunca supera lo abierto');
  });

  test('el vecino ve sus propios KPI, no los de Laura', async () => {
    const suyos = await ajeno((tx) => getSalesKpis(tx));
    assert.equal(suyos.openDeals, 1);
    assert.equal(Number(suyos.openAmount), 99_000_000);
  });
});
