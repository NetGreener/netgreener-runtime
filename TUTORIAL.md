# Node service runtime tutorial — HTTP, workers, and scripts

**Twin of:** [`SERVICE_RUNTIME_TUTORIAL.md`](../docs/SERVICE_RUNTIME_TUTORIAL.md)
**§4–§6** (FastAPI / Celery / process wrap).  
**Package:** `@netgreener/runtime` (public npm; see [`PRODUCTION_DOCS.md`](PRODUCTION_DOCS.md)).  
**Governed label:** **Node.js Runtime production** (N10 issued 2026-10-02).  
**Still not claimed:** default collector cutover; container/K8s; cgroup as production claim.  
**Opt-in (DevOps):** `NETGREENER_COLLECTOR_MODE=managed` — same idea as Python Celery (§7).

| Need deeper reference | Doc |
|-----------------------|-----|
| Node backlog / gates | [`NODE_RUNTIME_PARITY_PLAN.md`](../docs/NODE_RUNTIME_PARITY_PLAN.md) |
| Worker staging gate | [`WORKER_STAGING_GATE.md`](WORKER_STAGING_GATE.md) |
| Package status / CI | [`README.md`](README.md), [`ROADMAP.md`](ROADMAP.md) |
| Tenant dogfood | [`NODE_TENANT_DOGFOOD.md`](../docs/NODE_TENANT_DOGFOOD.md) |
| Service tokens | [`CI_SERVICE_TOKEN_ONBOARDING.md`](../docs/CI_SERVICE_TOKEN_ONBOARDING.md) |
| Python twin (Celery managed) | [`SERVICE_RUNTIME_TUTORIAL.md`](../docs/SERVICE_RUNTIME_TUTORIAL.md) · [`SERVICE_RUNTIME_INTEGRATION.md`](../docs/SERVICE_RUNTIME_INTEGRATION.md) |
| Optimize / LLM apply gates | [`OPTIMIZE_STUB.md`](OPTIMIZE_STUB.md) |
| Owner publish commands (CLI / npm / VSIX) | [`OWNER_PUBLISH_COMMANDS.md`](../docs/OWNER_PUBLISH_COMMANDS.md) |

---

## 0. What you will run

| Project has… | Situation | NetGreener path | Code change? |
|--------------|-----------|-----------------|--------------|
| **Express** HTTP API | Per-**route** KPIs | `netgreenerExpressMiddleware` | **Yes — one middleware line** (§4) |
| **Fastify** HTTP API | Per-**route** KPIs | `netgreenerFastifyPlugin` | **Yes — one `register`** (§4) |
| **Nest** | Express or Fastify under the hood | `applyNetGreenerNestHooks(app)` | **Yes — one hook** (§4) |
| **BullMQ** worker | Per-**task** KPIs | `netgreenerBullMqProcessor` | **Yes — wrap the processor** (§5) |
| **Script / cron / batch** `node …` | Process window + outbound `fetch` | `startProcessRuntime` / `runWithProcessTenant` / `netgreener run` | **Yes — start helper or CLI** (§6–§7) |

### Who should touch which env vars?

| Audience | Use | Ignore unless DevOps asks |
|----------|-----|---------------------------|
| **App developer** (Express/Fastify/Nest) | Token, project id, `SERVICE_RUNTIME=1` | `COLLECTOR_MODE`, `EXPORT_MODE=collector` |
| **DevOps / platform** | Workers needing durable spool | `NETGREENER_COLLECTOR_MODE=managed` (Python Celery twin; Node `netgreener run`) |

Default upload mode remains **`NETGREENER_EXPORT_MODE=direct`**. Sibling collector
IPC and managed mode are **opt-in only**; we do not cut over the default.

```text
HTTP:     middleware/plugin → window → POST /api/v1/runsessions/  (default direct)
BullMQ:   wrapped processor → window → same direct path (default)
Process:  startProcessRuntime / netgreener run → window → direct (default)

Opt-in:   NETGREENER_EXPORT_MODE=collector → IPC → sibling collector (you start collector)
Opt-in:   NETGREENER_COLLECTOR_MODE=managed → NetGreener starts+drains collector for you
          (Python: Celery launcher; Node: netgreener run)
```

