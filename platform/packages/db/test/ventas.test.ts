/**
 * Las consultas de Ventas contra Postgres embebido con las migraciones
 * y el seed aplicados: VEN-1 (empresas y contactos), VEN-2 (radar) y
 * VEN-3 (pipeline).
 *
 * Lo que estas pruebas cuidan, además del «terminado cuando» de cada
 * historia:
 *   - el aislamiento por workspace de TODO lo que se lee y se escribe,
 *     incluida la parte del esquema que no lo hace igual (company y
 *     contact se aíslan por owner_workspace_id, y sus filas SIN dueño
 *     son el catálogo compartido: migraciones 0024, 0025 y 0026);
 *   - que la baja de un contacto no se pueda deshacer;
 *   - que una señal descartada no vuelva a entrar por el mismo camino
 *     por el que entró.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompanyNotEditable,
  CompanyNotFound,
  ContactNotFound,
  ContactNotOwned,
  DuplicateCompanyName,
  DuplicateDomain,
  PITCH_ACTION,
  PENDING_DEAL_NAME,
  PITCH_DUE_BUSINESS_DAYS,
  SignalAlreadyReviewed,
  VentasError,
  acceptSignal,
  buildDedupeKey,
  companyInCrm,
  companyNameInCrm,
  countPendingSignals,
  createCompany,
  createDeal,
  createContact,
  createSignal,
  discardSignal,
  getCompany,
  getSalesKpis,
  importSignals,
  listCompanies,
  listContacts,
  listOwnerOptions,
  listPipeline,
  listSignals,
  listStages,
  moveDeal,
  normalizeDomain,
  promoteCompanyOnWin,
  signalRef,
  optOutContact,
  searchTerm,
  updateCompany,
  updateContact,
} from '../src/queries/ventas.ts';
import { WORKSPACE_DEFAULTS } from '../src/queries/cimientos.ts';
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
const SIGNAL_NUTRIVE = '00000002-0000-4000-8000-00000005e010';
/** Los dos negocios abiertos de Vitalé en el seed («2 Reels…» en propuesta y «Paquete snacks» en contactado). */
const DEAL_VITALE_PROPUESTA = '00000002-0000-4000-8000-0000000dea08';
const COMPANY_VITALE = '00000002-0000-4000-8000-0000000000e7';
const COMPANY_OLLA = '00000002-0000-4000-8000-0000000000e8';
/** El deal de Olla Fácil, en «nuevo». */
const DEAL_OLLA = '00000002-0000-4000-8000-0000000dea01';

