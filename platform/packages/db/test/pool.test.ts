/**
 * El pool de `pg` y su oyente de 'error'.
 *
 * `pg` emite 'error' en el Pool cuando se rompe una conexión OCIOSA: el
 * pooler de Supabase cierra las ociosas de forma rutinaria, y también lo
 * hacen un reinicio de Supavisor o un corte de red. Un EventEmitter sin
 * oyente de 'error' LANZA, así que eso no tumbaba una petición: tumbaba
 * el proceso entero de Next con ERR_UNHANDLED_ERROR. El runner del
 * worker sí lo manejaba; el paquete compartido —el que sirve la web— no.
 *
 * Nada de aquí abre una conexión: `pg` no conecta hasta la primera
 * consulta, así que esto corre sin red y sin Postgres.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/client.ts';

const LOCAL_URL = 'postgres://mc:mc@localhost:5432/oncue';
const pools: Array<{ end: () => Promise<void> }> = [];
const nuevo = (opts?: Parameters<typeof createPool>[1]) => {
  const p = createPool(LOCAL_URL, opts);
  pools.push(p);
  return p;
};

after(async () => {
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
});

describe('createPool', () => {
  test('el pool sale con un oyente de error: una conexión ociosa rota no tumba el proceso', () => {
    const pool = nuevo();
    assert.ok(pool.listenerCount('error') > 0, 'sin oyente, pool.emit("error") lanza y se cae Next entero');
    // Sin oyente esto lanzaría ERR_UNHANDLED_ERROR.
    assert.doesNotThrow(() => pool.emit('error', new Error('conexión ociosa rota'), undefined as never));
  });

  test('onError deja que la web lo mande a su logger', () => {
    const vistos: string[] = [];
    const pool = nuevo({ onError: (err) => vistos.push(err.message) });
    pool.emit('error', new Error('terminating connection due to administrator command'), undefined as never);
    assert.deepEqual(vistos, ['terminating connection due to administrator command']);
  });

  test('sin onError, el aviso sale por stderr y dice qué pasó', () => {
    const original = process.stderr.write.bind(process.stderr);
    const lineas: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lineas.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const pool = nuevo();
      pool.emit('error', new Error('read ECONNRESET'), undefined as never);
    } finally {
      process.stderr.write = original;
    }
    assert.equal(lineas.length, 1);
    assert.match(lineas[0] ?? '', /conexión ociosa rota/);
    assert.match(lineas[0] ?? '', /read ECONNRESET/);
  });
});
