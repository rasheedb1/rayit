import type { OwnerId } from "./team";

export interface Rule {
  path: string;
  owner: OwnerId | "modulo" | "archivo" | "quien-agrega";
  other: string;
}

export const RULES: readonly Rule[] = [
  { path: "platform/db/migrations/", owner: "rasheed", other: "Propone la migración en el PR; Rasheed la revisa y aplica." },
  { path: "platform/db/seed/", owner: "archivo", other: "0001_catalog y 0002_demo_ventas_metricas Rasheed · 0003_demo_finanzas_campanas Nicolás." },
  { path: "packages/db/src/client.ts, schema/", owner: "rasheed", other: "Pide cambios por PR." },
  { path: "packages/db/src/queries/<modulo>.ts", owner: "modulo", other: "El otro no lo toca." },
  { path: "packages/core/", owner: "archivo", other: "scoring.ts y flujo-caja.ts Nicolás · tarifas.ts Rasheed." },
  { path: "packages/connectors/", owner: "nicolas", other: "" },
  { path: "apps/worker/src/runner/", owner: "nicolas", other: "" },
  { path: "apps/worker/src/jobs/<modulo>/", owner: "modulo", other: "" },
  { path: "apps/web/app/(app)/<modulo>/", owner: "modulo", other: "" },
  { path: "apps/web/components/ui/", owner: "nicolas", other: "Se puede agregar un componente nuevo; para cambiar uno existente, PR revisado por Nicolás." },
  { path: "apps/web/content/backlog.ts", owner: "modulo", other: "Cada uno cambia el estado de sus propias historias." },
  { path: "apps/web/lib/auth/, lib/workspace/", owner: "rasheed", other: "" },
  { path: "apps/web/app/layout.tsx, components/shell.tsx, nav.tsx", owner: "nicolas", other: "" },
  { path: ".github/workflows/", owner: "rasheed", other: "" },
  { path: "package.json y pnpm-lock.yaml", owner: "quien-agrega", other: "Avisa en el daily." },
];

export const OWNER_RULE_LABEL: Record<Rule["owner"], string> = {
  rasheed: "Rasheed",
  nicolas: "Nicolás",
  modulo: "El dueño del módulo",
  archivo: "Por archivo",
  "quien-agrega": "Quien agrega la dependencia",
};

export const FLOW: readonly { title: string; body: string }[] = [
  { title: "Ramas cortas, una por historia", body: "Con el id delante: nicolas/CAM-3-seguidores-marca, rasheed/VEN-3-pipeline-kanban. Máximo tres días abiertas." },
  { title: "PR obligatorio, el otro revisa", body: "En menos de un día laborable. Si el PR toca solo tu carpeta, haces merge tras la revisión sin esperar cambios del otro." },
  { title: "CI verde antes de mergear", body: "Migraciones en Postgres embebido, typecheck, lint y pruebas." },
  { title: "main siempre despliega", body: "Cada merge publica esta URL. Lo que está a medias va detrás de una bandera, no de una rama larga." },
  { title: "Integración los viernes", body: "make dev con las dos cadenas juntas y una demo de cinco minutos cada uno." },
  { title: "Daily de quince minutos", body: "Qué terminé, qué sigo, qué me bloquea, y qué archivo compartido voy a tocar hoy. Esa última frase evita casi todos los conflictos." },
];

export const DEPENDENCIES: readonly { key: string; who: string; when: string; how: string }[] = [
  { key: "D1", who: "Todo lo de Nicolás que toca la base espera el monorepo y el cliente con RLS (CIM-1, CIM-2, Rasheed).", when: "Días 1 a 3", how: "Rasheed los entrega primero que nada, con un test. Nicolás arranca el kit de interfaz y el worker sin base esos tres días." },
  { key: "D2", who: "Las pantallas de Rasheed (Resumen, Ventas, Cotizar) esperan el kit de interfaz (CIM-5, Nicolás).", when: "Semana 1", how: "Rasheed hace base, auth, seeds y las consultas de Ventas en la semana 1; las pantallas las arma en la 2 con el kit ya listo." },
  { key: "D3", who: "Resumen y Campañas esperan datos de las plataformas, que esperan las aprobaciones.", when: "Semanas 1 a 8, quizá más", how: "Seed de métricas (CIM-6), importación por CSV (RES-2) y respuestas grabadas (CON-1)." },
  { key: "D4", who: "Cotizar quiere las views promedio del creador (creator_baseline, CON-6, Nicolás).", when: "Semana 5", how: "El tarifario acepta las views a mano, marcadas como manuales, y las reemplaza cuando exista la línea base (COT-1)." },
  { key: "D5", who: "Aceptar una cotización crea la campaña: Rasheed (COT-4) llama a la función de Nicolás (CAM-2).", when: "Semana 7", how: "CAM-2 se entrega en el sprint 2, mucho antes de que COT-4 la necesite. Se prueba juntos el lunes del sprint 4." },
  { key: "D6", who: "El job de seguimientos de Ventas (VEN-4) y «lo que importa esta semana» (RES-3) corren en el worker de Nicolás (CON-2).", when: "Semanas 5 y 9", how: "El runner existe desde la semana 1; cada job vive en la carpeta de su módulo." },
  { key: "D7", who: "El flujo de caja (FIN-6) lee los deals ganados de Rasheed (VEN-3).", when: "Semana 7", how: "Lee la vista deal_pipeline, que ya existe." },
];

export const DECISIONS: readonly { title: string; blocks: string[]; proposal: string; resolved?: string }[] = [
  {
    title: "Dirección visual",
    blocks: ["CIM-4"],
    proposal: "Geist, la del mock local, con Signal y Studio como temas opcionales.",
    resolved: "Resuelta el 21 de septiembre: minimalista, con Vercel y Notion como referencia. Es lo que ves aquí.",
  },
  {
    title: "Radar en el MVP",
    blocks: ["VEN-2"],
    proposal: "Arrancar con señales manuales y carga por CSV. Las fuentes automáticas son la primera historia de la fase 2, sobre la misma tabla signal.",
  },
  {
    title: "Autenticación",
    blocks: ["CIM-3"],
    proposal: "Supabase Auth con enlace mágico por correo: ya está pagado y vive sobre la misma base. Google como segundo método cuando pase la verificación.",
  },
  {
    title: "Dueño de los trámites",
    blocks: ["CON-9"],
    proposal: "Rasheed, con las cuentas de empresa, el lunes de la semana 1. Cada semana de retraso es una semana más de Resumen con CSV en vez de API.",
  },
  {
    title: "Acceso de Nicolás a las apps de TikTok y Meta",
    blocks: ["CON-3"],
    proposal: "Rasheed lo agrega como desarrollador en las dos apps la primera semana. Las llaves ya viajan en el vault.",
  },
];
