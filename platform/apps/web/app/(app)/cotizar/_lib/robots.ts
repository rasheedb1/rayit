/**
 * Los robots que abren un enlace para pintar su vista previa cuando
 * alguien lo pega en un chat: WhatsApp, Slack, Facebook/Messenger,
 * X, LinkedIn, Telegram, Discord, iMessage, Google Chat, Teams.
 *
 * Una visita suya NO es la marca abriendo la cotización: si contara, la
 * cotización pasaría a «Vista por la marca» en cuanto el creador pega
 * el enlace en WhatsApp, y el contador del media kit subiría solo. La
 * página pública lee el User-Agent y, si es uno de estos, llama a la
 * función de la base con p_count = false.
 *
 * Es una lista y no una heurística de «bot»: un falso positivo aquí es
 * una visita real que no se cuenta, así que solo entran los que se
 * conocen por nombre.
 */
const ROBOTS_DE_PREVISUALIZACION = [
  /WhatsApp/i,
  /Slackbot/i,
  /Slack-ImgProxy/i,
  /facebookexternalhit/i,
  /Facebot/i,
  /Twitterbot/i,
  /LinkedInBot/i,
  /TelegramBot/i,
  /Discordbot/i,
  /redditbot/i,
  /Applebot/i,
  /Google-PageRenderer/i,
  /GoogleImageProxy/i,
  /SkypeUriPreview/i,
  /MicrosoftPreview/i,
  /Iframely/i,
  /Embedly/i,
  /vkShare/i,
  /Pinterestbot/i,
];

export function esRobotDePrevisualizacion(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return ROBOTS_DE_PREVISUALIZACION.some((re) => re.test(userAgent));
}
