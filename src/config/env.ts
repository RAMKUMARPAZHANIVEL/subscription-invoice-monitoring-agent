import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GCP_REGION: z.string().optional(),
  INVOICE_CHECK_INTERVAL_CRON: z.string().default('0 */6 * * *'),
  INVOICE_ALERT_WEBHOOK_URL: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