---

## 1. Worksheet (your project)

```text
App entry file:     ________   (creates Express app or Fastify instance)
Framework:          Express / Fastify / Nest→Express / Nest→Fastify
ORG_ID:             ________
PROJECT_ID:         ________
API URL:            https://core-api.netgreener.com   (or your host)
Token secret name:  NETGREENER_TOKEN
Dry-run first?:     yes (recommended)
```

Find **ORG_ID** / **PROJECT_ID** in the NetGreener dashboard (project URL looks like
`https://dashboard.netgreener.com/projects/<PROJECT_ID>`).

---

## 2. Get a token

**Automation / servers (recommended):**

1. Create an API / service token (`ngs_…`) in the dashboard.
2. Store it as secret `NETGREENER_TOKEN`.
3. Details: [`CI_SERVICE_TOKEN_ONBOARDING.md`](../docs/CI_SERVICE_TOKEN_ONBOARDING.md).

**Local dry-run only:** you can skip the token and set `NETGREENER_RUNTIME_DRY_RUN=1`
(see §4.4). Dry-run builds a real payload shape and does **not** upload.

---

## 3. Install `@netgreener/runtime` in that project

```bash
npm install @netgreener/runtime
```

Requires Node.js **22** or **24** (see `package.json` `engines`). For install /
upgrade / claimed limits, see [`PRODUCTION_DOCS.md`](PRODUCTION_DOCS.md).

Verify the import resolves:

```js
import { netgreenerExpressMiddleware } from '@netgreener/runtime'
console.log(typeof netgreenerExpressMiddleware)
```

---

## 4. Express or Fastify — any Node HTTP API

Starting the app with `node`, `tsx`, PM2, or a container entrypoint does not change
the hook — those are process managers/servers.

### 4.1 Express — one middleware line

In the **same file** that creates `const app = express()` (not only in routers):

```js
import express from 'express'
import { netgreenerExpressMiddleware, getExpressRuntime } from '@netgreener/runtime'

const app = express()
app.use(netgreenerExpressMiddleware())

app.get('/health', (_req, res) => res.send('ok'))
// ...
```

Optional manual flush (tests / graceful shutdown):

```js
await getExpressRuntime().flush('manual')
```

### 4.2 Fastify — one plugin register

```js
import Fastify from 'fastify'
import {
  netgreenerFastifyPlugin,
  getFastifyRuntime,
  bindFastifyTenant,
} from '@netgreener/runtime'

const app = Fastify()
await app.register(netgreenerFastifyPlugin())

app.get('/health', async () => 'ok')

app.get('/me', async (request) => {
  // After auth: prefer bindFastifyTenant (request-scoped store).
  bindFastifyTenant(request, {
    tenantId: 'org_acme',
    tenantSource: 'verified-auth',
  })
  return { ok: true }
})
```

Notes:

- The plugin breaks Fastify encapsulation (`skip-override`) so hooks apply to routes
  registered on the same instance after `register`.
- Prefixed routes appear as `/prefix/path/:id` in `service_unit` (Fastify template).
- Raw request URLs are never metering fallbacks (`<unmatched>` when no template).

### 4.2b Nest — via underlying Express or Fastify adapter

No separate Nest interception layer. After `NestFactory.create`:

```js
import { NestFactory } from '@nestjs/core'
import { applyNetGreenerNestHooks } from '@netgreener/runtime'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)
await applyNetGreenerNestHooks(app)
await app.listen(3000)
```

Or explicitly:

```js
import { netgreenerNestExpressMiddleware } from '@netgreener/runtime'
// Express adapter:
app.use(netgreenerNestExpressMiddleware())

// Fastify adapter:
// await app.getHttpAdapter().getInstance().register(netgreenerNestFastifyPlugin())
```

