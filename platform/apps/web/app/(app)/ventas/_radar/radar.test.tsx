import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ESPERA_UI_LARGA_MS } from "@/lib/testing/tiempos";

// Las Server Actions se sustituyen: aquí importa cómo reacciona la
// bandeja a lo que devuelven, no la base (eso lo prueba @mc/db).
const aceptarSenal = vi.fn();
const descartarSenal = vi.fn();
const anotarSenal = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({}));
vi.mock("../actions", () => ({
  aceptarSenal: (...a: unknown[]) => aceptarSenal(...a),
  descartarSenal: (...a: unknown[]) => descartarSenal(...a),
  anotarSenal: (...a: unknown[]) => anotarSenal(...a),
  cargarLista: vi.fn(async () => ({})),
}));
vi.mock("../brief/actions", () => ({ noAceptarMarca: vi.fn(async () => ({})) }));

import { MESSAGES } from "../_lib/messages";
import { countryOptions } from "../_lib/paises";
import { Radar, type SignalCardData } from "./radar";

const PAISES = countryOptions("es-CO");

/** Una acción mockeada más su transición de React (lib/testing/tiempos.ts, con su porqué). */
const LENTO = { timeout: ESPERA_UI_LARGA_MS };

const SIGNAL = "00000005-0000-4000-8000-000000000001";
const card: SignalCardData = {
  id: SIGNAL,
  companyName: "Café Alma",
  headline: "Lanzó cold brew y pauta en Meta",
  fit: { kind: "good", text: "82 %" },
  sourceLabel: "Añadida a mano",
  detectedText: "20 sep",
  budgetText: null,
  evidenceUrl: null,
  viaCsv: false,
  crm: null,
  hiddenReason: null,
  fitNotes: [],
  canReject: false,
  rejectWarning: null,
};

beforeEach(() => {
  aceptarSenal.mockReset();
  descartarSenal.mockReset();
  anotarSenal.mockReset();
  anotarSenal.mockResolvedValue({});
});

