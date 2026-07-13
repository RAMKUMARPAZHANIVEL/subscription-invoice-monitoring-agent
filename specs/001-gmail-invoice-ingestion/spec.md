# Feature Specification: Gmail Invoice Ingestion & Extraction (Phase 1)

**Feature Branch**: `001-gmail-invoice-ingestion`

**Created**: 2026-07-10

**Status**: Draft

**Input**: User description:

```text
# Subscription Invoice Monitoring Agent

## Business Use Case

we manage multiple SaaS tools and subscriptions including Claude Code, CodeRabbit, Greptile, CoreValue, TinyMCE, AWS, GitHub, Jira, and others.

These vendors send monthly invoices and billing emails to the admin Gmail account.

Some subscriptions are:
- Fixed monthly subscriptions
- Usage-based (metered)
- Per-user/seat based

Tracking these invoices manually is time-consuming.

## Goal

Build an AI agent that:

- Connects to Gmail
- Identifies subscription invoice emails
- Reads email content and attachments
- Downloads invoice attachments (PDF, CSV, etc.)
- Extracts structured invoice information
- Stores invoices and metadata locally (and later in cloud storage)
- Prevents duplicate processing
- Maintains processing history
- Can run automatically every day
- Can be deployed on GCP Cloud Run
- Can integrate with Paperclip for future development

## Phase 1 Scope

Include:
- Gmail integration
- Invoice discovery
- Email parsing
- Attachment download
- Structured invoice extraction
- Local storage
- Logging
- Monitoring readiness

Exclude:
- Budget alerts
- Dashboards
- Forecasting
- Cost anomaly detection
```

## Business Objectives

- Eliminate the manual effort of tracking subscription invoices across SaaS vendors (Claude Code,
  CodeRabbit, Greptile, CoreValue, TinyMCE, AWS, GitHub, Jira, and others).
- Establish a reliable, deduplicated system of record for subscription invoices, trustworthy enough
  to serve as the foundation for future billing intelligence.
- Reduce the time an operator spends opening, reading, and filing vendor invoices each month.
- Capture the data and processing history needed to support future anomaly detection, budgeting, and
  forecasting, without building those capabilities in this phase.

## Scope

### In Scope (Phase 1)

- Gmail integration against a single admin account
- Invoice email discovery/identification across a configurable set of vendors
- Email content and attachment parsing (PDF and CSV at minimum)
- Attachment download and durable storage
- Structured invoice data extraction (vendor, amount, currency, dates, subscription type)
- Duplicate-processing prevention
- Processing history / audit trail for every evaluated email
- Durable local storage for invoices, metadata, and attachments
- Structured logging of every run
- Fully automated daily execution
- Deployability on GCP Cloud Run
- Readiness for future monitoring/alerting integration (not the alerting itself)

### Out of Scope (Phase 1)

- Budget alerts / threshold notifications
- Dashboards / visual reporting
- Spend forecasting
- Cost/usage anomaly detection
- Multiple Gmail accounts or non-Gmail email providers
- Paperclip integration (captured in Future Roadmap)
- Backfilling the pre-existing mailbox history — only emails received after the agent is first
  activated are processed (see Assumptions)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automatic invoice discovery and extraction (Priority: P1)

As the person responsible for tracking company subscriptions, I want the agent to automatically
find new subscription invoice emails in the admin Gmail account and extract their structured
details, so that I don't have to manually open and read every vendor invoice each month.

**Why this priority**: This is the core value proposition of the whole project — every other
capability (dedup, history, scheduling) exists in service of this.

**Independent Test**: With a real invoice email from a known vendor (e.g., GitHub) present in the
mailbox, trigger a run and confirm a structured invoice record is created with a linked attachment,
with no manual intervention.

**Acceptance Scenarios**:

1. **Given** a new invoice email arrives from a recognized vendor, **When** the agent runs its
   scheduled check, **Then** a structured invoice record (vendor, amount, currency, invoice date,
   billing period, and subscription type where determinable) is created.
2. **Given** an invoice email has a PDF attachment, **When** the agent processes it, **Then** the
   attachment is downloaded and linked to the corresponding invoice record.
3. **Given** an invoice email has no attachment but billing details are in the email body (e.g.,
   an AWS-style billing email), **When** the agent processes it, **Then** the invoice details are
   extracted from the email body itself.

---

### User Story 2 - Duplicate prevention & processing history (Priority: P2)

As the operator, I want the agent to never create duplicate invoice records or silently reprocess
the same email, so that the invoice records stay accurate and trustworthy.

**Why this priority**: Without this, every re-run or retry risks corrupting the very data set that
User Story 1 exists to build.

**Independent Test**: Run the discovery process twice against an unchanged mailbox; confirm the
second run creates zero new records and reports that nothing new was found.

**Acceptance Scenarios**:

1. **Given** an email has already been successfully processed, **When** the agent's scan includes
   that email again, **Then** no new invoice record is created for it.
2. **Given** an email previously failed processing, **When** the agent retries it, **Then** it is
   reprocessed safely without creating a duplicate if it now succeeds.
