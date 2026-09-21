import Link from "next/link";
import { SPRINTS } from "@/content/backlog";
import { OWNER_IDS } from "@/content/team";
import { daysRange, formatDays, SPRINT_CAPACITY_DAYS, stats, storiesIn, storyHref } from "@/lib/backlog";
import { OwnerName } from "./owner";
import { Progress } from "./progress";
import { SizeTag, StatusPill } from "./status-pill";

export function SprintBoard() {
  return (
    <div className="space-y-4">
      {SPRINTS.map((sp) => (
        <section key={sp.n} className="overflow-hidden rounded-lg border border-line" aria-labelledby={`board-${sp.n}`}>
          <header className="border-b border-line bg-bg-2 px-5 py-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 id={`board-${sp.n}`} className="text-sm font-semibold">
                Sprint {sp.n} · {sp.name}
              </h3>
              <span className="text-xs text-fg-3">{sp.weeks}</span>
            </div>
            <p className="mt-1 text-sm leading-6 text-fg-2">
              <span className="text-fg-3">Demo del viernes: </span>
              {sp.demo}
            </p>
          </header>

          <div className="grid divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0">
            {OWNER_IDS.map((o) => {
              const list = storiesIn(sp.n, o);
              const st = stats(list);
              const d = daysRange(list);
              const over = d[0] > SPRINT_CAPACITY_DAYS;
              return (
                <div key={o} className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <OwnerName owner={o} size="md" />
                    <span className={`font-mono text-xs tabular-nums ${over ? "text-danger" : "text-fg-3"}`} title="Días estimados frente a los diez días hábiles del sprint">
                      {list.length} · {formatDays(d)} / {SPRINT_CAPACITY_DAYS} d
                    </span>
                  </div>
                  <Progress stats={st} className="mt-3" />
                  <ul className="mt-2 divide-y divide-line">
                    {list.map((s) => (
                      <li key={s.id}>
                        <Link
                          href={storyHref(s)}
                          className="-mx-2 flex items-center gap-3 rounded-sm px-2 py-2 text-sm hover:bg-bg-2"
                        >
                          <span className="w-12 shrink-0 font-mono text-xs text-fg-3">{s.id}</span>
                          <span className="min-w-0 flex-1 truncate">{s.title}</span>
                          <SizeTag size={s.size} />
                          <StatusPill status={s.status} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
