from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1]
PYTHON = os.environ.get("ETUDE_TEST_PYTHON", sys.executable)


def run_cli(db: Path, *args: str, input_text: str | None = None, ok: bool = True):
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT / "src")
    result = subprocess.run(
        [PYTHON, "-m", "etude", "--db", str(db), *args],
        input=input_text,
        text=True,
        capture_output=True,
        env=env,
        cwd=ROOT,
    )
    assert result.stderr == ""
    assert result.stdout.count("\n") == 1
    payload = json.loads(result.stdout)
    if ok:
        assert result.returncode == 0, payload
    else:
        assert result.returncode == 1
        assert set(payload) == {"error"}
    return payload


def add_assisted(db: Path, atom_id: str = "CLI-1", prompt: str = "Question?"):
    agent_file = db.parent / f"{atom_id}.agent.md"
    agent_file.write_text("Grade against the canonical answer.", encoding="utf-8")
    return run_cli(
        db,
        "add",
        "--id",
        atom_id,
        "--user-prompt",
        prompt,
        "--agent-prompt-file",
        str(agent_file),
        "--tags",
        "cli,test",
        "--topic",
        "CLI",
    )


def add_deterministic(db: Path, atom_id: str = "DET-1"):
    return run_cli(
        db,
        "add",
        "--id",
        atom_id,
        "--user-prompt",
        "Capital of France?",
        "--expected",
        "Paris",
        "--expected",
        "PARIS!",
        "--agent-assisted",
        "false",
    )


def test_add_show_edit_archive_and_errors(tmp_path: Path):
    db = tmp_path / "db.json"
    created = add_assisted(db)
    assert created["id"] == "CLI-1"
    assert created["atom"]["state"] == "new"
    assert created["atom"]["tags"] == ["cli", "test"]

    shown = run_cli(db, "show", "CLI-1")
    assert shown["atom"]["user_prompt"] == "Question?"

    edited = run_cli(
        db,
        "edit",
        "CLI-1",
        "--set",
        "topic=Updated",
        "--set",
        'tags=["changed"]',
        "--set",
        "agent_assisted=false",
        "--set",
        'expected=["ok"]',
    )
    assert edited["atom"]["topic"] == "Updated"
    assert edited["atom"]["tags"] == ["changed"]
    assert edited["atom"]["agent_assisted"] is False
    assert run_cli(db, "edit", "CLI-1", "--archive")["atom"]["archived"] is True
    assert run_cli(db, "edit", "CLI-1", "--unarchive")["atom"]["archived"] is False
    run_cli(db, "show", "MISSING-1", ok=False)


def test_attempt_with_rating_and_verbatim_files(tmp_path: Path):
    db = tmp_path / "db.json"
    add_assisted(db)
    answer = tmp_path / "answer.txt"
    feedback = tmp_path / "feedback.txt"
    variant_prompt = tmp_path / "variant.md"
    answer.write_text("line one\nline two\n", encoding="utf-8")
    feedback.write_text("Useful feedback.\n", encoding="utf-8")
    variant_prompt.write_text("A variant prompt", encoding="utf-8")
    result = run_cli(
        db,
        "attempt",
        "CLI-1",
        "--rating",
        "2",
        "--answer-file",
        str(answer),
        "--feedback-file",
        str(feedback),
        "--variant",
        "CLI-1v1",
        "--variant-prompt-file",
        str(variant_prompt),
        "--mode",
        "random",
        "--via",
        "applet",
    )
    attempt = result["attempt"]
    assert attempt["answer"] == "line one\nline two\n"
    assert attempt["feedback"] == "Useful feedback.\n"
    assert attempt["variant_prompt"] == "A variant prompt"
    assert attempt["mode"] == "random" and attempt["via"] == "widget"
    assert result["atom"]["streak"] == 1
    assert result["atom"]["last_rating"] == 2
    error = run_cli(db, "attempt", "CLI-1", "--answer", "ungraded", ok=False)
    assert "rating" in error["error"]


def test_deterministic_attempt_without_rating_right_and_wrong(tmp_path: Path):
    db = tmp_path / "db.json"
    add_deterministic(db)
    right = run_cli(db, "attempt", "DET-1", "--answer", "  PARIS ")
    wrong = run_cli(db, "attempt", "DET-1", "--answer-file", "-", input_text="Lyon")
    assert right["computed"] is True and right["attempt"]["rating"] == 3
    assert wrong["computed"] is True and wrong["attempt"]["rating"] == 0
    assert right["attempt"]["feedback"] == wrong["attempt"]["feedback"] == ""
    assert wrong["atom"]["lapses"] == 1


