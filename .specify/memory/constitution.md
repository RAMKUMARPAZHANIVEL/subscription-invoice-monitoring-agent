# Subscription Invoice Monitoring Agent Constitution

<!--
Sync Impact Report

Version change:
1.0.0 → 1.1.0

Modified Principles:
- Replaced generic placeholder principles with domain-specific engineering principles.
- Preserved existing engineering standards (TypeScript, testing, observability, CI/CD).

Added:
- Reliability First
- Idempotent Processing
- Deterministic Before AI
- Security by Default
- Configuration over Code
- Complete Auditability
- Cloud Native Design
- Extensibility

No template updates required.
-->

# Subscription Invoice Monitoring Agent (SIMA) Constitution

## Purpose

The Subscription Invoice Monitoring Agent (SIMA) is an autonomous AI-powered service that monitors subscription invoices received through email, extracts structured billing information, securely stores invoice data, and provides a trusted foundation for future billing intelligence, analytics, anomaly detection, and cost optimization.

The project prioritizes reliability, maintainability, security, and extensibility over rapid feature delivery.

---

# Core Principles

## I. Reliability First

The system shall never intentionally lose invoice data.

Every discovered invoice must be:

* Successfully processed and stored
* Retried upon recoverable failure
* Marked as failed with sufficient diagnostic information

Silent failures are unacceptable.

---

## II. Idempotent Processing

Processing the same email multiple times shall never create duplicate invoices or inconsistent data.

Each processed email shall have a unique processing identity and support safe reprocessing.

---

## III. Deterministic Before AI

Deterministic software engineering shall be used whenever possible.

AI shall only be responsible for:

* Invoice understanding
* Vendor identification
* Metadata extraction
* Document normalization
* Future anomaly explanation

Core workflows including authentication, Gmail integration, scheduling, storage, configuration, retries, and persistence must never depend on AI.

---

## IV. Security by Default

Security is mandatory.

The system shall:

* Never hardcode credentials
* Use Secret Manager or environment variables
* Follow least-privilege access
* Encrypt sensitive communications
* Protect invoice and billing information

Secrets must never be committed to source control.

---

## V. Configuration over Code

Business behaviour shall be configuration driven.

Adding:

* Vendors
* Gmail search rules
* Parsing rules
* Invoice classifiers

should require configuration rather than source code changes whenever practical.

---

## VI. Complete Auditability

Every invoice shall be traceable back to its originating email.

The system shall maintain:

* Processing history
* Execution logs
* Processing timestamps
* Original email metadata
* Attachment references
* Error history

No invoice should exist without provenance.

---

## VII. Cloud Native Design

The application shall remain stateless.

Persistent data shall reside only in supported storage systems.

The application shall be deployable on Google Cloud Run without architectural changes.

---

## VIII. Extensibility

The architecture shall support future enhancements including:

* Multiple email providers
* Multiple Gmail accounts
* Additional AI providers
* Budget monitoring
* Cost anomaly detection
* Dashboards
* Conversational reporting
* Additional cloud providers

Future features should extend the system rather than require redesign.

---

## IX. Type Safety & Validated Boundaries

All code MUST be written in strict TypeScript.

Every external input—including:

* Gmail responses
* AI responses
* Environment variables
* HTTP requests
* Configuration files

must be validated before entering business logic.

No unvalidated data may cross module boundaries.

---

## X. Test-First for Critical Business Logic

Critical invoice processing logic shall be covered by automated tests.

The following require unit and integration testing:

* Email processing
* Duplicate detection
* Invoice extraction
* Vendor classification
* Retry behaviour
* Configuration loading

Changes affecting business rules must include corresponding tests.

---

## XI. Structured Observability

All runtime logging shall use structured logging.

Every scheduled execution shall record:

* Start time
* End time
* Execution duration
* Emails scanned
* Invoices processed
* Failures
* Retry attempts

Logs shall provide sufficient information for production troubleshooting.

---

## XII. Simplicity & Minimal Surface (YAGNI)

The system shall solve today's business problem before introducing abstractions.

Avoid speculative APIs, unnecessary configuration, or premature generalization.

Every dependency must have a concrete business justification.

---

## XIII. Automated Quality Gates

Every commit shall pass:

* ESLint
* Prettier
* TypeScript compilation
* Unit tests
* Integration tests (where applicable)

CI/CD shall independently verify all quality gates before deployment.

Production deployments shall never bypass automated validation.

---

# Technology & Deployment Constraints

The project shall use:

* Node.js 20+
* TypeScript
* pnpm
* PostgreSQL
* Prisma ORM
* Gmail API
* Google Cloud Run
* Cloud Scheduler
* Cloud Storage
* Secret Manager
* Pino logging
* Vitest
* GitHub Actions

Runtime configuration shall be loaded exclusively from validated environment variables.

Long-lived credentials shall never be stored in the repository.

---

# Development Workflow

All feature development shall follow the Spec-Driven Development lifecycle:

1. Constitution
2. Specification
3. Technical Plan
4. Task Breakdown
5. Implementation
6. Testing
7. Code Review
8. Deployment

Implementation shall never begin before an approved specification and implementation plan exist.

---

# AI Principles

AI assists business workflows but never replaces deterministic validation.

AI-generated outputs shall always be validated before persistence.

Business decisions affecting invoice integrity must remain deterministic.

---

# Governance

This constitution defines the engineering standards for the repository.

Any amendment shall:

* Update this document
* Increment the constitution version following semantic versioning
* Document the reason for the change

All pull requests shall be reviewed for compliance with these principles.

---

**Version:** 1.1.0

**Ratified:** 2026-07-10

**Last Amended:** 2026-07-10
