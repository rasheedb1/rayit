import type { Status, Size } from "@/content/backlog";
import { STATUS_LABEL, SIZE_LABEL } from "@/lib/backlog";

const TONE: Record<Status, { pill: string; dot: string }> = {
  pendiente: { pill: "border-line bg-bg text-fg-2", dot: "bg-fg-3" },
  en_curso: { pill: "border-transparent bg-info-bg text-info", dot: "bg-info" },
  bloqueada: { pill: "border-transparent bg-danger-bg text-danger", dot: "bg-danger" },
  hecho: { pill: "border-transparent bg-ok-bg text-ok", dot: "bg-ok" },
};

export function StatusPill({ status }: { status: Status }) {
  const t = TONE[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${t.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function SizeTag({ size }: { size: Size | null }) {
  if (!size) {
    return (
      <span className="inline-flex shrink-0 rounded-sm border border-dashed border-line-2 px-1.5 font-mono text-[11px] text-fg-3" title="No es código">
        —
      </span>
    );
  }
  const tone = size === "L" ? "bg-accent text-accent-fg border-transparent" : size === "M" ? "bg-bg-3 text-fg border-transparent" : "border-line text-fg-2";
  return (
    <span className={`inline-flex shrink-0 rounded-sm border px-1.5 font-mono text-[11px] font-medium ${tone}`} title={SIZE_LABEL[size]}>
      {size}
    </span>
  );
}