describe("Radar", () => {
  it("anotar una señal que ya se aceptó lo dice sin hablar de descartes y enlaza a la ficha", async () => {
    const empresa = "/ventas/empresas/00000002-0000-4000-8000-0000000000e1";
    anotarSenal.mockResolvedValue({
      message: MESSAGES.radar.form.duplicateAccepted,
      link: { href: empresa, label: MESSAGES.radar.form.seeCompany },
    });
    render(<Radar cards={[card]} currency="COP" countries={PAISES} />);
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.radar.newSignal }));
    fireEvent.change(screen.getByLabelText("Marca"), { target: { value: "Café Alma" } });
    fireEvent.change(screen.getByLabelText(/Qué viste/), { target: { value: "Lanzó cold brew" } });
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.radar.form.submit }));

    const alerta = await screen.findByRole("alert", undefined, LENTO);
    expect(alerta).toHaveTextContent("ya la aceptaste");
    expect(alerta).not.toHaveTextContent(/descart/i);
    expect(screen.getByRole("link", { name: MESSAGES.radar.form.seeCompany })).toHaveAttribute("href", empresa);
  });

  it("una marca que ya está en el CRM lo dice antes de aceptar, con su ficha y el negocio al que se sumará (pulido r8)", () => {
    const ficha = "/ventas/empresas/00000002-0000-4000-8000-0000000000e7";
    render(
      <Radar
        cards={[
          { ...card, id: "s1", companyName: "Vitalé", crm: { companyHref: ficha, joinsDeal: true, dealName: "Snacks de temporada" } },
          { ...card, id: "s2", companyName: "Nutrivé", crm: { companyHref: ficha, joinsDeal: true, dealName: null } },
          { ...card, id: "s3", companyName: "Granos del Valle", crm: { companyHref: ficha, joinsDeal: false, dealName: null } },
          { ...card, id: "s4", companyName: "Marca Nueva" },
        ]}
        currency="COP"
        countries={PAISES}
      />,
    );
    const [vitale, nutrive, granos, nueva] = screen.getAllByRole("listitem");

    const enCrm = within(vitale!).getByRole("link", { name: MESSAGES.radar.inCrmLink("Vitalé") });
    expect(enCrm).toHaveAttribute("href", ficha);
    expect(enCrm).toHaveTextContent(MESSAGES.radar.inCrm);
    expect(vitale).toHaveTextContent(MESSAGES.radar.joinsDeal("Snacks de temporada"));
    // Un negocio que se llama como la marca: se dice sin repetir el nombre.
    expect(nutrive).toHaveTextContent(MESSAGES.radar.joinsOpenDeal);
    // En el CRM pero sin negocio abierto: aceptarla abre uno, así que no promete sumarse.
    expect(within(granos!).getByText(MESSAGES.radar.inCrm)).toBeInTheDocument();
    expect(granos).not.toHaveTextContent(/se sumará/);
    // Una marca nueva no dice nada de eso.
    expect(within(nueva!).queryByText(MESSAGES.radar.inCrm)).toBeNull();
    expect(nueva).not.toHaveTextContent(/se sumará/);
  });

  it("la marca tiene un negocio abierto de un creador que no se lleva (ACC-7): lo dice antes, y al aceptar el aviso se queda en la tarjeta", async () => {
    const ficha = "/ventas/empresas/00000002-0000-4000-8000-0000000000e3";
    aceptarSenal.mockResolvedValue({ message: MESSAGES.radar.hiddenDealNotice("Hostal Brisa") });
    render(
      <Radar
        cards={[{ ...card, companyName: "Hostal Brisa", crm: { companyHref: ficha, joinsDeal: false, dealName: null }, hiddenDeal: true }]}
        currency="COP"
        countries={PAISES}
      />,
    );
    const tarjeta = screen.getByRole("listitem");
    expect(tarjeta).toHaveTextContent(MESSAGES.radar.hiddenDeal);
    expect(tarjeta).not.toHaveTextContent(/se sumará/);
    fireEvent.click(within(tarjeta).getByRole("button", { name: `${MESSAGES.radar.accept}: Hostal Brisa` }));
    await waitFor(() => expect(within(tarjeta).getByText(MESSAGES.radar.hiddenDealNotice("Hostal Brisa"))).toBeInTheDocument(), LENTO);
  });

  it("aceptar anuncia el negocio abierto y enlaza al pipeline", async () => {
    aceptarSenal.mockResolvedValue({
      ok: true,
      notice: "Abriste un negocio con Café Alma. La siguiente acción es «Enviar pitch».",
      link: { href: "/ventas?vista=pipeline", label: "Ver en el pipeline" },
    });
    render(<Radar cards={[card]} currency="COP" countries={PAISES} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar: Café Alma" }));

    expect(await screen.findByRole("status", undefined, LENTO)).toHaveTextContent("Enviar pitch");
    expect(screen.getByRole("link", { name: "Ver en el pipeline" })).toHaveAttribute("href", "/ventas?vista=pipeline");
    const data = aceptarSenal.mock.calls[0]?.[1] as FormData;
    expect(data.get("signalId")).toBe(SIGNAL);
  });

  it("aceptar la señal de una marca con un negocio abierto lo dice y enlaza a su ficha", async () => {
    const empresa = "/ventas/empresas/00000002-0000-4000-8000-0000000000e1";
    aceptarSenal.mockResolvedValue({
      ok: true,
      notice: "Ya tienes un negocio con Café Alma: la señal quedó anotada en él.",
      link: { href: empresa, label: "Ver el negocio" },
    });
    render(<Radar cards={[card]} currency="COP" countries={PAISES} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar: Café Alma" }));

    expect(await screen.findByRole("status", undefined, LENTO)).toHaveTextContent("Ya tienes un negocio con Café Alma");
    expect(screen.getByRole("link", { name: "Ver el negocio" })).toHaveAttribute("href", empresa);
    expect(screen.queryByRole("link", { name: "Ver en el pipeline" })).not.toBeInTheDocument();
  });

  it("si el CRM tiene una marca con el mismo nombre y otra web, pregunta si es la misma en vez de crear otra (pulido r2)", async () => {
    const FICHA = "00000008-0000-4000-8000-0000000000e1";
    aceptarSenal
      .mockResolvedValueOnce({ sameName: { id: FICHA, name: "Molino Andino" } })
      .mockResolvedValueOnce({ ok: true, notice: "Ya tienes un negocio con Molino Andino: la señal quedó anotada en él." });
    render(<Radar cards={[{ ...card, companyName: "Molino Andino" }]} currency="COP" countries={PAISES} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar: Molino Andino" }));

    const pregunta = await screen.findByRole("group", { name: MESSAGES.radar.sameBrand.question("Molino Andino") }, LENTO);
    expect(within(pregunta).getByRole("link", { name: MESSAGES.radar.sameBrand.see })).toHaveAttribute("href", `/ventas/empresas/${FICHA}`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // La pregunta se pinta en cuanto la acción responde, pero la transición sigue unos ticks con el botón ocupado:
    // un clic en ese hueco se pierde (pulido r4, CIM-12). Se espera a que el botón se suelte.
    const misma = within(pregunta).getByRole("button", { name: MESSAGES.radar.sameBrand.same });
    await waitFor(() => expect(misma).toBeEnabled(), LENTO);
    fireEvent.click(misma);

    await waitFor(() => expect(aceptarSenal).toHaveBeenCalledTimes(2), LENTO);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ya tienes un negocio con Molino Andino"), LENTO);
    const data = aceptarSenal.mock.calls[1]?.[1] as FormData;
    expect(data.get("useCompanyId")).toBe(FICHA);
    expect(data.get("createAnyway")).toBeNull();
  });

  it("«No, es otra marca» acepta creando una empresa nueva con el nombre por el que se preguntó", async () => {
    aceptarSenal
      .mockResolvedValueOnce({ sameName: { id: "00000008-0000-4000-8000-0000000000e1", name: "Molino Andino" } })
      .mockResolvedValueOnce({ ok: true, notice: "Abriste un negocio con Molino Andino." });
    render(<Radar cards={[{ ...card, companyName: "Molino Andino" }]} currency="COP" countries={PAISES} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar: Molino Andino" }));
    // El botón nace deshabilitado mientras la transición del primer clic termina: se espera a que se suelte
    // antes de pulsarlo, y a la segunda llamada antes de leerla (pulido r4, CIM-12).
    const otra = await screen.findByRole("button", { name: MESSAGES.radar.sameBrand.other }, LENTO);
    await waitFor(() => expect(otra).toBeEnabled(), LENTO);
    fireEvent.click(otra);

    await waitFor(() => expect(aceptarSenal).toHaveBeenCalledTimes(2), LENTO);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Abriste un negocio con Molino Andino"), LENTO);
    const data = aceptarSenal.mock.calls[1]?.[1] as FormData;
    expect(data.get("createAnyway")).toBe("Molino Andino");
    expect(data.get("useCompanyId")).toBeNull();
  });

  it("descartar pide el motivo y muestra el error del servidor en su campo", async () => {
    descartarSenal.mockResolvedValue({ errors: { reason: "Di por qué la descartas: es lo que afina el radar." } });
    render(<Radar cards={[card]} currency="COP" countries={PAISES} />);
    fireEvent.click(screen.getByRole("button", { name: "Descartar: Café Alma" }));
    fireEvent.click(screen.getByRole("button", { name: "Descartar señal" }));

    expect(await screen.findByRole("alert", undefined, LENTO)).toHaveTextContent("Di por qué la descartas");
    expect(screen.getByRole("textbox", { name: /¿Por qué la descartas\?/ })).toHaveAttribute("aria-invalid", "true");
  });

  it("descartar con motivo envía el texto y avisa que no vuelve", async () => {
    descartarSenal.mockResolvedValue({ ok: true, notice: "Señal descartada. No volverá al radar." });
    render(<Radar cards={[card]} currency="COP" countries={PAISES} />);
    fireEvent.click(screen.getByRole("button", { name: "Descartar: Café Alma" }));
    fireEvent.change(screen.getByRole("textbox", { name: /¿Por qué la descartas\?/ }), { target: { value: "No encaja con mi nicho" } });
    fireEvent.click(screen.getByRole("button", { name: "Descartar señal" }));

    expect(await screen.findByRole("status", undefined, LENTO)).toHaveTextContent("No volverá");
    const data = descartarSenal.mock.calls[0]?.[1] as FormData;
    expect(data.get("reason")).toBe("No encaja con mi nicho");
    expect(data.get("signalId")).toBe(SIGNAL);
  });

  it("un error al aceptar se queda en la tarjeta", async () => {
    aceptarSenal.mockResolvedValue({ message: "Esa señal ya la revisaste. Recarga el radar para ver cómo quedó." });
    render(<Radar cards={[card]} currency="COP" countries={PAISES} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar: Café Alma" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("ya la revisaste"), LENTO);
  });

  it("el país de «Anotar una marca» se elige de la lista, no se escribe (pulido r6)", () => {
    render(<Radar cards={[]} currency="COP" countries={PAISES} />);
    fireEvent.click(screen.getByRole("button", { name: "Anotar una marca", expanded: false }));
    const pais = screen.getByRole("combobox", { name: "País" });
    expect(pais).toHaveValue("");
    fireEvent.change(pais, { target: { value: "PE" } });
    expect(pais).toHaveValue("PE");
    expect(screen.getByRole("option", { name: "Perú" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "XX" })).toBeNull();
  });

  it("una señal oculta por el brief no se acepta con un clic: Aceptar es secundario y pide confirmación", async () => {
    aceptarSenal.mockResolvedValue({ ok: true, notice: "Negocio abierto." });
    const oculta = { ...card, hiddenReason: "Tu brief no acepta «harinas»" };
    render(<Radar cards={[oculta]} currency="COP" countries={PAISES} />);
    const aceptar = screen.getByRole("button", { name: "Aceptar: Café Alma" });
    expect(aceptar.className).not.toMatch(/bg-accent/);
    expect(aceptar.className).toMatch(/bg-surface/);
    fireEvent.click(aceptar);
    const dialogo = screen.getByRole("dialog", { name: MESSAGES.radar.hidden.acceptTitle("Café Alma") });
    expect(dialogo).toHaveTextContent("Tu brief no acepta «harinas». Si la aceptas, el negocio se abre");
    expect(aceptarSenal).not.toHaveBeenCalled();
    fireEvent.click(within(dialogo).getByRole("button", { name: MESSAGES.radar.hidden.acceptConfirm }));
    expect(await screen.findByRole("status", undefined, LENTO)).toHaveTextContent("Negocio abierto.");
    expect(aceptarSenal).toHaveBeenCalledTimes(1);
  });

  it("«¿No aceptar…?» de una marca del CRM con negocios abiertos lo avisa y no dice que entra como bloqueada", () => {
    const r = MESSAGES.radar.reject;
    const enCrm: SignalCardData = {
      ...card,
      companyName: "Nutrivé",
      canReject: true,
      crm: { companyHref: "/ventas/empresas/x", joinsDeal: true, dealName: null },
      rejectWarning: r.openDeals("2", 2, "Nutrivé"),
    };
    render(<Radar cards={[enCrm]} currency="COP" countries={PAISES} reject={{ creators: [{ id: "c1", name: "Laura" }] }} />);
    // El nombre accesible empieza por lo que se ve (WCAG 2.5.3).
    const boton = screen.getByRole("button", { name: r.actionFor("Nutrivé") });
    expect(boton.getAttribute("aria-label")?.startsWith(boton.textContent ?? "")).toBe(true);
    fireEvent.click(boton);
    const dialogo = screen.getByRole("dialog", { name: r.title("Nutrivé") });
    expect(dialogo).toHaveTextContent(r.descriptionInCrm);
    expect(dialogo).not.toHaveTextContent("Entra a tu CRM como bloqueada");
    expect(dialogo).toHaveTextContent("Tienes 2 negocios abiertos con Nutrivé");
  });

  it("vacía, la bandeja ofrece anotar una marca y abre el formulario", () => {
    render(<Radar cards={[]} currency="COP" countries={PAISES} />);
    fireEvent.click(screen.getByRole("button", { name: "Anotar una marca", expanded: false }));
    expect(screen.getByRole("form", { name: "Anotar una marca" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Qué viste/)).toBeRequired();
  });
});