/** Un workspace ajeno, para comprobar que nada se cruza. */
const WORKSPACE_AJENO = '00000009-0000-4000-8000-00000000be01';
const COMPANY_AJENA = '00000009-0000-4000-8000-0000000000f1';
const CONTACT_AJENO = '00000009-0000-4000-8000-0000000c00f1';
const CONTACT_AJENO_PUBLICO = '00000009-0000-4000-8000-0000000c00f2';
/** Un contacto de fuente pública SIN dueño: el catálogo compartido que llena el worker. */
const CONTACT_CATALOGO = '00000009-0000-4000-8000-0000000c00f3';
/** Una empresa del catálogo compartido (sin dueño). */
const COMPANY_CATALOGO = '00000009-0000-4000-8000-0000000000f2';

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

    -- Público (public_website) pero guardado por el vecino: es parte de
    -- SU CRM aunque lo haya sacado de una web pública, así que Laura NO
    -- lo ve (0025 §6; hasta ahí la lectura de 0020 dejaba pasar lo
    -- público de cualquiera, y por esa puerta se sacaba qué marcas
    -- prospecta cada agencia).
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source, source_url)
    VALUES ('${CONTACT_AJENO_PUBLICO}', '${COMPANY_AJENA}', '${WORKSPACE_AJENO}', 'Vocera Ajena',
            'prensa@marcaajena.co', 'public_website', 'https://marcaajena.co/prensa')
    ON CONFLICT DO NOTHING;

    -- Público y SIN dueño: el dato de prospección compartido (lo llena
    -- el enriquecimiento del worker). Laura lo ve y no lo edita.
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source, source_url)
    VALUES ('${CONTACT_CATALOGO}', '${COMPANY_AJENA}', NULL, 'Contacto de Catálogo',
            'hola@marcaajena.co', 'public_website', 'https://marcaajena.co/contacto')
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

  test('la referencia de una señal manual es su titular, sin tildes ni signos', () => {
    assert.equal(signalRef('Lanzó café de origen, ¡en Bogotá!'), 'lanzo-cafe-de-origen-en-bogota');
    assert.equal(signalRef('  LANZÓ   café de origen en Bogotá '), 'lanzo-cafe-de-origen-en-bogota', 'el mismo titular escrito distinto');
    assert.equal(signalRef('¡¡!!'), null);
    assert.ok((signalRef('palabra '.repeat(40)) ?? '').length <= 80, 'acotada: la clave no crece con el titular');
    assert.ok(!(signalRef('palabra '.repeat(40)) ?? '').endsWith('-'));
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
      (err: unknown) => err instanceof DuplicateDomain && err.params.name === 'Café Alma',
    );
  });

  test('el mismo nombre sin dominio avisa con la que ya existe; «Crear igual» la crea (pulido r7)', async () => {
    const primera = await laura((tx) => createCompany(tx, { name: 'Zumos Ñandú' }));
    // Escrito distinto (sin tildes, en mayúsculas): la misma marca para el buscador y para el radar.
    await assert.rejects(
      () => laura((tx) => createCompany(tx, { name: '  ZUMOS ÑANDU ' })),
      (err: unknown) => err instanceof DuplicateCompanyName && err.params.companyId === primera && err.params.name === 'Zumos Ñandú',
    );
    // Con dominio nuevo, a la de antes le falta el suyo: tampoco las separa.
    await assert.rejects(() => laura((tx) => createCompany(tx, { name: 'Zumos Ñandú', domain: 'zumosnandu.co' })), DuplicateCompanyName);
    const contar = () =>
      laura(async (tx) =>
        (await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM company_link cl JOIN company co ON co.id = cl.company_id WHERE brand_key(co.name) = brand_key('Zumos Ñandú')`,
        )).rows[0]?.n,
      );
    assert.equal(await contar(), 1, 'nada se creó');

    // Pulido r8: el «Crear igual» es para el nombre por el que se preguntó.
    // Si después del aviso se escribe otro nombre que también está en el
    // CRM, se vuelve a preguntar, ahora con esa otra empresa.
    const otra = await laura((tx) => createCompany(tx, { name: 'Bebidas Río' }));
    await assert.rejects(
      () => laura((tx) => createCompany(tx, { name: 'bebidas rio', allowSameNameAs: 'Zumos Ñandú' })),
      (err: unknown) => err instanceof DuplicateCompanyName && err.params.companyId === otra,
    );

    const segunda = await laura((tx) => createCompany(tx, { name: 'Zumos Ñandú', allowSameNameAs: 'Zumos Ñandú' }));
    assert.notEqual(segunda, primera);
    assert.equal(await contar(), 2, 'la persona dijo «Crear igual»');

    // Dos «Alma» con dominios distintos son dos marcas: no se pregunta.
    await laura((tx) => updateCompany(tx, primera, { domain: 'nandu.co' }));
    await laura((tx) => updateCompany(tx, segunda, { domain: 'nandu.pe' }));
    await laura((tx) => createCompany(tx, { name: 'Zumos Ñandú', domain: 'nandu.mx' }));
    // Y el nombre de una empresa del vecino no cuenta: no se ve.
    await ajeno((tx) => createCompany(tx, { name: 'Refrescos del Vecino' }));
    await laura((tx) => createCompany(tx, { name: 'Refrescos del Vecino' }));
  });

  test('una empresa que no es mía no se puede editar', async () => {
    await assert.rejects(
      () => laura((tx) => updateCompany(tx, COMPANY_AJENA, { name: 'Renombrada por Laura' })),
      CompanyNotFound,
    );
    const intacta = await t.raw<{ name: string }>(`SELECT name FROM company WHERE id = '${COMPANY_AJENA}'`);
    assert.equal(intacta[0]?.name, 'Marca Ajena');
  });

  test('una empresa del catálogo compartido se vincula y se trabaja, pero su ficha no se edita', async () => {
    // Sin dueño: la escribió el worker (enriquecimiento) o una migración.
    await t.admin(`
      INSERT INTO company (id, name, domain) VALUES ('${COMPANY_CATALOGO}', 'Catálogo Compartido', 'catalogo-compartido.co')
      ON CONFLICT DO NOTHING`);
    // Darla de alta con su dominio la VINCULA en vez de duplicarla.
    const id = await laura((tx) => createCompany(tx, { name: 'Catálogo', domain: 'catalogo-compartido.co' }));
    assert.equal(id, COMPANY_CATALOGO);
    // La relación y las notas son de este workspace: eso sí.
    await laura((tx) => updateCompany(tx, id, { relationship: 'client', notes: 'La trabajamos.' }));
    assert.equal((await laura((tx) => getCompany(tx, id)))?.relationship, 'client');
    // Su nombre es de todos. La política filtraría el UPDATE en silencio
    // (cero filas) y la pantalla diría «guardado»: la capa lo dice.
    await assert.rejects(() => laura((tx) => updateCompany(tx, id, { name: 'Renombrada' })), CompanyNotEditable);
    const intacta = await t.raw<{ name: string }>(`SELECT name FROM company WHERE id = '${COMPANY_CATALOGO}'`);
    assert.equal(intacta[0]?.name, 'Catálogo Compartido');
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
      (err: unknown) => err instanceof VentasError && err.code === 'InvalidSource',
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
      (err: unknown) => err instanceof VentasError && err.code === 'EmptyContact',
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
    assert.equal(desdeSuCasa.length, 3, 'en su casa ve el privado, el público que guardó y el del catálogo');
    assert.ok(desdeSuCasa.some((c) => c.id === CONTACT_AJENO));
  });

  test('un contacto público que guardó otro workspace no se ve: es parte de su CRM (0025 §6)', async () => {
    const contactos = await laura((tx) => listContacts(tx, COMPANY_AJENA));
    assert.equal(
      contactos.some((c) => c.id === CONTACT_AJENO_PUBLICO),
      false,
      'que la fuente sea pública no lo hace de todos: por ahí se sabía qué marcas prospecta el vecino',
    );
    // Y como no se ve, tampoco se edita ni se da de baja: para esta
    // transacción no existe, y lo dice igual que con un id inventado.
    await assert.rejects(
      () => laura((tx) => updateContact(tx, CONTACT_AJENO_PUBLICO, { roleTitle: 'Cambiado' })),
      ContactNotFound,
    );
    await assert.rejects(() => laura((tx) => optOutContact(tx, CONTACT_AJENO_PUBLICO, 'x')), ContactNotFound);
  });

  test('un contacto público del catálogo (sin dueño) se ve pero no se edita', async () => {
    const contactos = await laura((tx) => listContacts(tx, COMPANY_AJENA));
    const catalogo = contactos.find((c) => c.id === CONTACT_CATALOGO);
    assert.ok(catalogo, 'lo público sin dueño es el dato de prospección compartido');
    assert.equal(catalogo.isOwn, false, 'y no es de este workspace');
    await assert.rejects(
      () => laura((tx) => updateContact(tx, CONTACT_CATALOGO, { roleTitle: 'Cambiado' })),
      ContactNotOwned,
    );
    // La baja de un contacto que no es mío la registra el worker con
    // asWorker (ver 0020), no una pantalla.
    await assert.rejects(() => laura((tx) => optOutContact(tx, CONTACT_CATALOGO, 'x')), ContactNotOwned);
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

  test('aceptar la señal de una marca con un negocio abierto la suma a ese negocio, sin abrir otro', async () => {
    const antes = await laura((tx) => getSalesKpis(tx));
    const res = await laura((tx) => acceptSignal(tx, SIGNAL_VITALE));

    // Vitalé ya tiene dos negocios abiertos: la señal no abre un tercero.
    assert.equal(res.dealCreated, false);
    assert.equal(res.companyCreated, false);
    assert.equal(res.companyId, COMPANY_VITALE, 'la empresa ya existía (Vitalé): se reutiliza, no se duplica');
    assert.equal(res.companyName, 'Vitalé');
    assert.equal(res.dealId, DEAL_VITALE_PROPUESTA, 'el que va más adelante en el pipeline');

    // La señal queda revisada y sale de la bandeja.
    const bandeja = await laura((tx) => listSignals(tx, {}));
    assert.ok(!bandeja.some((s) => s.id === SIGNAL_VITALE));

    // Y queda en la historia de ESE negocio, para que la ficha la cuente.
    const actividad = await laura(async (tx) =>
      (await tx.query<{ kind: string; metadata: Record<string, unknown> }>(
        "SELECT kind, metadata FROM activity WHERE deal_id = $1 AND kind = 'signal_detected'", [DEAL_VITALE_PROPUESTA],
      )).rows,
    );
    assert.ok(actividad.some((a) => a.metadata.signal_id === SIGNAL_VITALE));

    const despues = await laura((tx) => getSalesKpis(tx));
    assert.equal(despues.pendingSignals, antes.pendingSignals - 1, 'una señal menos por revisar');
    assert.equal(despues.openDeals, antes.openDeals, 'ningún negocio abierto de más');
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
    assert.equal(otraVez.duplicate, true, 'ni con otra clave: la marca está descartada');
    assert.equal(otraVez.reason, 'discarded');

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
      (err: unknown) => err instanceof VentasError && err.code === 'InvalidReason',
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
    assert.deepEqual(primera.createdRows, [0, 1], 'dice QUÉ filas entraron, no solo cuántas');

    const segunda = await laura((tx) => importSignals(tx, filas));
    assert.equal(segunda.created, 0, 'el mismo archivo dos veces no crea nada nuevo');
    assert.equal(segunda.duplicated, 2);
    assert.deepEqual(segunda.createdRows, [], 'ninguna fila entró: la pantalla no puede avisar de una que «entró»');

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
    const nuevo = pipeline.find((d) => d.id === dealId);
    assert.equal(nuevo?.companyName, 'Té Sereno');
    // El negocio se llama como lo que se vio, no como la marca (pulido r4).
    assert.equal(nuevo?.name, 'Pauta nueva en Meta');
    assert.equal(nuevo?.stageId, 'nuevo');
    assert.equal(nuevo?.nextAction, PITCH_ACTION);
    assert.equal(nuevo?.dueState, 'futuro');
  });

  test('el negocio que abre una señal nunca se llama como la marca: su titular, o «Por definir»', async () => {
    // A mano, con titular: el negocio toma el titular.
    const aMano = await laura((tx) => createSignal(tx, { companyName: 'Panadería Aurora', headlineEs: 'Abre 3 tiendas en Bogotá' }));
    assert.ok(aMano.id);
    const conTitular = await laura((tx) => acceptSignal(tx, aMano.id!));
    // De una lista sin nota: el titular lo inventó la pantalla con el nombre.
    await laura((tx) => importSignals(tx, [{ name: 'Lácteos Brisa' }], { headline: (n) => `${n} entró por una lista de marcas` }));
    // Y uno cuyo titular es solo la marca, escrita de otra forma.
    const soloMarca = await laura((tx) => createSignal(tx, { companyName: 'Miel Serrana', headlineEs: 'MIEL SERRANA' }));
    const bandeja = await laura((tx) => listSignals(tx, { limit: 200 }));
    const deLista = bandeja.find((s) => s.companyName === 'Lácteos Brisa');
    assert.ok(deLista && soloMarca.id);
    const sinTitular = await laura((tx) => acceptSignal(tx, deLista.id, { pendingDealName: 'Por definir' }));
    const marca = await laura((tx) => acceptSignal(tx, soloMarca.id!));

    const pipeline = await laura((tx) => listPipeline(tx));
    const nombre = (id: string) => pipeline.find((d) => d.id === id)?.name;
    assert.equal(nombre(conTitular.dealId), 'Abre 3 tiendas en Bogotá');
    assert.equal(nombre(sinTitular.dealId), 'Por definir');
    assert.equal(nombre(marca.dealId), PENDING_DEAL_NAME);
  });

  test('una marca descartada no vuelve a entrar por otra fuente, por una lista ni a mano con solo su nombre', async () => {
    await laura((tx) => discardSignal(tx, SIGNAL_NUTRIVE, 'Ya trabaja con otra creadora.'));

    // Por una lista, con su dominio.
    const lista = await laura((tx) => importSignals(tx, [{ name: 'Nutrivé', domain: 'nutrive.co' }]));
    assert.equal(lista.created, 0);
    assert.equal(lista.duplicated, 1);

    // A mano, solo con el nombre y escrito de otra forma.
    for (const nombre of ['Nutrivé', 'NUTRIVE', ' nutrivé ']) {
      const aMano = await laura((tx) => createSignal(tx, { companyName: nombre, headlineEs: 'La vi en una feria' }));
      assert.equal(aMano.duplicate, true, `«${nombre}» es la misma marca`);
      assert.equal(aMano.reason, 'discarded');
    }

    // Por otra fuente automática, con otra clave.
    const otraFuente = await laura((tx) =>
      createSignal(tx, { domain: 'https://www.nutrive.co/tienda', headlineEs: 'Pauta nueva en Meta', sourceId: 'meta_ad_library' }));
    assert.equal(otraFuente.duplicate, true);

    const bandeja = await laura((tx) => listSignals(tx, { limit: 200 }));
    assert.ok(!bandeja.some((s) => s.companyName === 'Nutrivé'), 'la bandeja no la vuelve a enseñar');
  });

  test('una marca que ya está en la bandeja no entra dos veces, venga por donde venga', async () => {
    const primera = await laura((tx) => createSignal(tx, { companyName: 'Panadería Trigal', headlineEs: 'Abrió sede en Chapinero' }));
    assert.equal(primera.duplicate, false);
    const conDominio = await laura((tx) =>
      importSignals(tx, [{ name: 'Panaderia Trigal', domain: 'trigal.co' }, { name: 'Panadería Trigal' }]));
    assert.equal(conDominio.created, 0, 'ni con dominio ni repetida en el mismo archivo');
    assert.deepEqual(conDominio.createdRows, []);
    const otra = await laura((tx) => createSignal(tx, { companyName: 'Trigal', headlineEs: 'Otra marca, otro nombre' }));
    assert.equal(otra.duplicate, false, 'un nombre distinto es otra marca');
  });

  test('aceptar una señal con solo el nombre reutiliza la empresa del CRM y su negocio abierto', async () => {
    const creada = await laura((tx) => createSignal(tx, { companyName: 'olla facil', headlineEs: 'Nueva colaboración pagada' }));
    assert.ok(creada.id, 'Olla Fácil no tiene señales pendientes ni descartadas');
    const res = await laura((tx) => acceptSignal(tx, creada.id!));
    assert.equal(res.companyId, COMPANY_OLLA, 'la misma Olla Fácil, no una segunda sin dominio');
    assert.equal(res.companyCreated, false);
    assert.equal(res.dealCreated, false);
    assert.equal(res.dealId, DEAL_OLLA);

    const ollas = await laura(async (tx) =>
      (await tx.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM company_link cl JOIN company co ON co.id = cl.company_id WHERE brand_key(co.name) = 'ollafacil'",
      )).rows[0]?.n,
    );
    assert.equal(ollas, '1');
  });

  test('una marca del CRM sin dominio y sin negocios abre su negocio al aceptar, con «Enviar pitch» a las 15:00 locales', async () => {
    const companyId = await laura((tx) => createCompany(tx, { name: 'Mielera Andina' }));
    const creada = await laura((tx) => createSignal(tx, { companyName: 'MIELERA ANDINA', headlineEs: 'Lanzó miel con cacao' }));
    assert.ok(creada.id);
    const res = await laura((tx) => acceptSignal(tx, creada.id!, { nextAction: 'Mandar propuesta' }));
    assert.equal(res.companyId, companyId);
    assert.equal(res.dealCreated, true);

    const fila = await laura(async (tx) =>
      (await tx.query<{ next_action: string; stage_id: string; hora: number; dow: number; habiles: number }>(
        `SELECT next_action, stage_id,
                extract(hour FROM next_action_due AT TIME ZONE 'America/Bogota')::int AS hora,
                extract(isodow FROM next_action_due AT TIME ZONE 'America/Bogota')::int AS dow,
                (SELECT count(*)::int
                   FROM generate_series((now() AT TIME ZONE 'America/Bogota')::date + 1,
                                        (next_action_due AT TIME ZONE 'America/Bogota')::date, interval '1 day') AS dia
                  WHERE extract(isodow FROM dia) < 6) AS habiles
           FROM deal WHERE id = $1`, [res.dealId],
      )).rows[0],
    );
    assert.equal(fila?.stage_id, 'nuevo');
    assert.equal(fila?.next_action, 'Mandar propuesta', 'la frase la pone la pantalla');
    assert.equal(fila?.hora, 15, 'a las 15:00 en Bogotá, no a las 15:00 UTC');
    assert.ok((fila?.dow ?? 7) <= 5, 'vence un día hábil');
    assert.equal(fila?.habiles, PITCH_DUE_BUSINESS_DAYS, 'a tres días HÁBILES, como el seguimiento de una cotización');
  });

  test('«Enviar pitch» cuenta días hábiles: una señal aceptada el miércoles vence el lunes, no el sábado (pulido r7)', async () => {
    // Miércoles 23 de septiembre de 2026, 10:00 en Bogotá. Con días de
    // calendario el pitch caía el sábado 26 a las 15:00 y el lunes el
    // tablero decía «Vencido».
    const miercoles = new Date('2026-09-23T15:00:00Z');
    const hora = (id: string) =>
      laura(async (tx) =>
        (await tx.query<{ local: string }>(
          `SELECT to_char(next_action_due AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS local FROM deal WHERE id = $1`, [id],
        )).rows[0]?.local,
      );

    const senal = await laura((tx) => createSignal(tx, { companyName: 'Lácteos Andinos', headlineEs: 'Lanza yogur griego en Medellín' }));
    assert.ok(senal.id);
    const aceptada = await laura((tx) => acceptSignal(tx, senal.id!, { now: miercoles }));
    assert.equal(aceptada.dealCreated, true);
    assert.equal(await hora(aceptada.dealId), '2026-09-28 15:00', 'desde el radar: el lunes a las 15:00');

    const aMano = await laura((tx) => createDeal(tx, { companyId: aceptada.companyId, name: 'Otra campaña', now: miercoles }));
    assert.equal(await hora(aMano), '2026-09-28 15:00', 'desde la ficha: la misma cuenta');

    // Un viernes cuenta lunes, martes y miércoles.
    const viernes = await laura((tx) =>
      createDeal(tx, { companyId: aceptada.companyId, name: 'La del viernes', now: new Date('2026-09-25T15:00:00Z') }));
    assert.equal(await hora(viernes), '2026-09-30 15:00');
  });

  test('una marca aceptada admite una señal nueva; la MISMA señal repetida avisa que ya es un negocio', async () => {
    // El caso del hallazgo: se acepta «Café Altura Andina» y se vuelve a
    // anotar. Antes la clave era solo fuente:marca y el UNIQUE la frenaba
    // para siempre, con un aviso que hablaba de un descarte que no hubo.
    const marca = { companyName: 'Café Altura Andina', domain: 'cafealturaandina.co' };
    const primera = await laura((tx) => createSignal(tx, { ...marca, headlineEs: 'Lanzó café de origen en Meta' }));
    assert.ok(primera.id);
    const aceptada = await laura((tx) => acceptSignal(tx, primera.id!));

    // La misma señal otra vez (el mismo titular, escrito distinto): no entra,
    // y el motivo dice que ya es un negocio, con la empresa para enlazarla.
    const repetida = await laura((tx) => createSignal(tx, { ...marca, headlineEs: '  LANZÓ café de origen en Meta ' }));
    assert.equal(repetida.duplicate, true);
    assert.equal(repetida.reason, 'accepted');
    assert.equal(repetida.companyId, aceptada.companyId);

    // Lo mismo si vuelve por una lista con ese titular.
    const porLista = await laura((tx) =>
      importSignals(tx, [{ ...{ name: marca.companyName, domain: marca.domain }, note: 'Lanzó café de origen en Meta' }]));
    assert.equal(porLista.created, 0);

    // Una señal NUEVA de la misma marca (otra campaña, otra temporada) sí
    // entra: es información, como dice la regla del radar.
    const nueva = await laura((tx) => createSignal(tx, { ...marca, headlineEs: 'Abre tienda en Medellín' }));
    assert.equal(nueva.duplicate, false);
    assert.equal(nueva.reason, null);
    const bandeja = await laura((tx) => listSignals(tx, { limit: 200 }));
    const enBandeja = bandeja.find((s) => s.id === nueva.id);
    assert.equal(enBandeja?.companyId, aceptada.companyId, 'enlazada a la empresa que ya está en el CRM');
    assert.equal(enBandeja?.companyLinked, true);
    // Pulido r8: la tarjeta dice a qué negocio se sumará antes de aceptarla.
    assert.equal(enBandeja?.openDealId, aceptada.dealId, 'se sumará al negocio abierto, no abrirá otro');
    assert.equal(enBandeja?.openDealName, 'Lanzó café de origen en Meta');

    // Y con esa en la bandeja, la marca ya no entra otra vez por ningún camino.
    const otraMas = await laura((tx) => createSignal(tx, { ...marca, headlineEs: 'Otra cosa más' }));
    assert.equal(otraMas.reason, 'pending');
  });

  test('la bandeja dice si la marca ya está en el CRM aunque se anotara después de la señal (pulido r8)', async () => {
    // La señal entra sin empresa (la marca aún no estaba en el CRM)…
    const senal = await laura((tx) => createSignal(tx, { companyName: 'Tostadores del Páramo', headlineEs: 'Abrió tienda en línea' }));
    assert.ok(senal.id);
    const antes = (await laura((tx) => listSignals(tx, { limit: 200 }))).find((s) => s.id === senal.id);
    assert.equal(antes?.companyLinked, false);
    assert.equal(antes?.companyId, null, 'aceptarla crearía la empresa');
    assert.equal(antes?.openDealId, null);

    // …y luego alguien la crea a mano, escrita distinto. Aceptar la
    // reutilizaría (resolveCompany por nombre): la tarjeta ya lo dice.
    const empresa = await laura((tx) => createCompany(tx, { name: 'TOSTADORES DEL PARAMO' }));
    const despues = (await laura((tx) => listSignals(tx, { limit: 200 }))).find((s) => s.id === senal.id);
    assert.equal(despues?.companyLinked, true);
    assert.equal(despues?.companyId, empresa);
    assert.equal(despues?.openDealId, null, 'sin negocio abierto: aceptarla abre uno');

    const deal = await laura((tx) => createDeal(tx, { companyId: empresa, name: 'Temporada de regalos' }));
    const conNegocio = (await laura((tx) => listSignals(tx, { limit: 200 }))).find((s) => s.id === senal.id);
    assert.equal(conNegocio?.openDealId, deal);
    assert.equal(conNegocio?.openDealName, 'Temporada de regalos');

    const aceptada = await laura((tx) => acceptSignal(tx, senal.id!));
    assert.equal(aceptada.companyId, empresa, 'lo que dijo la tarjeta es lo que pasó');
    assert.equal(aceptada.dealId, deal);
    assert.equal(aceptada.dealCreated, false);
  });

  test('una señal sin marca no se puede guardar', async () => {
    await assert.rejects(
      () => laura((tx) => createSignal(tx, { headlineEs: 'Algo pasó' })),
      (err: unknown) => err instanceof VentasError && err.code === 'InvalidCompany',
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

    // Olla Fácil era «Prospecto»: ganarla la hace cliente, en la misma
    // transacción. Antes quedaba «Prospecto» y «Sin negocios abiertos».
    assert.equal(res.companyPromoted, true);
    const empresa = await laura((tx) => getCompany(tx, COMPANY_OLLA));
    assert.equal(empresa?.relationship, 'client');
  });

  test('ganar sube la relación a «Cliente» sin bajar nunca otra', async () => {
    const casos: { relationship: 'prospect' | 'contacted' | 'client' | 'past_client' | 'blocked'; queda: string; sube: boolean }[] = [
      { relationship: 'contacted', queda: 'client', sube: true },
      { relationship: 'past_client', queda: 'client', sube: true },
      { relationship: 'client', queda: 'client', sube: false },
      { relationship: 'blocked', queda: 'blocked', sube: false },
    ];
    for (const [i, caso] of casos.entries()) {
      const companyId = await laura((tx) => createCompany(tx, { name: `Marca Relación ${i}`, relationship: caso.relationship }));
      const dealId = await laura((tx) => createDeal(tx, { companyId, name: 'Un trabajo', amount: '1000000' }));
      const abierto = await laura((tx) => moveDeal(tx, dealId, 'propuesta'));
      assert.equal(abierto.companyPromoted, false, 'un negocio abierto no toca la relación');
      const ganado = await laura((tx) => moveDeal(tx, dealId, 'ganado'));
      assert.equal(ganado.companyPromoted, caso.sube, caso.relationship);
      assert.equal((await laura((tx) => getCompany(tx, companyId)))?.relationship, caso.queda, caso.relationship);
      // Reabrirlo no la devuelve a donde estaba: la relación no baja sola.
      await laura((tx) => moveDeal(tx, dealId, 'negociacion'));
      assert.equal((await laura((tx) => getCompany(tx, companyId)))?.relationship, caso.queda);
    }
    // Llamarla sobre un negocio abierto, o sobre uno que no existe, no hace nada.
    const abierta = await laura((tx) => createCompany(tx, { name: 'Marca Sin Ganar', relationship: 'prospect' }));
    const dealAbierto = await laura((tx) => createDeal(tx, { companyId: abierta, name: 'Por ganar' }));
    assert.equal(await laura((tx) => promoteCompanyOnWin(tx, dealAbierto)), false);
    assert.equal(await laura((tx) => promoteCompanyOnWin(tx, 'no-es-uuid')), false);
    assert.equal((await laura((tx) => getCompany(tx, abierta)))?.relationship, 'prospect');
  });

  test('ganar un negocio sin monto pide el monto: sin él no se mueve, con él cuadran el conteo y la suma (pulido r7)', async () => {
    const companyId = await laura((tx) => createCompany(tx, { name: 'Marca Sin Monto' }));
    const dealId = await laura((tx) => createDeal(tx, { companyId, name: 'Recién aceptado' }));
    const antes = await laura((tx) => getSalesKpis(tx));

    await assert.rejects(
      () => laura((tx) => moveDeal(tx, dealId, 'ganado')),
      (err: unknown) => err instanceof VentasError && err.code === 'AmountRequired',
    );
    const sigue = await laura(async (tx) =>
      (await tx.query<{ stage_id: string; won_at: string | null; historia: number }>(
        `SELECT d.stage_id, d.won_at, (SELECT count(*)::int FROM deal_stage_history WHERE deal_id = d.id) AS historia
           FROM deal d WHERE d.id = $1`, [dealId],
      )).rows[0],
    );
    assert.deepEqual(sigue, { stage_id: 'nuevo', won_at: null, historia: 1 }, 'nada quedó escrito');
    assert.equal((await laura((tx) => getCompany(tx, companyId)))?.relationship, 'prospect', 'ni la relación subió');

    const ganado = await laura((tx) => moveDeal(tx, dealId, 'ganado', { amount: '3200000' }));
    assert.equal(ganado.isWon, true);
    assert.equal(ganado.amountTo, '3200000.00');
    const despues = await laura((tx) => getSalesKpis(tx));
    assert.equal(despues.wonQuarterCount, antes.wonQuarterCount + 1);
    assert.equal(Number(despues.wonQuarter) - Number(antes.wonQuarter), 3200000, 'la suma sube con el conteo');
    assert.equal(despues.wonQuarterNoAmountCount, antes.wonQuarterNoAmountCount);

    // Un ganado sin monto de antes de la regla (escrito por fuera de
    // moveDeal) se cuenta aparte: la pantalla dice «N cerrados, M sin monto».
    const viejo = await laura((tx) => createDeal(tx, { companyId, name: 'Ganado sin monto, de antes' }));
    await t.admin(`UPDATE deal SET stage_id = 'ganado', won_at = now() WHERE id = '${viejo}'`);
    const conViejo = await laura((tx) => getSalesKpis(tx));
    assert.equal(conViejo.wonQuarterNoAmountCount, despues.wonQuarterNoAmountCount + 1);
    assert.equal(conViejo.wonQuarterCount, despues.wonQuarterCount + 1);
    assert.equal(conViejo.wonQuarter, despues.wonQuarter);
    // Se deja fuera del trimestre para las pruebas de KPI que siguen.
    await t.admin(`UPDATE deal SET stage_id = 'perdido', won_at = NULL, lost_at = now(), lost_reason = 'otro' WHERE id = '${viejo}'`);
    await laura((tx) => moveDeal(tx, dealId, 'negociacion'));
  });

  test('un negocio ganado del vecino no sube la relación de Laura con la misma marca', async () => {
    // El vecino gana su negocio con Marca Ajena; Laura no la tiene en su CRM
    // y, aunque la tuviera, la relación es de cada workspace.
    await ajeno((tx) => moveDeal(tx, '00000009-0000-4000-8000-0000000dea01', 'ganado'));
    const suya = await ajeno((tx) => getCompany(tx, COMPANY_AJENA));
    assert.equal(suya?.relationship, 'client');
    assert.equal(await laura((tx) => promoteCompanyOnWin(tx, '00000009-0000-4000-8000-0000000dea01')), false);
    // Se deja como estaba: las pruebas de KPI del vecino lo cuentan abierto.
    await ajeno((tx) => moveDeal(tx, '00000009-0000-4000-8000-0000000dea01', 'propuesta'));
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
      (err: unknown) => err instanceof VentasError && err.code === 'InvalidStage',
    );
  });

  test('una etapa privada del workspace (id uuid al azar, 0026 §2) se puede usar; la del vecino no', async () => {
    await t.admin(`
      INSERT INTO pipeline_stage (workspace_id, label_es, position, default_probability)
      VALUES ('${WORKSPACE_LAURA}', 'Piloto pagado', 45, 0.6);
    `);
    const privada = (await laura((tx) => listStages(tx))).find((e) => e.labelEs === 'Piloto pagado');
    assert.ok(privada, 'el tablero la recibe con las demás');
    assert.match(privada.id, /^[0-9a-f-]{36}$/);

    const res = await laura((tx) => moveDeal(tx, DEAL_OLLA, privada.id));
    assert.equal(res.moved, true);
    assert.equal(res.toStageId, privada.id);

    await assert.rejects(
      () => ajeno((tx) => moveDeal(tx, '00000009-0000-4000-8000-0000000dea01', privada.id)),
      (err: unknown) => err instanceof VentasError && err.code === 'InvalidStage',
      'la etapa de Laura no existe para el vecino',
    );
    await laura((tx) => moveDeal(tx, DEAL_OLLA, 'propuesta'));
  });

  test('abrir un negocio a mano desde la ficha de una empresa de mi CRM', async () => {
    const id = await laura((tx) => createDeal(tx, { companyId: COMPANY_GRANOS, name: 'Receta de temporada', amount: '2500000' }));
    const fila = (await laura((tx) => listPipeline(tx))).find((d) => d.id === id);
    assert.equal(fila?.stageId, 'nuevo');
    assert.equal(fila?.amount, '2500000.00');
    assert.equal(fila?.currency, 'COP');
    assert.equal(fila?.nextAction, PITCH_ACTION);

    await assert.rejects(() => laura((tx) => createDeal(tx, { companyId: COMPANY_AJENA, name: 'x' })), CompanyNotFound);
    await assert.rejects(
      () => laura((tx) => createDeal(tx, { companyId: COMPANY_GRANOS, name: '   ' })),
      (err: unknown) => err instanceof VentasError && err.code === 'InvalidDealName',
    );
  });

  test('«Ganado este trimestre» corta el trimestre en la zona del workspace, no en UTC', async () => {
    // Dos negocios ganados alrededor del inicio del trimestre EN BOGOTÁ
    // (UTC−5): uno dos horas antes —aún es el trimestre pasado aunque en
    // UTC ya sea el nuevo— y otro dos horas después.
    const antes = await laura((tx) => getSalesKpis(tx));
    await t.admin(`
      WITH q AS (SELECT date_trunc('quarter', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota' AS inicio)
      INSERT INTO deal (workspace_id, company_id, name, stage_id, amount, currency, won_at)
      SELECT '${WORKSPACE_LAURA}', '${COMPANY_GRANOS}', v.nombre, 'ganado', v.monto, 'COP', q.inicio + v.desfase
        FROM q, (VALUES ('Antes del trimestre', 1000000.00, interval '-2 hours'),
                        ('Dentro del trimestre', 2000000.00, interval '2 hours')) AS v(nombre, monto, desfase);
    `);
    const despues = await laura((tx) => getSalesKpis(tx));
    assert.equal(despues.wonQuarterCount, antes.wonQuarterCount + 1);
    assert.equal(Number(despues.wonQuarter) - Number(antes.wonQuarter), 2_000_000);
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

// =====================================================================
// Pulido r5
// =====================================================================

/** Laura Méndez, la persona del seed (dueña del workspace). */
const USER_LAURA = '00000002-0000-4000-8000-000000000002';
/** Alguien del workspace vecino: no puede ser responsable de nada de Laura. */
const USER_AJENO = '00000009-0000-4000-8000-0000000a0001';
const conLaura = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn, { userId: USER_LAURA });

describe('VEN-1 · editar la ficha, el responsable y la búsqueda (pulido r5)', () => {
  test('la búsqueda no distingue tildes, eñes ni espacios', async () => {
    const nandu = await laura((tx) => createCompany(tx, { name: 'Zeta Bebidas Ñandú' }));
    const gritada = await laura((tx) => createCompany(tx, { name: 'CAFÉ ÉPICO' }));

    const alma = await laura((tx) => listCompanies(tx, { search: 'cafe alma' }));
    assert.ok(alma.some((c) => c.id === COMPANY_CAFE_ALMA), '«cafe alma» encuentra «Café Alma»');
    const n = await laura((tx) => listCompanies(tx, { search: 'nandu' }));
    assert.ok(n.some((c) => c.id === nandu), '«nandu» encuentra la marca con Ñ');
    const e = await laura((tx) => listCompanies(tx, { search: 'cafe epico' }));
    assert.ok(e.some((c) => c.id === gritada), 'y las mayúsculas con tilde también');
    // Lo que no se parece sigue fuera.
    assert.ok(!n.some((c) => c.id === COMPANY_CAFE_ALMA));
  });

  test('una empresa con un negocio abierto sin monto suma NULL («Sin monto»), no 0', async () => {
    const id = await laura((tx) => createCompany(tx, { name: 'Kombu Prueba', domain: 'kombuprueba.co' }));
    await laura((tx) => createDeal(tx, { companyId: id, name: 'Sin presupuesto todavía', nextAction: 'Enviar pitch' }));
    const sinMonto = (await laura((tx) => listCompanies(tx, { search: 'kombu prueba' }))).find((c) => c.id === id);
    assert.equal(sinMonto?.openDealCount, 1);
    assert.equal(sinMonto?.openDealAmount, null, 'nada que sumar no es cero');
    assert.equal((await laura((tx) => getCompany(tx, id)))?.openDealAmount, null);

    await laura((tx) => createDeal(tx, { companyId: id, name: 'Con monto', amount: '1500000', nextAction: 'Enviar pitch' }));
    const conMonto = await laura((tx) => getCompany(tx, id));
    assert.equal(conMonto?.openDealCount, 2);
    assert.equal(Number(conMonto?.openDealAmount), 1_500_000, 'suma lo que tiene monto');
  });

  test('quien crea la empresa queda de responsable; sin sesión, ninguno', async () => {
    const conSesion = await conLaura((tx) => createCompany(tx, { name: 'Responsable Uno', domain: 'responsable-uno.co' }));
    const fila = await laura((tx) => getCompany(tx, conSesion));
    assert.equal(fila?.ownerUserId, USER_LAURA);
    assert.equal(fila?.ownerName, 'Laura Méndez');

    const sinSesion = await laura((tx) => createCompany(tx, { name: 'Responsable Dos', domain: 'responsable-dos.co' }));
    assert.equal((await laura((tx) => getCompany(tx, sinSesion)))?.ownerUserId, null);
  });

  test('el responsable es alguien del espacio: se asigna, se quita, y uno de fuera no vale', async () => {
    await t.admin(`
      INSERT INTO app_user (id, email, name) VALUES ('${USER_AJENO}', 'vecina@marcaajena.co', 'Vecina')
      ON CONFLICT DO NOTHING;
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WORKSPACE_AJENO}', '${USER_AJENO}', system_role_id('creator', 'owner'))
      ON CONFLICT DO NOTHING;`);
    const opciones = await laura((tx) => listOwnerOptions(tx));
    assert.deepEqual(opciones, [{ userId: USER_LAURA, label: 'Laura Méndez' }], 'solo las personas de este espacio');

    const id = await laura((tx) => createCompany(tx, { name: 'Con Responsable', domain: 'con-responsable.co' }));
    await laura((tx) => updateCompany(tx, id, { ownerUserId: USER_LAURA }));
    assert.equal((await laura((tx) => getCompany(tx, id)))?.ownerName, 'Laura Méndez');

    await assert.rejects(
      () => laura((tx) => updateCompany(tx, id, { ownerUserId: USER_AJENO })),
      (err: unknown) => err instanceof VentasError && err.code === 'InvalidOwner',
    );
    await assert.rejects(
      () => laura((tx) => createCompany(tx, { name: 'Otra', domain: 'otra-responsable.co', ownerUserId: USER_AJENO })),
      (err: unknown) => err instanceof VentasError && err.code === 'InvalidOwner',
    );

    await laura((tx) => updateCompany(tx, id, { ownerUserId: null }));
    assert.equal((await laura((tx) => getCompany(tx, id)))?.ownerUserId, null);
  });

  test('una empresa propia se corrige entera, y el país se puede vaciar', async () => {
    const id = await laura((tx) =>
      createCompany(tx, { name: 'Nutrivé Errata', domain: 'nutrive-errata.co', country: 'MX', city: 'CDMX', industry: 'snaks' }),
    );
    const creada = await laura((tx) => getCompany(tx, id));
    assert.equal(creada?.isOwn, true, 'la creó este espacio: es suya');

    await laura((tx) =>
      updateCompany(tx, id, { name: 'Nutrivé', domain: 'nutrive-bien.co', country: null, city: null, industry: 'snacks', notes: 'Corregida.' }),
    );
    const corregida = await laura((tx) => getCompany(tx, id));
    assert.equal(corregida?.name, 'Nutrivé');
    assert.equal(corregida?.domain, 'nutrive-bien.co');
    assert.equal(corregida?.country, null, 'vaciar el país lo borra, no lo deja como estaba');
    assert.equal(corregida?.city, null);
    assert.equal(corregida?.industry, 'snacks');
    assert.equal(corregida?.notes, 'Corregida.');
  });

  test('una empresa del catálogo compartido no es propia: solo sus notas', async () => {
    const CATALOGO_R5 = '00000009-0000-4000-8000-0000000000f5';
    await t.admin(`
      INSERT INTO company (id, name, domain) VALUES ('${CATALOGO_R5}', 'Catálogo R5', 'catalogo-r5.co')
      ON CONFLICT DO NOTHING`);
    const id = await laura((tx) => createCompany(tx, { name: 'Catálogo R5', domain: 'catalogo-r5.co' }));
    assert.equal(id, CATALOGO_R5, 'se vincula la del catálogo');
    assert.equal((await laura((tx) => getCompany(tx, id)))?.isOwn, false);
    // Las del seed las adjudicó 0026 al único espacio que las nombra.
    assert.equal((await laura((tx) => getCompany(tx, COMPANY_CAFE_ALMA)))?.isOwn, true);
  });

  test('la ficha pregunta primero si la empresa está en el CRM', async () => {
    assert.equal(await laura((tx) => companyInCrm(tx, COMPANY_CAFE_ALMA)), true);
    assert.equal(await laura((tx) => companyInCrm(tx, COMPANY_AJENA)), false, 'la del vecino no');
    assert.equal(await laura((tx) => companyInCrm(tx, 'no-soy-un-uuid')), false);
    // Pulido r8: el mismo corte con el nombre, para el título de la pestaña.
    assert.equal(await laura((tx) => companyNameInCrm(tx, COMPANY_CAFE_ALMA)), 'Café Alma');
    assert.equal(await laura((tx) => companyNameInCrm(tx, COMPANY_AJENA)), null, 'la del vecino no');
    assert.equal(await laura((tx) => companyNameInCrm(tx, 'no-soy-un-uuid')), null);
  });

  test('un contacto propio se corrige y conserva su procedencia', async () => {
    const id = await laura((tx) =>
      createContact(tx, { companyId: COMPANY_GRANOS, source: 'user_provided', fullName: 'Andres Mal Escrito', email: 'andres@granos.cm' }),
    );
    await laura((tx) => updateContact(tx, id, { fullName: 'Andrés Ruiz', email: 'andres@granos.co' }));
    const fila = (await laura((tx) => listContacts(tx, COMPANY_GRANOS))).find((c) => c.id === id);
    assert.equal(fila?.fullName, 'Andrés Ruiz');
    assert.equal(fila?.email, 'andres@granos.co');
    assert.equal(fila?.source, 'user_provided');
  });
});

describe('VEN-3 · perder un negocio pide su motivo (pulido r5)', () => {
  test('sin motivo no se mueve a «Perdido»; con motivo queda escrito y lo lee el pipeline', async () => {
    const id = await laura((tx) => createDeal(tx, { companyId: COMPANY_GRANOS, name: 'Para perder', nextAction: 'Enviar pitch' }));

    await assert.rejects(
      () => laura((tx) => moveDeal(tx, id, 'perdido')),
      (err: unknown) => err instanceof VentasError && err.code === 'LostReasonRequired',
    );
    const intacto = await laura(async (tx) => (await tx.query<{ stage_id: string }>('SELECT stage_id FROM deal WHERE id = $1', [id])).rows[0]);
    assert.equal(intacto?.stage_id, 'nuevo', 'sin motivo, el paso se deshace entero');

    await assert.rejects(
      // @ts-expect-error: un motivo que no está en el CHECK
      () => laura((tx) => moveDeal(tx, id, 'perdido', { lostReason: 'me cayó mal' })),
      (err: unknown) => err instanceof VentasError && err.code === 'InvalidReason',
    );

    const res = await laura((tx) => moveDeal(tx, id, 'perdido', { lostReason: 'precio' }));
    assert.equal(res.isLost, true);
    const fila = (await laura((tx) => listPipeline(tx))).find((d) => d.id === id);
    assert.equal(fila?.lostReason, 'precio');
    const actividad = await laura(async (tx) =>
      (await tx.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM activity WHERE deal_id = $1 AND kind = 'stage_change' ORDER BY occurred_at DESC LIMIT 1`, [id],
      )).rows[0]);
    assert.equal(actividad?.metadata.lost_reason, 'precio', 'la actividad del cambio también lo cuenta');

    // Reabrirlo borra el motivo (0031): ya no está perdido.
    await laura((tx) => moveDeal(tx, id, 'contactado'));
    assert.equal((await laura((tx) => listPipeline(tx))).find((d) => d.id === id)?.lostReason, null);
  });
});