### 4.3 Env for the API process

**Dry-run (no upload):**

```bash
NETGREENER_SERVICE_RUNTIME=1
NETGREENER_RUNTIME_DRY_RUN=1
NETGREENER_TOKEN=ngs_placeholder
NETGREENER_PROJECT_ID=1
# optional tenant header binding:
# NETGREENER_TENANT_SOURCE=header
# NETGREENER_TENANT_HEADER=X-Organization-Id
```

**Live upload (only with a real token; you retain evidence):**

```bash
NETGREENER_SERVICE_RUNTIME=1
NETGREENER_API_URL=https://core-api.netgreener.com
NETGREENER_TOKEN=<token>
NETGREENER_ORG_ID=<org>
NETGREENER_PROJECT_ID=<project>
NETGREENER_DEPLOY_ENVIRONMENT=staging
# Leave NETGREENER_RUNTIME_DRY_RUN unset or 0
# Leave NETGREENER_EXPORT_MODE unset (default direct) unless authorized for collector
```

### 4.4 Prove it

**A. Dry-run / CI smoke (no api_server):**

```bash
cd path/to/netgreener_node   # or your app with the package linked
npm test
NETGREENER_RUNTIME_DRY_RUN=1 npm run example:dogfood-tenant
npm run example:dry-run
```

Pass = scripts exit 0; payloads validate; no live upload required.

**B. Live (authorized):**

1. Deploy / start the API with live env (§4.3).
2. Call 2–3 real routes (health + one business route).
3. Stop the process (or wait for `NETGREENER_RUNTIME_FLUSH_MINUTES`, default 5).
4. Dashboard → **Project `<PROJECT_ID>`** → newest **Run** → **Runtime Ops** / API Runtime.
5. Pass = bounded route templates listed (e.g. `GET /health`), not raw customer paths.
6. Keep a sanitized evidence record (revision, env, run id) — see
   [`NODE_TENANT_DOGFOOD.md`](../docs/NODE_TENANT_DOGFOOD.md).

Live failure (non-2xx / missing token) must **fail** the run; local payload capture is
not a substitute for a successful upload.

### 4.5 Opt-in sibling collector (HTTP → MP2 IPC)

Default remains **`NETGREENER_EXPORT_MODE=direct`** (adapter POSTs RunSession). To send
HTTP window flushes to a sibling collector instead:

1. Start the collector (see
   [`COLLECTOR_SIBLING.md`](../netgreener_contracts/planning/mp2-collector/COLLECTOR_SIBLING.md)).
2. In the **API process** (same middleware as §4.1 / §4.2):

```bash
NETGREENER_EXPORT_MODE=collector
NETGREENER_COLLECTOR_ENDPOINT=tcp://127.0.0.1:17999
# Leave NETGREENER_RUNTIME_DRY_RUN unset — dry-run skips collector IPC on purpose
```

3. Hit routes and flush as in §4.4. Successful path = durable spool ACK over length-prefixed
   IPC (`run_session_window`), not a silent fall-back to direct upload.

**Honesty:** this proves the Node HTTP → exporter → collector wire (Express, Fastify,
and Nest-via-Express / Nest-via-Fastify adapters). It does **not** flip the default,
claim MP2 exit, Observation cloud ingest, or Python-style managed sidecar.
Worker/process twins: §5.5 / §6.1. Local proofs:
`express.collector.integration.test.ts`,
`fastify.collector.integration.test.ts`,
`nest.collector.integration.test.ts`,
`nest.fastify.collector.integration.test.ts`.

---

## 5. BullMQ — any worker project (Part 5 twin)

Unlike Python Celery (entrypoint wrap, often **no** task code changes), Node BullMQ
v0 meters by **wrapping the processor** you already pass to `Worker`. Default remains
**direct** flush from the worker process. For a **managed** sibling collector (Python
Celery twin), see §7 — opt-in DevOps only; not required for BullMQ KPIs.

### 5.1 Wrap the processor (required for task KPIs)

