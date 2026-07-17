import { describe, expect, it, vi } from 'vitest';
import type { Vendor } from '../../generated/prisma/client.js';

const findMany = vi.fn();

vi.mock('../../storage/prisma.js', () => ({
  prisma: { vendor: { findMany } },
}));

const { loadEnabledVendors, matchesSender, matchesSubject, matchesVendor, findMatchingVendor } =
  await import('./vendorConfig.js');

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

describe('loadEnabledVendors', () => {
  it('queries only enabled vendors', async () => {
    const vendors = [makeVendor()];
    findMany.mockResolvedValueOnce(vendors);

    const result = await loadEnabledVendors();

    expect(findMany).toHaveBeenCalledWith({ where: { enabled: true } });
    expect(result).toBe(vendors);
  });
});

describe('matchesSender', () => {
  it('matches an exact sender address', () => {
    const vendor = makeVendor({ senderPatterns: ['billing@github.com'] });

    expect(matchesSender(vendor, 'billing@github.com')).toBe(true);
  });

  it('matches a sender header containing the pattern', () => {
    const vendor = makeVendor({ senderPatterns: ['billing@github.com'] });

    expect(matchesSender(vendor, 'GitHub <billing@github.com>')).toBe(true);
  });

  it('matches a domain pattern', () => {
    const vendor = makeVendor({ senderPatterns: ['@aws.amazon.com'] });

    expect(matchesSender(vendor, 'orders@aws.amazon.com')).toBe(true);
  });

  it('is case insensitive', () => {
    const vendor = makeVendor({ senderPatterns: ['Billing@GitHub.com'] });

    expect(matchesSender(vendor, 'billing@github.com')).toBe(true);
  });

  it('returns false when no pattern matches', () => {
    const vendor = makeVendor({ senderPatterns: ['billing@github.com'] });

    expect(matchesSender(vendor, 'someone@example.com')).toBe(false);
  });

  it('returns false for an unrelated vendor with no matching patterns', () => {
    const vendor = makeVendor({ senderPatterns: ['@aws.amazon.com', '@amazonaws.com'] });

    expect(matchesSender(vendor, 'billing@github.com')).toBe(false);
  });
});

describe('matchesSubject', () => {
  it('matches when subject contains a configured pattern', () => {
    const vendor = makeVendor({ subjectPatterns: ['Your receipt'] });

    expect(matchesSubject(vendor, 'Your receipt from GitHub')).toBe(true);
  });

  it('is case insensitive', () => {
    const vendor = makeVendor({ subjectPatterns: ['INVOICE'] });

    expect(matchesSubject(vendor, 'Your invoice is ready')).toBe(true);
  });

  it('returns false when subject does not contain any configured pattern', () => {
    const vendor = makeVendor({ subjectPatterns: ['invoice'] });

    expect(matchesSubject(vendor, 'Welcome to GitHub')).toBe(false);
  });

  it('matches any subject when no subjectPatterns are configured', () => {
    const vendor = makeVendor({ subjectPatterns: [] });

    expect(matchesSubject(vendor, 'anything at all')).toBe(true);
  });
});

describe('matchesVendor', () => {
  it('matches when both sender and subject match', () => {
    const vendor = makeVendor({
      senderPatterns: ['billing@github.com'],
      subjectPatterns: ['receipt'],
    });

    expect(matchesVendor(vendor, { sender: 'billing@github.com', subject: 'Your receipt' })).toBe(
      true,
    );
  });

  it('does not match when sender matches but subject does not', () => {
    const vendor = makeVendor({
      senderPatterns: ['billing@github.com'],
      subjectPatterns: ['receipt'],
    });

    expect(
      matchesVendor(vendor, { sender: 'billing@github.com', subject: 'Welcome to GitHub' }),
    ).toBe(false);
  });

  it('ignores a disabled vendor even when sender and subject match', () => {
    const vendor = makeVendor({
      senderPatterns: ['billing@github.com'],
      subjectPatterns: [],
      enabled: false,
    });

    expect(matchesVendor(vendor, { sender: 'billing@github.com', subject: 'Your receipt' })).toBe(
      false,
    );
  });
});

describe('findMatchingVendor', () => {
  it('returns the vendor matching the candidate email', () => {
    const github = makeVendor({
      id: 'vendor_github',
      name: 'GitHub',
      senderPatterns: ['@github.com'],
    });
    const aws = makeVendor({ id: 'vendor_aws', name: 'AWS', senderPatterns: ['@aws.amazon.com'] });

    const result = findMatchingVendor([github, aws], {
      sender: 'billing@aws.amazon.com',
      subject: 'Your AWS invoice',
    });

    expect(result).toBe(aws);
  });

  it('skips disabled vendors even if their patterns match', () => {
    const disabled = makeVendor({ senderPatterns: ['@github.com'], enabled: false });

    const result = findMatchingVendor([disabled], {
      sender: 'billing@github.com',
      subject: 'Your receipt',
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when no vendor matches', () => {
    const github = makeVendor({ senderPatterns: ['@github.com'] });

    const result = findMatchingVendor([github], {
      sender: 'someone@example.com',
      subject: 'hello',
    });

    expect(result).toBeUndefined();
  });
});
