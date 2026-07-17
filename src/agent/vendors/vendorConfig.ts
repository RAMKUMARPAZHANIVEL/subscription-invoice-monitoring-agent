/**
 * Config-driven vendor loading and matching (data-model.md `Vendor`, Principle V).
 *
 * Discovery/extraction never hardcode vendor identity — they call `loadEnabledVendors` for the
 * current config and `matchesVendor` to classify a candidate email against it.
 */

import type { Vendor } from '../../generated/prisma/client.js';
import { prisma } from '../../storage/prisma.js';

export type { Vendor };

export interface CandidateEmail {
  sender: string;
  subject: string;
}

/** Reads all vendors with `enabled = true`, per data-model.md's config-over-code contract. */
export async function loadEnabledVendors(): Promise<Vendor[]> {
  return prisma.vendor.findMany({ where: { enabled: true } });
}

export function matchesSender(vendor: Vendor, sender: string): boolean {
  const normalizedSender = sender.toLowerCase();
  return vendor.senderPatterns.some((pattern) => normalizedSender.includes(pattern.toLowerCase()));
}

export function matchesSubject(vendor: Vendor, subject: string): boolean {
  // No subjectPatterns means the vendor is identified by sender alone (data-model.md: optional).
  if (vendor.subjectPatterns.length === 0) return true;
  const normalizedSubject = subject.toLowerCase();
  return vendor.subjectPatterns.some((pattern) =>
    normalizedSubject.includes(pattern.toLowerCase()),
  );
}

/** A disabled vendor never matches, even if invoked directly with a stale/cached vendor row. */
export function matchesVendor(vendor: Vendor, email: CandidateEmail): boolean {
  return (
    vendor.enabled && matchesSender(vendor, email.sender) && matchesSubject(vendor, email.subject)
  );
}

export function findMatchingVendor(vendors: Vendor[], email: CandidateEmail): Vendor | undefined {
  return vendors.find((vendor) => matchesVendor(vendor, email));
}
