import { notFound } from "next/navigation";
import { SPRINTS } from "@/content/backlog";
import { moduleBySlug } from "@/content/modules";
import { OWNERS, type OwnerId } from "@/content/team";
import { daysRange, formatDays, stats, storiesFor } from "@/lib/backlog";
import { OwnerAvatar } from "./owner";
import { PageHeader } from "./page-header";
import { Progress, StatsList } from "./progress";
import { StoryCard } from "./story-card";

/**
 * Página de un módulo mientras no existe su pantalla real: quién lo
 * construye, qué historias tiene, en qué sprint, y cómo va. Cuando la
 * primera historia de pantalla llegue a main, el dueño reemplaza el
 * page.tsx de su carpeta por el módulo de verdad.
 */
export function ModulePlan({ slug }: { slug: string }) {
  const mod = moduleBySlug(slug);
  if (!mod || !mod.prefix) notFound();

  const stories = storiesFor(mod.prefix);
  const st = stats(stories);
  const storyOwners = Array.from(new Set(stories.map((s) => s.owner))) as OwnerId[];
  // Un módulo con dueño se presenta con ese dueño; si alguien más tiene
  // historias dentro (los trámites de Conexiones, por ejemplo), se dice aparte.
  const owners: OwnerId[] = mod.owner ? [mod.owner] : storyOwners;
  const guests = storyOwners.filter((o) => o !== mod.owner && mod.owner);
  const isShared = !mod.owner;

  return (
    <>
      <PageHeader
        eyebrow={mod.group === "producto" ? "Módulo del producto" : "Construcción"}
        title={mod.name}
        description={mod.summary}
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_272px]">
        <div className="space-y-8">
          {SPRINTS.map((sp) => {
            const list = stories.filter((s) => s.sprint === sp.n);
            if (!list.length) return null;
            return (
              <section key={sp.n} aria-labelledby={`sprint-${sp.n}`}>
                <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 id={`sprint-${sp.n}`} className="text-sm font-semibold">
                    Sprint {sp.n}
                  </h2>
                  <span className="text-xs text-fg-3">
                    {sp.weeks} · {list.length} {list.length === 1 ? "historia" : "historias"} · {formatDays(daysRange(list))}
                  </span>
                </div>
                <div className="grid gap-3">
                  {list.map((s) => (
                    <StoryCard key={s.id} story={s} showOwner={isShared || s.owner !== mod.owner} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        <aside className="space-y-3 lg:sticky lg:top-8 lg:self-start">
          <div className="rounded-md border border-line p-4">
            <p className="text-xs text-fg-3">{owners.length > 1 ? "Dueños" : "Dueño"}</p>
            <div className="mt-2 space-y-3">
              {owners.map((o) => (
                <div key={o} className="flex items-center gap-3">
                  <OwnerAvatar owner={o} size="lg" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{OWNERS[o].name}</p>
                    <p className="text-xs text-fg-2">{OWNERS[o].chain}</p>
                  </div>
                </div>
              ))}
            </div>
            {guests.length > 0 && (
              <p className="mt-3 border-t border-line pt-3 text-xs text-fg-3">
                Con historias de{" "}
                {guests.map((g) => (
                  <span key={g} className="inline-flex items-center gap-1 text-fg-2">
                    <OwnerAvatar owner={g} />
                    {OWNERS[g].name}
                  </span>
                ))}
                , marcadas en cada tarjeta.
              </p>
            )}
          </div>

          <div className="rounded-md border border-line p-4">
            <div className="flex items-baseline justify-between">
              <p className="text-xs text-fg-3">Avance</p>
              <p className="font-mono text-xs tabular-nums text-fg-2">
                {st.hecho}/{st.total}
              </p>
            </div>
            <Progress stats={st} className="mt-2" />
            <div className="mt-3">
              <StatsList stats={st} />
            </div>
          </div>

          <div className="rounded-md border border-line p-4">
            <p className="text-xs text-fg-3">Qué hará</p>
            <p className="mt-1 text-sm leading-6 text-fg-2">{mod.purpose}</p>
          </div>

          <div className="rounded-md border border-line p-4">
            <p className="text-xs text-fg-3">Carpetas de este módulo</p>
            <ul className="mt-2 space-y-1.5">
              {mod.paths.map((p) => (
                <li key={p} className="break-all font-mono text-[11px] leading-4 text-fg-2">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </>
  );
}
