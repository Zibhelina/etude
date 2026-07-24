from __future__ import annotations

import json
import random
import sys
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from etude import algorithms, cascade, scheduler, schema, store


def atom(**overrides):
    value = {
        "user_prompt": "Question?",
        "agent_prompt": "Grade this.",
        "tags": [],
        "created": "2026-01-01",
        "archived": False,
        "state": "new",
        "streak": 0,
        "lapses": 0,
        "last_rating": None,
        "last_seen": None,
        "due": None,
        "attempts": [],
    }
    value.update(overrides)
    return value


def db_with_atoms(atoms, algorithm="fsrs", **queue_overrides):
    db = store.new_db()
    db["atoms"] = atoms
    queue = {
        "label": "Test",
        "algorithm": algorithm,
        "members": list(atoms),
        "order": [],
        "status": "active",
    }
    queue.update(queue_overrides)
    db["queues"] = {"q": queue}
    return db


def test_new_db_is_valid_v3_with_builtins():
    db = store.new_db()
    errors, warnings = schema.validate(db)
    assert errors == []
    assert warnings == []
    assert db["meta"]["schema_version"] == 3
    assert set(db["meta"]["queue_algorithms"]) == {
        "fsrs", "oldest-first", "newest-first", "weakest-first",
        "least-practiced", "manual", "random",
    }
    assert set(db) >= {"meta", "atoms", "queues"}


def test_new_db_factory_returns_independent_nested_values():
    first = store.new_db()
    second = store.new_db()
    first["meta"]["scheduler"]["presets"]["standard"]["interval_minutes"].append(1)
    assert first != second


def test_db_path_resolution_precedence(tmp_path, monkeypatch):
    home = tmp_path / "home"
    config_dir = home / ".etude"
    config_dir.mkdir(parents=True)
    (config_dir / "config.json").write_text(json.dumps({"db_path": "/configured/db.json"}))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setenv("ETUDE_DB", "/environment/db.json")
    assert store.resolve_db_path("/argument/db.json") == Path("/argument/db.json")
    assert store.resolve_db_path() == Path("/environment/db.json")
    monkeypatch.delenv("ETUDE_DB")
    assert store.resolve_db_path() == Path("/configured/db.json")
    (config_dir / "config.json").unlink()
    assert store.resolve_db_path() == config_dir / "db.json"


def test_load_save_and_inbox_are_atomic_json_and_preserve_unknown_keys(tmp_path, monkeypatch):
    path = tmp_path / "nested" / "db.json"
    original = store.new_db()
    original["future_extension"] = {"keep": "✓"}
    store.save(original, path)
    loaded = store.load(path)
    loaded["atoms"]["X-1"] = atom()
    store.save(loaded, path)
    assert json.loads(path.read_text())["future_extension"] == {"keep": "✓"}
    assert "\\u2713" not in path.read_text()
    assert list(path.parent.glob("*.tmp")) == []

    monkeypatch.setattr(store, "resolve_db_path", lambda db_path=None: path)
    assert store.load_inbox() == []
    payload = [{"atom_id": "X-1", "payload": "answer"}]
    store.save_inbox(payload)
    assert store.load_inbox() == payload
    assert (path.parent / "inbox.json").exists()


def test_validate_required_fields_resolution_and_integrity():
    db = db_with_atoms({
        "BAD": atom(user_prompt="", agent_prompt=None),
        "DET-1": atom(agent_assisted=False, expected=None),
        "INV-2": atom(state="done", last_rating=9),
    })
    db["queues"]["q"].update({
        "members": ["MISSING-1"],
        "order": ["INV-2", "MISSING-2"],
        "algorithm": "missing-algorithm",
        "status": "paused",
    })
    errors, _ = schema.validate(db)
    joined = "\n".join(errors)
    for phrase in ["BAD", "user_prompt", "agent_prompt", "DET-1", "expected",
                   "state", "last_rating", "MISSING-1", "MISSING-2",
                   "missing-algorithm", "status"]:
        assert phrase in joined


