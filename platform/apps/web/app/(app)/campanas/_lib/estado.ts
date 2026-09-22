import { CAMPAIGN_STATUSES, CAMPAIGN_STATUS_META, type CampaignStatus } from "@mc/core";
import type { PillKind } from "@/components/ui/pill";

/** La pastilla de una campaña sale de CAMPAIGN_STATUS_META (core): un solo sitio para etiqueta y color. */
export function pillForCampaign(status: CampaignStatus): { kind: PillKind; text: string } {
  const meta = CAMPAIGN_STATUS_META[status];
  return { kind: meta.kind, text: meta.label };
}

export type ListFilterKey = "todas" | CampaignStatus;

/** Filtros de la lista: la llave va en ?estado=. */
export const LIST_FILTERS: Record<ListFilterKey, { label: string; status: CampaignStatus | undefined }> = {
  todas: { label: "Todas", status: undefined },
  ...(Object.fromEntries(CAMPAIGN_STATUSES.map((s) => [s, { label: CAMPAIGN_STATUS_META[s].label, status: s }])) as Record<
    CampaignStatus,
    { label: string; status: CampaignStatus }
  >),
};

export const LIST_FILTER_KEYS = Object.keys(LIST_FILTERS) as ListFilterKey[];

export function filterKey(value: string | undefined): ListFilterKey {
  return value && value in LIST_FILTERS ? (value as ListFilterKey) : "todas";
}

export function filterHref(key: ListFilterKey): string {
  return key === "todas" ? "/campanas" : `/campanas?estado=${key}`;
}
