"""Resolve etude's card/tag/queue agent-instruction stack."""

from __future__ import annotations

from typing import Any


def resolve(
    db: dict[str, Any], atom_id: str, queue_id: str | None = None
) -> dict[str, Any]:
    atom = db.get("atoms", {})[atom_id]
    tag_instructions = db.get("meta", {}).get("tag_instructions", {})
    tags = [
        (tag, tag_instructions[tag])
        for tag in atom.get("tags", [])
        if tag in tag_instructions
    ]
    queue_instruction = None
    if queue_id is not None:
        queue_instruction = db.get("queues", {})[queue_id].get("agent_instructions")
    return {
        "card": atom.get("agent_prompt"),
        "tags": tags,
        "queue": queue_instruction,
    }
