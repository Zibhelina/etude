"""JSON persistence and data-path resolution for etude."""

from __future__ import annotations

import json
import os
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any

JsonObject = dict[str, Any]

RATING_SCALE = {"0": "fail", "1": "hard", "2": "good", "3": "easy"}
SCHEDULER_PRESETS: dict[str, dict[str, Any]] = {
    "standard": {
        "fail_minutes": 24 * 60,
        "interval_minutes": [2 * 24 * 60, 5 * 24 * 60, 12 * 24 * 60, 30 * 24 * 60],
        "cap_minutes": 30 * 24 * 60,
    },
    "exam-horizon": {
        "fail_minutes": 90,
        "interval_minutes": [2 * 60, 8 * 60, 22 * 60],
    },
}


def _builtin(label: str, description: str) -> dict[str, Any]:
    return {"label": label, "description": description, "builtin": True}


QUEUE_ALGORITHMS: dict[str, dict[str, Any]] = {
    "fsrs": _builtin("Spaced repetition", "Due, then new, then wrap-around."),
    "oldest-first": _builtin("Oldest first", "Oldest-created members first."),
    "newest-first": _builtin("Newest first", "Newest-created members first."),
    "weakest-first": _builtin("Weakest first", "Lowest mastery first."),
    "least-practiced": _builtin("Least practiced", "Fewest attempts first."),
    "manual": _builtin("Manual", "Explicit queue order, then remaining members."),
    "random": _builtin("Random", "Deterministic seeded shuffle when a seed is supplied."),
}


def resolve_db_path(db_path: str | os.PathLike[str] | None = None) -> Path:
    """Resolve the database path in contract precedence order."""
    if db_path is not None:
        return Path(db_path).expanduser()
    env_path = os.environ.get("ETUDE_DB")
    if env_path:
        return Path(env_path).expanduser()
    data_dir = Path.home() / ".etude"
    config_path = data_dir / "config.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        configured = config.get("db_path") if isinstance(config, dict) else None
        if isinstance(configured, str) and configured:
            return Path(configured).expanduser()
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        pass
    return data_dir / "db.json"


def new_db() -> JsonObject:
    """Return a fresh, valid schema-v3 database."""
    return {
        "meta": {
            "app": "etude",
            "schema_version": 3,
            "rating_scale": dict(RATING_SCALE),
            "scheduler": {
                "presets": deepcopy(SCHEDULER_PRESETS),
                "selection": "queue deadline <7d => exam-horizon, capped at deadline; else standard",
            },
            "queue_algorithms": deepcopy(QUEUE_ALGORITHMS),
            "tag_instructions": {},
            "default_theme": "default",
        },
        "atoms": {},
        "queues": {},
    }


def load(db_path: str | os.PathLike[str] | None = None) -> JsonObject:
    """Load the complete database; initialize an in-memory v3 DB if absent."""
    path = resolve_db_path(db_path)
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError:
        return new_db()
    if not isinstance(value, dict):
        raise ValueError(f"database must be a JSON object: {path}")
    return value


def _atomic_json_write(value: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=1)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def save(db: JsonObject, db_path: str | os.PathLike[str] | None = None) -> None:
    """Atomically save the entire supplied DB, including all unknown keys."""
    _atomic_json_write(db, resolve_db_path(db_path))


def _inbox_path(db_path: str | os.PathLike[str] | None = None) -> Path:
    return resolve_db_path(db_path).with_name("inbox.json")


def load_inbox(db_path: str | os.PathLike[str] | None = None) -> list[Any]:
    path = _inbox_path(db_path)
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError:
        return []
    if not isinstance(value, list):
        raise ValueError(f"inbox must be a JSON list: {path}")
    return value


def save_inbox(inbox: list[Any], db_path: str | os.PathLike[str] | None = None) -> None:
    if not isinstance(inbox, list):
        raise TypeError("inbox must be a list")
    _atomic_json_write(inbox, _inbox_path(db_path))
