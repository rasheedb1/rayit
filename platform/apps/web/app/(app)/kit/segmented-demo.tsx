"use client";

import { useState } from "react";
import { Segmented } from "@/components/ui/segmented";

type Net = "all" | "tiktok" | "instagram" | "youtube" | "facebook";

/** El filtro por red de Resumen (RES-1). */
export function SegmentedDemo() {
  const [net, setNet] = useState<Net>("all");
  const [order, setOrder] = useState<"views" | "saves" | "recent">("views");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<Net>
          label="Red"
          value={net}
          onChange={setNet}
          options={[
            { value: "all", label: "Todas" },
            { value: "tiktok", label: "TikTok" },
            { value: "instagram", label: "Instagram" },
            { value: "youtube", label: "YouTube" },
            { value: "facebook", label: "Facebook", disabled: true },
          ]}
        />
        <span className="font-mono text-xs text-muted">value=&quot;{net}&quot;</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Orden"
          size="sm"
          value={order}
          onChange={setOrder}
          options={[
            { value: "views", label: "Más views" },
            { value: "saves", label: "Más guardados" },
            { value: "recent", label: "Recientes" },
          ]}
        />
        <span className="font-mono text-xs text-muted">value=&quot;{order}&quot;</span>
      </div>
    </div>
  );
}
