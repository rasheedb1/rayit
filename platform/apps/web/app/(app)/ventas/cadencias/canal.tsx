import { Hand, Mail } from "lucide-react";

/**
 * El canal de un paso, con su icono: en la tarjeta, en el nodo de la
 * línea de tiempo y en el resumen «Día 0: …». Lucide ya no trae marcas
 * (LinkedIn, Instagram), así que esas dos van dibujadas aquí, en trazo y
 * con currentColor como el resto de iconos: sin colores de marca, con los
 * tokens del tema. Una tarea a mano lleva la mano: no sale sola.
 *
 * Mismo aspecto que PlatformPill del kit (esa es para las redes de
 * contenido, con su punto de color); esta es para los canales de
 * outreach, que no tienen token de color.
 */
export function IconoCanal({ canal, tipo, size = 14 }: { canal: string; tipo?: string; size?: number }) {
  const common = { width: size, height: size, "aria-hidden": true as const, className: "shrink-0" };
  if (tipo === "manual_task") return <Hand {...common} strokeWidth={1.75} />;
  if (canal === "email") return <Mail {...common} strokeWidth={1.75} />;
  if (canal === "linkedin") {
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M8 10.5V16M8 7.75v.01M12 16v-5.5M12 13a2.5 2.5 0 0 1 5 0v3" />
      </svg>
    );
  }
  if (canal === "instagram_dm") {
    return (
      <svg {...common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <path d="M17.25 6.75v.01" />
      </svg>
    );
  }
  return <Mail {...common} strokeWidth={1.75} />;
}

/** La pastilla del canal y tipo de un paso: icono + texto (el icono nunca es el único indicador). */
export function CanalPill({ canal, tipo, children }: { canal: string; tipo: string; children: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-surface py-0.5 pl-2 pr-2.5 text-[11.5px] font-medium text-ink-2"
      data-canal={canal}
    >
      <IconoCanal canal={canal} tipo={tipo} size={12} />
      {children}
    </span>
  );
}
