from __future__ import annotations

import json
import shutil
import sys
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from etude import migrate_v2, schema, store

REAL_V2_DB = Path("~/.etude/db-v2.json")


def _v2_atom(prompt: str, answer: str, **overrides):
    value = {
        "type": "question",
        "prompt": prompt,
        "answer": answer,
        "tags": ["test"],
        "source": "fixture",
        "created": "2026-01-01",
        "archived": False,
        "state": "new",
        "streak": 0,
        "lapses": 0,
        "last_rating": None,
        "last_seen": None,
        "due": None,
        "notes": "",
        "attempts": [],
    }
    value.update(overrides)
    return value


def _synthetic_v2_db():
    attempt = {
        "ts": "2026-01-02T12:00:00+00:00",
        "rating": 2,
        "mode": "agent-choice",
        "variant": "TEST-1v2",
        "variant_prompt": "A fresh variant",
        "answer": "learner response",
        "feedback": "good",
        "attempt_extension": {"nested": [1, "✓", {"keep": True}]},
    }
    algorithms = deepcopy(store.QUEUE_ALGORITHMS)
    return {
        "meta": {
            "app": "etude",
            "schema_version": 2,
            "rating_scale": deepcopy(store.RATING_SCALE),
            "scheduler": {
                "presets": deepcopy(store.SCHEDULER_PRESETS),
                "selection": "legacy selection",
                "scheduler_extension": ["preserve", {"exactly": True}],
            },
            "queue_algorithms": algorithms,
            "legacy_key": {"raw": [1, 2, 3]},
            "provenance": {"v2_migrated_at": "2026-01-01T00:00:00+00:00"},
        },
        "atoms": {
            "TEST-1": _v2_atom(
                "Question one?",
                "Rubric one",
                attempts=[attempt],
                last_seen=attempt["ts"],
                last_rating=attempt["rating"],
                state="learning",
                streak=1,
                atom_extension={"bytes": "unchanged", "items": [3, 2, 1]},
            ),
            "TEST-2": _v2_atom("Question two?", "Rubric two", type="task"),
            "TEST-3": _v2_atom("Question three?", "Rubric three"),
        },
        "queues": {
            "manual": {
                "label": "Manual",
                "algorithm": "manual",
                "members": ["TEST-2", "TEST-1"],
                "order": ["TEST-1", "TEST-2"],
                "status": "active",
                "manifest": {"phases": [{"cards": ["TEST-1"]}], "unicode": "ação"},
                "queue_extension": [1, {"two": 2}],
            },
            "spaced": {
                "label": "Spaced",
                "algorithm": "fsrs",
                "members": ["TEST-3"],
                "status": "archived",
                "agent_instructions": "Existing queue instructions",
            },
        },
        "top_level_extension": {"keep": "verbatim"},
    }


