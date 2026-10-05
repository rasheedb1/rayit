/**
 * Lo que Next corre una vez al arrancar el servidor, antes de atender
 * peticiones (instrumentation, Next 15).
 *
 * Solo una cosa: en el modo demo (sin DATABASE_URL, fuera de producción)
 * abre el Postgres embebido aquí y no dentro de la primera petición. Ver
 * abrirBaseDeLaDemo en lib/db/cliente.ts: abierta en una petición de
 * `next dev`, la primera página daba 500 (CIM-12, r4). Con DATABASE_URL o
 * en producción no hace nada.
 *
 * El import va DENTRO del `if` con NEXT_RUNTIME, como pide Next: este
 * archivo también se compila para el runtime edge, que no tiene `fs` ni
 * `pg`, y solo así el empaquetador quita el import de esa compilación.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { abrirBaseDeLaDemo } = await import("./lib/db/cliente");
    await abrirBaseDeLaDemo();
  }
}
