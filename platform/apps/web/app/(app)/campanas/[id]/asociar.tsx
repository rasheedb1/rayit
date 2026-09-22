"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { DELIVERABLES, DELIVERABLE_LABEL_ES } from "@mc/core";
import type { LinkablePost, SuggestedPost } from "@mc/db";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { PlatformPill } from "@/components/ui/platform-pill";
import { Segmented } from "@/components/ui/segmented";
import { formatDate, formatInt } from "@/lib/format";
import { asociarPost, buscarPosts, type AccionState } from "./actions";

/** Espera tras la última tecla antes de buscar en el servidor. */
const SEARCH_DEBOUNCE_MS = 300;

type Tab = "sugeridos" | "buscar";

function PostResumen({ post }: { post: LinkablePost }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium text-ink">{post.title ?? post.caption ?? "Sin título"}</p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
        <PlatformPill platformId={post.platformId} />
        {post.publishedAt ? <span>{formatDate(post.publishedAt)}</span> : <span>Sin fecha</span>}
        <span>{post.views === null ? "Sin views" : `${formatInt(post.views)} views`}</span>
      </p>
    </div>
  );
}

/** El formulario «Asociar» de un post: entregable, principal y el botón. */
export function AsociarForm({ campaignId, post }: { campaignId: string; post: LinkablePost }) {
  const [state, formAction, pending] = useActionState<AccionState, FormData>(asociarPost, {});
  const formRef = useRef<HTMLFormElement>(null);
  const errors = state.errors ?? {};
  useEffect(() => {
    if (state.errors) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);
  return (
    <form ref={formRef} action={formAction} noValidate aria-busy={pending || undefined} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="postId" value={post.postId} />
      <Field label="Entregable" error={errors.deliverable} htmlFor={`deliverable-${post.postId}`} className="w-40">
        <Select name="deliverable" placeholder="Sin entregable" options={DELIVERABLES.map((d) => ({ value: d, label: DELIVERABLE_LABEL_ES[d] }))} />
      </Field>
      <label className="flex min-h-9 items-center gap-1.5 text-sm text-fg-2">
        <input type="checkbox" name="isPrimary" className="h-4 w-4 accent-fg" />
        Principal
      </label>
      <Button type="submit" size="md" variant="primary" loading={pending}>
        Asociar
      </Button>
      {state.message && (
        <p role="alert" className="basis-full text-xs text-danger">
          {state.message}
        </p>
      )}
      {errors.postId && (
        <p role="alert" className="basis-full text-xs text-danger">
          {errors.postId}
        </p>
      )}
    </form>
  );
}

function Fila({ campaignId, post, reasons }: { campaignId: string; post: LinkablePost; reasons?: SuggestedPost["reasons"] }) {
  return (
    <li className="flex flex-col gap-3 py-3 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 flex-1">
        <PostResumen post={post} />
        {reasons && reasons.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Por qué se sugiere">
            {reasons.map((r) => (
              <li key={`${r.kind}:${r.text}`} className="rounded-full bg-good-wash px-2 py-0.5 text-[11.5px] font-medium text-good">
                {r.text}
              </li>
            ))}
          </ul>
        )}
      </div>
      <AsociarForm campaignId={campaignId} post={post} />
    </li>
  );
}

/**
 * «Asociar post»: pestaña Sugeridos (posts de las fechas de la campaña
 * que nombran a la marca, con el motivo) y pestaña Buscar (por título o
 * caption, contra el servidor).
 */
export function AsociarPosts({ campaignId, suggestions, initial }: { campaignId: string; suggestions: SuggestedPost[]; initial: LinkablePost[] }) {
  const [tab, setTab] = useState<Tab>(suggestions.length > 0 ? "sugeridos" : "buscar");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<LinkablePost[]>(initial);
  const [searching, startSearch] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Cuando la ficha se revalida (un post asociado), la lista inicial cambia.
  useEffect(() => {
    if (!q.trim()) setResults(initial);
  }, [initial, q]);

  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    const id = setTimeout(() => {
      startSearch(async () => {
        try {
          setResults(await buscarPosts(campaignId, term));
          setError(null);
        } catch {
          setError("No se pudo buscar. Inténtalo de nuevo.");
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [q, campaignId]);

  return (
    <div>
      <Segmented<Tab>
        label="Cómo elegir el post"
        size="sm"
        value={tab}
        onChange={setTab}
        options={[
          { value: "sugeridos", label: `Sugeridos (${suggestions.length})` },
          { value: "buscar", label: "Buscar" },
        ]}
      />

      {tab === "sugeridos" && (
        <div className="mt-3">
          {suggestions.length === 0 ? (
            <EmptyState
              title="Nada que sugerir"
              description="Buscamos posts publicados en las fechas de la campaña (con dos días de margen) que mencionen a la marca, la nombren o lleven el código. Prueba en «Buscar»."
            />
          ) : (
            <ul className="divide-y divide-line">
              {suggestions.map((s) => (
                <Fila key={s.postId} campaignId={campaignId} post={s} reasons={s.reasons} />
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "buscar" && (
        <div className="mt-3">
          <Field label="Buscar por título o caption" htmlFor="buscar-post">
            <Input id="buscar-post" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="cold brew, @cafealma, #ad…" autoComplete="off" />
          </Field>
          {error && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {error}
            </p>
          )}
          <div aria-busy={searching || undefined} aria-live="polite">
            {results.length === 0 ? (
              <EmptyState
                className="mt-3"
                title={q.trim() ? `Ningún post con «${q.trim()}»` : "No hay posts por asociar"}
                description={q.trim() ? "Prueba con otra palabra de la caption." : "Todos los posts del workspace ya están en esta campaña."}
              />
            ) : (
              <ul className="divide-y divide-line">
                {results.map((p) => (
                  <Fila key={p.postId} campaignId={campaignId} post={p} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