3. **Given** any evaluated email (successful, failed, or skipped), **When** an operator inspects the
   system, **Then** they can see when it was evaluated, its outcome, and a link back to the source
   email.

---

### User Story 3 - Reliable daily automated run with failure visibility (Priority: P3)

As the operator, I want the agent to run automatically every day and clearly surface anything it
couldn't process, so that I can trust it's running unattended and know when something needs my
attention.

**Why this priority**: Automation combined with trustworthy failure visibility is what makes this a
"set and forget" tool rather than another manual chore to babysit.

**Independent Test**: Trigger a scheduled run manually and confirm it completes and produces a run
summary (emails scanned, invoices processed, failures) even when there are zero new invoices.

**Acceptance Scenarios**:

1. **Given** the scheduled time arrives, **When** no manual action is taken, **Then** the agent runs
   automatically and completes without anyone needing to trigger it.
2. **Given** an invoice email cannot be extracted successfully, **When** the run completes, **Then**
   that email is marked as failed with enough diagnostic detail (vendor guess, error reason, link to
   the source email) for an operator to investigate, and the rest of the run is unaffected.
3. **Given** a run completes, **When** an operator reviews it, **Then** they can see a summary of
   emails scanned, invoices processed, failures, and run duration.

---

### Edge Cases

- What happens when a vendor changes its invoice email template and extraction fails or produces
  low-confidence results?
- How does the system handle an email that resembles an invoice but is actually marketing, a
  security alert, a one-time (non-subscription) purchase receipt, or a payment-failure notice?
- What happens when an invoice email has multiple attachments (e.g., a PDF and a CSV) — are both
  linked to the same invoice record?
- How does the system handle a vendor sending a duplicate or corrected/reissued invoice for the
  same billing period?
- What happens if Gmail access is temporarily unavailable (rate limiting, expired authorization,
  outage) during a scheduled run?
- What happens when an email's currency or language differs from what is expected?
- How does the system handle attachments that cannot be parsed (corrupted, password-protected, or
  a scanned image with no extractable text)?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST connect to a single designated admin Gmail account to search for and
  read mail.
- **FR-002**: The system MUST identify emails that are subscription invoices/billing notices from a
  configurable set of known vendors (e.g., Claude Code, CodeRabbit, Greptile, CoreValue, TinyMCE,
  AWS, GitHub, Jira), such that adding or adjusting a vendor does not require a source-code change.
- **FR-003**: The system MUST read the full email content (subject, body, sender) and download any
  attachments, supporting at minimum PDF and CSV formats.
- **FR-004**: The system MUST extract structured invoice information from each identified invoice
  email, including at minimum: vendor name, amount, currency, invoice/billing date, billing period
  (when present), and subscription type (fixed monthly / usage-based / per-seat) where determinable.
- **FR-005**: The system MUST extract invoice details from the email body when no attachment is
  present, and from the attachment content when one is present.
- **FR-006**: The system MUST store each extracted invoice's structured data, its source
  attachment(s), and a reference back to the originating email.
- **FR-007**: The system MUST NOT create a duplicate invoice record when the same source email is
  encountered more than once, including across retries and re-runs.
- **FR-008**: The system MUST record a processing history entry for every candidate email it
  evaluates, including its outcome (processed / failed / skipped-as-not-an-invoice), a timestamp,
  and enough detail to diagnose a failure.
- **FR-009**: The system MUST retry an email that failed for a recoverable reason (e.g., a
  transient network or access error), and MUST mark it as failed with diagnostic information if
  retries are exhausted, without halting processing of the rest of that run.
- **FR-010**: The system MUST run its full discovery-and-extraction pass automatically on a
  recurring daily schedule without manual triggering.
- **FR-011**: On first activation, the system MUST process only invoice emails received from that
  point forward, and MUST NOT scan or process pre-existing mailbox history.
- **FR-012**: The system MUST be deployable as a service on GCP Cloud Run without requiring
  architectural changes.
- **FR-013**: The system MUST NOT require hardcoded credentials; Gmail and any other required
  access MUST be configurable via environment variables or a secret store.
- **FR-014**: The system MUST log, for every scheduled run, the start time, end time, duration,
  number of emails scanned, number of invoices processed, and number of failures.
- **FR-015**: The system MUST expose a way for an operator to review processed invoices, their
  extracted data, and their processing history/status.

### Non-Functional Requirements

- **NFR-001 (Reliability)**: No invoice email evaluated by the system may be silently lost; every
  evaluation MUST end in one of: processed, retried, or recorded as failed with diagnostics.
- **NFR-002 (Durability)**: Stored invoice records and attachments MUST survive a service restart or
  redeployment.
- **NFR-003 (Idempotency)**: Reprocessing the same email under any circumstance (retry, re-run,
  redeploy) MUST NOT create a duplicate invoice record.
- **NFR-004 (Security)**: No credentials may be hardcoded; Gmail and storage access MUST be
  configured via environment variables or a secret manager, using least-privilege access.
- **NFR-005 (Auditability)**: Every invoice MUST be traceable back to its originating email,
  including its processing timestamps and error history.