def test_validate_queue_inheritance_attempt_warnings_and_declarative_specs():
    attempts = [
        {"ts": "2026-02-02T00:00:00+00:00", "rating": 2},
        {"ts": "2026-02-01T00:00:00+00:00", "rating": 1},
    ]
    db = db_with_atoms({"A-1": atom(agent_prompt=None, attempts=attempts,
                                      last_seen="wrong", last_rating=3)})
    db["queues"]["q"]["agent_assisted"] = False
    db["meta"]["queue_algorithms"]["custom"] = {
        "label": "Bad custom", "order": [{"key": "unknown", "dir": "sideways"}],
        "filter": {"states": ["imaginary"]},
    }
    errors, warnings = schema.validate(db)
    joined_errors = "\n".join(errors)
    assert "expected" in joined_errors
    assert "unknown" in joined_errors and "sideways" in joined_errors
    assert "imaginary" in joined_errors
    joined_warnings = "\n".join(warnings)
    assert "chronological" in joined_warnings
    assert "last_seen" in joined_warnings and "last_rating" in joined_warnings


def test_validate_rejects_bad_agent_assisted_and_incomplete_custom_algorithm():
    db = db_with_atoms({"A-1": atom(agent_assisted="sometimes")})
    db["meta"]["queue_algorithms"]["incomplete"] = {"label": "Incomplete"}
    errors, _ = schema.validate(db)
    assert any("agent_assisted" in error for error in errors)
    assert any("incomplete" in error and "order" in error for error in errors)


def test_attempt_chronology_compares_instants_not_iso_text():
    attempts = [
        {"ts": "2026-01-01T10:00:00+02:00", "rating": 2},
        {"ts": "2026-01-01T09:00:00+00:00", "rating": 2},
    ]
    current = atom(attempts=attempts, last_seen=attempts[-1]["ts"], last_rating=2)
    _, warnings = schema.validate(db_with_atoms({"A-1": current}))
    assert not any("chronological" in warning for warning in warnings)


def test_validate_reports_malformed_timestamps_without_crashing():
    attempts = [
        {"ts": "2026-01-01T10:00:00", "rating": 2},
        {"ts": "not-a-time", "rating": 2},
        {"ts": "2026-01-01T09:00:00+00:00", "rating": 2},
    ]
    current = atom(attempts=attempts, last_seen=attempts[-1]["ts"], last_rating=2)
    errors, _ = schema.validate(db_with_atoms({"A-1": current}))
    assert any("ISO-8601" in error for error in errors)


def test_agent_resolution_and_expected_matching():
    assert scheduler.resolve_agent_assisted({"agent_assisted": False}, {"agent_assisted": True}) is False
    assert scheduler.resolve_agent_assisted({}, {"agent_assisted": False}) is False
    assert scheduler.resolve_agent_assisted({}, {}) is True
    assert scheduler.check_expected({"expected": [" Dog ", "hound"]}, "  dOg") is True
    assert scheduler.check_expected({"expected": "YES"}, " yes ") is True
    assert scheduler.check_expected({"expected": ["yes"]}, "no") is False


def test_scheduler_standard_transitions_and_intervals():
    now = "2026-01-01T12:00:00+00:00"
    current = atom()
    scheduler.apply_attempt(current, 2, now, "standard")
    assert (current["state"], current["streak"]) == ("learning", 1)
    assert current["due"] == "2026-01-03T12:00:00+00:00"
    scheduler.apply_attempt(current, 2, now, "standard")
    assert (current["state"], current["streak"]) == ("review", 2)
    assert current["due"] == "2026-01-06T12:00:00+00:00"
    scheduler.apply_attempt(current, 0, now, "standard")
    assert (current["state"], current["streak"], current["lapses"]) == ("learning", 0, 1)
    assert current["due"] == "2026-01-02T12:00:00+00:00"
    assert current["last_seen"] == now and current["last_rating"] == 0

    hard = atom()
    scheduler.apply_attempt(hard, 1, now, "standard")
    assert hard["due"] == "2026-01-02T12:00:00+00:00"
    easy = atom()
    scheduler.apply_attempt(easy, 3, now, "standard")
    assert easy["due"] == "2026-01-06T12:00:00+00:00"
    with pytest.raises(ValueError):
        scheduler.apply_attempt(atom(), 4, now, "standard")


