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
  ANTHROPIC_API_KEY: z.string(),
  DATABASE_URL: z.string().url(),
  GMAIL_CLIENT_ID: z.string(),
  GMAIL_CLIENT_SECRET: z.string(),
  GMAIL_REFRESH_TOKEN: z.string(),
  GMAIL_ADMIN_EMAIL: z.string().email(),
  GCS_BUCKET_NAME: z.string(),
  ATTACHMENT_STORE_DRIVER: z.enum(['local', 'gcs']).default('gcs'),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
