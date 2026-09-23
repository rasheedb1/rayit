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
 */
export function Aviso({
  message,
  notice,
  size = "sm",
  className = "",
}: {
  message?: string | null;
  notice?: string | null;
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
  if (notice) {
    return (
      <p role="status" className={`rounded-md border border-good/30 bg-good-wash px-3 py-2 ${texto} text-good ${className}`}>
        {notice}
      </p>
    );
  }
  return null;
}
