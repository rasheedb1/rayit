/**
 * El título del aviso de una cuenta social rota (connection_error), en UN
 * sitio (RES-3). Lo escriben tres caminos —oauth.refresh, el token
 * rechazado al recolectar (markNeedsReauth) y la cuenta que ya no se
 * puede leer (notifyBrokenAccount)— y «Lo que importa esta semana» los
 * enseña juntos: si el texto cambia en uno solo, las filas divergen.
 *
 * La cuenta se nombra como la nombran Conexiones y «Hasta cuándo llegan
 * los datos»: la red y el @ («TikTok @laura.cocinafacil»).
 *
 * Sin imports a propósito: oauth-refresh.ts y _posts.ts lo usan los dos,
 * y _posts.ts ya importa de oauth-refresh.ts.
 */

/** Qué le pasó a la cuenta: el token ya no sirve, o la cuenta ya no se puede leer. */
export type BrokenAccountKind = 'reauth' | 'unreadable';

/** «@handle», sin duplicar la arroba si ya venía puesta. */
export function arroba(handle: string): string {
  return `@${handle.replace(/^@+/, '')}`;
}

/** «TikTok @laura.cocinafacil», o solo la red si la cuenta no tiene @. */
export function accountLabel(platformName: string, handle: string | null | undefined): string {
  const h = handle?.trim();
  return h ? `${platformName} ${arroba(h)}` : platformName;
}

export function connectionErrorTitle(platformName: string, handle: string | null | undefined, kind: BrokenAccountKind): string {
  const cuenta = accountLabel(platformName, handle);
  return kind === 'reauth' ? `Vuelve a conectar tu cuenta de ${cuenta}` : `No podemos leer tu cuenta de ${cuenta}`;
}

/** La severidad del aviso: sin token no hay nada que hacer hasta reconectar; una cuenta que no se lee se reintenta cada día. */
export function connectionErrorSeverity(kind: BrokenAccountKind): 'critical' | 'warning' {
  return kind === 'reauth' ? 'critical' : 'warning';
}
