/**
 * Vendor-driven Gmail query building and candidate email discovery (research.md #2, FR-002,
 * FR-011).
 *
 * Discovery stays deterministic (Principle III) — the search query is built entirely from the
 * configured vendor list's sender/subject patterns and a date floor, never from AI judgment about
 * "is this an invoice." `has:attachment` is deliberately NOT applied by default: FR-005 requires
 * discovering invoice emails that carry their details in the body with no attachment at all, so a
 * hard attachment filter would silently drop valid candidates. Callers that know they only want
 * attachment-bearing mail can opt in via `requireAttachment`.
 */

import type { Vendor } from '../../generated/prisma/client.js';
import type { GmailClient, GmailMessageList, ListMessagesParams } from './client.js';

/** The subset of `GmailClient` discovery needs — keeps this module easy to test in isolation. */
export type GmailMessageLister = Pick<GmailClient, 'listMessages'>;

export interface DiscoveryOptions {
  /** Only messages received on/after this date are candidates (FR-011: no historical backfill). */
  since: Date;
  /** Opt-in `has:attachment` filter — see module doc for why this defaults to unset. */
  requireAttachment?: boolean;
  maxResults?: number;
}

export interface CandidateEmailRef {
  id: string;
  threadId: string;
}

function quoteIfNeeded(pattern: string): string {
  return /\s/.test(pattern) ? `"${pattern}"` : pattern;
}

function buildSenderClause(vendor: Vendor): string {
  const senders = vendor.senderPatterns.map(quoteIfNeeded).join(' OR ');
  return `from:(${senders})`;
}

function buildSubjectClause(vendor: Vendor): string | undefined {
  if (vendor.subjectPatterns.length === 0) return undefined;
  const subjects = vendor.subjectPatterns.map(quoteIfNeeded).join(' OR ');
  return `subject:(${subjects})`;
}

/** Builds the sender(+subject) clause for a single vendor. */
export function buildVendorClause(vendor: Vendor): string {
  const senderClause = buildSenderClause(vendor);
  const subjectClause = buildSubjectClause(vendor);
  return subjectClause === undefined ? senderClause : `(${senderClause} ${subjectClause})`;
}

/** Formats a date as Gmail's `after:`/`before:` operators expect: `YYYY/MM/DD` (UTC, day-grain). */
export function formatGmailDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

/**
 * Builds the full Gmail search query for the given enabled vendors, or `null` when there are no
 * vendors to search for (an unscoped query would defeat FR-002's config-driven matching).
 */
export function buildDiscoveryQuery(vendors: Vendor[], options: DiscoveryOptions): string | null {
  if (vendors.length === 0) return null;

  const vendorClauses = vendors.map(buildVendorClause);
  const vendorsPart =
    vendorClauses.length === 1 ? vendorClauses[0]! : `(${vendorClauses.join(' OR ')})`;

  const parts = [vendorsPart, `after:${formatGmailDate(options.since)}`];
  if (options.requireAttachment === true) {
    parts.push('has:attachment');
  }

  return parts.join(' ');
}

/**
 * Discovers candidate invoice emails across all configured vendors, paginating through
 * `messages.list` until Gmail reports no further pages.
 */
export async function discoverCandidateEmails(
  client: GmailMessageLister,
  vendors: Vendor[],
  options: DiscoveryOptions,
): Promise<CandidateEmailRef[]> {
  const query = buildDiscoveryQuery(vendors, options);
  if (query === null) return [];

  const candidates: CandidateEmailRef[] = [];
  let pageToken: string | undefined;

  do {
    const params: ListMessagesParams = {
      q: query,
      ...(pageToken !== undefined ? { pageToken } : {}),
      ...(options.maxResults !== undefined ? { maxResults: options.maxResults } : {}),
    };
    const page: GmailMessageList = await client.listMessages(params);
    candidates.push(...(page.messages ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);

  return candidates;
}
