"""Queue ordering policies for built-in and declarative algorithms."""

from __future__ import annotations

import random
from functools import cmp_to_key
from typing import Any, Callable, Mapping


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _mastery(atom: Mapping[str, Any]) -> float:
    return min(max(int(atom.get("streak", 0) or 0), 0), 3) / 3


def _attempt_count(atom: Mapping[str, Any]) -> int:
    attempts = atom.get("attempts", [])
    return len(attempts) if isinstance(attempts, list) else 0


def _key_value(atom_id: str, atom: Mapping[str, Any], key: str) -> Any:
    if key == "id":
        return atom_id
    if key == "attempts":
        return _attempt_count(atom)
    if key == "mastery":
        return _mastery(atom)
    return atom.get(key)


def _compare_values(left: Any, right: Any, direction: str) -> int:
    if left is None and right is None:
        return 0
    if left is None:
        return 1
    if right is None:
        return -1
    try:
        result = (left > right) - (left < right)
    except TypeError:
        result = (str(left) > str(right)) - (str(left) < str(right))
    return -result if direction == "desc" else result


def _multi_sort(
    items: list[tuple[str, Mapping[str, Any]]], specs: list[Mapping[str, Any]]
) -> list[str]:
    def compare(left: tuple[str, Mapping[str, Any]], right: tuple[str, Mapping[str, Any]]) -> int:
        for spec in specs:
            result = _compare_values(
                _key_value(left[0], left[1], str(spec["key"])),
                _key_value(right[0], right[1], str(spec["key"])),
                str(spec["dir"]),
            )
            if result:
                return result
        return _compare_values(left[0], right[0], "asc")

    return [atom_id for atom_id, _ in sorted(items, key=cmp_to_key(compare))]


def _filter(items: list[tuple[str, Mapping[str, Any]]], spec: Mapping[str, Any]) -> list[tuple[str, Mapping[str, Any]]]:
    states = set(spec.get("states", []))
    tags_any = set(spec.get("tags_any", []))
    tags_all = set(spec.get("tags_all", []))
    excluded = set(spec.get("exclude_tags", []))
    selected = []
    for item in items:
        tags = set(item[1].get("tags", []))
        if states and item[1].get("state") not in states:
            continue
        if tags_any and not tags.intersection(tags_any):
            continue
        if tags_all and not tags_all.issubset(tags):
            continue
        if excluded.intersection(tags):
            continue
        selected.append(item)
    return selected


def _fsrs(items: list[tuple[str, Mapping[str, Any]]], now_iso: str) -> list[str]:
    due = [item for item in items if _text(item[1].get("due")) and item[1]["due"] <= now_iso]
    due.sort(key=lambda item: (_text(item[1].get("due")), item[0]))
    due_ids = {item[0] for item in due}
    new = [item for item in items if item[0] not in due_ids and item[1].get("state") == "new"]
    new.sort(key=lambda item: item[0])
    selected = due_ids | {item[0] for item in new}
    remaining = [item for item in items if item[0] not in selected]
    remaining.sort(key=lambda item: (
        int(item[1].get("streak", 0) or 0),
        _text(item[1].get("last_seen")),
        item[0],
    ))
    return [item[0] for item in due + new + remaining]


def _seed(queue: Mapping[str, Any], algorithm: Mapping[str, Any]) -> Any:
    for owner in (queue, queue.get("params", {}), queue.get("algorithm_params", {}), algorithm, algorithm.get("params", {})):
        if isinstance(owner, Mapping) and "seed" in owner:
            return owner["seed"]
    return None


def order(db: Mapping[str, Any], queue_id: str, now_iso: str) -> list[str]:
    """Return existing queue members in the configured policy's order."""
    queues = db.get("queues", {})
    atoms = db.get("atoms", {})
    queue = queues[queue_id]
    algorithm_name = queue.get("algorithm", "fsrs")
    registry = db.get("meta", {}).get("queue_algorithms", {})
    algorithm = registry.get(algorithm_name, {})
    include_archived = bool(queue.get("include_archived", algorithm.get("include_archived", False)))
    items = [
        (atom_id, atoms[atom_id])
        for atom_id in dict.fromkeys(queue.get("members", []))
        if atom_id in atoms and (include_archived or not atoms[atom_id].get("archived", False))
    ]

    if algorithm_name == "fsrs":
        return _fsrs(items, now_iso)
    if algorithm_name == "oldest-first":
        return _multi_sort(items, [{"key": "created", "dir": "asc"}])
    if algorithm_name == "newest-first":
        return _multi_sort(items, [{"key": "created", "dir": "desc"}])
    if algorithm_name == "weakest-first":
        return _multi_sort(items, [
            {"key": "mastery", "dir": "asc"},
            {"key": "last_rating", "dir": "asc"},
            {"key": "last_seen", "dir": "asc"},
        ])
    if algorithm_name == "least-practiced":
        return _multi_sort(items, [{"key": "attempts", "dir": "asc"}])
    if algorithm_name == "manual":
        available = {atom_id for atom_id, _ in items}
        explicit = []
        for atom_id in queue.get("order", []):
            if atom_id in available and atom_id not in explicit:
                explicit.append(atom_id)
        return explicit + sorted(available.difference(explicit))
    if algorithm_name == "random":
        ids = [atom_id for atom_id, _ in items]
        random.Random(_seed(queue, algorithm)).shuffle(ids)
        return ids

    if algorithm.get("agent_only"):
        return sorted(atom_id for atom_id, _ in items)
    filter_spec = algorithm.get("filter", {})
    if filter_spec:
        items = _filter(items, filter_spec)
    specs = algorithm.get("order")
    if not isinstance(specs, list) or not specs:
        return sorted(atom_id for atom_id, _ in items)
    return _multi_sort(items, specs)
