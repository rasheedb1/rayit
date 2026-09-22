// Datos de ejemplo de la galería, deterministas (sin Math.random) para
// que la página se vea igual en cada despliegue. Cifras del mock.
import { formatDate } from "@/lib/format";
import type { Series } from "@/components/ui/chart-utils";

const DAY = 86400000;
const END = Date.UTC(2026, 8, 20); // 20 sep 2026

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 90 días de seguidores de @cafealma con la campaña del 24 al 31 de agosto. */
export function brandFollowers(): { labels: string[]; series: Series[]; shade: { from: number; to: number; label: string } } {
  const r = rng(7);
  const labels: string[] = [];
  const data: number[] = [];
  let v = 18420;
  for (let i = 89; i >= 0; i--) {
    const d = new Date(END - i * DAY);
    labels.push(formatDate(d.toISOString()));
    const day = 89 - i;
    const inCampaign = day >= 62 && day <= 69;
    v += inCampaign ? 120 + Math.round(r() * 90) : 12 + Math.round(r() * 14) + (day > 69 ? 12 : 0);
    data.push(v);
  }
  return { labels, series: [{ name: "@cafealma", data, color: "accent" }], shade: { from: 62, to: 69, label: "Campaña 24–31 ago" } };
}

/** Views por semana y red, 12 semanas. */
export function weeklyViews(): { cats: string[]; series: Series[] } {
  const r = rng(3);
  const cats = Array.from({ length: 12 }, (_, i) => `S${34 + i}`);
  const base = { tiktok: 620000, instagram: 310000, youtube: 140000, facebook: 60000 };
  const mk = (b: number, s: number) => cats.map((_, i) => Math.round(b * (0.8 + r() * 0.5) * (1 + i * s)));
  return {
    cats,
    series: [
      { name: "TikTok", data: mk(base.tiktok, 0.02), color: "tiktok" },
      { name: "Instagram", data: mk(base.instagram, 0.015), color: "instagram" },
      { name: "YouTube", data: mk(base.youtube, 0.01), color: "youtube" },
      { name: "Facebook", data: mk(base.facebook, 0), color: "facebook" },
    ],
  };
}

/** Flujo de caja proyectado a ocho semanas (Finanzas del mock). */
export const CASH = {
  cats: ["S38", "S39", "S40", "S41", "S42", "S43", "S44", "S45"],
  series: [
    { name: "Cobros esperados", data: [3.1e6, 0, 5.2e6, 0, 2.6e6, 1.8e6, 0, 5.0e6], color: "accent" },
    { name: "Gastos e impuestos", data: [1.4e6, 1.1e6, 1.7e6, 1.1e6, 1.4e6, 1.3e6, 1.1e6, 1.6e6], color: "deemph" },
  ] satisfies Series[],
};

/** Seguidores por red en 90 días, para la línea con varias series. */
export function followersByNetwork(): { labels: string[]; series: Series[] } {
  const r = rng(11);
  const labels = Array.from({ length: 90 }, (_, i) => formatDate(new Date(END - (89 - i) * DAY).toISOString()));
  const grow = (start: number, step: number) => {
    let v = start;
    return labels.map(() => (v += Math.round(step * (0.6 + r() * 0.8))));
  };
  return {
    labels,
    series: [
      { name: "TikTok", data: grow(201000, 150), color: "tiktok" },
      { name: "Instagram", data: grow(121000, 80), color: "instagram" },
      { name: "YouTube", data: grow(46000, 35), color: "youtube" },
      { name: "Facebook", data: grow(20000, 12), color: "facebook", dashed: true },
    ],
  };
}
