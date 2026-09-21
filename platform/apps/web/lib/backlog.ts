import { STORIES, SPRINTS, type Story, type Status, type SprintNumber } from "@/content/backlog";
import { moduleByPrefix, type StoryPrefix } from "@/content/modules";
import type { OwnerId } from "@/content/team";

export const STATUS_ORDER: readonly Status[] = ["hecho", "en_curso", "bloqueada", "pendiente"];

export const STATUS_LABEL: Record<Status, string> = {
  pendiente: "Pendiente",
  en_curso: "En curso",
  bloqueada: "Bloqueada",
  hecho: "Hecho",
};

export const SIZE_LABEL = {
  S: "S · un día o menos",
  M: "M · dos o tres días",
  L: "L · una semana",
} as const;

/** Días que pide cada tamaño: extremo bajo y alto. */
const SIZE_DAYS = { S: [1, 1], M: [2, 3], L: [5, 5] } as const;

/** Días hábiles por persona en un sprint de dos semanas. */
export const SPRINT_CAPACITY_DAYS = 10;

const byId = new Map(STORIES.map((s) => [s.id, s]));

export function storyById(id: string): Story {
  const s = byId.get(id);
  if (!s) throw new Error(`No existe la historia ${id}`);
  return s;
}

export function storiesFor(prefix: StoryPrefix): Story[] {
  return STORIES.filter((s) => s.module === prefix);
}

export function storiesOf(owner: OwnerId): Story[] {
  return STORIES.filter((s) => s.owner === owner);
}

export function storiesIn(sprint: SprintNumber, owner?: OwnerId): Story[] {
  return STORIES.filter((s) => s.sprint === sprint && (owner ? s.owner === owner : true));
}

export interface Stats {
  total: number;
  hecho: number;
  en_curso: number;
  bloqueada: number;
  pendiente: number;
  /** 0..1 */
  progress: number;
}

export function stats(list: readonly Story[]): Stats {
  const count = (st: Status) => list.filter((s) => s.status === st).length;
  const total = list.length;
  const hecho = count("hecho");
  return {
    total,
    hecho,
    en_curso: count("en_curso"),
    bloqueada: count("bloqueada"),
    pendiente: count("pendiente"),
    progress: total ? hecho / total : 0,
  };
}

/** Rango de días estimado de una lista de historias. */
export function daysRange(list: readonly Story[]): [number, number] {
  return list.reduce<[number, number]>(
    (acc, s) => {
      if (!s.size) return acc;
      const [lo, hi] = SIZE_DAYS[s.size];
      return [acc[0] + lo, acc[1] + hi];
    },
    [0, 0],
  );
}

export function formatDays([lo, hi]: [number, number]): string {
  return lo === hi ? `${lo} d` : `${lo}–${hi} d`;
}

/** Ruta de la página donde vive una historia, con su ancla. */
export function storyHref(story: Story): string {
  const m = moduleByPrefix(story.module);
  const base = m.group === "construccion" ? `/${m.slug}` : `/${m.slug}`;
  return `${base}#${story.id}`;
}

/** Historias que esperan a esta. */
export function dependents(id: string): Story[] {
  return STORIES.filter((s) => s.deps.includes(id));
}

export function sprint(n: SprintNumber) {
  const sp = SPRINTS.find((s) => s.n === n);
  if (!sp) throw new Error(`No existe el sprint ${n}`);
  return sp;
}
