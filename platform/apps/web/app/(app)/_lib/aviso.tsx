/**
 * El resultado de una acción: el error en rojo y con `role="alert"`, el
 * aviso de que salió bien en verde y con `role="status"`, para que un
 * lector de pantalla lo anuncie sin robar el foco.
 *
 * Nació en Ventas y vive aquí desde el pulido r8 para que Ventas y
 * Cotizar pinten el mismo recuadro: estaba copiado a mano en seis sitios
 * de Cotizar, y un cambio de estilo o de accesibilidad se hacía en uno y
 * no en los otros. `size="xs"` es el de un sitio estrecho (la tarjeta del
 * tablero, la línea de la siguiente acción): va como prop y no en
 * `className` porque dos tamaños de letra en la misma clase no se sabe
 * cuál gana.
 *
 * Dos tonos más, para lo que no es ni error ni éxito (VEN-9, canales):
 * `warning` en ámbar (algo que no depende de la persona: «LinkedIn todavía
 * no está disponible») e `info` en neutro (algo que la persona decidió:
 * «Cancelaste la autorización»). Los dos con `role="status"`: se anuncian
 * sin interrumpir. Si llegan varios, gana el primero de: message, warning,
 * info, notice.
 */
export function Aviso({
  message,
  notice,
  warning,
  info,
  size = "sm",
  className = "",
}: {
  message?: string | null;
  notice?: string | null;
  warning?: string | null;
  info?: string | null;
  size?: "sm" | "xs";
  className?: string;
}) {
  const texto = size === "xs" ? "text-xs" : "text-sm";
  if (message) {
    return (
      <p role="alert" className={`rounded-md border border-bad/30 bg-bad-wash px-3 py-2 ${texto} text-bad ${className}`}>
        {message}
      </p>
    );
  }
  if (warning) {
    return (
      <p role="status" className={`rounded-md border border-warn/30 bg-warn-wash px-3 py-2 ${texto} text-warn ${className}`}>
        {warning}
      </p>
    );
  }
  if (info) {
    return (
      <p role="status" className={`rounded-md border border-line bg-surface-2 px-3 py-2 ${texto} text-fg-2 ${className}`}>
        {info}
      </p>
    );
  }
  if (notice) {
    return (
      <p role="status" className={`rounded-md border border-good/30 bg-good-wash px-3 py-2 ${texto} text-good ${className}`}>
        {notice}
      </p>
    );
  }
  return null;
}
