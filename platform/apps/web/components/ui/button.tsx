"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Muestra el spinner, marca aria-busy y desactiva el botón. Conserva el ancho. */
  loading?: boolean;
  disabled?: boolean;
  /** Si viene, es un enlace (next/link) con el mismo estilo. */
  href?: string;
  type?: "button" | "submit";
  /** A la izquierda del texto, decorativo. */
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
} & Pick<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title" | "form" | "name" | "value">;

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink border-accent hover:bg-ink-2 hover:border-ink-2",
  secondary: "bg-surface text-ink border-border hover:bg-hover hover:border-axis",
  ghost: "bg-transparent text-ink-2 border-transparent hover:bg-hover hover:text-ink",
  danger: "bg-surface text-bad border-border hover:bg-bad-wash hover:border-bad",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-9 px-3.5 text-sm",
};

const GAP: Record<ButtonSize, string> = { sm: "gap-1.5", md: "gap-2" };

const BASE =
  "relative inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md border font-medium transition-colors " +
  "disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress";

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled = false,
  href,
  type = "button",
  icon,
  children,
  onClick,
  className = "",
  ...rest
}: ButtonProps) {
  const classes = `${BASE} ${VARIANT[variant]} ${SIZE[size]} ${className}`;
  const content = (
    <>
      {loading && (
        <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
          <Spinner />
        </span>
      )}
      <span className={`inline-flex items-center ${GAP[size]} ${loading ? "invisible" : ""}`}>
        {icon && (
          <span className="inline-flex shrink-0" aria-hidden="true">
            {icon}
          </span>
        )}
        {children}
      </span>
    </>
  );

  if (href && !disabled && !loading) {
    return (
      <Link href={href} className={classes} onClick={onClick} {...rest}>
        {content}
      </Link>
    );
  }
  return (
    <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} onClick={onClick} {...rest}>
      {content}
    </button>
  );
}
