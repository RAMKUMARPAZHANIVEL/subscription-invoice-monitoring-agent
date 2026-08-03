import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

// prisma.ts requires a full env (DATABASE_URL, Gmail creds, etc.); mock env.js like
// invoiceMonitor.test.ts does so this file only needs DATABASE_URL to point at the real
// local test database. The constitution (Principle X / CLAUDE.md Testing) prohibits mocking
// the database itself, so these tests exercise Prisma's upsert against real Postgres.
vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL:
      'postgresql://app_user:your_password@localhost:5433/subscription_invoice_dev?schema=public',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    GMAIL_CLIENT_ID: 'test-client-id',
    GMAIL_CLIENT_SECRET: 'test-client-secret',
    GMAIL_REFRESH_TOKEN: 'test-refresh-token',
    GMAIL_ADMIN_EMAIL: 'admin@example.com',
    GCS_BUCKET_NAME: 'test-bucket',
    ATTACHMENT_STORE_DRIVER: 'local',
    ATTACHMENT_STORE_LOCAL_DIR: '.data/attachments-test',
  },
}));

const { prisma } = await import('./prisma.js');

describe('SourceEmail upsert by gmailMessageId', () => {
  const gmailMessageIds: string[] = [];

  function upsert(gmailMessageId: string) {
    return prisma.sourceEmail.upsert({
      where: { gmailMessageId },
      create: {
        gmailMessageId,
        sender: 'billing@testvendor.example',
        subject: 'Your invoice',
        receivedAt: new Date(),
      },
      update: {},
    });
  }

  afterEach(async () => {
    await prisma.sourceEmail.deleteMany({ where: { gmailMessageId: { in: gmailMessageIds } } });
    gmailMessageIds.length = 0;
  });

  it('creates exactly one row on first upsert', async () => {
    const gmailMessageId = `abc123-${randomUUID()}`;
    gmailMessageIds.push(gmailMessageId);

    await upsert(gmailMessageId);

    const rows = await prisma.sourceEmail.findMany({ where: { gmailMessageId } });
    expect(rows).toHaveLength(1);
  });

  it('does not create a second row when upserted again with the same gmailMessageId', async () => {
    const gmailMessageId = `abc123-${randomUUID()}`;
    gmailMessageIds.push(gmailMessageId);

    await upsert(gmailMessageId);
    await upsert(gmailMessageId);

    const rows = await prisma.sourceEmail.findMany({ where: { gmailMessageId } });
    expect(rows).toHaveLength(1);
  });

  it('creates a distinct row for a different gmailMessageId', async () => {
    const first = `abc123-${randomUUID()}`;
    const second = `xyz999-${randomUUID()}`;
    gmailMessageIds.push(first, second);

    await upsert(first);
    await upsert(second);

    const rows = await prisma.sourceEmail.findMany({
      where: { gmailMessageId: { in: [first, second] } },
    });
    expect(rows).toHaveLength(2);
  });

  it('rejects a direct create with a duplicate gmailMessageId, enforcing the unique constraint', async () => {
    const gmailMessageId = `abc123-${randomUUID()}`;
    gmailMessageIds.push(gmailMessageId);

    await prisma.sourceEmail.create({
      data: {
        gmailMessageId,
        sender: 'billing@testvendor.example',
        subject: 'Your invoice',
        receivedAt: new Date(),
      },
    });

    await expect(
      prisma.sourceEmail.create({
        data: {
          gmailMessageId,
          sender: 'billing@testvendor.example',
          subject: 'Your invoice',
          receivedAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    const rows = await prisma.sourceEmail.findMany({ where: { gmailMessageId } });
    expect(rows).toHaveLength(1);
  });
});