```js
import { Worker } from 'bullmq'
import { netgreenerBullMqProcessor, getBullMqRuntime } from '@netgreener/runtime'

const processor = netgreenerBullMqProcessor(async (job) => {
  // your existing job logic
  await fetch('https://api.openai.com/v1/chat/completions', { /* … */ })
  return { ok: true }
})

const worker = new Worker('queue-name', processor, { connection: { /* redis */ } })

// optional: await getBullMqRuntime().flush('manual')
```

Each job records a unit like `task:<job.name>`. Outbound `fetch` / axios made inside
the processor inherit that task unit when ALS is active.

### 5.2 Tenant from job data

Set env (or programmatic config) so tenant is read from `job.data`:

```bash
NETGREENER_TENANT_SOURCE=task_kwarg
NETGREENER_TENANT_TASK_KWARG=organization_id   # default
```

Enqueue with the kwarg present:

```js
await queue.add('ocr', { organization_id: 'org_acme', /* … */ })
```

### 5.3 Env for the worker process

Same token/project vars as §4.3. Prefer dry-run first:

```bash
NETGREENER_SERVICE_RUNTIME=1
NETGREENER_RUNTIME_DRY_RUN=1
NETGREENER_TENANT_SOURCE=task_kwarg
```

### 5.4 Prove it

1. Start the worker with the wrapped processor.
2. Enqueue **one** job the way your project already does.
3. Flush (shutdown or `getBullMqRuntime().flush('manual')`).
4. Dry-run: payload includes `task:<name>` and optional `by_tenant`.
5. Live (authorized): dashboard Runtime Ops shows the task row.

**Honesty gap vs Python Part 5:** managed collector / process-tree sidecar for Node
workers is still open under MP2–MP3. Real Redis + `bullmq` Worker smoke exists
(`examples/bullmq-live-smoke.mjs`; live run **39574**) — that is not managed-sidecar
parity.

### 5.5 Opt-in sibling collector (BullMQ → MP2 IPC)

Same env as §4.5 on the **worker process** (default remains `direct`):

```bash
NETGREENER_EXPORT_MODE=collector
NETGREENER_COLLECTOR_ENDPOINT=tcp://127.0.0.1:17999
# Leave NETGREENER_RUNTIME_DRY_RUN unset — dry-run skips collector IPC
```

Successful flush = `run_session_window` with `collector: bullmq_worker` and
`task:<job.name>` units over IPC — **not** a Python-style managed sidecar and **not**
a silent fall-back to direct upload. Local proof:
`src/tests/workers.collector.integration.test.ts`.

---

## 6. Scripts, cron, sidecars, batch jobs (Part 6 twin)

Use this when the work is **not** an HTTP API and **not** a BullMQ worker:
nightly jobs, ETL, report generators, simple long-lived Node processes.

```js
import {
  startProcessRuntime,
  runWithProcessTenant,
  flushProcessRuntime,
} from '@netgreener/runtime'

startProcessRuntime()

await runWithProcessTenant('org_acme', async () => {
  // batch work + outbound fetch…
}, { serviceUnit: 'task:nightly_report' })

await flushProcessRuntime('manual')
```

Env: same as §4.3 (`NETGREENER_SERVICE_RUNTIME=1`, dry-run or live token). Leave
export mode at default `direct` unless authorized for collector.

You get a **process/task** window and supported outbound HTTP observation — **not**
Express/Fastify per-route rows and **not** BullMQ `task:…` rows unless you also use §5.

There is no `netgreener runtime process -- node job.js` CLI wrapper in this package
yet; call `startProcessRuntime` from your entry file (or a thin launcher you own).

### 6.1 Opt-in sibling collector (process → MP2 IPC)

Same env as §4.5 / §5.5. Flush via `flushProcessRuntime('manual')` or shutdown.
IPC payload uses `collector: node_process`. For **NetGreener-started** collector
lifecycle (Python Celery twin), use §7 instead of manually starting the sibling.

---

