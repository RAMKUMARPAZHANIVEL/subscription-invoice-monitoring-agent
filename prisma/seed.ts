/**
 * Vendor seed data (data-model.md `Vendor`, Principle V: config over code).
 *
 * Run via `pnpm db:seed` (invokes `prisma db seed`, wired to this file through
 * `prisma.config.ts`'s `migrations.seed`). Only needs `DATABASE_URL` — it builds its own
 * PrismaClient rather than importing `src/storage/prisma.ts`, which pulls in `src/config/env.ts`
 * and would require unrelated Gmail/GCS/AI env vars just to seed vendors.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

interface VendorSeed {
  name: string;
  enabled: boolean;
  senderPatterns: string[];
  subjectPatterns: string[];
}

const vendors: VendorSeed[] = [
  {
    name: 'Claude',
    enabled: true,
    senderPatterns: ['@anthropic.com'],
    subjectPatterns: ['receipt', 'invoice'],
  },
  {
    name: 'GitHub',
    enabled: true,
    senderPatterns: ['billing@github.com'],
    subjectPatterns: ['payment receipt', 'receipt for your'],
  },
  {
    name: 'AWS',
    enabled: true,
    senderPatterns: ['@aws.amazon.com'],
    subjectPatterns: ['your aws bill', 'aws billing statement'],
  },
  {
    name: 'Jira',
    enabled: true,
    senderPatterns: ['@atlassian.com'],
    subjectPatterns: ['invoice', 'receipt'],
  },
  {
    name: 'Tiny.cloud',
    enabled: true,
    senderPatterns: ['@tiny.cloud'],
    subjectPatterns: ['invoice', 'receipt'],
  },
  {
    name: 'Coderabbit',
    enabled: true,
    senderPatterns: ['@coderabbit.ai'],
    subjectPatterns: ['invoice', 'receipt'],
  },
  {
    name: 'Greptile',
    enabled: true,
    senderPatterns: ['@greptile.com'],
    subjectPatterns: ['invoice', 'receipt'],
  },
  {
    name: 'CoreValue',
    enabled: true,
    senderPatterns: ['@corevalue.dev'],
    subjectPatterns: ['invoice', 'receipt'],
  },
  {
    // Controlled vendor for production ingestion validation (T206/WIZ-55). Self-to-self
    // (admin mailbox sending to itself) so sender/subject stay fully within our control and can't
    // collide with real vendor mail.
    name: 'SIMA Test Vendor',
    enabled: true,
    senderPatterns: ['ramkumar@replicacia.com'],
    subjectPatterns: ['SIMA-TEST-INVOICE'],
  },
];

async function main(): Promise<void> {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    for (const vendor of vendors) {
      await prisma.vendor.upsert({
        where: { name: vendor.name },
        update: {
          enabled: vendor.enabled,
          senderPatterns: vendor.senderPatterns,
          subjectPatterns: vendor.subjectPatterns,
        },
        create: vendor,
      });
      console.log(`Seeded vendor: ${vendor.name}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Vendor seed failed:', error);
  process.exitCode = 1;
});
