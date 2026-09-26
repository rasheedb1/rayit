import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// findBy* y waitFor esperan 1 s por omisión. Con `pnpm verificar` corriendo
// typecheck, lint y las pruebas de todo el monorepo a la vez, una acción
// mockeada más su transición de React pueden tardar más que eso sin que
// nada esté mal, y la puerta salía roja al azar. 5 s sigue muy por debajo
// del testTimeout: una espera que nunca se cumple sigue fallando.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => cleanup());