def test_exam_preset_selection_and_deadline_cap():
    now = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
    assert scheduler.choose_preset("2026-01-08T11:59:59+00:00", now.isoformat()) == "exam-horizon"
    assert scheduler.choose_preset("2026-01-08T12:00:00+00:00", now.isoformat()) == "standard"
    assert scheduler.choose_preset(None, now.isoformat()) == "standard"
    current = atom(streak=2, state="review")
    scheduler.apply_attempt(current, 2, now.isoformat(), {"name": "exam-horizon", "deadline": "2026-01-01T20:00:00+00:00"})
    assert current["due"] == "2026-01-01T20:00:00+00:00"
    failed = atom()
    scheduler.apply_attempt(failed, 0, now.isoformat(), "exam-horizon")
    assert failed["due"] == "2026-01-01T13:30:00+00:00"


def test_builtin_algorithm_orders():
    atoms = {
        "A-1": atom(created="2026-01-01", state="review", streak=3, last_rating=3,
                    last_seen="2026-01-04T00:00:00+00:00", due="2026-01-02T00:00:00+00:00", attempts=[{}] * 3),
        "A-2": atom(created="2026-01-03", state="new"),
        "A-3": atom(created="2026-01-02", state="learning", streak=1, last_rating=1,
                    last_seen="2026-01-03T00:00:00+00:00", due="2026-01-06T00:00:00+00:00", attempts=[{}]),
        "A-4": atom(created="2026-01-04", state="review", streak=0, last_rating=0,
                    last_seen="2026-01-02T00:00:00+00:00", due="2026-01-10T00:00:00+00:00"),
        "A-5": atom(created="2026-01-05", archived=True),
    }
    expected = {
        "fsrs": ["A-1", "A-2", "A-4", "A-3"],
        "oldest-first": ["A-1", "A-3", "A-2", "A-4"],
        "newest-first": ["A-4", "A-2", "A-3", "A-1"],
        "weakest-first": ["A-4", "A-2", "A-3", "A-1"],
        "least-practiced": ["A-2", "A-4", "A-3", "A-1"],
    }
    for name, ids in expected.items():
        db = db_with_atoms(deepcopy(atoms), name)
        assert algorithms.order(db, "q", "2026-01-05T00:00:00+00:00") == ids


def test_manual_random_and_declarative_algorithms():
    atoms = {
        "A-1": atom(tags=["x", "y"], state="review", streak=2),
        "A-2": atom(tags=["x"], state="learning", streak=1),
        "A-3": atom(tags=["z"], state="new", streak=0),
    }
    db = db_with_atoms(deepcopy(atoms), "manual", order=["A-3", "A-1"])
    assert algorithms.order(db, "q", "2026-01-01T00:00:00+00:00") == ["A-3", "A-1", "A-2"]

    db["queues"]["q"].update({"algorithm": "random", "seed": 42})
    expected = list(atoms)
    random.Random(42).shuffle(expected)
    assert algorithms.order(db, "q", "2026-01-01T00:00:00+00:00") == expected

    db["meta"]["queue_algorithms"]["custom"] = {
        "label": "Custom",
        "order": [{"key": "streak", "dir": "desc"}, {"key": "id", "dir": "asc"}],
        "filter": {"states": ["review", "learning"], "tags_any": ["x"],
                   "tags_all": ["x"], "exclude_tags": ["blocked"]},
    }
    db["queues"]["q"]["algorithm"] = "custom"
    assert algorithms.order(db, "q", "2026-01-01T00:00:00+00:00") == ["A-1", "A-2"]


def test_include_archived_and_cascade_resolution():
    db = db_with_atoms({"A-1": atom(agent_prompt="card", tags=["x", "none", "y"]),
                        "A-2": atom(archived=True)}, "oldest-first",
                       agent_instructions="queue")
    db["meta"]["tag_instructions"] = {"x": "first", "y": "second"}
    assert cascade.resolve(db, "A-1", "q") == {
        "card": "card", "tags": [("x", "first"), ("y", "second")], "queue": "queue"
    }
    assert cascade.resolve(db, "A-1") == {
        "card": "card", "tags": [("x", "first"), ("y", "second")], "queue": None
    }
    db["queues"]["q"]["include_archived"] = True
    assert "A-2" in algorithms.order(db, "q", "2026-01-01T00:00:00+00:00")
    with pytest.raises(KeyError):
        cascade.resolve(db, "missing", "q")
