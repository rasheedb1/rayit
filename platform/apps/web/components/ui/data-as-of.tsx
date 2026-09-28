import { formatDate, type LocaleOpts } from "@/lib/format";

export type DataAsOfProps = {
  /** ISO. Se formatea en UTC salvo que `opts` traiga la zona del workspace. */
  date: string;
  /** "Instagram", "CSV de TikTok Studio"… */
  source?: string;
  /**
   * El locale y la zona del workspace (`formatterFor` los tiene en
   * `.locale` y `.timeZone`). Sin ellos, es-CO y UTC, que son los
   * valores por defecto de un workspace y no constantes del producto.
   */
  opts?: LocaleOpts;
  className?: string;
};

/** «datos hasta el 20 sep · Instagram». Va junto a cada cifra que depende de una sincronización. */
export function DataAsOf({ date, source, opts, className = "" }: DataAsOfProps) {
  return (
    <p className={`text-xs text-muted ${className}`}>
      datos hasta el <time dateTime={date}>{formatDate(date, "short", opts)}</time>
      {source && <> · {source}</>}
    </p>
  );
}
