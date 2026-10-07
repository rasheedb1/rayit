import type { Metadata } from "next";
import {
  admiteCasillas,
  can,
  CASILLAS,
  casillasDe,
  esUltimoDueno,
  INVITACION_VIGENCIA_DIAS,
  NOMBRES_DE_CASILLA,
  permisosQueFaltan,
} from "@mc/core";
import {
  getTeamWorkspaceKind,
  listMembers,
  listPendingInvitations,
  listTeamRoles,
  sessionHasScope,
  type TeamMember,
} from "@mc/db/queries/equipo";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { requireModuleAccess } from "@/lib/permisos/modulo";
import { permisosDeLaSesion } from "@/lib/permisos/sesion";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "./_lib/messages";
import { AccionesInvitacion, CambiarRol, InvitarForm, QuitarMiembro, type CasillaOpcion, type RolOpcion } from "./formularios";
import { AvisoDeSalidas } from "./salidas";

const t = MESSAGES;

export const metadata: Metadata = { title: t.meta };
// Lee la sesión y la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/**
 * Equipo (ACC-4): quién está en el espacio, a quién se invitó, e
 * invitar, cambiar el rol y quitar. Es la pantalla real del módulo
 * Accesos (antes, su plan de construcción, que sigue en /plan/accesos).
 *
 * Qué se OFRECE depende de los permisos de quien mira: solo los roles y
 * las casillas que puede dar, y los botones de una persona solo si
 * puede tocarla (tiene todo lo que ella tiene). Es cortesía: la Server
 * Action lo vuelve a comprobar y la base, otra vez (0078).
 */