- **NFR-006 (Operability)**: A scheduled run MUST complete, or fail visibly, without manual
  intervention, and MUST produce a run summary (scanned/processed/failed counts, duration).
- **NFR-007 (Portability)**: The system MUST run as a stateless, cloud-native service deployable on
  GCP Cloud Run without architectural changes.
- **NFR-008 (Extensibility)**: Adding a new vendor MUST be possible via configuration, not a
  source-code change.
- **NFR-009 (Performance)**: A daily run over the current invoice volume (a single admin mailbox,
  roughly ten vendors, monthly billing cadence) MUST complete comfortably within the 24-hour cycle
  between scheduled runs.

### Key Entities

- **Invoice**: A structured record derived from a vendor billing email — vendor, amount, currency,
  invoice date, billing period, subscription type, line items (if available), status, and links to
  its attachment(s) and source email.
- **Vendor**: A configured subscription provider (e.g., GitHub, AWS, Jira) with identification rules
  (sender addresses/domains, subject patterns) used to recognize its invoice emails without code
  changes.
- **Source Email**: The originating Gmail message for an invoice — sender, subject, received date,
  a unique message identifier, and the reference used to guarantee it is never processed twice.
- **Attachment**: A file (PDF, CSV, etc.) downloaded from a source email and associated with exactly
  one invoice record.
- **Processing History Entry**: A record of one evaluation of one email — timestamp, outcome,
  diagnostic detail, and links to the source email and any resulting invoice.

## Constraints

- Must operate against a single designated admin Gmail account in Phase 1.
- Must be deployable on GCP Cloud Run without architectural changes.
- Must not store or transmit credentials in source control; secrets are provided via environment
  variables or a secret manager only.
- Deterministic logic (authentication, scheduling, storage, retries) must not depend on AI; AI is
  scoped to invoice understanding, vendor identification, and data extraction only.
- Must not implement budget alerts, dashboards, forecasting, or anomaly detection in this phase.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 95% of invoice emails from the initially configured vendor list are correctly
  identified as invoices (not missed, not false-flagged) over a 30-day observation window.
- **SC-002**: At least 90% of identified invoice emails produce a complete structured invoice record
  (vendor, amount, currency, date) without manual correction.
- **SC-003**: Re-running the discovery process against previously processed mail never produces a
  duplicate invoice record (zero duplicates observed across repeated runs).
- **SC-004**: The daily automated run completes without manual intervention on at least 99% of
  scheduled days over a 30-day period.
- **SC-005**: When an invoice cannot be processed automatically, an operator can determine what went
  wrong from the recorded diagnostic detail in under 5 minutes, without searching raw email or code.
- **SC-006**: Time an operator spends manually tracking and reviewing subscription invoices drops by
  at least 80% compared to the fully manual process.

## Assumptions

- The admin Gmail account is a single, known account with an owner who can grant the necessary
  authorization; multi-account support is out of scope for Phase 1.
- "Structured invoice information" for Phase 1 means, at minimum: vendor, amount, currency,
  invoice/billing date, billing period, and subscription type where determinable — richer detail
  (e.g., an itemized per-seat breakdown) is best-effort, not guaranteed.
- Local storage for Phase 1 means storage the service controls directly (a database plus file
  storage) that survives service restarts and redeployments; it does not mean data may be lost
  between runs. Migration to full cloud object storage is expected in a later phase, but Phase 1
  must not be lossy in the meantime.
- Invoice currency is assumed to be primarily USD; other currencies are stored as provided (amount
  plus currency code) without conversion.
- Emails that are not recognized as invoices (marketing, security alerts, payment-failure notices,
  one-time purchase receipts) are left unprocessed and are out of scope for structured extraction in
  Phase 1.
- "Paperclip integration for future development" refers to a planned future integration and is not a
  Phase 1 requirement; it is captured in the Future Roadmap below.
- On first activation, only new invoice emails (received after activation) are processed; existing
  mailbox history is not backfilled.

## Risks

- Vendor invoice formats change over time (redesigned templates, new fields), which can silently
  degrade extraction accuracy; this needs an ongoing detection signal (e.g., a rising failure or
  low-confidence rate per vendor), not just a one-time build.
- Gmail access quotas, authorization expiry, or transient outages could delay a day's run; the
  retry and failure-visibility requirements exist specifically to make this survivable rather than
  silent.
- Misclassifying a non-invoice email as an invoice (or vice versa) could create bad data or hide a
  real cost; vendor-driven identification reduces but does not eliminate this risk.
- Attachments that are scanned images, password-protected, or otherwise non-parseable will fail
  structured extraction; these must surface as diagnosable failures rather than being silently
  skipped.
- Invoice and billing data may carry data-sensitivity obligations even in Phase 1, ahead of any
  dashboard or analytics use.

## Future Roadmap (out of Phase 1 scope)

- Budget alerts and threshold-based notifications.
- Dashboards and visual reporting.
- Spend forecasting.
- Cost/usage anomaly detection.
- Multi-account or multi-provider (beyond Gmail) email ingestion.
- Migration of attachment/backup storage to cloud object storage.
- Integration with Paperclip.
