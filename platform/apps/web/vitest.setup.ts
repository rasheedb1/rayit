import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";
import { ESPERA_UI_MS } from "./lib/testing/tiempos";

// findBy* y waitFor esperan 1 s por omisión; aquí, ESPERA_UI_MS (el
// porqué está en lib/testing/tiempos.ts, con los demás techos).
configure({ asyncUtilTimeout: ESPERA_UI_MS });

afterEach(() => cleanup());
