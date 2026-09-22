import type { ReactNode } from "react";
import { Button } from "./button";

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: { label: string; href: string } | { label: string; onClick: () => void };
  /** Un solo tono (currentColor), 24 px. Por defecto, un círculo punteado. */
  icon?: ReactNode;
  className?: string;
}

function DefaultIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
    </svg>
  );
}

/** Estado vacío: qué no hay y qué hacer. Server Component (con onClick, el botón es cliente). */
export function EmptyState({ title, description, action, icon, className = "" }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-md border border-dashed border-line px-6 py-12 text-center ${className}`}>
      <div className="text-fg-3">{icon ?? <DefaultIcon />}</div>
      <p className="mt-3 text-sm font-semibold text-fg">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm leading-5 text-fg-2">{description}</p>}
      {action && (
        <div className="mt-5">
          {"href" in action ? (
            <Button variant="primary" href={action.href}>{action.label}</Button>
          ) : (
            <Button variant="primary" onClick={action.onClick}>{action.label}</Button>
          )}
        </div>
      )}
    </div>
  );
}