describe('VEN-2 · la siguiente acción del producto se reconoce por su marcador (pulido r5)', () => {
  test('el negocio nace con el marcador de pitch, y reescribirla a mano lo quita', async () => {
    const id = await laura((tx) => createDeal(tx, { companyId: COMPANY_GRANOS, name: 'Con marcador', nextAction: 'Send pitch' }));
    const kind = async () =>
      (await laura(async (tx) => (await tx.query<{ k: string | null }>('SELECT next_action_kind AS k FROM deal WHERE id = $1', [id])).rows[0]))?.k;
    assert.equal(await kind(), 'pitch', 'la frase está en inglés, el marcador no tiene idioma');

    // Cambiar otra columna no toca el marcador.
    await laura((tx) => tx.query(`UPDATE deal SET amount = 1000 WHERE id = $1`, [id]));
    assert.equal(await kind(), 'pitch');

    await laura((tx) => tx.query(`UPDATE deal SET next_action = 'Llamar a Sofía' WHERE id = $1`, [id]));
    assert.equal(await kind(), null, 'una frase escrita a mano no es el pitch');
  });

  test('los respaldos de moneda y locale salen de un solo sitio', () => {
    assert.deepEqual({ ...WORKSPACE_DEFAULTS }, { currency: 'COP', locale: 'es-CO', timeZone: 'UTC', country: 'CO' });
  });
});
