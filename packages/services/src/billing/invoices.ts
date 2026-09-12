/**
 * Read-only mirror of Stripe invoices. Populated by webhooks; upsert is keyed
 * on `stripeInvoiceId` so a redelivery is harmless. No line-item or card data
 * is ever stored.
 */
import { type Db, prisma } from '@growth-agent/db';
import type { StripeInvoice } from './gateway.js';

function fromUnix(seconds: number | null | undefined): Date | null {
  return seconds ? new Date(seconds * 1000) : null;
}

export async function upsertInvoiceFromStripe(
  input: { organizationId: string; invoice: StripeInvoice },
  db: Db = prisma,
) {
  const i = input.invoice;
  const data = {
    organizationId: input.organizationId,
    stripeInvoiceId: i.id,
    number: i.number,
    status: i.status ?? 'draft',
    amountDue: i.amount_due ?? 0,
    amountPaid: i.amount_paid ?? 0,
    amountRemaining: i.amount_remaining ?? 0,
    currency: i.currency ?? 'usd',
    hostedInvoiceUrl: i.hosted_invoice_url,
    invoicePdfUrl: i.invoice_pdf,
    periodStart: fromUnix(i.period_start),
    periodEnd: fromUnix(i.period_end),
    issuedAt: fromUnix(i.created),
  };
  return db.invoice.upsert({
    where: { stripeInvoiceId: i.id },
    create: data,
    update: {
      number: data.number,
      status: data.status,
      amountDue: data.amountDue,
      amountPaid: data.amountPaid,
      amountRemaining: data.amountRemaining,
      hostedInvoiceUrl: data.hostedInvoiceUrl,
      invoicePdfUrl: data.invoicePdfUrl,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      issuedAt: data.issuedAt,
    },
  });
}

export async function listInvoices(organizationId: string, db: Db = prisma) {
  return db.invoice.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}
