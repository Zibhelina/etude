"""Schema-v3 constants and integrity validation."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Mapping

from .scheduler import resolve_agent_assisted

STATES = frozenset({"new", "learning", "review"})
RATING_MIN = 0
RATING_MAX = 3
RATING_RANGE = range(RATING_MIN, RATING_MAX + 1)
ID_PATTERN = re.compile(r"^[A-Z][A-Z0-9]*-\d+$")
ID_REGEX = ID_PATTERN
QUEUE_STATUSES = frozenset({"active", "archived"})
SORT_KEYS = frozenset({
    "created", "last_seen", "due", "streak", "lapses", "last_rating",
    "attempts", "mastery", "id",
})
SORT_DIRECTIONS = frozenset({"asc", "desc"})
THEME_VARIABLES = [
    "--bg", "--panel", "--panel2", "--border", "--text", "--dim", "--faint",
    "--accent", "--green", "--yellow", "--red", "--purple", "--mono", "--sans",
]
THEME_VARIABLE_CONTRACT = THEME_VARIABLES
THEME_VARS = THEME_VARIABLES
THEME_CONTRACT = THEME_VARIABLES
ATOM_ID_RE = ID_PATTERN
RATINGS = tuple(RATING_RANGE)


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _atom_contexts(db: Mapping[str, Any], atom_id: str) -> list[Mapping[str, Any]]:
    queues = db.get("queues", {})
    contexts = [
        queue for queue in queues.values()
        if isinstance(queue, dict) and atom_id in queue.get("members", [])
    ]
    return contexts or [{}]


def _validate_algorithm(name: str, spec: Any, errors: list[str]) -> None:
    if not isinstance(spec, dict):
        errors.append(f"meta.queue_algorithms.{name} must be an object")
        return
    declared_order = spec.get("order")
    if declared_order is None and not spec.get("builtin") and not spec.get("agent_only"):
        errors.append(f"meta.queue_algorithms.{name}.order is required for a declarative algorithm")
    if declared_order is not None:
        if not isinstance(declared_order, list) or not declared_order:
            errors.append(f"meta.queue_algorithms.{name}.order must be a non-empty list")
        else:
            for index, item in enumerate(declared_order):
                if not isinstance(item, dict):
                    errors.append(f"meta.queue_algorithms.{name}.order[{index}] must be an object")
                    continue
                key, direction = item.get("key"), item.get("dir")
                if key not in SORT_KEYS:
                    errors.append(f"meta.queue_algorithms.{name}.order[{index}] unknown key {key!r}")
                if direction not in SORT_DIRECTIONS:
                    errors.append(f"meta.queue_algorithms.{name}.order[{index}] invalid dir {direction!r}")
    filter_spec = spec.get("filter")
    if filter_spec is not None:
        if not isinstance(filter_spec, dict):
            errors.append(f"meta.queue_algorithms.{name}.filter must be an object")
            return
        states = filter_spec.get("states")
        if states is not None:
            if not isinstance(states, list):
                errors.append(f"meta.queue_algorithms.{name}.filter.states must be a list")
            else:
                for state in states:
                    if state not in STATES:
                        errors.append(f"meta.queue_algorithms.{name}.filter.states has invalid state {state!r}")
        for field in ("tags_any", "tags_all", "exclude_tags"):
            value = filter_spec.get(field)
            if value is not None and (
                not isinstance(value, list) or not all(isinstance(tag, str) for tag in value)
            ):
                errors.append(f"meta.queue_algorithms.{name}.filter.{field} must be a string list")


def validate(db: Mapping[str, Any]) -> tuple[list[str], list[str]]:
    """Return exhaustive human-readable ``(errors, warnings)`` lists."""
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(db, Mapping):
        return ["database must be an object"], []

    meta = db.get("meta")
    atoms = db.get("atoms")
    queues = db.get("queues")
    if not isinstance(meta, dict):
        errors.append("meta must be an object")
        meta = {}
    if meta.get("schema_version") != 3:
        errors.append("meta.schema_version must be 3")
    if not isinstance(atoms, dict):
        errors.append("atoms must be an object")
        atoms = {}
    if not isinstance(queues, dict):
        errors.append("queues must be an object")
        queues = {}

    algorithms = meta.get("queue_algorithms", {})
    if not isinstance(algorithms, dict):
        errors.append("meta.queue_algorithms must be an object")
        algorithms = {}
    else:
        for name, spec in algorithms.items():
            _validate_algorithm(name, spec, errors)

    for atom_id, atom in atoms.items():
        prefix = f"atoms.{atom_id}"
        if not isinstance(atom_id, str) or not ID_PATTERN.fullmatch(atom_id):
            errors.append(f"{prefix}: invalid atom ID")
        if not isinstance(atom, dict):
            errors.append(f"{prefix} must be an object")
            continue
        if not _nonempty_string(atom.get("user_prompt")):
            errors.append(f"{prefix}.user_prompt must be a non-empty string")
        if atom.get("agent_assisted") is not None and not isinstance(atom.get("agent_assisted"), bool):
            errors.append(f"{prefix}.agent_assisted must be true, false, or null")
        for field in ("widget_data", "applet_data"):
            if field in atom and not isinstance(atom[field], dict):
                errors.append(f"{prefix}.{field} must be an object")
        if "widget_data" in atom and "applet_data" in atom:
            errors.append(f"{prefix} must not define both widget_data and legacy applet_data")

        resolutions = [resolve_agent_assisted(atom, queue) for queue in _atom_contexts(db, atom_id)]
        if any(resolutions) and not _nonempty_string(atom.get("agent_prompt")):
            errors.append(f"{prefix}.agent_prompt is required when agent-assisted")
        if any(not value for value in resolutions):
            expected = atom.get("expected")
            valid_expected = _nonempty_string(expected) or (
                isinstance(expected, list) and bool(expected)
                and all(_nonempty_string(item) for item in expected)
            )
            if not valid_expected:
                errors.append(f"{prefix}.expected is required when deterministic")

        if atom.get("state") not in STATES:
            errors.append(f"{prefix}.state must be one of {sorted(STATES)}")
        rating = atom.get("last_rating")
        if rating is not None and (
            isinstance(rating, bool) or not isinstance(rating, int) or rating not in RATING_RANGE
        ):
            errors.append(f"{prefix}.last_rating must be null or 0..3")

        attempts = atom.get("attempts", [])
        if not isinstance(attempts, list):
            errors.append(f"{prefix}.attempts must be a list")
            continue
        timestamps: list[datetime] = []
        for index, attempt in enumerate(attempts):
            if not isinstance(attempt, dict):
                errors.append(f"{prefix}.attempts[{index}] must be an object")
                continue
            attempt_rating = attempt.get("rating")
            if (isinstance(attempt_rating, bool) or not isinstance(attempt_rating, int)
                    or attempt_rating not in RATING_RANGE):
                errors.append(f"{prefix}.attempts[{index}].rating must be 0..3")
            ts = attempt.get("ts")
            if isinstance(ts, str):
                try:
                    parsed_ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    if parsed_ts.utcoffset() is None:
                        raise ValueError("timestamp has no offset")
                    timestamps.append(parsed_ts)
                except ValueError:
                    errors.append(f"{prefix}.attempts[{index}].ts must be ISO-8601 with offset")
            else:
                errors.append(f"{prefix}.attempts[{index}].ts must be ISO-8601")
        if timestamps != sorted(timestamps):
            warnings.append(f"{prefix}.attempts are not chronological")
        if attempts and isinstance(attempts[-1], dict):
            latest = attempts[-1]
            if atom.get("last_seen") != latest.get("ts"):
                warnings.append(f"{prefix}.last_seen does not mirror the last attempt")
            if atom.get("last_rating") != latest.get("rating"):
                warnings.append(f"{prefix}.last_rating does not mirror the last attempt")

    for queue_id, queue in queues.items():
        prefix = f"queues.{queue_id}"
        if not isinstance(queue, dict):
            errors.append(f"{prefix} must be an object")
            continue
        if queue.get("status") not in QUEUE_STATUSES:
            errors.append(f"{prefix}.status must be active or archived")
        if queue.get("agent_assisted") is not None and not isinstance(queue.get("agent_assisted"), bool):
            errors.append(f"{prefix}.agent_assisted must be true, false, or null")
        algorithm = queue.get("algorithm")
        if algorithm not in algorithms:
            errors.append(f"{prefix}.algorithm refers to unknown algorithm {algorithm!r}")
        members = queue.get("members", [])
        if not isinstance(members, list):
            errors.append(f"{prefix}.members must be a list")
            members = []
        for atom_id in members:
            if atom_id not in atoms:
                errors.append(f"{prefix}.members refers to missing atom {atom_id!r}")
        order = queue.get("order", [])
        if not isinstance(order, list):
            errors.append(f"{prefix}.order must be a list")
            order = []
        for atom_id in order:
            if atom_id not in atoms:
                errors.append(f"{prefix}.order refers to missing atom {atom_id!r}")
            if atom_id not in members:
                errors.append(f"{prefix}.order atom {atom_id!r} is not a member")

    return errors, warnings
