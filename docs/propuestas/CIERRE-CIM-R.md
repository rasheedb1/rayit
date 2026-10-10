# Antes del primer cliente que pague (R7): CIM-9, CIM-10 y CON-9 · 10-oct-2026

Escrito para: Rasheed, que tiene las cuentas de empresa y los paneles, y
para quien revise el texto legal. Las tres historias son mitad código y
mitad persona: aquí está lo que el código ya hace y el guion exacto de
lo que falta hacer a mano, con su verificación y su vuelta atrás.

## 1. CIM-9 · /legal: el borrador

`/legal` publica un borrador completo de términos de servicio y política
de privacidad (`apps/web/lib/auth/messages.ts`, `legal`), con la fecha
de versión («Versión del 10 de octubre de 2026») y el aviso «Borrador
pendiente de revisión legal» a la vista. `app/legal/page.test.tsx` fija
la versión, el aviso, las dos anclas y las cuatro frases que la ley pide
nombrar. El contacto sale de `SUPPORT_EMAIL`; sin la variable la página
dice que se publicará.

Lo que dice está sacado del código, no de un modelo de internet: entrar
por enlace sin contraseña (CIM-3), credenciales cifradas
(`connection_secret`, `TOKEN_ENCRYPTION_KEY`), permisos registrados con
fecha y quién los dio (`data_consent`, ACC-8), demografía agregada
(`audience_breakdown`, CON-7), cuentas por @ con lo público (CON-10),
enlaces públicos que el dueño publica y retira (COT-2, COT-3, CAM-6),
baja por enlace en cada correo (VEN-15), roles y alcance (ACC), proveedores
de nube fuera de Colombia (Supabase en Canadá, Vercel).

### 1.1 Lo que falta de una persona (Rasheed)

1. `SUPPORT_EMAIL` en Vercel, production y preview, con un buzón que
   alguien lea: `make vercel.run ARGS="env add SUPPORT_EMAIL production"`.
   Verificar: `/legal` enseña el correo como enlace `mailto:`.
2. La revisión legal (§2) y, con ella, quitar `pendiente` de
   `messages.ts` y poner la fecha de versión definitiva.

## 2. Lo que un abogado tiene que confirmar

| # | Afirmación del borrador | Qué hay que confirmar |
|---|---|---|
| 1 | «Lo presta On Cue (razón social, NIT y dirección se publicarán…)» | La razón social, el NIT, la dirección y el representante legal. Van en el texto antes de quitar el aviso |
| 2 | Ley 1581 de 2012 y Decreto 1377 de 2013 como marco | Que basta con eso para un servicio B2B a creadores en Colombia, y si hace falta el registro en el RNBD de la SIC (depende de activos y de si la empresa es «responsable» con más de 100.000 UVT en activos) |
| 3 | «No usamos tus datos para entrenar modelos» | Cierto hoy: el modelo se usa para redactar mensajes y clasificar respuestas (VEN-12, VEN-14) con el texto del propio espacio, sin entrenar nada. Si eso cambia, el párrafo cambia |
| 4 | Encargados: alojamiento, base de datos, envío de correo, plataformas y canales | Si hay que nombrarlos (Vercel, Supabase, Google, Meta, TikTok, Unipile) y con qué contratos de encargo |
| 5 | «Transferencia internacional» a proveedores fuera de Colombia | Si la autorización por uso basta o hace falta una declaración expresa al entrar (una casilla en /login) |
| 6 | «Al desconectar una cuenta dejamos de leerla y sus credenciales dejan de usarse» | El código marca la cuenta `deleted_at` y deja de leerla; la fila de `connection_secret` no se borra sola. Decidir si se borra al desconectar (una línea en `disconnectConnection`) o a petición, y decir lo que se decida |
| 7 | Plazos: «mientras tu espacio exista», borrado a petición | Si hace falta un plazo máximo de conservación por tipo de dato (métricas, bitácora, mensajes de outreach) y un procedimiento escrito de borrado |
| 8 | Outreach: contactos de marcas, mensajes y bajas | Que el envío de correo comercial a empresas con enlace de baja y dirección postal (VEN-15) cumple la Ley 527 de 1999 / 1581 y, para destinatarios fuera de Colombia, CAN-SPAM y RGPD |
| 9 | Derechos del titular y plazos de respuesta (10 y 15 días hábiles) | Quién contesta el buzón de `SUPPORT_EMAIL` y cómo se registra cada solicitud |
| 10 | Menores | On Cue no está pensado para menores de 18; si se declara, el texto lo dice y /login lo pregunta |

