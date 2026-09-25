"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { EditorDePitch, type EditorData } from "./editor";

/**
 * Cuándo se vuelve a montar el editor del pitch (ronda 5).
 *
 * El servidor manda `aiKey` (vista.ts, editorKey): cambia cuando la IA se
 * pone a redactar o trae un borrador nuevo, y es null cuando lo último lo
 * escribió una persona. El editor se monta de nuevo SOLO cuando llega una
 * clave de la IA distinta de la montada. Si la clave pasa a null (la
 * persona guardó, copió o programó el borrador de la IA; o el toque ya
 * está programado y el servidor no devuelve borrador), el editor sigue
 * montado: conserva el texto, el aviso («Programado») y su foco.
 *
 * `arrived` le dice al editor que se montó porque llegó un borrador nuevo
 * de la IA, no porque se abrió la página: entonces lleva el foco al aviso
 * del borrador y lo anuncia. «Escribir otro pitch» lo monta limpio.
 */
export function MontajeDelEditor({ data, aiKey }: { data: EditorData; aiKey: string | null }) {
  const router = useRouter();
  const [mount, setMount] = useState({ key: aiKey ?? "a-mano", seen: aiKey, arrived: false, n: 0 });
  /** Los toques que ya se programaron desde aquí: si la página todavía los trae como borrador, no se reabren. */
  const [done, setDone] = useState<readonly string[]>([]);
  const shown = data.draft && done.includes(data.draft.touchId) ? { ...data, draft: null } : data;
  // Estado derivado de las props, durante el render (el patrón de React para «cuando cambia una prop»).
  if (aiKey !== mount.seen) {
    const remount = aiKey !== null && aiKey !== mount.key;
    setMount({
      key: remount ? aiKey : mount.key,
      seen: aiKey,
      arrived: remount ? !aiKey.endsWith(":pendiente") : mount.arrived,
      n: mount.n,
    });
  }
  return (
    <EditorDePitch
      key={`${mount.key}#${mount.n}`}
      data={shown}
      arrived={mount.arrived}
      onReset={(scheduledTouch) => {
        if (scheduledTouch) setDone((xs) => [...xs, scheduledTouch]);
        setMount((m) => ({ key: "a-mano", seen: aiKey, arrived: false, n: m.n + 1 }));
        router.refresh();
      }}
    />
  );
}
