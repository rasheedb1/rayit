/**
 * ACC-4 · las reglas de Equipo que no dependen de la base: las casillas
 * del mánager, «nadie otorga lo que no tiene» y el vencimiento.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admiteCasillas,
  CASILLAS,
  casillasDe,
  EXTRA_PERMISOS,
  INVITACION_VIGENCIA_DIAS,
  isExtraPermiso,
  isPermiso,
  normalizarCorreo,
  permisosConCasillas,
  permisosDeCasillas,
  permisosDeRol,
  permisosQueFaltan,
  venceInvitacion,
} from '../src/index.ts';

describe('las casillas del mánager', () => {
  test('son permisos del catálogo, y el Mánager de fábrica no trae ninguno (decisión E)', () => {
    const manager = permisosDeRol('creator', 'manager');
    for (const p of EXTRA_PERMISOS) {
      assert.ok(isPermiso(p), p);
      assert.ok(!manager.has(p), `${p} no debería venir de fábrica`);
    }
  });

  test('ver finanzas da facturas, gastos y flujo de caja, y nada que escriba', () => {
    assert.deepEqual([...CASILLAS.finanzas], ['finanzas.factura.ver', 'finanzas.gasto.ver', 'finanzas.flujo.ver']);
    assert.ok(CASILLAS.finanzas.every((p) => p.endsWith('.ver')));
  });

  test('conectar cuentas da conectar y quitar, lo que espera ACC-8', () => {
    assert.deepEqual([...CASILLAS.conexiones], ['conexiones.cuenta.conectar', 'conexiones.cuenta.desconectar']);
  });

  test('ida y vuelta: casillas → permisos → casillas', () => {
    assert.deepEqual(casillasDe(permisosDeCasillas(['conexiones', 'finanzas'])), ['finanzas', 'conexiones']);
    assert.deepEqual(permisosDeCasillas([]), []);
    assert.deepEqual(casillasDe([]), []);
  });

  test('media casilla se pinta desmarcada', () => {
    assert.deepEqual(casillasDe(['finanzas.flujo.ver']), []);
  });

  test('solo el Mánager de creador las admite', () => {
    assert.ok(admiteCasillas('creator', 'manager'));
    assert.ok(!admiteCasillas('creator', 'editor'));
    assert.ok(!admiteCasillas('creator', 'owner'));
    assert.ok(!admiteCasillas('agency', 'manager'));
  });

  test('isExtraPermiso solo acepta los de la lista', () => {
    assert.ok(isExtraPermiso('finanzas.flujo.ver'));
    assert.ok(!isExtraPermiso('finanzas.factura.crear'));
    assert.ok(!isExtraPermiso('equipo.rol.editar'));
  });

  test('el Mánager con la casilla de finanzas ve el flujo; sin ella, no', () => {
    assert.ok(!permisosConCasillas('creator', 'manager').has('finanzas.flujo.ver'));
    assert.ok(permisosConCasillas('creator', 'manager', ['finanzas']).has('finanzas.flujo.ver'));
    assert.ok(permisosConCasillas('creator', 'manager', ['finanzas']).has('campanas.campana.ver'));
  });
});

describe('nadie otorga lo que no tiene', () => {
  test('el Dueño puede dar cualquier rol de creador con sus casillas', () => {
    const dueno = permisosDeRol('creator', 'owner');
    const pedido = [...permisosDeRol('creator', 'manager'), ...EXTRA_PERMISOS];
    assert.deepEqual(permisosQueFaltan(dueno, pedido), []);
  });

  test('un Mánager no puede dar la casilla de finanzas: dice qué le falta', () => {
    const manager = permisosDeRol('creator', 'manager');
    assert.deepEqual(permisosQueFaltan(manager, permisosDeCasillas(['finanzas'])), [...CASILLAS.finanzas]);
  });

  test('un Administrador de agencia no puede hacer Dueño a nadie', () => {
    const admin = permisosDeRol('agency', 'admin');
    assert.deepEqual(permisosQueFaltan(admin, permisosDeRol('agency', 'owner')), ['equipo.workspace.configurar']);
  });
});

describe('invitación', () => {
  test(`vence a los ${INVITACION_VIGENCIA_DIAS} días`, () => {
    const ahora = new Date('2026-10-05T12:00:00Z');
    assert.equal(venceInvitacion(ahora).toISOString(), '2026-10-12T12:00:00.000Z');
  });

  test('el correo se normaliza y se valida', () => {
    assert.equal(normalizarCorreo('  Andres@Ejemplo.COM '), 'andres@ejemplo.com');
    assert.equal(normalizarCorreo('sin-arroba'), null);
    assert.equal(normalizarCorreo('a b@c.co'), null);
    assert.equal(normalizarCorreo(''), null);
    assert.equal(normalizarCorreo(`${'a'.repeat(250)}@c.co`), null);
  });
});
