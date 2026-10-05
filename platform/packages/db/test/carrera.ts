/**
 * Las pruebas de carreras (dos transacciones que se pisan) esperan un
 * aviso que da la primera transacción desde dentro: «ya tengo la fila».
 *
 * Esperar el aviso a secas era uno de los sospechosos de CIM-12 (la nota
 * de VEN-15 r4): si la transacción falla ANTES de avisar, el aviso no
 * llega nunca. Con Node 24+ la prueba no se cancela —el runner de
 * node:test mantiene vivo el bucle mientras quede una prueba pendiente—,
 * sino que se queda colgada hasta --test-timeout (dos minutos en @mc/db) y
 * el error de verdad, el de la transacción, sale como un rechazo sin
 * dueño, lejos de la prueba que lo causó. Bajo carga, con dos verificar a
 * la vez, esos dos minutos se sumaban a la corrida.
 *
 * esperarAviso corre el aviso contra la transacción: si esta termina
 * primero, la prueba falla ahí mismo con SU error.
 */
export async function esperarAviso(aviso: Promise<void>, transaccion: Promise<unknown>): Promise<void> {
  await Promise.race([
    aviso,
    transaccion.then(
      () => {
        throw new Error('la transacción terminó sin dar el aviso');
      },
      (err: unknown) => {
        throw err;
      },
    ),
  ]);
}
