import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CompanySignalRow } from "@mc/db/queries/ventas-ficha";
import type { ContactRow } from "@mc/db/queries/ventas";
import { formatterFor } from "@/lib/format";

vi.mock("../../actions", () => ({ crearContacto: vi.fn(), darDeBaja: vi.fn(), editarContacto: vi.fn() }));

import { FICHA } from "../messages";
import { Contactos } from "./contactos";
import { LoQueSabemos } from "./sabemos";

/**
 * Las URL que llegan de la base (evidencia de una señal, LinkedIn y fuente
 * de un contacto) son text libre: las llenarán los conectores del radar,
 * el outreach y los seeds. Un `javascript:` en un href es un XSS de un
 * clic en la ficha; solo se enlaza http(s).
 */
const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
const empresa = { sizeBucket: null, runsAds: null, adsPlatforms: [], fitScore: null };
const senal: CompanySignalRow = {
  id: "00000008-0000-4000-8000-000000000001",
  headline: "Lanza línea de cold brew",
  sourceLabel: "Manual",
  detectedAt: "2026-09-20T15:00:00Z",
  evidenceUrl: null,
  status: "accepted",
  fitScore: null,
  budgetEstimate: null,
  budgetCurrency: null,
  discardReason: null,
};

describe("«Lo que sabemos»: la evidencia solo se enlaza si es http(s)", () => {
  it("una evidencia https es un enlace que abre aparte", () => {
    render(<LoQueSabemos company={empresa} signals={[{ ...senal, evidenceUrl: "https://marca.co/lanzamiento" }]} f={f} />);
    const enlace = screen.getByRole("link", { name: FICHA.sabemos.evidence });
    expect(enlace).toHaveAttribute("href", "https://marca.co/lanzamiento");
    expect(enlace).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("javascript:alert(1) o data: no se pintan como enlace", () => {
    render(
      <LoQueSabemos
        company={empresa}
        signals={[
          { ...senal, evidenceUrl: "javascript:alert(1)" },
          { ...senal, id: "00000008-0000-4000-8000-000000000002", evidenceUrl: "data:text/html,<script>alert(1)</script>" },
        ]}
        f={f}
      />,
    );
    expect(screen.queryByRole("link", { name: FICHA.sabemos.evidence })).toBeNull();
    expect(document.querySelector('a[href^="javascript:"], a[href^="data:"]')).toBeNull();
  });
});

describe("Contactos: LinkedIn y fuente solo se enlazan si son http(s)", () => {
  const contacto: ContactRow = {
    id: "00000007-0000-4000-8000-000000000001",
    companyId: "00000002-0000-4000-8000-0000000000e1",
    fullName: "Laura Gómez",
    roleTitle: null,
    email: null,
    phone: null,
    linkedinUrl: "javascript:alert(1)",
    instagramHandle: null,
    source: "public_website",
    sourceUrl: "javascript:alert(2)",
    optedOut: false,
    optedOutAt: null,
    optedOutReason: null,
    optedOutByReply: null,
    bounced: false,
    isOwn: true,
    createdAt: "2026-09-20T12:00:00Z",
  };

  it("un javascript: en linkedin_url o source_url no es un enlace", () => {
    render(<Contactos companyId={contacto.companyId} contacts={[contacto]} />);
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("uno https sí", () => {
    render(
      <Contactos
        companyId={contacto.companyId}
        contacts={[{ ...contacto, linkedinUrl: "https://www.linkedin.com/in/laura", sourceUrl: "https://cafealma.co/equipo" }]}
      />,
    );
    expect(document.querySelector('a[href="https://www.linkedin.com/in/laura"]')).not.toBeNull();
    expect(document.querySelector('a[href="https://cafealma.co/equipo"]')).not.toBeNull();
  });
});
