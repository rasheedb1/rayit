import type { ReactNode } from "react";

/** Una sección de la galería: nombre, uso mínimo y variantes. */
export function Section({ id, title, usage, children }: { id: string; title: string; usage: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-8 border-t border-border py-10 first:border-t-0 first:pt-0">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <a href={`#${id}`} className="font-mono text-xs text-muted hover:text-ink">
          #{id}
        </a>
      </div>
      <pre className="mb-6 overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[12px] leading-5 text-ink-2">
        <code>{usage}</code>
      </pre>
      <div className="space-y-6">{children}</div>
    </section>
  );
}

/** Una variante dentro de la sección, con su etiqueta. */
export function Variant({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      {children}
    </div>
  );
}
