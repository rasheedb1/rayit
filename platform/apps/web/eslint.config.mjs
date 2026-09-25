import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { ignores: [".next/**", "node_modules/**"] },
  {
    // @mc/db/worker marca una transacción como del worker (WorkerSql): es lo
    // que impide llamar al despachador desde la web. La web que de verdad
    // necesita el rol del worker usa asWorker (VEN-10 r2).
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@mc/db/worker",
              message: "@mc/db/worker es solo del worker: la web usa asWorker de @mc/db.",
            },
          ],
        },
      ],
    },
  },
];
