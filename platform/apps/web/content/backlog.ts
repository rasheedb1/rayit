// =====================================================================
// El backlog del MVP, con su estado vivo.
//
// La narrativa (por qué este reparto, las reglas, las dependencias)
// está en docs/backlog-mvp.md. Aquí vive lo que cambia cada día: el
// estado de cada historia.
//
// Para marcar avance, el dueño de la historia cambia `status` y, si
// hace falta, deja una `note` corta (qué falta, qué PR). Se sube en el
// mismo PR de la historia; el despliegue de main lo publica.
//
//   pendiente  → nadie la ha empezado
//   en_curso   → hay una rama abierta
//   bloqueada  → espera algo que no depende del dueño (dilo en la nota)
//   hecho      → cumple su «terminado cuando» y está en main
// =====================================================================
import type { OwnerId } from "./team";
import type { StoryPrefix } from "./modules";

export type Status = "pendiente" | "en_curso" | "bloqueada" | "hecho";
export type Size = "S" | "M" | "L";
export type SprintNumber = 1 | 2 | 3 | 4 | 5;

export interface Story {
  id: string;
  module: StoryPrefix;
  owner: OwnerId;
  /** S: un día o menos · M: dos o tres días · L: una semana · null: no es código */
  size: Size | null;
  sprint: SprintNumber;
  deps: string[];
  title: string;
  desc: string;
  /** Lo que se enseña en la demo del viernes. */
  done: string;
  status: Status;
  note?: string;
}

export interface Sprint {
  n: SprintNumber;
  weeks: string;
  name: string;
  demo: string;
}

export const SPRINTS: readonly Sprint[] = [
  {
    n: 1,
    weeks: "Semanas 1 y 2",
    name: "Cimientos y las primeras piezas de cada cadena",
    demo: "Login y marco; seeds cargados; empresas y radar manual (Rasheed); primera factura a mano y el worker corriendo un job (Nicolás).",
  },
  {
    n: 2,
    weeks: "Semanas 3 y 4",
    name: "Resumen con datos, pipeline, primera cuenta conectada",
    demo: "Resumen con seed y con un CSV real de Instagram; pipeline kanban (Rasheed). Conectar una cuenta de TikTok sandbox; ficha de campaña con posts del seed (Nicolás).",
  },
  {
    n: 3,
    weeks: "Semanas 5 y 6",
    name: "Métricas reales, ficha de empresa, cotizar y cobrar",
    demo: "Ficha de empresa con siguiente acción; tarifario y media kit público (Rasheed). El recolector trayendo métricas reales de la cuenta conectada, línea base, pagos y cuentas por cobrar (Nicolás).",
  },
  {
    n: 4,
    weeks: "Semanas 7 y 8",
    name: "El ciclo completo",
    demo: "Cotización enviada y aceptada crea la campaña (Rasheed); la campaña mide seguidores de la marca, calcula el resultado y envía el reporte; flujo de caja (Nicolás). Pitch trazable (Rasheed).",
  },
  {
    n: 5,
    weeks: "Semanas 9 y 10",
    name: "Lo que depende de aprobaciones, y el piloto",
    demo: "Pantalla de conexiones, demografía, YouTube, recordatorios de cobro (Nicolás). Lo que importa esta semana, cuándo publicar, brief y conversión (Rasheed). Producción abierta a los primeros creadores.",
  },
];

