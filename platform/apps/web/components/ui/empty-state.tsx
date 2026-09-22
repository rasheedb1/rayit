import type { ReactNode } from "react";
import { Button } from "./button";

export type EmptyStateProps = {
  title: string;
  description?: string;
  action?: { label: string; href: string } | { label: string; onClick: () => void };
  /** Un solo tono (currentColor), 24 px. Por defecto, un círculo punteado. */
  icon?: ReactNode;
  className?: string;
};

function DefaultIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
      <path d="M9 12h6" strokeLinecap="round" />
    </svg>
  );
}

/** Lo que se ve cuando no hay datos: qué falta y qué hacer, sin un cero engañoso. */
export function EmptyState({ title, description, action, icon, className = "" }: EmptyStateProps) {
  return (
    <div role="status" className={`flex flex-col items-center justify-center rounded-md border border-dashed border-border px-6 py-10 text-center ${className}`}>
      <span className="text-muted">{icon ?? <DefaultIcon />}</span>
      <p className="mt-3 text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm leading-5 text-ink-2">{description}</p>}
      {action && (
        <div className="mt-4">
          {"href" in action ? (
            <Button variant="primary" size="sm" href={action.href}>
              {action.label}
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
