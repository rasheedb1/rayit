/** Las cuatro redes del producto (platform.id en la base y tokens --s-<red> del tema). */
export type PlatformId = "tiktok" | "instagram" | "facebook" | "youtube";

export type PlatformPillProps = {
  /** platform.id de la base: tiktok, instagram, facebook, youtube. Otro valor se muestra tal cual, sin color. */
  platformId: string;
  className?: string;
};

export const PLATFORM_LABEL: Record<PlatformId, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
};

export function isPlatformId(value: string): value is PlatformId {
  return value in PLATFORM_LABEL;
}

/**
 * Pastilla de red con el punto en el color de la plataforma (`--s-<red>`).
 * El texto sigue en tinta normal: el color nunca es el único indicador
 * y los tokens de red están calibrados para gráficos, no para texto.
 */
export function PlatformPill({ platformId, className = "" }: PlatformPillProps) {
  const known = isPlatformId(platformId);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-surface py-0.5 pl-2 pr-2.5 text-[11.5px] font-medium text-ink-2 ${className}`}
      data-platform={platformId}
    >
      <span
        className="h-1.5 w-1.5 rounded-full bg-current"
        style={known ? { color: `var(--s-${platformId})` } : undefined}
        aria-hidden="true"
      />
      {known ? PLATFORM_LABEL[platformId] : platformId}
    </span>
  );
}
