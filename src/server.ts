import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { runInvoiceCheck } from './agent/invoiceMonitor.js';
import { prisma } from './storage/prisma.js';
import type { Prisma } from './generated/prisma/client.js';
import { SubscriptionType } from './generated/prisma/enums.js';

const listInvoicesQuerySchema = z.object({
  vendor: z.string().min(1).optional(),
  subscriptionType: z.nativeEnum(SubscriptionType).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const invoiceListInclude = {
  vendor: { select: { name: true } },
  attachments: { select: { id: true } },
} satisfies Prisma.InvoiceInclude;

type InvoiceListRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceListInclude }>;

function toInvoiceListItem(invoice: InvoiceListRow) {
  return {
    id: invoice.id,
    vendor: invoice.vendor.name,
    amount: invoice.amount.toFixed(2),
    currency: invoice.currency,
    invoiceDate: formatDateOnly(invoice.invoiceDate),
    billingPeriodStart: invoice.billingPeriodStart
      ? formatDateOnly(invoice.billingPeriodStart)
      : null,
    billingPeriodEnd: invoice.billingPeriodEnd ? formatDateOnly(invoice.billingPeriodEnd) : null,
    subscriptionType: invoice.subscriptionType,
    extractionConfidence: invoice.extractionConfidence,
    attachmentCount: invoice.attachments.length,
  };
}

const invoiceDetailInclude = {
  vendor: { select: { name: true } },
  sourceEmail: true,
  attachments: true,
  processingHistoryEntries: { orderBy: { evaluatedAt: 'asc' } },
} satisfies Prisma.InvoiceInclude;

type InvoiceDetailRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceDetailInclude }>;

function toInvoiceDetail(invoice: InvoiceDetailRow) {
  return {
    id: invoice.id,
    vendor: invoice.vendor.name,
    amount: invoice.amount.toFixed(2),
    currency: invoice.currency,
    invoiceDate: formatDateOnly(invoice.invoiceDate),
    billingPeriodStart: invoice.billingPeriodStart
      ? formatDateOnly(invoice.billingPeriodStart)
      : null,
    billingPeriodEnd: invoice.billingPeriodEnd ? formatDateOnly(invoice.billingPeriodEnd) : null,
    subscriptionType: invoice.subscriptionType,
    lineItems: invoice.lineItems ?? null,
    extractionConfidence: invoice.extractionConfidence,
    sourceEmail: {
      gmailMessageId: invoice.sourceEmail.gmailMessageId,
      sender: invoice.sourceEmail.sender,
      subject: invoice.sourceEmail.subject,
      receivedAt: invoice.sourceEmail.receivedAt.toISOString(),
    },
    attachments: invoice.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
    })),
    processingHistory: invoice.processingHistoryEntries.map((entry) => ({
      outcome: entry.outcome,
      attemptNumber: entry.attemptNumber,
      evaluatedAt: entry.evaluatedAt.toISOString(),
    })),
  };
}

export function createServer(): Express {
  const app = express();

  app.use(express.json());

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.post('/tasks/check-invoices', async (_req: Request, res: Response) => {
    try {
      const result = await runInvoiceCheck();
      res.status(200).json(result);
    } catch (error) {
      logger.error({ error }, 'Invoice check failed');
      res.status(500).json({ status: 'error' });
    }
  });

  app.post('/tasks/ingest-invoices', async (_req: Request, res: Response) => {
    logger.info('Received invoice ingestion trigger request');
    try {
      const summary = await runInvoiceCheck();
      res.status(200).json({
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        durationMs: summary.durationMs,
        emailsScanned: summary.emailsScanned,
        invoicesProcessed: summary.invoicesProcessed,
        failures: summary.failures,
      });
    } catch (error) {
      logger.error({ error }, 'Invoice ingestion run failed');
      res.status(500).json({ status: 'error' });
    }
  });

  app.get('/invoices', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ query: req.query }, 'Received GET /invoices request');
    try {
      const parsed = listInvoicesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ status: 'error', message: 'Invalid query parameters' });
        return;
      }
      const { vendor, subscriptionType, from, to, limit, cursor } = parsed.data;

      const where: Prisma.InvoiceWhereInput = {
        ...(vendor ? { vendor: { name: vendor } } : {}),
        ...(subscriptionType ? { subscriptionType } : {}),
        ...(from || to
          ? { invoiceDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      };

      const rows = await prisma.invoice.findMany({
        where,
        orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: invoiceListInclude,
      });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const lastRow = page[page.length - 1];
      const nextCursor = hasMore && lastRow ? lastRow.id : null;

      res.status(200).json({ invoices: page.map(toInvoiceListItem), nextCursor });
      logger.info(
        { durationMs: Date.now() - startedAt, count: page.length },
        'GET /invoices completed',
      );
    } catch (error) {
      logger.error({ error }, 'GET /invoices failed');
      res.status(500).json({ status: 'error' });
    }
  });

  app.get('/invoices/:id', async (req: Request<{ id: string }>, res: Response) => {
    const { id } = req.params;
    const startedAt = Date.now();
    logger.info({ invoiceId: id }, 'Received GET /invoices/:id request');
    try {
      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: invoiceDetailInclude,
      });

      if (!invoice) {
        logger.info(
          { invoiceId: id, durationMs: Date.now() - startedAt },
          'GET /invoices/:id: invoice not found',
        );
        res.status(404).json({ status: 'error', message: 'Invoice not found' });
        return;
      }

      res.status(200).json(toInvoiceDetail(invoice));
      logger.info(
        { invoiceId: id, durationMs: Date.now() - startedAt },
        'GET /invoices/:id completed',
      );
    } catch (error) {
      logger.error({ invoiceId: id, error }, 'GET /invoices/:id failed');
      res.status(500).json({ status: 'error' });
    }
  });

  return app;
}

export function startServer() {
  const app = createServer();
  return app.listen(env.PORT, () => {
    logger.info(`Server listening on port ${env.PORT}`);
  });
}
