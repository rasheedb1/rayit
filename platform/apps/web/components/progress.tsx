import type { Stats } from "@/lib/backlog";

/** Barra segmentada: hecho, en curso, bloqueada; lo que falta queda en gris. */
export function Progress({ stats, className = "" }: { stats: Stats; className?: string }) {
  const pct = (n: number) => (stats.total ? `${(n / stats.total) * 100}%` : "0%");
  return (
    <div
      className={`flex h-1.5 w-full overflow-hidden rounded-full bg-bg-3 ${className}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={stats.total}
      aria-valuenow={stats.hecho}
      aria-label={`${stats.hecho} de ${stats.total} historias hechas`}
    >
      {stats.hecho > 0 && <span className="bg-ok" style={{ width: pct(stats.hecho) }} />}
      {stats.en_curso > 0 && <span className="bg-info" style={{ width: pct(stats.en_curso) }} />}
      {stats.bloqueada > 0 && <span className="bg-danger" style={{ width: pct(stats.bloqueada) }} />}
    </div>
  );
}

export function StatsList({ stats }: { stats: Stats }) {
  const rows: Array<[string, number, string]> = [
    ["Hechas", stats.hecho, "bg-ok"],
    ["En curso", stats.en_curso, "bg-info"],
    ["Bloqueadas", stats.bloqueada, "bg-danger"],
    ["Pendientes", stats.pendiente, "bg-fg-3"],
  ];
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-fg-2">
      {rows.map(([label, n, dot]) => (
        <li key={label} className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
            {label}
          </span>
          <span className="font-mono tabular-nums">{n}</span>
        </li>
      ))}
    </ul>
  );
}
