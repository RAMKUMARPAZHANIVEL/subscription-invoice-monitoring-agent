import { describe, expect, it, vi } from 'vitest';
import type { Vendor } from '../../generated/prisma/client.js';
import {
  buildDiscoveryQuery,
  buildVendorClause,
  discoverCandidateEmails,
  formatGmailDate,
  type GmailMessageLister,
} from './discovery.js';

function makeVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor_1',
    name: 'GitHub',
    senderPatterns: ['billing@github.com'],
    subjectPatterns: [],
    defaultSubscriptionType: null,
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('formatGmailDate', () => {
  it('formats a UTC date as YYYY/MM/DD', () => {
    expect(formatGmailDate(new Date('2026-03-05T12:34:56Z'))).toBe('2026/03/05');
  });

  it('zero-pads single-digit months and days', () => {
    expect(formatGmailDate(new Date('2026-01-09T00:00:00Z'))).toBe('2026/01/09');
  });
});

describe('buildVendorClause', () => {
  it('builds a sender-only clause when the vendor has no subject patterns', () => {
    const vendor = makeVendor({ senderPatterns: ['billing@github.com'] });

    expect(buildVendorClause(vendor)).toBe('from:(billing@github.com)');
  });

  it('OR-joins multiple sender patterns', () => {
    const vendor = makeVendor({ senderPatterns: ['@aws.amazon.com', '@amazonaws.com'] });

    expect(buildVendorClause(vendor)).toBe('from:(@aws.amazon.com OR @amazonaws.com)');
  });

  it('combines sender and subject clauses when subject patterns are configured', () => {
    const vendor = makeVendor({
      senderPatterns: ['billing@github.com'],
      subjectPatterns: ['receipt', 'invoice'],
    });

    expect(buildVendorClause(vendor)).toBe(
      '(from:(billing@github.com) subject:(receipt OR invoice))',
    );
  });

  it('quotes subject patterns containing spaces', () => {
    const vendor = makeVendor({
      senderPatterns: ['billing@github.com'],
      subjectPatterns: ['Your receipt'],
    });

    expect(buildVendorClause(vendor)).toBe('(from:(billing@github.com) subject:("Your receipt"))');
  });
});

describe('buildDiscoveryQuery', () => {
  const since = new Date('2026-01-15T00:00:00Z');

  it('returns null when there are no vendors to search for', () => {
    expect(buildDiscoveryQuery([], { since })).toBeNull();
  });

  it('builds a query for a single vendor with the date filter appended', () => {
    const vendor = makeVendor({ senderPatterns: ['billing@github.com'] });

    expect(buildDiscoveryQuery([vendor], { since })).toBe(
      'from:(billing@github.com) after:2026/01/15',
    );
  });

  it('OR-groups clauses across multiple vendors', () => {
    const github = makeVendor({ id: 'v1', name: 'GitHub', senderPatterns: ['@github.com'] });
    const aws = makeVendor({
      id: 'v2',
      name: 'AWS',
      senderPatterns: ['@aws.amazon.com'],
      subjectPatterns: ['invoice'],
    });

    expect(buildDiscoveryQuery([github, aws], { since })).toBe(
      '(from:(@github.com) OR (from:(@aws.amazon.com) subject:(invoice))) after:2026/01/15',
    );
  });

  it('does not include has:attachment by default (FR-005: body-only invoices are valid)', () => {
    const vendor = makeVendor();

    expect(buildDiscoveryQuery([vendor], { since })).not.toContain('has:attachment');
  });

  it('appends has:attachment when requireAttachment is explicitly true', () => {
    const vendor = makeVendor({ senderPatterns: ['billing@github.com'] });

    expect(buildDiscoveryQuery([vendor], { since, requireAttachment: true })).toBe(
      'from:(billing@github.com) after:2026/01/15 has:attachment',
    );
  });
});

describe('discoverCandidateEmails', () => {
  const since = new Date('2026-01-15T00:00:00Z');

  it('returns no candidates and never calls Gmail when there are no vendors', async () => {
    const listMessages = vi.fn();
    const client: GmailMessageLister = { listMessages };

    const result = await discoverCandidateEmails(client, [], { since });

    expect(result).toEqual([]);
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('queries with the built vendor query and returns the matched messages', async () => {
    const vendor = makeVendor({ senderPatterns: ['billing@github.com'] });
    const listMessages = vi.fn().mockResolvedValue({
      messages: [
        { id: 'm1', threadId: 't1' },
        { id: 'm2', threadId: 't2' },
      ],
    });
    const client: GmailMessageLister = { listMessages };

    const result = await discoverCandidateEmails(client, [vendor], { since });

    expect(listMessages).toHaveBeenCalledWith({ q: 'from:(billing@github.com) after:2026/01/15' });
    expect(result).toEqual([
      { id: 'm1', threadId: 't1' },
      { id: 'm2', threadId: 't2' },
    ]);
  });

  it('passes maxResults through to each page request', async () => {
    const vendor = makeVendor();
    const listMessages = vi.fn().mockResolvedValue({ messages: [] });
    const client: GmailMessageLister = { listMessages };

    await discoverCandidateEmails(client, [vendor], { since, maxResults: 10 });

    expect(listMessages).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 10 }));
  });

  it('paginates until nextPageToken is absent, accumulating messages across pages', async () => {
    const vendor = makeVendor();
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ id: 'm1', threadId: 't1' }],
        nextPageToken: 'page2',
      })
      .mockResolvedValueOnce({
        messages: [{ id: 'm2', threadId: 't2' }],
      });
    const client: GmailMessageLister = { listMessages };

    const result = await discoverCandidateEmails(client, [vendor], { since });

    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(listMessages).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pageToken: 'page2' }),
    );
    expect(result).toEqual([
      { id: 'm1', threadId: 't1' },
      { id: 'm2', threadId: 't2' },
    ]);
  });

  it('handles a response with no messages field', async () => {
    const vendor = makeVendor();
    const listMessages = vi.fn().mockResolvedValue({});
    const client: GmailMessageLister = { listMessages };

    const result = await discoverCandidateEmails(client, [vendor], { since });

    expect(result).toEqual([]);
  });
});
