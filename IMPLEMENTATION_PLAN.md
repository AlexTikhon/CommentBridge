# Implementation Plan

## Scope

Build a production-minded NestJS API that reads normalized comments for a
logical post and sends replies through deterministic platform adapters. The
implementation deliberately remains a single deployable application with
PostgreSQL as its source of truth.

## Delivery sequence

1. Define strict TypeScript, NestJS, Prisma, linting, formatting, and test
   configuration.
2. Model accounts, logical posts, platform publications, and self-referencing
   comments in Prisma; add an initial SQL migration and deterministic seed.
3. Define framework-independent domain types, repository and adapter ports,
   cursor encoding, and application errors.
4. Implement Instagram and LinkedIn mock adapters plus an adapter registry.
5. Implement the Prisma repository and comments application service, keeping
   provider calls outside database transactions.
6. Expose versioned REST endpoints, health/readiness, request IDs, RFC 7807
   problem details, validation, and Swagger documentation.
7. Add unit tests around service/adapter behavior and integration/E2E suites
   backed by a disposable PostgreSQL database.
8. Document architecture, decisions, assumptions, trade-offs, operations, and
   production evolution.
9. Run all required install, static-analysis, test, build, Compose, and diff
   checks and record the actual outcomes.

## Key acceptance checks

- Stable cursor pagination using `(effectiveCreatedAt, id)`.
- Publication-scoped uniqueness for external IDs and idempotency keys.
- Atomic local creation of one pending reply under concurrent repeated keys.
- No open database transaction during a provider call.
- Replay never invokes the platform adapter again.
- Provider failures persist only a safe code and return the internal reply ID.
- Adding a platform changes registration/configuration, not the comment service.
- No credentials, raw provider payloads, Prisma types, or stack traces leak via
  the HTTP API.

## Explicit non-goals

Authentication, OAuth/token storage, inbound synchronization, real platform
network calls, queues, outbox workers, and distributed exactly-once delivery.
