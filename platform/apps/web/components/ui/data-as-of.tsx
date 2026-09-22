import { formatDate } from "@/lib/format";

export type DataAsOfProps = {
  /** ISO. Se formatea en UTC. */
  date: string;
  /** "Instagram", "CSV de TikTok Studio"… */
  source?: string;
  className?: string;
};

/** «datos hasta el 20 sep · Instagram». Va junto a cada cifra que depende de una sincronización. */
export function DataAsOf({ date, source, className = "" }: DataAsOfProps) {
  return (
    <p className={`text-xs text-muted ${className}`}>
      datos hasta el <time dateTime={date}>{formatDate(date)}</time>
      {source && <> · {source}</>}
    </p>
  );
}
