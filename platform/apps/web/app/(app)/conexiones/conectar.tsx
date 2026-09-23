import type { OAuthProviderId } from "@mc/connectors";
import { SectionTitle } from "@/components/page-header";
import { CONSENT_POLICY_VERSION, consentText, PLATFORM_LABEL } from "./_lib/consent";
import { appDeRed, type EntornoDeConexion } from "./_lib/entorno";
import { MESSAGES } from "./_lib/messages";
import { ConnectDialog } from "./connect-dialog";

const t = MESSAGES.conectar;

/**
 * Las redes que un creador conecta desde esta pantalla (decisión 6 de
 * docs/propuestas/CON-4.md). Hoy es una sola, y no por falta de código:
 *
 *   - **TikTok** es la única red donde autorizar añade algo que el @ no
 *     da. TikTok no publica seguidores ni vistas por @ (CON-10 §7), así
 *     que el permiso del dueño es lo que desbloquea las cifras. Es lo
 *     que se probó en vivo el 23-sep.
 *   - **Instagram** entrega seguidores y publicaciones por @ con
 *     `business_discovery` (CON-10 §3). Autorizarla está escrito en
 *     CON-3 pero quedó fuera del MVP: ofrecer aquí un botón que pide
 *     permisos para conseguir lo que ya tenemos es pedir de más.
 *   - **`tiktok-business`** (la Accounts API) no es otra red, es otra
 *     app de la misma; depende del trámite de CON-9 y aquí haría elegir
 *     entre dos TikToks.
 *   - **YouTube** todavía no tiene OAuth (CON-8) y sigue por @.
 *
 * Añadir una es añadirla a esta lista: el diálogo, la ruta y el
 * callback ya existen para las tres de CON-3.
 */
export const REDES_CONECTABLES: readonly OAuthProviderId[] = ["tiktok"];

/**
 * «Conectar una cuenta autorizada»: un botón por red, cada uno con su
 * diálogo de consentimiento y su POST a la ruta `start` de CON-3.
 *
 * Solo se monta con la bandera `oauth_connect` encendida. Una red sin
 * credenciales en el entorno NO desaparece: el botón sale deshabilitado
 * y dice qué variable falta, que es lo que hace falta saber para
 * arreglarlo.
 */
export function Conectar({ entorno }: { entorno: EntornoDeConexion }) {
  return (
    <section aria-labelledby="conectar" className="mb-10 rounded-md border border-border bg-surface p-5">
      <SectionTitle>
        <span id="conectar">{t.titulo}</span>
      </SectionTitle>
      <p className="max-w-2xl text-sm leading-6 text-ink-2">{t.descripcion}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {REDES_CONECTABLES.map((provider) => {
          const red = PLATFORM_LABEL[provider];
          const app = appDeRed(entorno, provider);
          const motivo = app.configurada ? undefined : t.sinConfigurar(red, app.faltan.join(", "));
          return (
            <ConnectDialog
              key={provider}
              label={red}
              actionLabel={t.boton(red)}
              text={consentText(provider)}
              policyVersion={CONSENT_POLICY_VERSION}
              action={`/conexiones/oauth/${provider}/start`}
              disabledReason={motivo}
              variant="secondary"
            />
          );
        })}
      </div>
    </section>
  );
}
