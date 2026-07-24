"""One-shot migration from etude schema v2 to schema v3."""

from __future__ import annotations

import argparse
import json
import shutil
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

from . import schema, store

V3_NOTE = (
    "Schema v2→v3: prompt/answer renamed to user_prompt/agent_prompt; "
    "type dropped; agent-assistance, attempt-via, queue instructions, and theme metadata added."
)


def _now_with_offset() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def migrate(db: dict[str, Any], migrated_at: str | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return a migrated copy of a schema-v2 database and its JSON report."""
    migrated = deepcopy(db)
    meta = migrated.get("meta")
    if not isinstance(meta, dict):
        meta = {}
        migrated["meta"] = meta

    renamed = {
        "prompt_to_user_prompt": 0,
        "answer_to_agent_prompt": 0,
        "type_dropped": 0,
        "attempt_via_added": 0,
    }

    atoms = migrated.get("atoms")
    if not isinstance(atoms, dict):
        atoms = {}
    for atom in atoms.values():
        if not isinstance(atom, dict):
            continue
        if "prompt" in atom:
            if "user_prompt" not in atom:
                atom["user_prompt"] = atom["prompt"]
            del atom["prompt"]
            renamed["prompt_to_user_prompt"] += 1
        if "answer" in atom:
            if "agent_prompt" not in atom:
                atom["agent_prompt"] = atom["answer"]
            del atom["answer"]
            renamed["answer_to_agent_prompt"] += 1
        if "type" in atom:
            del atom["type"]
            renamed["type_dropped"] += 1
        atom.setdefault("agent_assisted", None)
        attempts = atom.get("attempts", [])
        if isinstance(attempts, list):
            for attempt in attempts:
                if isinstance(attempt, dict) and "via" not in attempt:
                    attempt["via"] = "chat"
                    renamed["attempt_via_added"] += 1

    queues = migrated.get("queues")
    if not isinstance(queues, dict):
        queues = {}
    for queue in queues.values():
        if not isinstance(queue, dict):
            continue
        queue.setdefault("agent_assisted", None)
        queue.setdefault("agent_instructions", "")

    meta["schema_version"] = 3
    meta.setdefault("tag_instructions", {})
    meta.setdefault("default_theme", "default")
    provenance = meta.get("provenance")
    if not isinstance(provenance, dict):
        provenance = {}
        meta["provenance"] = provenance
    provenance["v3_migrated_at"] = migrated_at or _now_with_offset()
    provenance["v3_note"] = V3_NOTE

    errors, warnings = schema.validate(migrated)
    algorithms = meta.get("queue_algorithms", {})
    report = {
        "counts": {
            "atoms": len(atoms),
            "attempts": sum(
                len(atom.get("attempts", []))
                for atom in atoms.values()
                if isinstance(atom, dict) and isinstance(atom.get("attempts", []), list)
            ),
            "queues": len(queues),
            "algorithms": len(algorithms) if isinstance(algorithms, dict) else 0,
        },
        "fields_renamed": renamed,
        "validation": {"errors": errors, "warnings": warnings},
    }
    return migrated, report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Migrate an etude schema-v2 DB to v3")
    parser.add_argument("--from", dest="from_path", type=Path, required=True, help="schema-v2 db.json")
    parser.add_argument(
        "--to",
        dest="to_path",
        type=Path,
        default=None,
        help="output path (default: resolved etude DB path)",
    )
    parser.add_argument("--dry-run", action="store_true", help="validate and report without writing")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the migration CLI and return a process-style status code."""
    args = _parser().parse_args(argv)
    source = args.from_path.expanduser()
    target = args.to_path.expanduser() if args.to_path is not None else store.resolve_db_path()
    db = store.load(source)

    version = db.get("meta", {}).get("schema_version") if isinstance(db.get("meta"), dict) else None
    if isinstance(version, (int, float)) and not isinstance(version, bool) and version >= 3:
        print(json.dumps({"status": "no-op", "schema_version": version}, ensure_ascii=False))
        return 0

    migrated, report = migrate(db)
    report["dry_run"] = bool(args.dry_run)
    print(json.dumps(report, ensure_ascii=False, indent=1))
    if report["validation"]["errors"]:
        return 1
    if args.dry_run:
        return 0

    if target.exists():
        backup = Path(f"{target}.pre-v3.bak.json")
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target, backup)
    store.save(migrated, target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
