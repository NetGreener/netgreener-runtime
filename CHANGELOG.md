# Changelog — @netgreener/runtime

## [0.1.7] — 2026-09-27

### Fixed
- Publish CI builds then publishes with Trusted Publisher OIDC

## [0.1.6] — 2026-09-27

### Fixed
- Publish CI uses build/pack/SBOM only (skips Azure-only production-prep smoke)

## [0.1.5] — 2026-09-27

### Fixed
- Split CI gate steps for clearer Trusted Publisher publish diagnostics

## [0.1.4] — 2026-09-27

### Fixed
- Trusted Publisher OIDC: publish job no longer uses a GitHub Environment claim

## [0.1.3] — 2026-09-27

### Fixed
- CI setup-node pin (v4 + Node 24) for Trusted Publisher OIDC

## [0.1.2] — 2026-09-27

### Fixed
- Trusted Publisher OIDC publish hardening (Node 24, npm latest, no empty auth token)

## [0.1.1] — 2026-09-27

### Fixed
- Trusted Publisher OIDC publish (Node >= 22.14, npm >= 11.5.1)
- Guard against re-publishing an existing npm version

## [0.1.0] — 2026-09-24

### Added
- Express / Fastify / Nest-via-adapter middleware with tenant attribution
- Outbound `fetch` metering (`external_api_v0`), optional axios/undici wraps
- BullMQ processor wrap and process/cron helpers
- Default `NETGREENER_EXPORT_MODE=direct` upload to NetGreener API
- Opt-in collector IPC and thin-flush documentation in the tutorial
- Local `netgreener analyze` scaffold (`run` / `optimize` stubs)

### Notes
- First public npm release with provenance from this repository
- Process CPU/RSS are measured on instrumented hooks; cgroup/process-tree
  sampling is not claimed in this version
