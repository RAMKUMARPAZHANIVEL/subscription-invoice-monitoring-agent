import express, { type Express, type Request, type Response } from 'express';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { runInvoiceCheck } from './agent/invoiceMonitor.js';

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

  return app;
}

export function startServer() {
  const app = createServer();
  return app.listen(env.PORT, () => {
    logger.info(`Server listening on port ${env.PORT}`);
  });
}