## 7. Managed collector — `NETGREENER_COLLECTOR_MODE=managed` (opt-in)

**Same idea as Python Celery** (`docs/SERVICE_RUNTIME_INTEGRATION.md`): NetGreener
starts and drains a sibling `python -m netgreener.collector_server`, and the Node
child exports with `NETGREENER_EXPORT_MODE=collector`.

### Who needs this?

| You are… | Recommendation |
|----------|----------------|
| Wiring Express / Fastify / Nest | **Skip** — leave unset; use default **direct** |
| Running BullMQ with default path | **Skip** unless platform asks for durable spool |
| DevOps wrapping `netgreener run` / workers | **Optional** — set `managed` when you want supervised collector |

### Example (`netgreener run`)

```powershell
$env:NETGREENER_SERVICE_RUNTIME = "1"
$env:NETGREENER_TOKEN = "ngs_…"          # kept on collector; stripped from child by default
$env:NETGREENER_PROJECT_ID = "97"
$env:NETGREENER_COLLECTOR_MODE = "managed"
# optional: $env:NETGREENER_COLLECTOR_ENDPOINT = "tcp://127.0.0.1:17999"
netgreener run .\jobs\report.mjs .
```

Requires Python with `netgreener.collector_server` importable. Windows: **`tcp://` only**.

When the Node child flushes with `EXPORT_MODE=collector`, IPC includes `emitter_pid`.
The collector attaches an honest **`collector_resource_sample_v0`** (process-tree via
psutil; cgroup v2 on Linux only) onto `session_metadata` — it does **not** erase
Node `node_process_*` provenance. Disable with
`NETGREENER_COLLECTOR_ENRICH_RESOURCES=0`.

Default package / unset mode remains **direct**. Managed does **not** change N10
production claim wording by itself.

### CI / dogfood (no upload)

```powershell
# Module honesty (Linux tree/cgroup; Windows unavailable = PASS)
npm run example:n5b-linux-gate

# Live flush → collector enrich (needs sibling ../netgreener_cli or NETGREENER_CLI_ROOT)
# Linux CI sets NETGREENER_N5B_REQUIRE_FLUSH=1
npm run example:n5b-flush-dogfood
```

Artifact: `artifacts/n5b-flush/latest.json`. Azure job: `n5b_flush_dogfood`.

---

## 7b. Optimize, LLM apply-verified, Investigate (parity)

Default optimize stays **local** (no LLM, no upload). Same `api_server` brain when you opt in.

### CLI

```powershell
# Local proposals (+ optional deterministic safe apply)
netgreener optimize .\my-app
netgreener optimize .\my-app --apply --skip-test

# Shared LLM session (review JSON)
$env:NETGREENER_TOKEN = "ngs_…"
netgreener optimize .\my-app --llm --project-id 97

# LLM splice writes — VerificationProvider before/after (NOT the same as --apply)
netgreener optimize .\my-app --llm --apply-verified --project-id 97 --skip-test
```

`--llm` + `--apply` is rejected on purpose. Use `--apply-verified` for LLM writes.

### VS Code (Node workspace)

| Command | Path |
|---------|------|
| **Plan Optimizations** | QuickPick: LLM plan · **LLM apply-verified (CLI)** · Local Node Optimize |
| **Investigate Anomaly Brief** | Claim brief → `.netgreener/anomaly-investigation.json` → scoped Analyze |
| URI | `vscode://netgreener.netgreener-vscode-extension/anomalyBrief?briefId=…` |

Does **not** flip `EXPORT_MODE`. Does **not** invent measured savings.

---

## 8. Common failures

