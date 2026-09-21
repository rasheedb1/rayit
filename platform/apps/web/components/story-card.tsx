import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { Story } from "@/content/backlog";
import { OWNERS } from "@/content/team";
import { storyById, storyHref } from "@/lib/backlog";
import { OwnerName } from "./owner";
import { SizeTag, StatusPill } from "./status-pill";

function DepChip({ id, from }: { id: string; from: Story }) {
  const dep = storyById(id);
  const cross = dep.owner !== from.owner;
  const tone = dep.owner === "rasheed" ? "bg-rasheed-bg text-rasheed" : "bg-nicolas-bg text-nicolas";
  return (
    <Link
      href={storyHref(dep)}
      title={`${dep.title} · ${OWNERS[dep.owner].name}${cross ? " · la hace la otra persona" : ""}`}
      className={`rounded-sm px-1.5 py-0.5 font-mono text-[11px] font-medium hover:underline ${tone} ${cross ? "ring-1 ring-current" : ""}`}
    >
      {id}
    </Link>
  );
}

export function StoryCard({ story, showOwner = false }: { story: Story; showOwner?: boolean }) {
  return (
    <article
      id={story.id}
      className="scroll-mt-24 rounded-md border border-line bg-bg p-4 transition-colors target:border-line-2 target:bg-bg-2"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className="pt-0.5 font-mono text-xs text-fg-3">{story.id}</span>
        <h3 className="min-w-0 flex-1 text-sm font-medium leading-5">{story.title}</h3>
        <div className="flex items-center gap-2">
          <SizeTag size={story.size} />
          <StatusPill status={story.status} />
        </div>
      </div>

      <p className="mt-2 text-sm leading-6 text-fg-2">{story.desc}</p>

      {story.note && (
        <p className="mt-3 rounded-sm border-l-2 border-line-2 bg-bg-2 px-3 py-2 text-sm leading-6 text-fg-2">{story.note}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-3">
        {showOwner && <OwnerName owner={story.owner} />}
        <span className="flex flex-wrap items-center gap-1.5">
          {story.deps.length ? (
            <>
              Depende de
              {story.deps.map((d) => (
                <DepChip key={d} id={d} from={story} />
              ))}
            </>
          ) : (
            "Sin dependencias"
          )}
        </span>
      </div>

      <details className="group mt-3 text-sm">
        <summary className="inline-flex cursor-pointer select-none items-center gap-1.5 text-fg-2 hover:text-fg">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
          Terminado cuando
        </summary>
        <p className="mt-2 rounded-sm bg-bg-2 px-3 py-2 leading-6 text-fg-2">{story.done}</p>
      </details>
    </article>
  );
}
