/**
 * Cómo se nombra una cuenta social en una frase, y el aviso de una cuenta
 * rota (connection_error), en UN sitio (RES-3).
 *
 * Lo usan el worker —oauth.refresh, el token rechazado al recolectar
 * (markNeedsReauth) y la cuenta que ya no se puede leer
 * (notifyBrokenAccount)— y la web —la fila de «Lo que importa esta
 * semana»—. La campana enseña el título que escribió el worker y el
 * Resumen arma el suyo con las mismas piezas: si una cambia sola, las
 * dos pantallas dicen cosas distintas de la misma cuenta. Como
 * `videoName` (scoring.ts) para los videos.
 *
 * El seed de la demo (db/seed/0011_demo_semana.sql) copia a mano el
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
  if (kind === 'unreadable') return `No podemos leer tu cuenta de ${accountLabel(platformName, handle)}`;
  const h = handle?.trim().replace(/^@+/, '');
  return `${platformName} dejó de darnos las cifras de ${h ? arroba(h) : 'tu cuenta'}`;
}

/** La severidad del aviso: sin token no hay nada que hacer hasta reconectar; una cuenta que no se lee se reintenta cada día. */
export function connectionErrorSeverity(kind: BrokenAccountKind): 'critical' | 'warning' {
  return kind === 'reauth' ? 'critical' : 'warning';
}
