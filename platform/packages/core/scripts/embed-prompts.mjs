#!/usr/bin/env node
/**
 * Regenera packages/core/src/outreach/prompts.gen.ts a partir de los
 * prompts/*.md de outreach (generate, judge, classify).
 *
 * Por qué una copia en TypeScript: el turno del worker (CIM-7) corre los
 * handlers dentro del bundle de Next, y webpack fija import.meta.url a
 * la ruta de la máquina que hizo el build (/Users/… en local,
 * /vercel/path0 en Vercel); la función corre en /var/task, así que un
 * readFileSync(new URL('./prompts/x.md', import.meta.url)) da ENOENT.
 * Es el mismo problema que resolvió packages/db/src/supabase-ca.ts.
 *
 * Los .md siguen siendo la fuente que se edita. Tras editarlos:
 *   make core.prompts            (o: node packages/core/scripts/embed-prompts.mjs)
 * Con --check no escribe: sale con 1 si el .ts no coincide con los .md.
 * La prueba packages/core/test/outreach-prompts.test.ts falla si divergen.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(CORE, 'src', 'outreach');
export const PROMPT_NAMES = ['generate', 'judge', 'classify'];
export const GENERATED = join(DIR, 'prompts.gen.ts');

/** Un literal de plantilla que devuelve exactamente `text`. */
const literal = (text) => '`' + text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';

/** El contenido que debe tener prompts.gen.ts con los .md de hoy. */
export function render() {
  const entries = PROMPT_NAMES.map((name) => `  ${name}: ${literal(readFileSync(join(DIR, 'prompts', `${name}.md`), 'utf8'))},`);
  return `/**
 * Los prompts de outreach (prompts/*.md), incrustados. ARCHIVO GENERADO:
 * no se edita a mano. Se editan los .md y se corre \`make core.prompts\`
 * (packages/core/scripts/embed-prompts.mjs); la prueba
 * test/outreach-prompts.test.ts falla si las dos copias divergen.
 *
 * Existe porque en el bundle de Next (el turno del worker, CIM-7) un
 * readFileSync relativo a import.meta.url apunta a la máquina del build.
 */
export const PROMPTS = {
${entries.join('\n')}
} as const;

export type PromptName = keyof typeof PROMPTS;
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = render();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(GENERATED, 'utf8');
    } catch {
      // falta: diverge
    }
    if (current !== out) {
      console.error('packages/core/src/outreach/prompts.gen.ts no coincide con prompts/*.md: corre `make core.prompts`.');
      process.exit(1);
    }
  } else {
    writeFileSync(GENERATED, out);
    console.log('  packages/core/src/outreach/prompts.gen.ts regenerado');
  }
}
