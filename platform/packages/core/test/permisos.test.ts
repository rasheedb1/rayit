import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCIONES, MODULOS, PERMISOS, PERMISO_MINIMO, ROLES_SISTEMA, TODOS_LOS_PERMISOS, WORKSPACE_KINDS,
  assertNoEsUltimoDueno, can, esUltimoDueno, isPermiso, moduloDe, permisoDef, permisosDeRol, permisosDelModulo,
  permisosOtorgables, puedeAsignarRol, rolSistema,
  PermisoDesconocidoError, RolDesconocidoError, SinPermisoError, UltimoDuenoError,
  type Permiso,
} from '../src/permisos.ts';

// ------------------------------------------------------------- catálogo

test('cada clave tiene la forma <módulo>.<recurso>.<acción> con módulo y acción del vocabulario cerrado', () => {
  for (const p of PERMISOS) {
    const partes = p.key.split('.');
    assert.equal(partes.length, 3, p.key);
    const [modulo, recurso, accion] = partes;
    assert.ok((MODULOS as readonly string[]).includes(modulo!), `${p.key}: módulo`);
    assert.ok((ACCIONES as readonly string[]).includes(accion!), `${p.key}: acción`);
    assert.match(recurso!, /^[a-z]+$/, `${p.key}: recurso en minúsculas y sin acentos`);
    assert.equal(p.module, modulo, `${p.key}: module coincide con la clave`);
  }
});

test('las claves son únicas y hay 43', () => {
  assert.equal(new Set(TODOS_LOS_PERMISOS).size, PERMISOS.length);
  assert.equal(PERMISOS.length, 43);
});

test('cada etiqueta empieza en infinitivo y en mayúscula; cada sensibilidad es normal o sensible', () => {
  for (const p of PERMISOS) {
    assert.match(p.labelEs, /^[A-ZÁÉÍÓÚ][^.]+[^.]$/, p.key);
    assert.match(p.labelEs.split(/[ ,]/)[0]!, /(ar|er|ir)$/, `${p.key}: «${p.labelEs}» no empieza en infinitivo`);
    assert.ok(p.sensitivity === 'normal' || p.sensitivity === 'sensible', p.key);
  }
});

test('todo lo de Finanzas y Equipo es sensible; conectar y desconectar también; ver el estado de una cuenta, no', () => {
  for (const p of PERMISOS) {
    if (p.module === 'finanzas' || p.module === 'equipo') assert.equal(p.sensitivity, 'sensible', p.key);
  }
  assert.equal(permisoDef('conexiones.cuenta.conectar').sensitivity, 'sensible');
  assert.equal(permisoDef('conexiones.cuenta.desconectar').sensitivity, 'sensible');
  assert.equal(permisoDef('conexiones.cuenta.ver').sensitivity, 'normal');
});

test('no existe un permiso para ver el token de una cuenta conectada (decisión E)', () => {
  assert.deepEqual(permisosDelModulo('conexiones'), [
    'conexiones.cuenta.ver',
    'conexiones.cuenta.conectar',
    'conexiones.cuenta.desconectar',
  ]);
});

test('isPermiso, permisoDef y moduloDe', () => {
  assert.equal(isPermiso('finanzas.factura.crear'), true);
  assert.equal(isPermiso('finanzas.factura.borrar'), false);
  assert.equal(isPermiso(''), false);
  assert.equal(moduloDe('campanas.reporte.enviar'), 'campanas');
  assert.throws(
    () => permisoDef('nada.nada.ver' as Permiso),
    (e: unknown) => e instanceof PermisoDesconocidoError && /«nada.nada.ver»/.test(e.messageEs),
  );
});

test('cada módulo tiene un permiso mínimo, que es un .ver del propio módulo', () => {
  for (const m of MODULOS) {
    const min = PERMISO_MINIMO[m];
    assert.ok(isPermiso(min), m);
    assert.equal(moduloDe(min), m);
    assert.ok(min.endsWith('.ver'), min);
  }
});

// ------------------------------------------------------------- roles

test('hay cinco roles de creador y cinco de agencia, con claves únicas por tipo de workspace', () => {
  for (const kind of WORKSPACE_KINDS) {
    const roles = ROLES_SISTEMA.filter((r) => r.workspaceKind === kind);
    assert.equal(roles.length, 5, kind);
    assert.equal(new Set(roles.map((r) => r.key)).size, 5, kind);
  }
  assert.deepEqual(
    ROLES_SISTEMA.map((r) => `${r.workspaceKind}:${r.key}`),
    [
      'creator:owner', 'creator:manager', 'creator:editor', 'creator:finance', 'creator:viewer',
      'agency:owner', 'agency:admin', 'agency:manager', 'agency:finance', 'agency:viewer',
    ],
  );
});

