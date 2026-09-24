import type { OAuthProviderId } from "@mc/connectors";
import { SectionTitle } from "@/components/page-header";
import { CONSENT_POLICY_VERSION, consentText, PLATFORM_LABEL } from "./_lib/consent";
import { appDeRed, type EntornoDeConexion } from "./_lib/entorno";
import { MESSAGES } from "./_lib/messages";
import { ConnectDialog } from "./connect-dialog";

const t = MESSAGES.conectar;

/**
 * Las redes que un creador conecta desde esta pantalla (decisión 6 de
 * docs/propuestas/CON-4.md, y YouTube desde el cierre CON-C):
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
 *   - **YouTube** (CON-8): autorizar el canal desbloquea la analítica
 *     —retención y demografía— que la Data API no da por @. Queda
 *     apagada hasta que estén GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET.
 *
 * Añadir una es añadirla a esta lista: el diálogo, la ruta y el
 * callback ya existen para las tres de CON-3.
 */
export const REDES_CONECTABLES: readonly OAuthProviderId[] = ["tiktok", "youtube"];

/**
 * «Conectar una cuenta autorizada»: un botón por red, cada uno con su
 * diálogo de consentimiento y su POST a la ruta `start` de CON-3.
 *
 * Solo se monta con la bandera `oauth_connect` encendida. Una red sin
 * credenciales en el entorno no ofrece botón (cierre CON-C: ninguna
 * fuente apagada tiene un botón en pantalla); en su lugar, una frase
 * dice qué variable falta, que es lo que hace falta saber para
 * encenderla. Nombres de variables, nunca sus valores.
 */
export function Conectar({ entorno }: { entorno: EntornoDeConexion }) {
  const ready = REDES_CONECTABLES.filter((provider) => appDeRed(entorno, provider).configurada);
  const off = REDES_CONECTABLES.filter((provider) => !appDeRed(entorno, provider).configurada).map((provider) => ({ provider, missing: appDeRed(entorno, provider).faltan }));
  return (
    <section aria-labelledby="conectar" className="mb-10 rounded-md border border-border bg-surface p-5">
      <SectionTitle>
        <span id="conectar">{t.titulo}</span>
      </SectionTitle>
      <p className="max-w-2xl text-sm leading-6 text-ink-2">{t.descripcion}</p>
      {ready.length > 0 && <div className="mt-4 flex flex-wrap gap-2">
        {ready.map((provider) => {
          const red = PLATFORM_LABEL[provider];
          return (
            <ConnectDialog
              key={provider}
              label={red}
              actionLabel={t.boton(red)}
              text={consentText(provider)}
              policyVersion={CONSENT_POLICY_VERSION}
              action={`/conexiones/oauth/${provider}/start`}
              variant="secondary"
            />
          );
        })}
      </div>}
      {off.map(({ provider, missing }) => (
        <p key={provider} className="mt-2 max-w-2xl text-xs text-ink-2">
          {t.sinConfigurar(PLATFORM_LABEL[provider], missing.join(", "))}
        </p>
      ))}
    </section>
  );
}
