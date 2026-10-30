#!/usr/bin/env python3
"""Backfill terminal Local Agent Runs into the local Memory settlement queue.

This is a narrow, idempotent migration for the installed Local Runtime. It
does not create Memory conclusions and does not modify runs or their evidence;
the deployed Local Agent settlement worker performs the actual extraction and
fusion after jobs are queued.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import time
from datetime import datetime
from pathlib import Path


DATA_ROOT = Path.home() / "Library/Application Support/AgentLoop Local Runtime"
DEFAULT_RUN_DB = DATA_ROOT / "agentloop.db"
DEFAULT_MEMORY_DB = DATA_ROOT / "memory.db"


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Idempotently enqueue historical terminal Runs for Local Memory settlement.")
    parser.add_argument("--run-db", type=Path, default=DEFAULT_RUN_DB)
    parser.add_argument("--memory-db", type=Path, default=DEFAULT_MEMORY_DB)
    parser.add_argument("--owner", help="only backfill one owner_user_id; default requires one owner in the selected Runs")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--include-failed", action="store_true", help="also enqueue failed/cancelled Runs; omitted means completed Runs only")
    parser.add_argument("--dry-run", action="store_true", help="report candidates without writing or creating a backup")
    return parser.parse_args()


def ro(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise SystemExit(f"Database not found: {path}")
    connection = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=10000")
    return connection


def job_id(tenant: str, owner: str, run_id: str, commit_ref: str) -> str:
    # Matches SqliteMemoryStore's idHash({ scope, runId, terminalCommitRef })
    payload = json.dumps({"scope": {"tenantId": tenant, "ownerUserId": owner}, "runId": run_id, "terminalCommitRef": commit_ref}, separators=(",", ":"), ensure_ascii=False)
    return "memjob_" + hashlib.sha256(payload.encode()).hexdigest()[:24]


def backup_database(source: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    destination = Path("/private/tmp") / f"agentloop-memory-before-backfill-{stamp}.db"
    src = sqlite3.connect(f"file:{source.resolve()}?mode=ro", uri=True)
    dst = sqlite3.connect(destination)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return destination


def main() -> None:
    options = args()
    if options.limit < 1:
        raise SystemExit("--limit must be >= 1")
    runs = ro(options.run_db)
    memory_ro = ro(options.memory_db)
    try:
        queued_owners = [row[0] for row in memory_ro.execute("SELECT DISTINCT owner_user_id FROM local_memory_settlement_jobs")]
        queued_tenants = [row[0] for row in memory_ro.execute("SELECT DISTINCT tenant_id FROM local_memory_settlement_jobs")]
        if len(queued_owners) > 1 or len(queued_tenants) > 1:
            raise SystemExit("Refusing to backfill: Memory DB contains multiple owner/tenant scopes; pass --owner and split the operation.")
        owner = options.owner or (queued_owners[0] if queued_owners else None)
        if owner is None:
            raise SystemExit("Cannot infer owner_user_id; pass --owner explicitly.")
        tenant = queued_tenants[0] if queued_tenants else None
        if tenant is None:
            raise SystemExit("Cannot infer local Memory tenant_id from existing jobs.")
        statuses = ("completed", "failed", "cancelled") if options.include_failed else ("completed",)
        placeholders = ",".join("?" for _ in statuses)
        rows = runs.execute(f"""
            SELECT r.id AS run_id, r.owner_user_id, r.status,
                   o.result_ref, o.committed_at
              FROM runs r
              JOIN run_outcomes o ON o.run_id = r.id
             WHERE r.owner_user_id = ?
               AND r.status IN ({placeholders})
             ORDER BY o.committed_at ASC, r.id ASC
             LIMIT ?
        """, (owner, *statuses, options.limit)).fetchall()
        if not rows:
            raise SystemExit(f"No terminal Runs found for owner {owner}.")
        existing = {row[0] for row in memory_ro.execute("SELECT run_id FROM local_memory_settlement_jobs WHERE owner_user_id = ?", (owner,))}
        candidates = []
        for row in rows:
            commit_ref = row["result_ref"] or f"{row['run_id']}:{row['committed_at']}"
            if row["run_id"] not in existing:
                candidates.append((row, commit_ref, job_id(tenant, owner, row["run_id"], commit_ref)))
        print(json.dumps({"runDb": str(options.run_db), "memoryDb": str(options.memory_db), "owner": owner, "tenant": tenant, "terminalRunsFound": len(rows), "alreadyQueued": len(rows) - len(candidates), "toEnqueue": len(candidates), "dryRun": options.dry_run}, ensure_ascii=False, indent=2))
        if options.dry_run or not candidates:
            return
    finally:
        memory_ro.close()
        runs.close()

    backup = backup_database(options.memory_db)
    print(json.dumps({"backup": str(backup)}, ensure_ascii=False))
    memory = sqlite3.connect(options.memory_db)
    memory.execute("PRAGMA busy_timeout=30000")
    try:
        now = int(time.time() * 1000)
        with memory:
            for row, commit_ref, settlement_job_id in candidates:
                memory.execute("""
                    INSERT OR IGNORE INTO local_memory_settlement_jobs
                      (tenant_id, owner_user_id, run_id, terminal_commit_ref,
                       settlement_job_id, enqueued_at, status, attempts, last_error, next_attempt_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, NULL, ?)
                """, (tenant, owner, row["run_id"], commit_ref, settlement_job_id, now, now))
        print(json.dumps({"insertedOrAlreadyPresent": len(candidates), "backup": str(backup)}, ensure_ascii=False))
    finally:
        memory.close()


if __name__ == "__main__":
    main()