test('cada rol solo lista permisos del catálogo, sin repetidos, y tiene etiqueta y descripción', () => {
  for (const r of ROLES_SISTEMA) {
    assert.ok(r.labelEs.length > 0 && r.descriptionEs.length > 0, r.key);
    assert.equal(new Set(r.permisos).size, r.permisos.length, `${r.workspaceKind}:${r.key} repite permisos`);
    for (const p of r.permisos) assert.ok(isPermiso(p), `${r.key}: ${p}`);
  }
});

test('el Dueño tiene todo, en los dos tipos de workspace', () => {
  for (const kind of WORKSPACE_KINDS) {
    const dueno = permisosDeRol(kind, 'owner');
    for (const p of TODOS_LOS_PERMISOS) assert.equal(can(dueno, p), true, `${kind} owner: ${p}`);
    assert.equal(dueno.size, PERMISOS.length);
  }
});

test('el Mánager de creador NO trae finanzas.flujo.ver, finanzas.gasto.ver ni conexiones.cuenta.conectar (decisión 9)', () => {
  const manager = permisosDeRol('creator', 'manager');
  assert.equal(can(manager, 'finanzas.flujo.ver'), false);
  assert.equal(can(manager, 'finanzas.gasto.ver'), false);
  assert.equal(can(manager, 'finanzas.gasto.registrar'), false);
  assert.equal(can(manager, 'finanzas.ajustes.configurar'), false);
  assert.equal(can(manager, 'finanzas.factura.ver'), false);
  assert.equal(can(manager, 'conexiones.cuenta.conectar'), false);
  assert.equal(can(manager, 'conexiones.cuenta.desconectar'), false);
  assert.equal(can(manager, 'equipo.miembro.invitar'), false);
  assert.equal(can(manager, 'equipo.rol.editar'), false);
});

test('el Mánager de creador SÍ trae campanas.reporte.enviar, todo Ventas y Cotizar, el cobro y ver el resto', () => {
  const manager = permisosDeRol('creator', 'manager');
  assert.equal(can(manager, 'campanas.reporte.enviar'), true);
  assert.equal(can(manager, 'campanas.campana.crear'), true);
  assert.equal(can(manager, 'finanzas.cobro.ver'), true);
  for (const p of [...permisosDelModulo('ventas'), ...permisosDelModulo('cotizar'), ...permisosDelModulo('campanas')]) {
    assert.equal(can(manager, p), true, p);
  }
  assert.equal(can(manager, 'resumen.panel.ver'), true);
  assert.equal(can(manager, 'conexiones.cuenta.ver'), true);
  assert.equal(can(manager, 'equipo.miembro.ver'), true);
});

test('el Contador no edita campañas, pero las ve y tiene todo Finanzas', () => {
  const contador = permisosDeRol('creator', 'finance');
  assert.equal(can(contador, 'campanas.campana.editar'), false);
  assert.equal(can(contador, 'campanas.campana.ver'), true);
  for (const p of permisosDelModulo('finanzas')) assert.equal(can(contador, p), true, p);
  assert.equal(can(contador, 'ventas.negocio.ver'), false);
  assert.equal(can(contador, 'resumen.panel.ver'), false);
  assert.equal(can(contador, 'conexiones.cuenta.ver'), false);
});

test('el Editor ve campañas y marca entregables; no toca Ventas, Cotizar, Finanzas ni Equipo', () => {
  const editor = permisosDeRol('creator', 'editor');
  assert.deepEqual([...editor].sort(), ['campanas.campana.ver', 'campanas.post.asociar', 'conexiones.cuenta.ver', 'resumen.panel.ver']);
});

test('Solo lectura: únicamente .ver, y nada de Finanzas ni Equipo', () => {
  for (const kind of WORKSPACE_KINDS) {
    const viewer = permisosDeRol(kind, 'viewer');
    for (const p of viewer) {
      assert.ok(p.endsWith('.ver'), `${kind} viewer: ${p}`);
      assert.notEqual(moduloDe(p), 'finanzas', p);
      assert.notEqual(moduloDe(p), 'equipo', p);
    }
    assert.equal(can(viewer, 'campanas.campana.ver'), true);
    assert.equal(can(viewer, 'conexiones.cuenta.ver'), true);
  }
});

