# Node shared-TCK consumer integration

The contracts repository owns fixtures, expected outcomes, applicability, roll-ups,
and result generation. This directory contains only the Node consumer declaration, a
tracked production ledger, and a small stdin/stdout adapter.

## Current honest boundary

The adapter maps only these versioned actions to named production exports:

| TCK action | Required production export | Current state |
|---|---|---|
| `observation.validate@1.0.0` | `validateObservationEnvelope` | Not implemented; adapter returns `ADAPTER_ACTION_UNSUPPORTED` |
| `delivery.classify@1.0.0` | `classifyObservationDelivery` | Not implemented; adapter returns `ADAPTER_ACTION_UNSUPPORTED` |

It never branches on `case_id`, fixture digest, expected outcome, or check IDs. The
request does not contain the oracle. If a production export is later added, it must
implement the documented boundary and return the small result shape consumed by the
adapter; the ledger and focused tests must be updated in the same change.

Before dispatch, the adapter hashes the adjacent implementation ledger and requires it
to equal the implementation-artifact digest supplied by the shared runner. A ledger
action remains unsupported until it explicitly names a production module and export
with `status: implemented`. The module must resolve inside the repository and its
working bytes must equal the exact tracked Git blob at the requested consumer revision;
ignored build output alone can never enable a pass.

The adapter constructs `observed_environment` from `process.versions.node`, the
installed TypeScript package, `process.platform`, `process.arch`, and Azure's `TF_BUILD`
marker. These two TCK actions are framework-neutral, so `framework` is `null`; the
profile does not claim Express is installed. Caller-provided deployment or framework
labels cannot create an environment match. A mismatch returns an execution error and
the shared runner rejects the environment binding.

## Admitted contracts pin

`netgreener-contracts.lock.json` currently pins
`5aedf46c84dd12028526bff5e00d1fefb1e61648`, the merge commit published on the
contracts repository's `origin/main`. The lock was generated through the normal
published-revision path, without `--allow-unpublished-revision`.

The pinned canonical `profiles/v1/nodejs.runtime.json` is semantically identical to
this consumer profile, including its complete check inventory, runner, and exact
verification environments. Admission of the contracts revision does not promote this
consumer's support status: both production actions remain explicitly unsupported, so
the shared result remains incomplete and self-attested.

## Commands

Local wiring checks build the package, exercise the real adapter process, ensure the
current missing production seams remain marked unsupported, and validate the lock,
profile, ledger, and optional sibling contracts checkout:

```bash
npm run conformance:check
```

The shared runner requires both repositories to be clean, the adapter and ledger to be
tracked at exact `HEAD`, and the contracts revision to be admitted on fetched
`origin/main`. Once those conditions hold:

```bash
NETGREENER_CONTRACTS_ROOT=/path/to/netgreener_contracts \
npm run conformance:run
```

Both declared environments require Node 22.12.0 and the installed TypeScript 5.9.3
toolchain. The Windows environment derives deployment mode `local`; Azure Pipelines
derives `azure-pipelines` from `TF_BUILD`. Both declare `framework: null`. Set
`NETGREENER_PYTHON` if the shared runner's Python interpreter is not on `PATH`. On
Windows, `python` must resolve to a direct interpreter, not a Store/App-Execution-Alias
launcher; set `NETGREENER_PYTHON` to the direct executable when necessary.

The default command deliberately omits both policy gates so an honest incomplete result
can be retained as a CI artifact. Set `NETGREENER_REQUIRE_SHARED_TCK_PASS=1` only after
the production seams are implemented; it asks the shared runner to enforce the
`CHK-Q1.shared-tck` gate.

Generated `conformance/results/` and `artifacts/v1/` paths must remain ignored. They
are CI artifacts, not source and not conformance claims by themselves.

## Admission and future refresh checklist

For the current admitted contracts revision and every future refresh:

1. Check out the contracts repository from `refs/heads/main`.
2. Generate and check `netgreener-contracts.lock.json` from the full merged main
   revision without `--allow-unpublished-revision`; never edit its SHA or digests
   manually.
3. Keep the exact canonical-profile comparison in the integration validator.
4. Retain the resulting incomplete run as self-attested CI evidence. Do not require the
   shared-TCK pass gate until both production boundaries genuinely exist.

The contracts checkout and conformance job must not persist Git credentials. When an
explicit authenticated `origin/main` fetch is needed, use `System.AccessToken` only
for that fetch, unset it, and then launch the shared runner and adapter. Keep this
credential boundary intact.