export const STORIES: readonly Story[] = [
  // ---------------------------------------------------------------- CIM
  {
    id: "CIM-1", module: "CIM", owner: "rasheed", size: "M", sprint: 1, deps: [],
    title: "Monorepo listo",
    desc: "apps/web con Next.js + TypeScript, packages/db con Drizzle, apps/worker con pg-boss, turbo corriendo dev, typecheck, lint y test. Un package.json por paquete.",
    done: "make dev levanta los tres procesos y pnpm turbo run typecheck lint pasa en CI.",
    status: "en_curso",
    note: "apps/web ya existe y pasa typecheck, lint y build. Faltan packages/db y apps/worker.",
  },
  {
    id: "CIM-2", module: "CIM", owner: "rasheed", size: "M", sprint: 1, deps: ["CIM-1"],
    title: "Cliente de base con aislamiento (RLS)",
    desc: "Cada consulta corre en una transacción que fija app.workspace_id con set_config(…, true), contra el pooler en modo transacción. Esquema Drizzle generado desde las migraciones para las tablas del MVP.",
    done: "Un test crea dos workspaces, inserta un deal en cada uno y comprueba que ninguno ve el del otro. Sin workspace_id fijado, la consulta devuelve cero filas.",
    status: "pendiente",
  },
  {
    id: "CIM-3", module: "CIM", owner: "rasheed", size: "M", sprint: 1, deps: ["CIM-2"],
    title: "Autenticación y workspaces",
    desc: "Supabase Auth con correo y enlace mágico. Al entrar se crea app_user y membership; si no hay workspace, se crea uno de tipo creador con su creator_profile. Cambio de workspace en la barra.",
    done: "Se entra con un correo nuevo y aparece un workspace vacío con nombre; se entra con uno del seed y aparece la creadora ficticia.",
    status: "pendiente",
  },
  {
    id: "CIM-4", module: "CIM", owner: "nicolas", size: "M", sprint: 1, deps: [],
    title: "Marco de la aplicación y navegación",
    desc: "Layout, navegación con los módulos del MVP, los de fase 2 ocultos tras una bandera, tema claro y oscuro, dirección visual minimalista. Cada módulo con su ruta.",
    done: "Se navega entre los módulos, el tema se conserva al recargar, y una bandera apagada quita el módulo del menú.",
    status: "en_curso",
    note: "Marco desplegado el 21 de septiembre. Las banderas viven en content/flags.ts hasta que exista el cliente de base. Nicolás lo revisa y lo cierra.",
  },
  {
    id: "CIM-5", module: "CIM", owner: "nicolas", size: "L", sprint: 1, deps: ["CIM-4"],
    title: "Kit de interfaz compartido",
    desc: "Fila de KPIs con delta y sparkline, tabla con «Ver tabla» sobre cada gráfico, gráfico de líneas y de barras con tooltip, estado vacío, aviso «datos hasta el {fecha}», formulario con validación, botón de acción principal.",
    done: "Una página de galería (/kit) muestra cada componente con datos de ejemplo, en claro y oscuro.",
    status: "pendiente",
  },
  {
    id: "CIM-6", module: "CIM", owner: "rasheed", size: "S", sprint: 1, deps: ["CIM-2"],
    title: "Seed de ventas y métricas",
    desc: "Ocho empresas, quince deals repartidos por etapa, actividades; cuatro conexiones (una por red), sesenta posts, noventa días de snapshots con curvas verosímiles y una línea base calculada. Idempotente.",
    done: "make seed deja Ventas y Resumen con los mismos números que el mock.",
    status: "pendiente",
  },
  {
    id: "CIM-7", module: "CIM", owner: "rasheed", size: "S", sprint: 1, deps: ["CIM-1"],
    title: "Despliegue continuo",
    desc: "El repositorio de GitHub conectado al proyecto de Vercel para que cada merge a main publique solo; el worker corre en Railway o Fly con las variables del vault.",
    done: "Un merge a main aparece en la URL sin correr ningún comando.",
    status: "en_curso",
    note: "La web ya despliega con make vercel.deploy PROD=1. Falta conectar GitHub al proyecto de Vercel y desplegar el worker.",
  },
  {
    id: "CIM-8", module: "CIM", owner: "nicolas", size: "S", sprint: 1, deps: ["CIM-2"],
    title: "Seed de finanzas y campañas",
    desc: "Tres facturas (una vencida), pagos, gastos recurrentes, dos campañas con posts asociados y snapshots de seguidores de la marca. Números tomados del mock. Idempotente.",
    done: "make seed deja Finanzas y Campañas con los mismos números que el mock.",
    status: "pendiente",
  },

  // ---------------------------------------------------------------- CON
  {
    id: "CON-1", module: "CON", owner: "nicolas", size: "L", sprint: 2, deps: ["CIM-1"],
    title: "Conectores con respuestas grabadas",
    desc: "Cliente para TikTok Display, TikTok Accounts, Instagram Graph y YouTube Data + Analytics. Reintentos, respeto de cuota, registro en api_call_log y api_quota_usage. Fixtures para las pruebas.",
    done: "pnpm test pasa sin red y cada llamada deja su fila en api_call_log.",
    status: "pendiente",
  },
  {
    id: "CON-2", module: "CON", owner: "nicolas", size: "M", sprint: 1, deps: ["CIM-1"],
    title: "Worker arrancado y oauth.refresh",
    desc: "pg-boss sobre la base, job_definition cargado, job_run registrando duración y errores. El job oauth.refresh renueva tokens antes de que venzan. Cada job vive en la carpeta de su módulo.",
    done: "make worker toma un job de la cola, lo registra, y un token con access_expires_at cercano se renueva solo.",
    status: "pendiente",
  },
  {
    id: "CON-3", module: "CON", owner: "nicolas", size: "L", sprint: 2, deps: ["CON-1", "CIM-3"],
    title: "OAuth de TikTok e Instagram en sandbox",
    desc: "Callback, cifrado del token con TOKEN_ENCRYPTION_KEY, secret_ref en social_connection, data_consent con la evidencia. Necesita acceso de desarrollador a las apps de TikTok y Meta (lo da Rasheed).",
    done: "Conectar una cuenta de prueba deja la fila con sus scopes y el token no aparece en claro en ninguna tabla.",
    status: "pendiente",
  },
  {
    id: "CON-4", module: "CON", owner: "nicolas", size: "M", sprint: 5, deps: ["CON-3", "CIM-5"],
    title: "Pantalla Conexiones",
    desc: "Lista sobre connection_health, botón para conectar cada red, estado (activa, vencida, necesita reautorizar), horas desde la última sincronización, y el paso manual «activa Analytics en TikTok».",
    done: "Una conexión con token vencido se ve en rojo con el botón de reautorizar.",
    status: "pendiente",
  },
  {
    id: "CON-5", module: "CON", owner: "nicolas", size: "L", sprint: 3, deps: ["CON-1", "CON-2"],
    title: "Recolector de posts y métricas",
    desc: "collect.posts descubre videos nuevos; collect.post_metrics y collect.account_metrics guardan el snapshot con age_hours. Append-only.",
    done: "Dos corridas seguidas producen dos filas por post y post_metrics_daily_delta muestra el crecimiento.",
    status: "pendiente",
  },
  {
    id: "CON-6", module: "CON", owner: "nicolas", size: "M", sprint: 3, deps: ["CON-5"],
    title: "Línea base y puntaje",
    desc: "compute.baseline (mediana por red y corte de edad) y compute.post_score. Con menos de ocho videos, is_reliable = false. Usa packages/core/scoring.ts, que ya existe.",
    done: "Un post con el doble de views que la mediana queda con outlier_tier = outlier.",
    status: "pendiente",
  },
  {
    id: "CON-7", module: "CON", owner: "nicolas", size: "M", sprint: 5, deps: ["CON-5"],
    title: "Demografía de audiencia",
    desc: "collect.demographics por cuenta, respetando metric_requirement: si falta un prerrequisito, lo explica en vez de dejar la celda vacía.",
    done: "Con la respuesta grabada, la tabla coincide con el fixture; con una cuenta personal de TikTok, dice por qué no hay demografía.",
    status: "pendiente",
  },
  {
    id: "CON-8", module: "CON", owner: "nicolas", size: "M", sprint: 5, deps: ["CON-3"],
    title: "OAuth de YouTube",
    desc: "Mismo flujo que CON-3 para un canal de prueba.",
    done: "Conectar un canal de prueba deja la fila con sus scopes y el token cifrado.",
    status: "pendiente",
  },
  {
    id: "CON-9", module: "CON", owner: "rasheed", size: null, sprint: 1, deps: [],
    title: "Trámites de plataforma",
    desc: "Formulario de Accounts API de TikTok, App Review + Business Verification de Meta, auditoría de Google. No es código: es el camino crítico, y lo hace quien tiene las cuentas de empresa. Se inicia el día 1.",
    done: "Los tres iniciados en la semana 1, con fecha y número de caso en docs/tramites.md.",
    status: "pendiente",
  },

  // ---------------------------------------------------------------- RES
  {
    id: "RES-1", module: "RES", owner: "rasheed", size: "L", sprint: 2, deps: ["CIM-5", "CIM-6"],
    title: "Pantalla Resumen",
    desc: "Los cuatro KPIs (seguidores, views en 30 días, alcance en no seguidores, guardados por mil), seguidores por red en 90 días, views por semana y red en 12 semanas. Filtro por red. Aviso «datos hasta el {fecha}» por conexión.",
    done: "Con el seed, la pantalla coincide con el mock; con una conexión sin datos, muestra el estado vacío y no un cero.",
    status: "pendiente",
  },
  {
    id: "RES-2", module: "RES", owner: "rasheed", size: "M", sprint: 2, deps: ["CIM-5"],
    title: "Importación por CSV",
    desc: "El creador exporta desde TikTok Studio, Instagram Insights o YouTube Studio y sube el archivo; se convierte en snapshots con source = csv_import. Es la vía mientras no hay aprobaciones.",
    done: "Un CSV real de Instagram Insights llena post_metric_snapshot y aparece en Resumen.",
    status: "pendiente",
  },
  {
    id: "RES-3", module: "RES", owner: "rasheed", size: "M", sprint: 5, deps: ["CON-6", "VEN-4", "FIN-4"],
    title: "Lo que importa esta semana",
    desc: "Lista generada desde los datos: outliers nuevos, conexión con error, factura vencida, deal con seguimiento vencido. Lee notification.",
    done: "Las cuatro fuentes producen su fila y cada una lleva a su módulo.",
    status: "pendiente",
  },
  {
    id: "RES-4", module: "RES", owner: "rasheed", size: "S", sprint: 5, deps: ["CON-7"],
    title: "Demografía y cuándo publicar, en pantalla",
    desc: "El bloque de audiencia por edad, género y país, y el de «cuándo publicar» (seguidores conectados por hora, Instagram), sobre lo que recolecta CON-7.",
    done: "El gráfico por hora coincide con el fixture; si la cuenta no da demografía, la pantalla explica por qué.",
    status: "pendiente",
  },

  // ---------------------------------------------------------------- VEN
  {
    id: "VEN-1", module: "VEN", owner: "rasheed", size: "M", sprint: 1, deps: ["CIM-2", "CIM-5"],
    title: "Empresas y contactos",
    desc: "Crear, editar, buscar por nombre (el índice trigram ya existe), company_link con relationship y dueño. Un contacto exige source; sin procedencia no se guarda.",
    done: "Se crea una empresa con dos contactos y aparece en la búsqueda al tercer carácter.",
    status: "pendiente",
  },
  {
    id: "VEN-2", module: "VEN", owner: "rasheed", size: "M", sprint: 1, deps: ["VEN-1"],
    title: "Radar manual y por CSV",
    desc: "Bandeja de signal con estado pendiente, aceptar (crea o actualiza empresa y deal en nuevo) o descartar con motivo. Fuente manual y carga por CSV de una lista de marcas. Las fuentes automáticas quedan para fase 2.",
    done: "Aceptar una señal crea el deal con «Enviar pitch» como siguiente acción; descartarla la saca de la bandeja y no vuelve a entrar (dedupe_key).",
    status: "pendiente",
  },
  {
    id: "VEN-3", module: "VEN", owner: "rasheed", size: "L", sprint: 2, deps: ["VEN-1"],
    title: "Pipeline kanban y lista",
    desc: "Tablero por etapa y vista de lista sobre deal_pipeline. Arrastrar cambia la etapa y escribe deal_stage_history con los días en la etapa. KPIs: deals abiertos, cierre ponderado, ganado en el trimestre.",
    done: "Mover un deal a «Ganado» fija won_at; el cierre ponderado cambia al mover entre etapas.",
    status: "pendiente",
  },
  {
    id: "VEN-4", module: "VEN", owner: "rasheed", size: "M", sprint: 3, deps: ["VEN-3", "CON-2"],
    title: "Siguiente acción y seguimientos",
    desc: "Cada deal abierto tiene acción, fecha y responsable. Lista «vencidos hoy» arriba del pipeline. El job ventas/seguimientos.ts crea la notification de tipo deal_due y deal_overdue cada mañana.",
    done: "Un deal sin siguiente acción se ve marcado; uno vencido aparece en la lista y en la campana.",
    status: "pendiente",
  },
  {
    id: "VEN-5", module: "VEN", owner: "rasheed", size: "L", sprint: 3, deps: ["VEN-3"],
    title: "Ficha de empresa",
    desc: "Cabecera, contactos, línea de tiempo de activity (nota, correo, llamada, reunión, cambio de etapa), «lo que sabemos» (señales), y la cadena deal → cotización → campaña → factura con enlaces.",
    done: "Registrar una llamada la pone en la línea de tiempo y actualiza last_contact_at.",
    status: "pendiente",
  },
  {
    id: "VEN-6", module: "VEN", owner: "rasheed", size: "M", sprint: 4, deps: ["COT-2", "VEN-5"],
    title: "Pitch con afirmaciones trazables",
    desc: "Borrador de correo a partir de la señal, el media kit y la última campaña. Cada cifra apunta a su origen en claims. Se guarda como outbound_touch en draft y se copia al portapapeles: no se envía desde la plataforma en el MVP.",
    done: "Un pitch con una cifra sin origen no se puede marcar como listo.",
    status: "pendiente",
  },
  {
    id: "VEN-7", module: "VEN", owner: "rasheed", size: "S", sprint: 5, deps: ["VEN-2"],
    title: "Brief de outbound",
    desc: "Qué busca el creador (categorías, países, presupuesto mínimo, entregables) y qué no acepta. Filtra la bandeja del radar.",
    done: "Una señal de una categoría excluida no aparece en la bandeja.",
    status: "pendiente",
  },
  {
    id: "VEN-8", module: "VEN", owner: "rasheed", size: "S", sprint: 5, deps: ["VEN-3"],
    title: "Deal perdido y conversión por etapa",
    desc: "Motivo de pérdida, y tasa de conversión por etapa desde deal_stage_history.",
    done: "La tasa entre etapas aparece en el pipeline con el número de deals que la sostiene.",
    status: "pendiente",
  },

  // ---------------------------------------------------------------- COT
  {
    id: "COT-1", module: "COT", owner: "rasheed", size: "M", sprint: 3, deps: ["CIM-2"],
    title: "Tarifario sugerido",
    desc: "packages/core/tarifas.ts calcula el rango por entregable desde views promedio × CPM de niche_cpm_benchmark, con modificadores (derechos de uso, exclusividad). Las views vienen de creator_baseline si existe y es confiable; si no, el creador las escribe y quedan marcadas como manuales.",
    done: "Con las views del mock salen los rangos del mock; cambiar el CPM cambia el rango y la explicación lo dice.",
    status: "pendiente",
  },
  {
    id: "COT-2", module: "COT", owner: "rasheed", size: "M", sprint: 3, deps: ["COT-1", "RES-1"],
    title: "Media kit público",
    desc: "Foto congelada de los números en media_kit.snapshot, página pública por slug, opcional con contraseña y vencimiento. Contador de vistas.",
    done: "El enlace abre sin sesión, muestra las cifras congeladas, y no cambia aunque cambien las métricas.",
    status: "pendiente",
  },
  {
    id: "COT-3", module: "COT", owner: "rasheed", size: "L", sprint: 4, deps: ["COT-1", "VEN-3"],
    title: "Cotización",
    desc: "Crear desde un deal, ítems desde el tarifario, subtotal, descuento, impuesto y total. Lo que se acuerda antes de publicar: métricas a reportar, cortes (24 h, 7 d, 30 d), derechos, exclusividad, plazo de pago. Numeración COT-2026-014.",
    done: "Enviar pasa el deal a «Propuesta enviada»; la cotización tiene su enlace público.",
    status: "pendiente",
  },
  {
    id: "COT-4", module: "COT", owner: "rasheed", size: "M", sprint: 4, deps: ["COT-3", "CAM-2"],
    title: "Aceptación crea la campaña",
    desc: "Al marcar aceptada, llama a createCampaignFromQuote() de queries/campanas.ts (la escribe Nicolás en CAM-2) y pasa el deal a «Ganado». Es el punto de cruce entre las dos cadenas.",
    done: "Aceptar una cotización deja una campaña en planned y Nicolás la ve en su módulo sin tocar nada.",
    status: "pendiente",
  },

  // ---------------------------------------------------------------- CAM
  {
    id: "CAM-1", module: "CAM", owner: "nicolas", size: "M", sprint: 2, deps: ["CIM-5", "CIM-6"],
    title: "Lista y ficha de campaña",
    desc: "Estado, entregables, fechas, posts asociados (elegidos a mano de creator_post_board o detectados por fecha y mención), código y enlace de seguimiento. Desde la ficha se crea la factura (FIN-1).",
    done: "Se asocian dos posts a una campaña y aparecen con sus views actuales.",
    status: "pendiente",
  },
  {
    id: "CAM-2", module: "CAM", owner: "nicolas", size: "S", sprint: 2, deps: ["CAM-1"],
    title: "Crear campaña desde la cotización",
    desc: "createCampaignFromQuote() en queries/campanas.ts: crea la campaña con quote_id, agreed_metrics, fechas y brand_baseline_from catorce días antes. Es el contrato con Cotizar: Rasheed la llama desde COT-4.",
    done: "Rasheed la usa en COT-4 sin pedir cambios.",
    status: "pendiente",
  },
  {
    id: "CAM-3", module: "CAM", owner: "nicolas", size: "M", sprint: 4, deps: ["CON-1", "CON-2"],
    title: "Seguidores de la marca",
    desc: "brand.snapshot diario del perfil público de la marca (Business Discovery en Instagram, canal en YouTube), desde brand_baseline_from.",
    done: "La curva de seguidores de la marca sale del snapshot con su línea base de dos semanas.",
    status: "pendiente",
  },
  {
    id: "CAM-4", module: "CAM", owner: "nicolas", size: "S", sprint: 4, deps: ["CAM-1"],
    title: "Lo que aporta la marca",
    desc: "Canjes del código, pedidos, ingresos, por formulario o CSV, en campaign_brand_input.",
    done: "Subir un CSV de ventas diarias llena la tabla y aparece en la ficha.",
    status: "pendiente",
  },
  {
    id: "CAM-5", module: "CAM", owner: "nicolas", size: "M", sprint: 4, deps: ["CAM-3", "CAM-4", "CON-6"],
    title: "Resultado de campaña",
    desc: "campaign.compute llena campaign_result con views, alcance, clics, canjes, seguidores ganados por la marca frente a su ritmo previo, CPM y CPA reales, y views_vs_median. missing_inputs dice qué falta.",
    done: "Los seis KPIs salen de la tabla; si no hay datos de la marca, la celda dice «sin datos de la marca», no cero.",
    status: "pendiente",
  },
  {
    id: "CAM-6", module: "CAM", owner: "nicolas", size: "L", sprint: 4, deps: ["CAM-5"],
    title: "Reporte a la marca",
    desc: "Página pública por slug con el payload congelado, «acordado antes de publicar» arriba, envío por enlace o PDF, sent_at y viewed_at. Registra activity de tipo report_sent.",
    done: "El reporte enviado no cambia aunque lleguen snapshots nuevos; la marca lo abre sin sesión.",
    status: "pendiente",
  },

  // ---------------------------------------------------------------- FIN
  {
    id: "FIN-1", module: "FIN", owner: "nicolas", size: "M", sprint: 1, deps: ["CIM-2", "CIM-5"],
    title: "Facturas",
    desc: "Crear desde una campaña o a mano, con subtotal, IVA, retención en la fuente, total, fecha de emisión y vencimiento, numeración por workspace. Estados draft → sent → partial/paid → overdue. Campo para el número de la factura electrónica DIAN.",
    done: "Una factura creada desde una campaña trae nombre, empresa y monto sin escribirlos.",
    status: "pendiente",
  },
  {
    id: "FIN-2", module: "FIN", owner: "nicolas", size: "M", sprint: 3, deps: ["FIN-1"],
    title: "Pagos y reserva de impuestos",
    desc: "Registrar un pago contra una factura (parcial o total), método y referencia. Actualiza paid_amount, status y paid_at. Crea tax_reserve con el porcentaje configurado del workspace.",
    done: "Registrar un pago parcial deja la factura en partial; el total la pasa a paid y aparta el impuesto.",
    status: "pendiente",
  },
  {
    id: "FIN-3", module: "FIN", owner: "nicolas", size: "M", sprint: 3, deps: ["FIN-1"],
    title: "Cuentas por cobrar",
    desc: "Tabla sobre receivables con aging_bucket, y los cuatro KPIs: por cobrar, vencido, cobrado en el año, apartado para impuestos.",
    done: "Con el seed, coincide con el mock; la factura vencida sale en rojo con sus días.",
    status: "pendiente",
  },
  {
    id: "FIN-4", module: "FIN", owner: "nicolas", size: "M", sprint: 5, deps: ["FIN-1", "CON-2"],
    title: "Recordatorios de cobro",
    desc: "Job finanzas/recordatorios.ts que, a los 7 días antes, el día y a los 7, 21 y 45 después del vencimiento, redacta el correo, lo guarda como notification de tipo invoice_overdue y lo deja listo para copiar. Envío automático real en fase 2.",
    done: "Una factura vencida hace 41 días tiene sus tres recordatorios en la bandeja con reminders_sent = 3.",
    status: "pendiente",
  },
  {
    id: "FIN-5", module: "FIN", owner: "nicolas", size: "S", sprint: 3, deps: ["CIM-5"],
    title: "Gastos",
    desc: "Registro con categoría, proveedor, monto, fecha, recurrente o no, foto del recibo en S3, deducible. Lista por mes.",
    done: "Un gasto recurrente aparece proyectado en las ocho semanas siguientes.",
    status: "pendiente",
  },
  {
    id: "FIN-6", module: "FIN", owner: "nicolas", size: "M", sprint: 4, deps: ["FIN-2", "FIN-5", "VEN-3"],
    title: "Flujo de caja proyectado",
    desc: "packages/core/flujo-caja.ts combina cobros esperados (facturas por due_on, deals ganados sin factura por expected_close_date y plazo de pago) menos gastos recurrentes y reserva de impuestos, por semana, ocho semanas. Gráfico y tabla.",
    done: "El gráfico sale de la función con los datos del seed; un test cubre una semana con cobro, gasto e impuesto.",
    status: "pendiente",
  },
  {
    id: "FIN-7", module: "FIN", owner: "nicolas", size: "S", sprint: 5, deps: ["FIN-6"],
    title: "Ingresos de plataformas",
    desc: "Carga manual o CSV de Creator Rewards, AdSense y bonos en platform_payout. Entra al flujo de caja.",
    done: "Un CSV de AdSense aparece como ingreso en su mes.",
    status: "pendiente",
  },
  {
    id: "FIN-8", module: "FIN", owner: "nicolas", size: "S", sprint: 5, deps: ["CIM-3"],
    title: "Configuración financiera",
    desc: "Moneda, porcentaje de reserva de impuestos, IVA y retención por defecto, datos fiscales para la factura. En workspace.settings.",
    done: "Cambiar el porcentaje cambia la reserva de los pagos siguientes, no de los anteriores.",
    status: "pendiente",
  },
];
