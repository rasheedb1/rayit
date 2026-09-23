/**
 * Concurrencia dentro de una corrida: como mucho `limit` elementos a la
 * vez (el límite sale de ctx.definition.maxConcurrency, contra el rate
 * limit de cada plataforma), conservando el orden de arranque. La usan
 * los jobs de Conexiones y Campañas.
 */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await fn(item);
      }
    }),
  );
}
