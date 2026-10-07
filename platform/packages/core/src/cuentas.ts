/**
 * Cómo se nombra una cuenta social en una frase, y el aviso de una cuenta
 * rota (connection_error), en UN sitio (RES-3).
 *
 * Lo usan el worker —oauth.refresh, el token rechazado al recolectar
 * (markNeedsReauth) y la cuenta que ya no se puede leer
 * (notifyBrokenAccount)— y la web —la fila de «Lo que importa esta
 * semana»—. La campana enseña el título que escribió el worker y la
 * fila del Resumen dice ESE MISMO título (connectionErrorTitle con
 * brokenAccountKind del estado de la cuenta): si cada una armara su
 * frase, las dos pantallas dirían cosas distintas de la misma cuenta.
 * apps/web …/resumen/semana.test.tsx lo comprueba. Como `videoName`
 * (scoring.ts) para los videos.
 *
 * Sin «tu» delante de una cuenta con @: en una agencia la cuenta no es
 * de quien lee. De quién es lo dice la fila (su creadora) cuando el
 * espacio tiene varias.
 *
 * El seed de la demo (db/seed/0012_demo_semana.sql) copia a mano el
 * título de una cuenta rota; packages/db/test/resumen-semana.test.ts
 * comprueba que coincide con `connectionErrorTitle`.
 */

/** «@handle», sin duplicar la arroba si ya venía puesta. */
export function arroba(handle: string): string {
  return `@${handle.trim().replace(/^@+/, '')}`;
}

/** «TikTok @laura.cocinafacil», o solo la red si la cuenta no tiene @. */
export function accountLabel(platformName: string, handle: string | null | undefined): string {
  const h = handle?.trim().replace(/^@+/, '');
  return h ? `${platformName} ${arroba(h)}` : platformName;
}

/** Qué le pasó a la cuenta: el token ya no sirve, o la cuenta ya no se puede leer. */
export type BrokenAccountKind = 'reauth' | 'unreadable';

/**
 * El título del aviso de una cuenta rota.
 *
 * Dice lo que pasó y NO promete cómo se arregla: si Conexiones puede
 * reautorizar la cuenta depende del entorno (la app de OAuth de esa red,
 * la bandera de conexión), y la fila más urgente del Resumen no puede
 * mandar a un módulo que contesta «esta versión no puede reautorizarla
 * desde aquí». El cómo lo dice Conexiones, que sabe si puede.
 */
export function connectionErrorTitle(platformName: string, handle: string | null | undefined, kind: BrokenAccountKind): string {
  if (kind === 'unreadable') return `No podemos leer la cuenta de ${accountLabel(platformName, handle)}`;
  const h = handle?.trim().replace(/^@+/, '');
  return `${platformName} dejó de darnos las cifras de ${h ? arroba(h) : 'tu cuenta'}`;
}

/**
 * Qué avería es, por el estado en que Conexiones dejó la cuenta: 'error'
 * es la que no se puede leer y se reintenta; las otras (needs_reauth,
 * expired, revoked) se quedaron sin token. El barrido semanal del worker
 * avisa de las tres sin token con 'reauth', y la fila del Resumen tiene
 * que decir lo mismo que ese aviso.
 */
export function brokenAccountKind(status: string): BrokenAccountKind {
  return status === 'error' ? 'unreadable' : 'reauth';
}

/** La severidad del aviso: sin token no hay nada que hacer hasta reconectar; una cuenta que no se lee se reintenta cada día. */
export function connectionErrorSeverity(kind: BrokenAccountKind): 'critical' | 'warning' {
  return kind === 'reauth' ? 'critical' : 'warning';
}
