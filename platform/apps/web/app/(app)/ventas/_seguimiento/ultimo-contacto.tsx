import type { UltimoContactoData } from "./datos";

/**
 * «Último contacto: hace 3 días», en una línea discreta (VEN-5). Es la
 * señal de que un negocio se enfría: la ficha, la tarjeta del tablero y
 * la lista del pipeline la enseñan igual. El texto llega hecho del
 * servidor (ultimoContacto, en datos.ts); la fecha exacta va en el title
 * y en el dateTime de <time>. Sin contacto, «Sin contacto todavía».
 *
 * Sin estado ni efectos: la monta tanto un componente de servidor (la
 * ficha) como uno de cliente (el tablero).
 */
export function UltimoContacto({
  data,
  short = false,
  className = "",
}: {
  data: UltimoContactoData;
  /** Solo «hace 3 días», bajo una columna que ya dice «Último contacto». */
  short?: boolean;
  className?: string;
}) {
  const texto = short ? data.short : data.text;
  return (
    <p className={`text-xs leading-4 text-muted ${className}`}>
      {data.iso ? (
        <time dateTime={data.iso} title={data.date ?? undefined} className="tabular-nums">
          {texto}
        </time>
      ) : (
        texto
      )}
    </p>
  );
}
