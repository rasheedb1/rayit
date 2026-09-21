import type { Metadata } from "next";
import Link from "next/link";
import { DECISIONS, DEPENDENCIES, FLOW, OWNER_RULE_LABEL, RULES } from "@/content/reglas";
import { storyById, storyHref } from "@/lib/backlog";
import { OwnerAvatar } from "@/components/owner";
import { PageHeader, SectionTitle } from "@/components/page-header";

export const metadata: Metadata = { title: "Reglas" };

function StoryLink({ id }: { id: string }) {
  const s = storyById(id);
  const tone = s.owner === "rasheed" ? "bg-rasheed-bg text-rasheed" : "bg-nicolas-bg text-nicolas";
  return (
    <Link href={storyHref(s)} className={`rounded-sm px-1.5 py-0.5 font-mono text-[11px] font-medium hover:underline ${tone}`} title={s.title}>
      {id}
    </Link>
  );
}

export default function ReglasPage() {
  return (
    <>
      <PageHeader
        eyebrow="Construcción"
        title="Reglas para no pisarse"
        description="Un dueño por carpeta, el esquema de la base como contrato, y cinco dependencias con salida. Si el archivo no está en tu columna, abres un PR pequeño y lo revisa el dueño."
      />

      <section aria-labelledby="carpetas">
        <SectionTitle meta="Un PR que cruza dos módulos se parte en dos">
          <span id="carpetas">Un dueño por carpeta</span>
        </SectionTitle>
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="bg-bg-2 text-left text-xs text-fg-3">
                <th className="px-4 py-2.5 font-medium">Ruta</th>
                <th className="px-4 py-2.5 font-medium">Dueño</th>
                <th className="px-4 py-2.5 font-medium">La otra persona</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {RULES.map((r) => (
                <tr key={r.path} className="align-top">
                  <td className="px-4 py-2.5 font-mono text-xs text-fg">{r.path}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    <span className="inline-flex items-center gap-2">
                      {(r.owner === "rasheed" || r.owner === "nicolas") && <OwnerAvatar owner={r.owner} />}
                      {OWNER_RULE_LABEL[r.owner]}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-fg-2">{r.other || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mt-10 grid gap-10 lg:grid-cols-2">
        <section aria-labelledby="flujo">
          <SectionTitle>
            <span id="flujo">Flujo de trabajo</span>
          </SectionTitle>
          <ol className="divide-y divide-line rounded-md border border-line">
            {FLOW.map((f, i) => (
              <li key={f.title} className="flex gap-3 p-4">
                <span className="font-mono text-xs text-fg-3">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <p className="text-sm font-medium">{f.title}</p>
                  <p className="mt-0.5 text-sm leading-6 text-fg-2">{f.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="deps">
          <SectionTitle meta="Ordenadas por cuándo muerden">
            <span id="deps">Las cinco dependencias</span>
          </SectionTitle>
          <ol className="divide-y divide-line rounded-md border border-line">
            {DEPENDENCIES.map((d) => (
              <li key={d.key} className="flex gap-3 p-4">
                <span className="font-mono text-xs font-medium text-fg-2">{d.key}</span>
                <div>
                  <p className="text-sm leading-6">{d.who}</p>
                  <p className="mt-0.5 text-xs text-fg-3">{d.when}</p>
                  <p className="mt-1.5 text-sm leading-6 text-fg-2">
                    <span className="font-medium text-fg">Salida: </span>
                    {d.how}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="mt-10" aria-labelledby="decisiones">
        <SectionTitle meta="Cada una con una propuesta, para que decidir tome un minuto">
          <span id="decisiones">Decisiones</span>
        </SectionTitle>
        <ol className="grid gap-3 md:grid-cols-2">
          {DECISIONS.map((d, i) => (
            <li key={d.title} className={`rounded-md border p-4 ${d.resolved ? "border-line bg-bg-2" : "border-line"}`}>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold">
                  <span className="mr-2 font-mono text-xs font-normal text-fg-3">{i + 1}</span>
                  {d.title}
                </p>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${d.resolved ? "bg-ok-bg text-ok" : "bg-bg-3 text-fg-2"}`}>
                  {d.resolved ? "Resuelta" : "Pendiente"}
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-fg-2">
                <span className="font-medium text-fg">Propuesta: </span>
                {d.proposal}
              </p>
              {d.resolved && <p className="mt-1.5 text-sm leading-6 text-ok">{d.resolved}</p>}
              <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
                Bloquea
                {d.blocks.map((b) => (
                  <StoryLink key={b} id={b} />
                ))}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
