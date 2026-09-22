/**
 * Finanzas: facturas, pagos, gastos, ingresos de plataforma y reserva
 * de impuestos. Migración 0008 (última parte).
 *
 * Todo importe es numeric(14,2) y viaja como string decimal; la moneda
 * va en su propia columna. `overdue` existe en el CHECK pero no se
 * persiste: la vista receivables lo deriva de due_on.
 */
import { boolean, date, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currency, money, timestamptz, updatedAt, uuidPk } from './_tipos.ts';
import { creatorProfile, platform, workspaceId } from './cimientos.ts';
import { campaign } from './campanas.ts';
import { quote } from './cotizar.ts';
import { company } from './ventas.ts';

export const INVOICE_STATUSES = ['draft', 'sent', 'partial', 'paid', 'overdue', 'void'] as const;
export const PAYMENT_DIRECTIONS = ['in', 'out'] as const;
export const PAYOUT_SOURCES = ['api', 'csv_import', 'manual'] as const;

export const invoice = pgTable('invoice', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  companyId: uuid('company_id').notNull().references(() => company.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').references(() => campaign.id, { onDelete: 'set null' }),
  quoteId: uuid('quote_id').references(() => quote.id, { onDelete: 'set null' }),
  number: text('number').notNull(),
  currency: currency('currency').default('COP').notNull(),
  subtotal: money('subtotal').notNull(),
  tax: money('tax').default('0').notNull(),
  /** Retención en la fuente. */
  withholding: money('withholding').default('0').notNull(),
  total: money('total').notNull(),
  issuedOn: date('issued_on', { mode: 'string' }).notNull(),
  dueOn: date('due_on', { mode: 'string' }).notNull(),
  status: text('status', { enum: INVOICE_STATUSES }).default('draft').notNull(),
  paidAmount: money('paid_amount').default('0').notNull(),
  paidAt: timestamptz('paid_at'),
  remindersSent: integer('reminders_sent').default(0).notNull(),
  lastReminderAt: timestamptz('last_reminder_at'),
  /** Factura electrónica (DIAN u homólogo). */
  externalRef: text('external_ref'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const payment = pgTable('payment', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  invoiceId: uuid('invoice_id').references(() => invoice.id, { onDelete: 'set null' }),
  direction: text('direction', { enum: PAYMENT_DIRECTIONS }).notNull(),
  amount: money('amount').notNull(),
  currency: currency('currency').notNull(),
  method: text('method'),
  receivedAt: timestamptz('received_at').defaultNow().notNull(),
  reference: text('reference'),
  notes: text('notes'),
});

export const expense = pgTable('expense', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  category: text('category').notNull(),
  vendor: text('vendor'),
  description: text('description'),
  amount: money('amount').notNull(),
  currency: currency('currency').notNull(),
  incurredOn: date('incurred_on', { mode: 'string' }).notNull(),
  isRecurring: boolean('is_recurring').default(false).notNull(),
  recurrence: text('recurrence'),
  receiptUrl: text('receipt_url'),
  deductible: boolean('deductible').default(true).notNull(),
  createdAt: createdAt(),
});

export const platformPayout = pgTable('platform_payout', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  creatorId: uuid('creator_id').references(() => creatorProfile.id, { onDelete: 'set null' }),
  platformId: text('platform_id').notNull().references(() => platform.id),
  periodStart: date('period_start', { mode: 'string' }).notNull(),
  periodEnd: date('period_end', { mode: 'string' }).notNull(),
  amount: money('amount').notNull(),
  currency: currency('currency').notNull(),
  source: text('source', { enum: PAYOUT_SOURCES }).notNull(),
  createdAt: createdAt(),
});

export const taxReserve = pgTable('tax_reserve', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  paymentId: uuid('payment_id').references(() => payment.id, { onDelete: 'cascade' }),
  rate: numeric('rate', { precision: 6, scale: 4 }).notNull(),
  amount: money('amount').notNull(),
  currency: currency('currency').notNull(),
  /** '2026-Q3' */
  period: text('period'),
  releasedAt: timestamptz('released_at'),
  createdAt: createdAt(),
});