test('en la agencia, el Administrador tiene todo salvo configurar y cerrar la cuenta', () => {
  const admin = permisosDeRol('agency', 'admin');
  assert.equal(can(admin, 'equipo.workspace.configurar'), false);
  assert.equal(admin.size, PERMISOS.length - 1);
  assert.equal(can(admin, 'equipo.miembro.invitar'), true);
  assert.equal(can(admin, 'equipo.rol.editar'), true);
});

test('el Ejecutivo de cuenta de agencia tiene exactamente Ventas, Cotizar y Campañas', () => {
  const ejecutivo = permisosDeRol('agency', 'manager');
  const esperado = new Set([...permisosDelModulo('ventas'), ...permisosDelModulo('cotizar'), ...permisosDelModulo('campanas')]);
  assert.deepEqual([...ejecutivo].sort(), [...esperado].sort());
});

test('permisosDeRol devuelve el mismo conjunto cada vez y lanza con un rol que no existe para ese tipo', () => {
  assert.equal(permisosDeRol('creator', 'manager'), permisosDeRol('creator', 'manager'));
  assert.equal(rolSistema('creator', 'admin'), undefined);
  assert.throws(
    () => permisosDeRol('creator', 'admin'),
    (e: unknown) => e instanceof RolDesconocidoError && /«admin».*«creator»/.test(e.messageEs),
  );
  assert.equal(rolSistema('agency', 'editor'), undefined);
});

// ------------------------------------------------------------- reglas de código

test('nadie otorga lo que no tiene: la intersección con los propios', () => {
  const manager = permisosDeRol('creator', 'manager');
  const pedidos: Permiso[] = ['campanas.reporte.enviar', 'finanzas.flujo.ver', 'conexiones.cuenta.conectar', 'ventas.negocio.ver'];
  assert.deepEqual([...permisosOtorgables(manager, pedidos)], ['campanas.reporte.enviar', 'ventas.negocio.ver']);
  assert.deepEqual([...permisosOtorgables(new Set(), pedidos)], []);
  assert.equal(permisosOtorgables(permisosDeRol('creator', 'owner'), pedidos).size, pedidos.length);
});

test('un Administrador de agencia no puede asignar Dueño; un Dueño puede asignar cualquier rol; un Mánager no puede asignar Contador', () => {
  assert.equal(puedeAsignarRol(permisosDeRol('agency', 'admin'), 'agency', 'owner'), false);
  assert.equal(puedeAsignarRol(permisosDeRol('agency', 'admin'), 'agency', 'manager'), true);
  for (const r of ROLES_SISTEMA) {
    assert.equal(puedeAsignarRol(permisosDeRol(r.workspaceKind, 'owner'), r.workspaceKind, r.key), true, r.key);
  }
  assert.equal(puedeAsignarRol(permisosDeRol('creator', 'manager'), 'creator', 'finance'), false);
  // Solo lectura cabe dentro de lo que el Mánager tiene: sí lo puede asignar.
  assert.equal(puedeAsignarRol(permisosDeRol('creator', 'manager'), 'creator', 'viewer'), true);
});

test('el último dueño no se quita ni se degrada', () => {
  assert.equal(esUltimoDueno(['u1'], 'u1'), true);
  assert.equal(esUltimoDueno(['u1', 'u2'], 'u1'), false);
  assert.equal(esUltimoDueno(['u2'], 'u1'), false);
  assert.equal(esUltimoDueno([], 'u1'), false);
  assert.throws(
    () => assertNoEsUltimoDueno(['u1'], 'u1'),
    (e: unknown) => e instanceof UltimoDuenoError && /último dueño/.test(e.messageEs),
  );
  assert.doesNotThrow(() => assertNoEsUltimoDueno(['u1', 'u2'], 'u1'));
});

// ------------------------------------------------------------- errores

test('SinPermisoError lleva el permiso y un mensaje en español con la etiqueta en minúscula', () => {
  const e = new SinPermisoError('finanzas.factura.crear');
  assert.equal(e.permiso, 'finanzas.factura.crear');
  assert.equal(e.messageEs, 'No tienes permiso para crear facturas.');
  assert.equal(e.code, 'SinPermisoError');
  assert.equal(e.name, 'SinPermisoError');
  assert.ok(e instanceof Error);
});