def test_next_respects_manual_queue_order_and_full(tmp_path: Path):
    db = tmp_path / "db.json"
    add_assisted(db, "CLI-1", "First")
    add_assisted(db, "CLI-2", "Second")
    run_cli(
        db,
        "queue",
        "create",
        "manual-q",
        "--label",
        "Manual",
        "--algorithm",
        "manual",
        "--members",
        "CLI-1",
        "CLI-2",
    )
    run_cli(db, "queue", "edit", "manual-q", "--set", 'order=["CLI-2","CLI-1"]')
    compact = run_cli(db, "next", "--queue", "manual-q", "-n", "1")
    assert compact == {"queue": "manual-q", "atoms": [{"id": "CLI-2", "user_prompt": "Second"}]}
    full = run_cli(db, "next", "--queue", "manual-q", "-n", "2", "--full")
    assert [item["id"] for item in full["atoms"]] == ["CLI-2", "CLI-1"]
    assert "attempts" in full["atoms"][0]


def test_queue_create_members_list_show_and_archive(tmp_path: Path):
    db = tmp_path / "db.json"
    add_assisted(db, "CLI-1")
    add_assisted(db, "CLI-2")
    made = run_cli(db, "queue", "create", "q", "--label", "Queue", "--algorithm", "fsrs")
    assert made["queue"]["members"] == []
    added = run_cli(db, "queue", "add-members", "q", "CLI-1", "CLI-2")
    assert added["queue"]["members"] == ["CLI-1", "CLI-2"]
    removed = run_cli(db, "queue", "remove-members", "q", "CLI-1")
    assert removed["queue"]["members"] == ["CLI-2"]
    assert run_cli(db, "queue", "show", "q")["queue"]["label"] == "Queue"
    assert run_cli(db, "queue", "list")["queues"][0]["id"] == "q"
    assert run_cli(db, "queue", "archive", "q")["queue"]["status"] == "archived"


def test_context_cascade_and_meta_edit(tmp_path: Path):
    db = tmp_path / "db.json"
    add_assisted(db)
    run_cli(db, "edit-meta", 'tag_instructions={"cli":"Tag rule"}', "default_theme=everforest")
    run_cli(
        db,
        "queue",
        "create",
        "q",
        "--label",
        "Queue",
        "--algorithm",
        "fsrs",
        "--members",
        "CLI-1",
        "--agent-instructions",
        "Queue rule",
    )
    result = run_cli(db, "context", "CLI-1", "--queue", "q")
    assert result["context"] == {
        "card": "Grade against the canonical answer.",
        "tags": [["cli", "Tag rule"]],
        "queue": "Queue rule",
    }


def test_algorithms_stats_status_validate_and_inbox(tmp_path: Path):
    db = tmp_path / "db.json"
    add_assisted(db)
    add_deterministic(db)
    run_cli(db, "queue", "create", "q", "--label", "Queue", "--algorithm", "fsrs", "--members", "CLI-1", "DET-1")
    run_cli(db, "attempt", "CLI-1", "--rating", "2", "--answer", "answer")
    run_cli(db, "attempt", "DET-1", "--answer", "wrong")

    spec = tmp_path / "algorithm.json"
    spec.write_text(json.dumps({"label": "By ID", "order": [{"key": "id", "dir": "asc"}]}), encoding="utf-8")
    assert run_cli(db, "algorithms", "add", "by-id", "--spec-file", str(spec))["name"] == "by-id"
    assert "by-id" in {item["name"] for item in run_cli(db, "algorithms", "list")["algorithms"]}

    stats = run_cli(db, "stats", "--queue", "q", "--tags", "cli,test", "--days", "30")["stats"]
    assert set(stats) == {"total", "seen", "coverage", "mastery", "rating_distribution", "attempts_per_day"}
    assert stats["total"] == 1 and stats["seen"] == 1 and stats["coverage"] == 1.0
    assert set(stats["rating_distribution"]) == {"0", "1", "2", "3"}
    assert isinstance(stats["attempts_per_day"], dict)

    status = run_cli(db, "status")
    assert status["atoms"]["total"] == 2
    assert status["active_queues"] == 1
    validation = run_cli(db, "validate")
    assert validation == {"errors": [], "warnings": []}
    assert run_cli(db, "inbox", "list") == {"inbox": []}
    assert run_cli(db, "inbox", "clear") == {"cleared": 0, "inbox": []}


def test_script_validate_wrapper(tmp_path: Path):
    db = tmp_path / "db.json"
    add_assisted(db)
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT / "src")
    result = subprocess.run(
        [PYTHON, str(ROOT / "scripts" / "validate.py"), "--db", str(db)],
        text=True,
        capture_output=True,
        env=env,
        cwd=ROOT,
    )
    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == {"errors": [], "warnings": []}


def test_migrate_v2_delegates_to_resolved_output_and_stays_compact(tmp_path: Path):
    source = tmp_path / "v2.json"
    target = tmp_path / "v3.json"
    source.write_text(
        json.dumps({"meta": {"schema_version": 2, "queue_algorithms": {}}, "atoms": {}, "queues": {}}),
        encoding="utf-8",
    )
    result = run_cli(target, "migrate-v2", "--from", str(source))
    assert result["dry_run"] is False
    assert result["validation"]["errors"] == []
    assert json.loads(target.read_text(encoding="utf-8"))["meta"]["schema_version"] == 3
