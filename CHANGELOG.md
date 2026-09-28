# Changelog — @netgreener/runtime

## [0.1.0] — 2026-09-24

### Added
- Express / Fastify / Nest-via-adapter middleware with tenant attribution
- Outbound `fetch` metering (`external_api_v0`), optional axios/undici wraps
- BullMQ processor wrap and process/cron helpers
- Default `NETGREENER_EXPORT_MODE=direct` upload to NetGreener API
- Opt-in collector IPC and thin-flush documentation in the tutorial
- Local `netgreener analyze` scaffold (`run` / `optimize` stubs)

### Notes
- First public npm release ships with npm provenance from this repository
- Process CPU/RSS are measured on instrumented hooks; cgroup/process-tree
  sampling is not claimed in this version
