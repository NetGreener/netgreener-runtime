# Legacy Python compatibility shapes (read-only)

These fixtures mirror fields produced by the current Python service runtime and
accepted by the existing API. They are migration fixtures, not the cross-language
specification. MP0 artifacts in `netgreener_contracts` will define the stable contract;
Python and Node must both conform without copying one implementation's debt.

| Block | Python origin (reference only) |
|-------|--------------------------------|
| `service_runtime_v0` | `netgreener_cli/netgreener/service_runtime_v0.py` → `build_v0` |
| `external_api_v0` | `netgreener_cli/netgreener/external_api_meter.py` → `build_v0` (+ `by_model`) |
| `measurement_provenance` / evidence | CLI/API evidence grade helpers (`r9_v0`) |
| Upload | `POST /api/v1/runsessions/` with `session_metadata` |

Legacy Node compatibility payloads use adapter identifiers such as:

- `express_middleware`
- `fastify_middleware`
- `node_process`
- `bullmq_adapter` (later)

Existing Python identifiers remain readable during migration: `asgi_middleware`,
`outbound_http`, and the current Celery/collector strings. The shared collector and
Observation v1 naming rules remain an MP0/MP2 decision.
