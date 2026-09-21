import type { ReactNode } from "react";

export function Kpi({ label, value, hint, children }: { label: string; value: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-bg p-4">
      <p className="text-xs text-fg-3">{label}</p>
      <p className="mt-1 font-mono text-2xl font-medium tabular-nums leading-none">{value}</p>
      {hint && <p className="mt-2 text-xs text-fg-2">{hint}</p>}
      {children}
    </div>
  );
}
