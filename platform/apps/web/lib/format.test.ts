import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMoney, formatInt, formatCompact, formatPct, formatDelta, formatDate, formatDateRange,
  formatDaysRelative, parseMoneyInput, formatMoneyInputDisplay,
} from "./format.ts";

test("formatMoney: compact y full con las cifras del mock", () => {
  assert.equal(formatMoney("9400000.00", "COP", { mode: "compact" }), "COP 9,4 M");
  assert.equal(formatMoney("38600000.00", "COP", { mode: "compact" }), "COP 38,6 M");
  assert.equal(formatMoney("4246000.00", "COP", { mode: "compact" }), "COP 4,2 M");
  assert.equal(formatMoney("5200000.00", "COP", { mode: "full" }), "COP 5.200.000");
  assert.equal(formatMoney("5200000.00", "COP"), "COP 5.200.000");
  assert.equal(formatMoney("850000.00", "COP", { mode: "compact" }), "COP 850.000", "bajo 1 M, compact = full");
});

test("formatMoney: cero, negativos, mil millones, decimales y otra moneda", () => {
  assert.equal(formatMoney("0", "COP"), "COP 0");
  assert.equal(formatMoney("0.00", "COP", { mode: "compact" }), "COP 0");
  assert.equal(formatMoney("-1100000.00", "COP", { mode: "compact" }), "−COP 1,1 M");
  assert.equal(formatMoney("-12.50", "COP"), "−COP 12,50");
  assert.equal(formatMoney("1000000000.00", "COP", { mode: "compact" }), "COP 1.000 M");
  assert.equal(formatMoney("1234567890.55", "COP"), "COP 1.234.567.890,55");
  assert.equal(formatMoney("5200000.50", "COP"), "COP 5.200.000,50");
  assert.equal(formatMoney("1250000", "USD", { mode: "compact" }), "USD 1,3 M", "half-up en la décima");
  assert.equal(formatMoney("1249999.99", "USD", { mode: "compact" }), "USD 1,2 M");
  assert.throws(() => formatMoney("5.200.000", "COP"), /Monto inválido/);
  assert.throws(() => formatMoney("", "COP"), /Monto inválido/);
});

test("enteros, compactos y porcentajes en es-CO", () => {
  assert.equal(formatInt(1234567), "1.234.567");
  assert.equal(formatInt(0), "0");
  assert.equal(formatCompact(214000), "214 mil");
  assert.equal(formatCompact(1200000), "1,2 M");
  assert.equal(formatPct(0.31), "31 %");
  assert.equal(formatPct(0.58, 1), "58,0 %");
  assert.equal(formatDelta(0.31), "+31 %");
  assert.equal(formatDelta(-0.05), "−5 %");
  assert.equal(formatDelta(0), "0 %");
  assert.equal(formatDelta(0.0004), "0 %");
  assert.equal(formatDelta(0.308, 1), "+30,8 %");
});

test("fechas en UTC, mes corto de tres letras como el mock", () => {
  assert.equal(formatDate("2026-09-20"), "20 sep");
  assert.equal(formatDate("2026-10-09"), "9 oct");
  assert.equal(formatDate("2026-08-06T23:30:00Z"), "6 ago", "no cambia de día por la zona local");
  assert.equal(formatDate("2026-09-20", "long"), "20 de septiembre de 2026");
  assert.equal(formatDateRange("2026-08-24", "2026-08-31"), "24–31 ago");
  assert.equal(formatDateRange("2026-08-24", "2026-09-02"), "24 ago–2 sep");
  assert.throws(() => formatDate("ayer"), /Fecha inválida/);
});

test("días relativos para la columna Vence", () => {
  assert.equal(formatDaysRelative(23), "en 23 días");
  assert.equal(formatDaysRelative(0), "hoy");
  assert.equal(formatDaysRelative(1), "mañana");
  assert.equal(formatDaysRelative(-1), "ayer");
  assert.equal(formatDaysRelative(-41), "hace 41 días");
});

test("MoneyInput: escribir y pegar", () => {
  assert.equal(parseMoneyInput("5200000"), "5200000.00");
  assert.equal(parseMoneyInput("5.200.000,50"), "5200000.50");
  assert.equal(parseMoneyInput("5,200,000.50"), "5200000.50");
  assert.equal(parseMoneyInput("5.200.000"), "5200000.00");
  assert.equal(parseMoneyInput("5200000.5"), "5200000.50");
  assert.equal(parseMoneyInput("1,5"), "1.50");
  assert.equal(parseMoneyInput("5,200"), "5200.00", "tres dígitos tras el separador: miles");
  assert.equal(parseMoneyInput("COP 5.200.000"), "5200000.00");
  assert.equal(parseMoneyInput(" 1 234 567 "), "1234567.00");
  assert.equal(parseMoneyInput("2.675"), "2675.00");
  assert.equal(parseMoneyInput("1.000,005"), "1000.01", "half-up al centavo");
  assert.equal(parseMoneyInput("0,005"), "5.00", "un separador con tres dígitos detrás: miles");
  assert.equal(parseMoneyInput("-1000"), "-1000.00");
  assert.equal(parseMoneyInput(""), null);
  assert.equal(parseMoneyInput("abc"), null);
  assert.equal(parseMoneyInput("1.2.3,4,5"), null);
  assert.equal(formatMoneyInputDisplay("5200000.50"), "5.200.000,50");
  assert.equal(formatMoneyInputDisplay("5200000.00"), "5.200.000");
  assert.equal(formatMoneyInputDisplay(""), "");
});