def _write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def test_migration_applies_v3_changes_and_preserves_unknown_values(tmp_path, capsys):
    source = tmp_path / "v2.json"
    target = tmp_path / "v3.json"
    original = _synthetic_v2_db()
    unknown_before = json.dumps(
        {
            "top": original["top_level_extension"],
            "meta": original["meta"]["legacy_key"],
            "scheduler": original["meta"]["scheduler"]["scheduler_extension"],
            "atom": original["atoms"]["TEST-1"]["atom_extension"],
            "attempt": original["atoms"]["TEST-1"]["attempts"][0]["attempt_extension"],
            "manifest": original["queues"]["manual"]["manifest"],
            "queue": original["queues"]["manual"]["queue_extension"],
            "algorithms": original["meta"]["queue_algorithms"],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    _write_json(source, original)

    assert migrate_v2.main(["--from", str(source), "--to", str(target)]) == 0
    report = json.loads(capsys.readouterr().out)
    migrated = store.load(target)

    assert report["counts"] == {"atoms": 3, "attempts": 1, "queues": 2, "algorithms": 7}
    assert report["fields_renamed"] == {
        "prompt_to_user_prompt": 3,
        "answer_to_agent_prompt": 3,
        "type_dropped": 3,
        "attempt_via_added": 1,
    }
    assert report["validation"]["errors"] == []
    assert migrated["meta"]["schema_version"] == 3
    assert migrated["meta"]["tag_instructions"] == {}
    assert migrated["meta"]["default_theme"] == "default"
    assert "v3_migrated_at" in migrated["meta"]["provenance"]
    assert "v3_note" in migrated["meta"]["provenance"]

    for atom in migrated["atoms"].values():
        assert atom["agent_assisted"] is None
        assert "prompt" not in atom and "answer" not in atom and "type" not in atom
        assert "expected" not in atom
        assert atom["user_prompt"].startswith("Question")
        assert atom["agent_prompt"].startswith("Rubric")
    assert migrated["atoms"]["TEST-1"]["attempts"][0]["via"] == "chat"
    assert migrated["queues"]["manual"]["agent_assisted"] is None
    assert migrated["queues"]["manual"]["agent_instructions"] == ""
    assert migrated["queues"]["spaced"]["agent_instructions"] == "Existing queue instructions"

    unknown_after = json.dumps(
        {
            "top": migrated["top_level_extension"],
            "meta": migrated["meta"]["legacy_key"],
            "scheduler": migrated["meta"]["scheduler"]["scheduler_extension"],
            "atom": migrated["atoms"]["TEST-1"]["atom_extension"],
            "attempt": migrated["atoms"]["TEST-1"]["attempts"][0]["attempt_extension"],
            "manifest": migrated["queues"]["manual"]["manifest"],
            "queue": migrated["queues"]["manual"]["queue_extension"],
            "algorithms": migrated["meta"]["queue_algorithms"],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    assert unknown_after == unknown_before
    assert schema.validate(migrated)[0] == []


def test_v3_input_is_an_idempotent_no_op(tmp_path, capsys):
    path = tmp_path / "db.json"
    db = store.new_db()
    db["unchanged"] = {"value": "same"}
    _write_json(path, db)
    before = path.read_bytes()

    assert migrate_v2.main(["--from", str(path), "--to", str(path)]) == 0
    report = json.loads(capsys.readouterr().out)

    assert report["status"] == "no-op"
    assert path.read_bytes() == before
    assert not Path(f"{path}.pre-v3.bak.json").exists()


def test_existing_target_is_backed_up_before_migration(tmp_path, capsys):
    source = tmp_path / "source.json"
    target = tmp_path / "target.json"
    _write_json(source, _synthetic_v2_db())
    previous = {"existing": ["target", "contents"]}
    _write_json(target, previous)
    previous_bytes = target.read_bytes()

    assert migrate_v2.main(["--from", str(source), "--to", str(target)]) == 0
    capsys.readouterr()

    backup = Path(f"{target}.pre-v3.bak.json")
    assert backup.read_bytes() == previous_bytes
    assert store.load(target)["meta"]["schema_version"] == 3


def test_real_kms_v2_copy_migrates_cleanly(tmp_path, capsys):
    copied_source = tmp_path / "kms-v2.json"
    target = tmp_path / "kms-v3.json"
    shutil.copyfile(REAL_V2_DB, copied_source)

    assert migrate_v2.main(["--from", str(copied_source), "--to", str(target)]) == 0
    report = json.loads(capsys.readouterr().out)
    migrated = store.load(target)

    assert report["counts"]["atoms"] == 174
    assert report["counts"]["attempts"] == 157
    assert report["counts"]["queues"] == 2
    assert report["validation"]["errors"] == []
    assert len(migrated["atoms"]) == 174
    assert sum(len(atom.get("attempts", [])) for atom in migrated["atoms"].values()) == 157
    assert len(migrated["queues"]) == 2
    assert schema.validate(migrated)[0] == []


def test_dry_run_does_not_write_target_or_backup(tmp_path, capsys):
    source = tmp_path / "source.json"
    target = tmp_path / "target.json"
    _write_json(source, _synthetic_v2_db())
    _write_json(target, {"leave": "alone"})
    before = target.read_bytes()

    assert migrate_v2.main([
        "--from", str(source), "--to", str(target), "--dry-run"
    ]) == 0
    report = json.loads(capsys.readouterr().out)

    assert report["dry_run"] is True
    assert report["validation"]["errors"] == []
    assert target.read_bytes() == before
    assert not Path(f"{target}.pre-v3.bak.json").exists()
