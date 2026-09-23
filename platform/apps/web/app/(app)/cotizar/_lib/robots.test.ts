import { describe, expect, it } from "vitest";
import { esRobotDePrevisualizacion } from "./robots";

describe("esRobotDePrevisualizacion", () => {
  it("reconoce a los que desenrollan enlaces en los chats", () => {
    for (const ua of [
      "WhatsApp/2.23.20.0 A",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Twitterbot/1.0",
      "TelegramBot (like TwitterBot)",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
      "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
    ]) {
      expect(esRobotDePrevisualizacion(ua), ua).toBe(true);
    }
  });

  it("una persona con un navegador cuenta como visita", () => {
    expect(
      esRobotDePrevisualizacion(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(false);
    expect(esRobotDePrevisualizacion("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36")).toBe(false);
    expect(esRobotDePrevisualizacion(null)).toBe(false);
    expect(esRobotDePrevisualizacion("")).toBe(false);
  });
});
