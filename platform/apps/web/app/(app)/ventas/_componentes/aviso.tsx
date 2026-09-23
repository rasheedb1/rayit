/**
 * El resultado de una acción: el error en rojo y con `role="alert"`, el
 * aviso de que salió bien en verde y con `role="status"`, para que un
 * lector de pantalla lo anuncie sin robar el foco.
 */
export function Aviso({ message, notice, className = "" }: { message?: string; notice?: string; className?: string }) {
  if (message) {
    return (
      <p role="alert" className={`rounded-md border border-bad/30 bg-bad-wash px-3 py-2 text-sm text-bad ${className}`}>
        {message}
      </p>
    );
  }
  if (notice) {
    return (
      <p role="status" className={`rounded-md border border-good/30 bg-good-wash px-3 py-2 text-sm text-good ${className}`}>
        {notice}
      </p>
    );
  }
  return null;
}
