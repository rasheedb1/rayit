import type { Metadata } from "next";
import { casillasDe } from "@mc/core";
import { isInvitationToken, lookupInvitation, type InvitationClosedStatus } from "@mc/db/queries/equipo";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { isAuthConfigured } from "@/lib/auth/config";
import { lookupInvitationWithoutSession } from "@/lib/db";
import { withIdentity } from "@/lib/db/cliente";
import { formatterFor } from "@/lib/format";
import { MESSAGES } from "../../../(app)/accesos/_lib/messages";
import { AceptarInvitacion } from "./aceptar";
import { salirYVolver } from "./actions";
import { quienAcepta } from "./quien";

const t = MESSAGES.aceptar;

export const metadata: Metadata = { title: t.meta, referrer: "no-referrer" };
// Lee la sesión y la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/**
 * El enlace de una invitación de Equipo (ACC-4): /invitacion/<token>.
 *
 * Vive en su propio grupo, (invitacion), sin el marco de la aplicación:
 * quien lo abre puede no tener todavía ningún espacio, y lo primero que
 * ve un mánager de On Cue es la invitación, no el espacio de nadie.
 *
 * Pide sesión como el resto de la aplicación (no está en las rutas
 * públicas): sin ella el middleware manda a /login y vuelve aquí. Un
 * token sin la forma de newInvitationToken() dice «no es válido» antes
 * de pedir nada. En la demo (sin llaves de Auth) no hay cuentas: el
 * enlace se lee sin sesión y enseña lo que verá la persona invitada,
 * con un aviso en lugar del botón de aceptar. Abrir
 * el enlace NO acepta nada —solo lo lee, con invitation_lookup—; aceptar
 * es el botón. Sin `referrer`: el token va en la ruta y no tiene por qué
 * salir hacia ningún otro sitio.
 *
 * La fecha de vencimiento, en el locale y la zona del espacio que invita
 * (0079 §5), no en los de quien lo lee: el enlace vence
 * INVITACION_VIGENCIA_DIAS días después de crearse.
 *
 * Las casillas se cuentan desde el invitado y con el nombre del espacio
 * («Ver las finanzas de Laura: …»), no con la etiqueta del formulario,
 * que habla desde quien invita («mis finanzas»).
 */
export default async function InvitacionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Un enlace cortado o inventado no tiene nada que leer: lo dice antes
  // de pedir sesión, para no mandar a /login con un `next` inútil.
  if (!isInvitationToken(token)) return <EnlaceCerrado status="not_found" />;

  const demo = !isAuthConfigured();
  const quien = await quienAcepta();
  if (!quien && !demo) {
    return (
      <EmptyState
        title={t.sinSesion.titulo}
        description={t.sinSesion.texto}
        action={{ label: t.sinSesion.entrar, href: `/login?next=${encodeURIComponent(`/invitacion/${token}`)}` }}
      />
    );
  }

  // En la demo sin persona simulada nadie abre el enlace: se lee sin
  // sesión, para enseñar lo que verá la persona invitada.
  const vista = quien ? await withIdentity(quien, (tx) => lookupInvitation(tx, token)) : await lookupInvitationWithoutSession(token);
  if (vista.status !== "pending") return <EnlaceCerrado status={vista.status} />;

  const fmt = formatterFor({ locale: vista.locale ?? "", timezone: vista.timezone ?? "", currency: "" });
  const casillas = casillasDe(vista.extraPermissions);
  return (
    <section className="grid gap-5">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{t.eyebrow}</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink">{t.titulo(vista.workspaceName)}</h1>
        <p className="mt-2 text-sm leading-5 text-ink-2">{t.rol(vista.roleLabel)}</p>
      </header>
      {casillas.length > 0 && (
        <div className="text-sm text-ink-2">
          <p className="font-medium text-ink">{t.casillasTitulo}</p>
          <ul className="mt-1 list-disc pl-5">
            {casillas.map((c) => (
              <li key={c}>{t.casillas[c](vista.workspaceName)}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-sm text-ink-2">
        {vista.invitedByName && <>{t.invitadoPor(vista.invitedByName)} </>}
        {t.vence(fmt.date(vista.expiresAt, "long"))}
      </p>
      {/* En la demo no hay cuentas: ni «Aceptar» ni «Entrar con otra
          cuenta» llevan a ningún sitio, y se dice por qué. La excepción
          es una copia de desarrollo cuya persona simulada (DEMO_USER_ID)
          ES la invitada: ahí aceptar funciona de verdad. */}
      {demo && vista.emailMatches !== true ? (
        <div className="grid gap-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm">
          <p className="font-medium text-ink">{t.demo.titulo}</p>
          <p className="text-ink-2">{t.demo.texto}</p>
        </div>
      ) : vista.emailMatches === false ? (
        <div role="alert" className="grid gap-3 rounded-md border border-warn/40 bg-warn-wash px-3 py-2 text-sm text-ink">
          <p>{t.otroCorreo(vista.invitedEmailMasked)}</p>
          <form action={salirYVolver.bind(null, token)}>
            <Button type="submit" variant="secondary" size="sm">
              {t.salir}
            </Button>
          </form>
        </div>
      ) : (
        <AceptarInvitacion token={token} />
      )}
    </section>
  );
}

/** Un enlace que no sirve (o nunca sirvió): qué pasó y el camino al inicio. */
function EnlaceCerrado({ status }: { status: InvitationClosedStatus }) {
  return <EmptyState title={t.estados[status].titulo} description={t.estados[status].texto} action={{ label: t.irAlInicio, href: "/" }} />;
}
