import Link from "next/link";
import type { ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps {
  /** secondary por defecto */
  variant?: ButtonVariant;
  /** md por defecto */
  size?: ButtonSize;
  /** Spinner + aria-busy + disabled; conserva el ancho. */
  loading?: boolean;
  disabled?: boolean;
  /** Si viene, renderiza next/link con el mismo estilo. */
  href?: string;
  type?: "button" | "submit";
  /** A la izquierda, aria-hidden. */
  icon?: ReactNode;
  /** Texto obligatorio. */
  children: ReactNode;
  /** Solo desde un componente cliente. */
  onClick?: () => void;
  /** Tooltip nativo; útil con disabled para decir por qué. */
  title?: string;
  /** Para <button> dentro de un <form> con Server Actions. */
  name?: string;
  value?: string;
  form?: string;
  "aria-describedby"?: string;
  className?: string;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-accent text-accent-fg hover:bg-fg-2",
  secondary: "border-line bg-bg text-fg hover:border-line-2 hover:bg-bg-2",
  ghost: "border-transparent bg-transparent text-fg-2 hover:bg-bg-3 hover:text-fg",
  danger: "border-transparent bg-danger-bg text-danger hover:bg-danger hover:text-bg",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-4 text-sm",
};

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border font-medium transition-colors " +
  "disabled:pointer-events-none disabled:opacity-50 aria-busy:pointer-events-none";

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Botón del kit. Sin hooks: sirve igual en Server y Client Components.
 * Con `href` es un enlace con el mismo aspecto (sin Slot ni asChild).
 */
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
  title,
  name,
  value,
  form,
  className = "",
  ...aria
}: ButtonProps) {
  const cls = `${BASE} ${VARIANT[variant]} ${SIZE[size]} ${className}`;
  const content = (
    <>
      {loading ? <Spinner /> : icon ? <span aria-hidden="true" className="inline-flex">{icon}</span> : null}
      <span>{children}</span>
      {loading && <span className="sr-only">Cargando</span>}
    </>
  );
  if (href && !disabled && !loading) {
    return (
      <Link href={href} className={cls} title={title} aria-describedby={aria["aria-describedby"]}>
        {content}
      </Link>
    );
  }
  return (
    <button
      type={type}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-disabled={disabled || loading || undefined}
      onClick={onClick}
      title={title}
      name={name}
      value={value}
      form={form}
      aria-describedby={aria["aria-describedby"]}
    >
      {content}
    </button>
  );
}
