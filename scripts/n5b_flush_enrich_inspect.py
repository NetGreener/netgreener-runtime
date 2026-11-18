#!/usr/bin/env python3
"""Inspect a collector spool after a Node flush and prove enrich.

Reads pending ``run_session_window`` events, runs the same
``run_session_payload_from_ipc`` path the collector uses (fail-closed + enrich),
and asserts ``collector_resource_sample_v0``.

Does not upload. Does not flip EXPORT_MODE defaults.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spool-dir", required=True)
    parser.add_argument("--out", required=True, help="JSON artifact path")
    parser.add_argument(
        "--require-linux-tree",
        action="store_true",
        help="Fail unless process_tree.available (use on Linux CI)",
    )
    args = parser.parse_args()

    from netgreener.collector_run_session_bridge import run_session_payload_from_ipc
    from netgreener.collector_spool import CollectorSpool

    spool = CollectorSpool(args.spool_dir)
    try:
        events = spool.pending_by_kind("run_session_window", limit=20)
    finally:
        spool.close()

    if not events:
        print("n5b-flush-inspect: FAIL no run_session_window in spool", file=sys.stderr)
        return 1

    event = events[-1]
    emitter_pid = event.get("emitter_pid")
    if emitter_pid is None:
        print("n5b-flush-inspect: FAIL emitter_pid missing on wire", file=sys.stderr)
        return 1

    payload = run_session_payload_from_ipc(event)
    meta = payload.get("session_metadata") or {}
    sample = meta.get("collector_resource_sample")
    if not isinstance(sample, dict) or sample.get("schema") != "collector_resource_sample_v0":
        print("n5b-flush-inspect: FAIL missing collector_resource_sample_v0", file=sys.stderr)
        return 1

    tree = sample.get("process_tree") if isinstance(sample.get("process_tree"), dict) else {}
    cgroup = sample.get("cgroup") if isinstance(sample.get("cgroup"), dict) else {}
    prov = meta.get("measurement_provenance") if isinstance(meta.get("measurement_provenance"), dict) else {}

    report = {
        "schema": "n5b_flush_dogfood_v0",
        "platform": sys.platform,
        "emitter_pid": emitter_pid,
        "event_id": event.get("event_id"),
        "runtime_window_id": event.get("runtime_window_id"),
        "collector_resource_sample": sample,
        "measurement_provenance": {
            "cpu_source": prov.get("cpu_source"),
            "collector_enrichment": prov.get("collector_enrichment"),
            "collector_cpu_source": prov.get("collector_cpu_source"),
            "collector_cgroup_source": prov.get("collector_cgroup_source"),
        },
        "checks": {
            "emitter_pid_present": True,
            "sample_schema_ok": True,
            "process_tree_available": bool(tree.get("available")),
            "cgroup_available": bool(cgroup.get("available")),
            "cgroup_reason": cgroup.get("reason"),
        },
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if args.require_linux_tree:
        if sys.platform != "linux":
            print(
                f"n5b-flush-inspect: FAIL --require-linux-tree on {sys.platform}",
                file=sys.stderr,
            )
            return 1
        if not tree.get("available"):
            print(
                f"n5b-flush-inspect: FAIL process_tree unavailable: {tree.get('reason')}",
                file=sys.stderr,
            )
            return 1
        if int(tree.get("pid_count") or 0) < 1:
            print("n5b-flush-inspect: FAIL process_tree pid_count < 1", file=sys.stderr)
            return 1

    print(
        "n5b-flush-inspect: PASS "
        f"tree={tree.get('available')} cgroup={cgroup.get('available')} "
        f"enrich={prov.get('collector_enrichment')} out={out_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
