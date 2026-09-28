import type { MetricRequirement } from "@mc/db";
import { SectionTitle } from "@/components/page-header";
import { Pill } from "@/components/ui/pill";
import { MESSAGES } from "./_lib/messages";

const t = MESSAGES.pasosManuales;

/**
 * El paso que ninguna API puede dar por el creador: activar Analytics
 * en la app de TikTok. La instrucción NO está escrita aquí: es
 * `metric_requirement.message_es` de `tt.insights.optin` (migración
 * 0011), el mismo catálogo que CON-7 leerá para explicar cada hueco de
 * demografía. Copiarla sería una segunda fuente de verdad.
 *
 * Solo aparece si hay al menos una cuenta de TikTok **autorizada**: sin
 * token no hay API a la que desbloquearle nada.
 */
export function PasosManuales({ requisito, cuentas }: { requisito: MetricRequirement | null; cuentas: readonly string[] }) {
  if (!requisito || cuentas.length === 0) return null;
  return (
    <section aria-labelledby="pasos-manuales" className="mt-10 rounded-md border border-warn/40 bg-warn-wash p-5">
      <SectionTitle>
        <span id="pasos-manuales">{t.titulo}</span>
      </SectionTitle>
      <div className="flex flex-col gap-2">
        <Pill kind="warn">{t.etiqueta}</Pill>
        <p className="max-w-2xl text-sm leading-6 text-ink">{requisito.messageEs}</p>
        <p className="max-w-2xl text-sm leading-6 text-ink-2">{t.paraQue}</p>
        <p className="text-xs text-ink-2">{cuentas.join(" · ")}</p>
      </div>
    </section>
  );
}
