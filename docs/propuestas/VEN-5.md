# VEN-5 · Ficha de empresa

Rama: `rasheed/VEN-5-ficha-empresa-r5` (VEN-4 y VEN-5 viajan juntas).
La nota corta vive en `platform/apps/web/content/backlog.ts`; aquí va el
detalle.

---

## Qué hace

`/ventas/empresas/[id]`, como la ficha de Attio: todo en bloques que se
pliegan (Negocios, Actividad, Contactos, Relación, Datos y «Lo que
sabemos»); cada título es un `h2` con su botón de disclosure
(`aria-expanded`), así la ficha se recorre por encabezados.

- **Cabecera**: nombre, dominio, nichos como pastillas, sector, relación
  y responsable.
- **Negocios**: cada uno con su siguiente acción (VEN-4), «Último
  contacto: hace 3 días», la cifra rotulada («COP 12,0 M abiertos») y la
  cadena cotización → campaña → factura enlazada a cada módulo, con el
  estado de Finanzas de todas sus facturas (`listChainInvoices` pagina).
- **Actividad**: registro rápido por teclado (N, L, C, R con el foco en el
  bloque, WCAG 2.1.4; ⌘ + Enter) y la línea de tiempo con «Ver más» por
  cursor. Una llamada, un correo o una reunión mueven
  `deal.last_contact_at` sin retrocederlo; si caen en un negocio con la
  acción vencida o de hoy, se pregunta «¿Era «…»?».
- **Contactos** con procedencia y baja (respetada también en el servidor,
  `ContactOptedOut`).
- **Lo que sabemos**: la ficha enriquecida y todas las señales, también
  las descartadas con su motivo.

## Dónde está cada cosa

| Pieza | Archivo |
|---|---|
| Página | `apps/web/app/(app)/ventas/empresas/[id]/(ficha)/page.tsx` |
| Bloques | `[id]/bloque.tsx`, `negocio.tsx`, `registro.tsx`, `linea-de-tiempo.tsx`, `contactos.tsx`, `relacion.tsx`, `datos.tsx`, `sabemos.tsx`, `cadena.tsx` |
| Textos | `ventas/empresas/messages.ts` |
| Consultas | `packages/db/src/queries/ventas-ficha.ts` |
| Enlaces externos | `apps/web/lib/url.ts` (`safeHref`) |

## Pruebas

- `packages/db/test/ventas-ficha.test.ts`: registrar una llamada la pone
  en la línea de tiempo y mueve `last_contact_at` (el «terminado
  cuando»); una nota no lo mueve; nada cruza de un espacio a otro.
- `apps/web/app/(app)/ventas/empresas/[id]/*.test.tsx`: registro por
  teclado, línea de tiempo, bloques, contactos, datos y enlaces externos.

## Pendiente humano

El de VEN-4 (aplicar 0034–0036 y `make db.seed`; ver
[VEN-4.md](VEN-4.md)). La ficha no necesita esquema propio.

---

## Historia por rondas

### r1 (203ac61, e05e5dc)
Ficha con línea de tiempo, registro rápido, «lo que sabemos» y la
cadena; pruebas de pantalla.

### r2 (c452df6)
Atajos solo con el foco en «Actividad» (WCAG 2.1.4); `ContactOptedOut`;
«Ver más» por cursor; nichos como pastillas; Contactos, Relación y Datos
también en bloque.

### r3 (9005ea0)
Bloques con patrón de disclosure (`h2 > button`), `hidden="until-found"`;
teclas del registro en `messages.ts`; topes de texto en `@mc/core`; la
cadena lee todas las facturas; «Negocio» del registro en su propia fila.

### r4 (beacad8)
«Último contacto: hace N días» (días en SQL, `Intl.RelativeTimeFormat`);
«¿Era «…»?» al registrar; seed con tres «Cambio de etapa».

### r5
- **Enlaces externos seguros.** «Ver la evidencia» pintaba
  `signal.evidence_url` como href sin mirar el protocolo; la columna es
  text libre y la llenarán los conectores del radar. `safeHref` (solo
  http y https) se aplica a la evidencia de la ficha y del radar y al
  LinkedIn y la fuente de los contactos: un `javascript:` no se enlaza.
- **«Editar» de Datos** va como en Contactos: lo primero del cuerpo, a la
  izquierda y secundario (antes, solo y a la derecha, parecía perdido).
- **El aviso «¿Era…?»** se va cuando la acción del negocio cambia, y
  pulsarlo con la pantalla vieja ya no cierra la acción nueva
  (`ActionChanged`; detalle en [VEN-4.md](VEN-4.md)).
- Las notas del backlog pasan a dos o tres frases; el detalle de las
  rondas vive aquí.