| Symptom | Check |
|---------|--------|
| No rows in dashboard | `NETGREENER_SERVICE_RUNTIME=1`, real token, dry-run unset for live |
| Only dry-run locally | Expected when `NETGREENER_RUNTIME_DRY_RUN=1` |
| Raw paths / IDs in units | Bug — should be templates or `<unmatched>`; file an issue |
| Fastify routes not metered | Ensure `register(netgreenerFastifyPlugin())` before routes; package includes skip-override |
| Tenant missing after auth (Fastify) | Use `bindFastifyTenant(request, …)` |
| BullMQ jobs invisible | Processor must be wrapped with `netgreenerBullMqProcessor` |
| BullMQ tenant missing | `NETGREENER_TENANT_SOURCE=task_kwarg` + kwarg in `job.data` |
| Package not found on npm | Check `@netgreener/runtime` install / registry access |
| Managed collector fails to start | Python `netgreener.collector_server` on PATH; Windows needs `tcp://` |
| Serverless / Lambda freezes mid-window | Use thin-flush (§10); flush at invoke end; durability is best-effort |

---

## 9. Minimal copy-paste canaries

**Express dry-run:** middleware + `/health` + `NETGREENER_RUNTIME_DRY_RUN=1` +
`getExpressRuntime().flush('manual')`.

**Fastify dry-run:** `register(plugin)` + `/health` + dry-run env +
`getFastifyRuntime().flush('manual')`.

**BullMQ dry-run:** wrap processor + one fake job + `getBullMqRuntime().flush('manual')`
(see `examples/tenant-dogfood.mjs`).

**Process dry-run:** `startProcessRuntime` + `runWithProcessTenant` + flush.

---

## 10. Thin-flush / serverless mode

Long-running VM / container / K8s Node should keep default **`direct`** or opt-in
**`collector`** (§4.5). Serverless hosts often cannot run a durable sibling collector.

### When to use thin

Set **one** of:

```bash
NETGREENER_EXPORT_MODE=thin
# or alias when EXPORT_MODE is unset:
NETGREENER_FLUSH_MODE=thin
```

Optional shorter window:

```bash
NETGREENER_RUNTIME_FLUSH_MINUTES=1
```

### What thin does (honesty)

| Behavior | Thin mode |
|----------|-----------|
| Upload path | Same direct RunSession POST as `direct` today |
| Durability grade | `best_effort_bounded` (visible; not silent drop) |
| Sibling collector spool | **No** |
| Auto-detect platforms | **No** — `detectServerlessPlatformSignals()` is informational only |

Platform signals the helper recognizes (for your own wiring / checks):
`AWS_LAMBDA_FUNCTION_NAME`, `FUNCTIONS_WORKER_RUNTIME` / `AZURE_FUNCTIONS_ENVIRONMENT`,
`FUNCTION_TARGET` / `FUNCTION_SIGNATURE_TYPE`, `VERCEL` / `VERCEL_ENV`, `NETLIFY`.

```js
import {
  detectServerlessPlatformSignals,
  exportModeFromEnv,
} from '@netgreener/runtime'

const hint = detectServerlessPlatformSignals()
// hint.suggestedExportMode === 'thin' when a host signal is present — still not applied.
```

### Invoke-end flush (required for thin)

Call flush before the isolate freezes:

```js
import { getExpressRuntime } from '@netgreener/runtime'

export async function handler(event, context) {
  try {
    // … handle request with middleware-wrapped app …
  } finally {
    await getExpressRuntime().flush('shutdown')
  }
}
```

**Not claimed:** Lambda extensions, automatic freeze hooks, MP3 serverless support, or
flipping the default off `direct` for long-running Node.

---

## 11. Stop here (honesty)

This tutorial does **not** by itself:
- publish `@netgreener/runtime` to npm
- establish MP3 support, Python-equivalent managed worker collectors, npm release, or
  live acceptance without your retained evidence
- flip `NETGREENER_EXPORT_MODE` default away from `direct`

Package examples: `examples/express-dry-run.mjs`, `examples/tenant-dogfood.mjs`.

---

## Revision note

This tutorial documents **experimental** Node HTTP (N1), Nest-via-adapter, BullMQ,
and process helpers (N3) as of the stacked Node tutorial slices. It does **not**
establish MP3 support, Python-equivalent managed worker collectors, npm release, or
default export-mode cutover.