export default async function EquipoPage() {
  await requireModuleAccess("accesos");
  const permisos = await permisosDeLaSesion();
  const ws = await getCurrentWorkspace();
  const fmt = formatterFor(ws);
  const fechas = { locale: fmt.locale, timeZone: fmt.timeZone };

  const { miembros, pendientes, roles, kind, acotada } = await withWorkspace(async (tx) => ({
    miembros: await listMembers(tx),
    pendientes: await listPendingInvitations(tx),
    roles: await listTeamRoles(tx),
    kind: await getTeamWorkspaceKind(tx),
    acotada: await sessionHasScope(tx),
  }));

  // Con alcance limitado (ACC-6) no se administra el equipo (0079 §6):
  // ni invitar, ni cambiar, ni quitar, aunque el rol tenga el permiso.
  const puedeInvitar = !acotada && can(permisos, "equipo.miembro.invitar");
  const puedeEditar = !acotada && can(permisos, "equipo.rol.editar");
  const puedeQuitar = !acotada && can(permisos, "equipo.miembro.revocar");
  const otorga = (pedidos: Iterable<string>) => permisosQueFaltan(permisos, pedidos).length === 0;

  const rolesOtorgables: RolOpcion[] = roles
    .filter((r) => otorga(r.permissions))
    .map((r) => ({ id: r.id, label: r.label, description: r.description, conCasillas: admiteCasillas(kind, r.key) }));
  const casillas: CasillaOpcion[] = NOMBRES_DE_CASILLA.map((c) => ({ casilla: c, disponible: otorga(CASILLAS[c]) }));
  const permisosDelRol = new Map(roles.map((r) => [r.id, r.permissions]));
  /** ¿Puede quien mira tocar a esta persona? Solo si tiene todo lo que ella tiene. */
  const puedeTocar = (roleId: string, extras: readonly string[]) => otorga([...(permisosDelRol.get(roleId) ?? []), ...extras]);
  /**
   * Si hay una sola persona con rol de Dueño, a esa fila no se le ofrece
   * «Quitar» (sale deshabilitado con el motivo) ni «Cambiar rol».
   * Cortesía: la acción y el disparador membership_keeps_an_owner siguen
   * siendo la barrera real.
   */
  const duenos = miembros.filter((m) => m.roleKey === "owner").map((m) => m.userId);

  /** Cambiar rol y Quitar de una persona, o nada si quien mira no puede tocarla. */
  function acciones(m: TeamMember) {
    if (!puedeTocar(m.roleId, m.extraPermissions) || !(puedeEditar || puedeQuitar)) return null;
    const ultimoDueno = esUltimoDueno(duenos, m.userId);
    return (
      <div className="flex flex-wrap items-start gap-2">
        {/* A la única dueña no se le ofrece cambiar de rol: el único
            cambio posible sería degradarla, y la base lo para. */}
        {puedeEditar && !ultimoDueno && (
          <CambiarRol userId={m.userId} roleId={m.roleId} marcadas={casillasDe(m.extraPermissions)} roles={rolesOtorgables} casillas={casillas} />
        )}
        {puedeQuitar && <QuitarMiembro userId={m.userId} quien={m.name ?? m.email} unicoDueno={ultimoDueno} />}
      </div>
    );
  }

  /**
   * Personas, con la tabla del kit y DOS columnas, Persona y Rol, para
   * que a 400 px todo quepa sin desplazar la tabla de lado. La fecha de
   * alta va bajo el correo («Desde el …») y las acciones, en una fila
   * propia bajo la persona: a cualquier ancho «Cambiar rol» y «Quitar»
   * están a la vista, y el formulario de Cambiar rol se abre con el
   * ancho de la celda, no apretado en una columna de acciones. Una sola
   * copia de cada acción (nada de una versión escondida para móvil): el
   * foco, los avisos y las pruebas ven un único botón.
   */
  const columnas: Column<TeamMember>[] = [
    {
      key: "persona",
      header: t.miembros.columnas.persona,
      render: (m) => (
        <div className="grid min-w-0 gap-2">
          <CellMain
            sub={
              <>
                {m.name && <span className="block break-all">{m.email}</span>}
                <span className="block tabular-nums">{t.miembros.desde(fmt.date(m.joinedAt, "long"))}</span>
              </>
            }
          >
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="min-w-0 break-all">{m.name ?? m.email}</span>
              {m.isMe && <Pill kind="neutral">{t.miembros.tu}</Pill>}
            </span>
          </CellMain>
          {acciones(m)}
        </div>
      ),
    },
    {
      key: "rol",
      header: t.miembros.columnas.rol,
      render: (m) => (
        <span className="flex flex-wrap items-center gap-1.5 text-ink-2">
          <span className="whitespace-nowrap">{m.roleLabel}</span>
          {casillasDe(m.extraPermissions).map((c) => (
            <Pill key={c} kind="warn">
              {t.casillas[c].corta}
            </Pill>
          ))}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.titulo} description={t.descripcion} />

      {puedeInvitar ? (
        <section className="mb-12 max-w-3xl">
          <SectionTitle meta={t.invitar.descripcion(INVITACION_VIGENCIA_DIAS)}>{t.invitar.titulo}</SectionTitle>
          <InvitarForm roles={rolesOtorgables} casillas={casillas} fechas={fechas} />
        </section>
      ) : (
        <p className="mb-8 max-w-3xl rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink-2">
          {acotada ? t.errores.scoped : t.soloVer}
        </p>
      )}

      <section className="mb-12 max-w-3xl">
        <AvisoDeSalidas
          filas={miembros.map((m) => ({ id: m.userId, aviso: t.miembros.quitado(m.name ?? m.email) }))}
          titulo={<SectionTitle meta={t.miembros.meta(miembros.length)}>{t.miembros.titulo}</SectionTitle>}
        >
          <DataTable
            caption={t.miembros.titulo}
            columns={columnas}
            rows={miembros}
            rowKey={(m) => m.userId}
            emptyState={null}
            stickyHeader={false}
          />
        </AvisoDeSalidas>
      </section>

      <section className="max-w-3xl">
        {/* Por correo y no por id, como la clave de cada fila: «Nuevo
            enlace» cambia el id de la invitación y no es una salida. */}
        <AvisoDeSalidas
          filas={pendientes.map((i) => ({ id: i.email, aviso: t.pendientes.revocada(i.email) }))}
          titulo={<SectionTitle>{t.pendientes.titulo}</SectionTitle>}
        >
        {/* Lista y no DataTable a propósito: «Nuevo enlace» pinta debajo de
            la fila el enlace recién creado, con su campo para copiar y su
            aviso del correo, a todo el ancho. En una celda de tabla ese
            bloque quedaría apretado en la columna de acciones. Mismos
            tokens que la tabla de Personas (border-border). */}
        {pendientes.length === 0 ? (
          <EmptyState title={t.pendientes.vacio} />
        ) : (
          <ul className="overflow-hidden rounded-md border border-border">
            {pendientes.map((i) => (
              // Por correo y no por id: «Nuevo enlace» revoca esta fila y
              // crea otra, y con la misma clave React conserva el enlace
              // recién creado en pantalla al repintar la lista.
              <li key={i.email} className="flex flex-col gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{i.email}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
                      <span>{i.roleLabel}</span>
                      {casillasDe(i.extraPermissions).map((c) => (
                        <Pill key={c} kind="warn">
                          {t.casillas[c].corta}
                        </Pill>
                      ))}
                      {i.invitedByName && <span className="text-muted">· {t.pendientes.invitadaPor(i.invitedByName)}</span>}
                    </p>
                  </div>
                  <span className="shrink-0">
                    {i.expired ? (
                      <Pill kind="bad">{t.pendientes.vencida}</Pill>
                    ) : (
                      <Pill kind="neutral">{t.pendientes.vence(fmt.date(i.expiresAt, "long"))}</Pill>
                    )}
                  </span>
                </div>
                {/* Revocar o renovar pide lo mismo que dar (0079 §2): la invitación
                    de un rol que quien mira no podría dar no se le ofrece. */}
                {puedeInvitar && puedeTocar(i.roleId, i.extraPermissions) && (
                  <AccionesInvitacion invitationId={i.id} correo={i.email} fechas={fechas} />
                )}
              </li>
            ))}
          </ul>
        )}
        </AvisoDeSalidas>
      </section>
    </>
  );
}