## 3. CIM-10 · CAPTCHA y SMTP propio: el guion

El código está (`lib/auth/captcha.ts`, el widget en `app/login/formulario.tsx`,
`captchaToken` hacia Supabase en `acciones.ts`, pruebas en
`captcha.test.ts` y `acciones.test.ts`). Lo que falta lo hace una persona
en los paneles, **en este orden**, porque al revés deja a todo el mundo
fuera:

| Paso | Quién | Qué | Verificación | Vuelta atrás |
|---|---|---|---|---|
| a | Rasheed | Cloudflare → Turnstile → «Add site»: nombre «On Cue», dominios `on-cue-web.vercel.app` y `localhost`, modo *Managed*. Da una clave de sitio y una secreta | Las dos claves a la vista en el panel | Borrar el sitio |
| b | Rasheed | `make vercel.run ARGS="env add TURNSTILE_SITE_KEY production"` y lo mismo con `preview` (la clave **de sitio**, pública). La secreta NO va a Vercel | `./scripts/vercel.sh run env ls production` la lista | `env rm` |
| c | Rasheed | Redesplegar (`make vercel.deploy PROD=1` o el próximo push a `main`) | `/login` pinta el widget y, al enviar, el log no dice «sin CAPTCHA». Entrar sigue funcionando: Supabase todavía no exige el token | Quitar la variable y redesplegar |
| d | Rasheed | Supabase → Authentication → Attack Protection → *Enable Captcha protection*, proveedor **Turnstile**, pegar la clave **secreta** | `curl -s -X POST https://<ref>.supabase.co/auth/v1/otp -H "apikey: <anon>" -H "Content-Type: application/json" -d '{"email":"x@y.test"}'` responde 4xx con `captcha`; `/login` con el widget sigue entrando | Apagar Attack Protection: en el acto deja de exigirse |
| e | Rasheed | Supabase → Project Settings → Auth → SMTP Settings: el SMTP propio (p. ej. Resend o Postmark con el dominio de On Cue verificado), remitente `no-reply@<dominio>` | Un enlace real llega a un buzón nuestro en menos de un minuto y con el remitente propio | Desactivar «Enable Custom SMTP»: vuelve el de Supabase (4 correos/hora) |

Lo que NO hay que hacer: encender (d) antes de (c). Con el CAPTCHA
exigido y el widget sin desplegar, cada envío falla con «No pudimos
comprobar que no eres un robot» y nadie entra.

## 4. CON-9 · trámites

El camino, los permisos exactos que pide el código, lo que hay que
preparar y los riesgos (el dominio propio para Google) están en
[`docs/tramites.md`](../tramites.md). Rasheed escribe ahí la fecha y el
número de caso de cada uno; la nota de CON-9 en `content/backlog.ts`
pasa a `en_curso` con la fecha del primero.

## 5. Decisiones

| Pregunta | Lo que quedó | Si se quiere lo contrario |
|---|---|---|
| ¿El borrador legal sale publicado antes de la revisión? | **Sí, con el aviso a la vista**: un texto honesto con aviso vale más que «pendiente de redacción» frente a Meta y Google, que leen la página. Ninguno de los tres trámites se envía hasta quitar el aviso (tramites.md §0) | Volver al párrafo corto en `messages.ts` |
| ¿Dominio propio? | Google exige página de inicio y política en un dominio propio verificado; `vercel.app` no vale. Decisión y registro de Rasheed; el código no cambia (APP_URL y las Redirect URLs sí) | — |
