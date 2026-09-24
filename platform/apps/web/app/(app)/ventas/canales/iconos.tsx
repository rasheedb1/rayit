import { Mail } from "lucide-react";
import type { Channel } from "./_lib/config";

/**
 * El icono de cada canal, a la izquierda de su fila, como las
 * integraciones de Vercel y de Linear (el logo del servicio en un
 * recuadro con borde). lucide 1.x ya no trae glifos de marcas, así que
 * LinkedIn e Instagram van dibujados aquí, en trazo como los de lucide y
 * con currentColor: siguen el tema claro y oscuro sin un color literal.
 * Decorativos (aria-hidden): el nombre del canal ya está en el título.
 */
function LinkedinGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" />
      <rect x="2" y="9" width="4" height="12" />
      <circle cx="4" cy="4" r="2" />
    </svg>
  );
}

function InstagramGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <path d="M17.5 6.5h.01" />
    </svg>
  );
}

export function ChannelIcon({ channel }: { channel: Channel }) {
  return (
    <span
      data-canal-icono={channel}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-fg-2"
      aria-hidden
    >
      {channel === "email" ? <Mail size={16} strokeWidth={1.75} aria-hidden /> : channel === "linkedin" ? <LinkedinGlyph /> : <InstagramGlyph />}
    </span>
  );
}
