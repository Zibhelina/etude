"""Etude scheduler state transitions and deterministic answer checking."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Mapping

STATES = frozenset({"new", "learning", "review"})
RATING_MIN = 0
RATING_MAX = 3

_PRESETS: dict[str, dict[str, Any]] = {
    "standard": {
        "fail_minutes": 1440,
        "interval_minutes": [2880, 7200, 17280, 43200],
        "cap_minutes": 43200,
    },
    "exam-horizon": {
        "fail_minutes": 90,
        "interval_minutes": [120, 480, 1320],
    },
}


def _datetime(value: str, *, timezone_from: datetime | None = None) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None and timezone_from is not None:
        parsed = parsed.replace(tzinfo=timezone_from.tzinfo)
    return parsed


def choose_preset(queue_deadline: str | None, now: str | datetime) -> str:
    """Choose exam-horizon only when a deadline is strictly less than 7 days away."""
    if not queue_deadline:
        return "standard"
    current = _datetime(now) if isinstance(now, str) else now
    deadline = _datetime(queue_deadline, timezone_from=current)
    return "exam-horizon" if deadline - current < timedelta(days=7) else "standard"


def _preset_spec(preset: str | Mapping[str, Any]) -> tuple[dict[str, Any], str | None]:
    if isinstance(preset, str):
        try:
            return dict(_PRESETS[preset]), None
        except KeyError as exc:
            raise ValueError(f"unknown scheduler preset: {preset}") from exc
    name = preset.get("name")
    if isinstance(name, str):
        try:
            spec = dict(_PRESETS[name])
        except KeyError as exc:
            raise ValueError(f"unknown scheduler preset: {name}") from exc
        spec.update({key: value for key, value in preset.items() if key not in {"name", "deadline"}})
    else:
        spec = dict(preset)
    deadline = preset.get("deadline")
    return spec, deadline if isinstance(deadline, str) and deadline else None


def apply_attempt(
    atom: dict[str, Any], rating: int, now_iso: str, preset: str | Mapping[str, Any]
) -> None:
    """Mutate an atom's global scheduler fields for one attempt."""
    if isinstance(rating, bool) or not isinstance(rating, int) or not RATING_MIN <= rating <= RATING_MAX:
        raise ValueError("rating must be an integer from 0 through 3")
    now = _datetime(now_iso)
    spec, deadline_text = _preset_spec(preset)

    if rating == 0:
        atom["streak"] = 0
        atom["lapses"] = int(atom.get("lapses", 0) or 0) + 1
        atom["state"] = "learning"
        minutes = float(spec["fail_minutes"])
    else:
        streak = int(atom.get("streak", 0) or 0) + 1
        atom["streak"] = streak
        atom.setdefault("lapses", 0)
        old_state = atom.get("state", "new")
        if old_state == "new":
            atom["state"] = "learning"
        elif old_state == "learning" and streak >= 2:
            atom["state"] = "review"
        elif old_state in STATES:
            atom["state"] = old_state
        else:
            atom["state"] = "learning"

        intervals = list(spec["interval_minutes"])
        index = streak - 1 + (1 if rating == 3 else 0)
        minutes = float(intervals[min(index, len(intervals) - 1)])
        if rating == 1:
            minutes /= 2
        cap = spec.get("cap_minutes")
        if cap is not None:
            minutes = min(minutes, float(cap))

    due = now + timedelta(minutes=minutes)
    if deadline_text:
        deadline = _datetime(deadline_text, timezone_from=now)
        due = min(due, deadline)
    atom["last_rating"] = rating
    atom["last_seen"] = now_iso
    atom["due"] = due.isoformat()


def check_expected(atom: Mapping[str, Any], answer: str) -> bool:
    """Case-insensitive, surrounding-whitespace-trimmed any-of matching."""
    expected = atom.get("expected")
    accepted = expected if isinstance(expected, list) else [expected]
    normalized = answer.strip().casefold()
    return any(isinstance(item, str) and item.strip().casefold() == normalized for item in accepted)


def resolve_agent_assisted(atom: Mapping[str, Any], queue: Mapping[str, Any] | None = None) -> bool:
    """Resolve atom explicit value, then queue value, then the true default."""
    atom_value = atom.get("agent_assisted")
    if isinstance(atom_value, bool):
        return atom_value
    queue_value = (queue or {}).get("agent_assisted")
    if isinstance(queue_value, bool):
        return queue_value
    return True
