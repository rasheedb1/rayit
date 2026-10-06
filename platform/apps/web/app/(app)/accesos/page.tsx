import type { Metadata } from "next";
import { admiteCasillas, can, CASILLAS, casillasDe, INVITACION_VIGENCIA_DIAS, NOMBRES_DE_CASILLA, permisosQueFaltan } from "@mc/core";
import { getTeamWorkspaceKind, listMembers, listPendingInvitations, listTeamRoles } from "@mc/db/queries/equipo";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { requireModuleAccess } from "@/lib/permisos/modulo";
import { permisosDeLaSesion } from "@/lib/permisos/sesion";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "./_lib/messages";
import { AccionesInvitacion, CambiarRol, InvitarForm, QuitarMiembro, type CasillaOpcion, type RolOpcion } from "./formularios";

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

  const { miembros, pendientes, roles, kind } = await withWorkspace(async (tx) => ({
    miembros: await listMembers(tx),
    pendientes: await listPendingInvitations(tx),
    roles: await listTeamRoles(tx),
    kind: await getTeamWorkspaceKind(tx),
  }));

  const puedeInvitar = can(permisos, "equipo.miembro.invitar");
  const puedeEditar = can(permisos, "equipo.rol.editar");
  const puedeQuitar = can(permisos, "equipo.miembro.revocar");
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
   * «Quitar» (sale deshabilitado con el motivo). Cortesía: la acción y el
   * disparador membership_keeps_an_owner siguen siendo la barrera real.
   */
  const esUnicoDueno = miembros.filter((m) => m.roleKey === "owner").length === 1;

  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.titulo} description={t.descripcion} />

      {puedeInvitar ? (
        <section className="mb-12 max-w-3xl">
          <SectionTitle meta={t.invitar.descripcion(INVITACION_VIGENCIA_DIAS)}>{t.invitar.titulo}</SectionTitle>
          <InvitarForm roles={rolesOtorgables} casillas={casillas} fechas={fechas} />
        </section>
      ) : (
        <p className="mb-8 max-w-3xl rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink-2">{t.soloVer}</p>
      )}

      <section className="mb-12 max-w-3xl">
        <SectionTitle meta={t.miembros.meta(miembros.length)}>{t.miembros.titulo}</SectionTitle>
        <ul className="overflow-hidden rounded-md border border-border">
          {miembros.map((m) => {
            const tocable = puedeTocar(m.roleId, m.extraPermissions);
            const quien = m.name ?? m.email;
            const ultimoDueno = esUnicoDueno && m.roleKey === "owner";
            return (
              <li key={m.userId} className="flex flex-col gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                    <span className="min-w-0 truncate">{quien}</span>
                    {m.isMe && <Pill kind="neutral">{t.miembros.tu}</Pill>}
                  </p>
                  {m.name && <p className="truncate text-xs text-muted">{m.email}</p>}
                  <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
                    <span>{m.roleLabel}</span>
                    {casillasDe(m.extraPermissions).map((c) => (
                      <Pill key={c} kind="warn">
                        {t.casillas[c].corta}
                      </Pill>
                    ))}
                    <span className="text-muted">· {t.miembros.desde(fmt.date(m.joinedAt, "long"))}</span>
                  </p>
                </div>
                {tocable && (puedeEditar || puedeQuitar) && (
                  <div className="flex shrink-0 flex-wrap items-start gap-2 sm:max-w-sm sm:justify-end">
                    {/* A la única dueña no se le ofrece cambiar de rol: el
                        único cambio posible sería degradarla, y la base lo para. */}
                    {puedeEditar && !ultimoDueno && (
                      <CambiarRol
                        userId={m.userId}
                        roleId={m.roleId}
                        marcadas={casillasDe(m.extraPermissions)}
                        roles={rolesOtorgables}
                        casillas={casillas}
                      />
                    )}
                    {puedeQuitar && <QuitarMiembro userId={m.userId} quien={quien} unicoDueno={ultimoDueno} />}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="max-w-3xl">
        <SectionTitle>{t.pendientes.titulo}</SectionTitle>
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
      </section>
    </>
  );
}
