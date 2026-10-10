# Resumen, lo que faltaba (R4-RES) · 10-oct-2026

Escrito para: Rasheed y Nicolás. RES-4 sobre la demografía real de CON-7
y lo que del pulido final de Resumen quedó para después.

## 1. RES-4 · «Quién te ve»

`app/(app)/resumen/audiencia.tsx` (`QuienTeVe`) va debajo de los
gráficos del panel, con su propio `Suspense`. Lee `listAccountAudience`
y `listAccounts` (`@mc/db`, Conexiones) en una transacción, respeta el
filtro de red del panel y pinta, por cuenta con demografía, el mismo
componente que la ficha de Conexiones (`conexiones/[id]/audiencia.tsx`):
un solo sitio decide cómo se lee un tramo (edad tal cual, género por su
palabra, país por su nombre, ciudad sin la región) y qué se enseña
cuando la red dio porcentajes y no personas. Nada de aritmética en
React: las barras son lo que dio la red.

Estados: la red del filtro no tiene cuentas; hay cuentas pero ninguna
con demografía (la frase distingue la cuenta por @, que necesita la
autorización del dueño, de la autorizada que todavía no tiene lectura o
tiene menos de 100 seguidores); y lo que falta por cuenta lo dice el
hueco de `metric_gap` con la frase de la migración. Prueba:
`resumen/audiencia.test.tsx` (tres casos).

**«Cuándo publicar» no se pinta.** El «terminado cuando» pedía el
gráfico por hora de seguidores conectados (Instagram `online_followers`).
Ninguna tabla lo guarda: `audience_breakdown` (0039) tiene edad, género,
país, ciudad, idioma, dispositivo y tipo de seguidor, y
`collect.demographics` no pide esa métrica. Un gráfico vacío mentiría,
así que el bloque lo dice en una frase. RES-4 queda **en curso** hasta
que CON-7 (Nicolás) recoja `online_followers` por hora; entonces el
bloque es una dimensión más del mismo componente.

## 2. Pulido final de Resumen (pendientes-pulido-final.json)

| Hallazgo | Estado |
|---|---|
| `asistente.tsx` de 1 025 líneas: reducer puro + un archivo por paso | **Pendiente**: refactor sin cambio de comportamiento, con las pruebas de RES-2 como red; es trabajo de una sesión entera |
| Etiquetas de «Visualizaciones por semana» a 1 280 px (6 de 12) | **Pendiente**: `_lib/eje.ts` con el paso según el ancho |
| Prueba de actualización 0033 → última con datos (`actualizacion.test.ts`) | **Pendiente**: Supabase pasó por ahí de verdad; la prueba evita que una migración futura lo rompa |

## 3. Decisiones

| Pregunta | Lo que quedó | Si se quiere lo contrario |
|---|---|---|
| ¿Reutilizar el componente de Conexiones o copiarlo en Resumen? | Reutilizar (importado desde la carpeta de Nicolás, con su autorización): dos copias de «cómo se lee un tramo» acabarían distintas | Mover `Audiencia`, `barrasDe` y `etiquetaDeTramo` a `components/` compartidos, con sus textos |
| ¿Mostrar un gráfico por hora vacío con «próximamente»? | No: una ausencia se explica con una frase | — |
