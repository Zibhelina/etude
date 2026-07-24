"""Command-line interface for etude's JSON practice database."""

from __future__ import annotations

import argparse
import contextlib
import importlib
import io
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, NoReturn, Sequence

from . import algorithms, cascade, scheduler, schema, store


class CLIError(ValueError):
    """A user-facing command error."""


class JSONArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise CLIError(message)


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _print(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def _bool(value: str) -> bool:
    normalized = value.casefold()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    raise argparse.ArgumentTypeError("expected true or false")


def _positive(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return number


def _value(text: str) -> Any:
    """Coerce JSON-looking values while keeping ordinary text as text."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _assignment(text: str) -> tuple[str, Any]:
    if "=" not in text:
        raise CLIError(f"expected field=value, got {text!r}")
    key, raw = text.split("=", 1)
    if not key:
        raise CLIError("assignment field cannot be empty")
    return key, _value(raw)


def _set_path(target: dict[str, Any], assignment: str) -> None:
    field, value = _assignment(assignment)
    parts = field.split(".")
    owner = target
    for part in parts[:-1]:
        child = owner.get(part)
        if child is None:
            child = {}
            owner[part] = child
        if not isinstance(child, dict):
            raise CLIError(f"cannot set {field!r}: {part!r} is not an object")
        owner = child
    owner[parts[-1]] = value


def _read(path: str | None, *, label: str) -> str | None:
    if path is None:
        return None
    if path == "-":
        return sys.stdin.read()
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise CLIError(f"cannot read {label} file {path!r}: {exc}") from exc


def _comma_list(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def _atom(db: dict[str, Any], atom_id: str) -> dict[str, Any]:
    try:
        atom = db["atoms"][atom_id]
    except KeyError as exc:
        raise CLIError(f"unknown atom: {atom_id}") from exc
    if not isinstance(atom, dict):
        raise CLIError(f"atom is not an object: {atom_id}")
    return atom


def _queue(db: dict[str, Any], queue_id: str) -> dict[str, Any]:
    try:
        queue = db["queues"][queue_id]
    except KeyError as exc:
        raise CLIError(f"unknown queue: {queue_id}") from exc
    if not isinstance(queue, dict):
        raise CLIError(f"queue is not an object: {queue_id}")
    return queue


def _save(db: dict[str, Any], path: str | None) -> None:
    store.save(db, path)


def _status(args: argparse.Namespace) -> dict[str, Any]:
    db = store.load(args.db)
    atoms = db.get("atoms", {})
    queues = db.get("queues", {})
    now = _now()
    active_atoms = [atom for atom in atoms.values() if isinstance(atom, dict) and not atom.get("archived", False)]
    due = sum(bool(atom.get("due")) and atom["due"] <= now for atom in active_atoms)
    return {
        "atoms": {
            "total": len(atoms),
            "active": len(active_atoms),
            "archived": len(atoms) - len(active_atoms),
        },
        "active_queues": sum(isinstance(q, dict) and q.get("status") == "active" for q in queues.values()),
        "due_now": due,
    }


def _next(args: argparse.Namespace) -> dict[str, Any]:
    db = store.load(args.db)
    _queue(db, args.queue)
    ids = algorithms.order(db, args.queue, _now())[: args.n]
    if args.full:
        selected = [dict(db["atoms"][atom_id], id=atom_id) for atom_id in ids]
    else:
        selected = [{"id": atom_id, "user_prompt": db["atoms"][atom_id].get("user_prompt")} for atom_id in ids]
    return {"queue": args.queue, "atoms": selected}


def _show(args: argparse.Namespace) -> dict[str, Any]:
    db = store.load(args.db)
    return {"id": args.id, "atom": _atom(db, args.id)}


def _context(args: argparse.Namespace) -> dict[str, Any]:
    db = store.load(args.db)
    _atom(db, args.id)
    if args.queue is not None:
        _queue(db, args.queue)
    return {"id": args.id, "queue": args.queue, "context": cascade.resolve(db, args.id, args.queue)}


def _attempt(args: argparse.Namespace) -> dict[str, Any]:
    db = store.load(args.db)
    atom = _atom(db, args.id)
    queue = _queue(db, args.queue) if args.queue else None
    answer_file = _read(args.answer_file, label="answer")
    if args.answer is not None and answer_file is not None:
        raise CLIError("use only one of --answer and --answer-file")
    answer = args.answer if args.answer is not None else answer_file
    if answer is None:
        raise CLIError("an answer is required (--answer or --answer-file)")

    assisted = scheduler.resolve_agent_assisted(atom, queue)
    computed = False
    rating = args.rating
    if rating is None:
        if assisted:
            raise CLIError("--rating is required for an agent-assisted atom")
        rating = 3 if scheduler.check_expected(atom, answer) else 0
        computed = True
    elif not 0 <= rating <= 3:
        raise CLIError("rating must be an integer from 0 through 3")

    feedback = _read(args.feedback_file, label="feedback")
    variant_prompt = _read(args.variant_prompt_file, label="variant prompt")
    timestamp = _now()
    attempt = {
        "ts": timestamp,
        "rating": rating,
        "mode": "widget" if args.mode == "applet" else args.mode,
        "variant": args.variant,
        "variant_prompt": variant_prompt,
        "answer": answer,
        "feedback": feedback if feedback is not None else "",
        "via": "widget" if args.via == "applet" else args.via,
    }
    attempts = atom.setdefault("attempts", [])
    if not isinstance(attempts, list):
        raise CLIError(f"atom {args.id} attempts is not a list")
    attempts.append(attempt)

    deadline = queue.get("deadline") if queue else None
    preset_name = scheduler.choose_preset(deadline, timestamp)
    preset: str | dict[str, Any]
    preset = {"name": preset_name, "deadline": deadline} if deadline and preset_name == "exam-horizon" else preset_name
    scheduler.apply_attempt(atom, rating, timestamp, preset)
    _save(db, args.db)
    return {"id": args.id, "computed": computed, "attempt": attempt, "atom": atom}


def _add(args: argparse.Namespace) -> dict[str, Any]:
    db = store.load(args.db)
    if args.id in db.get("atoms", {}):
        raise CLIError(f"atom already exists: {args.id}")
    if not schema.ID_PATTERN.fullmatch(args.id):
        raise CLIError(f"invalid atom ID: {args.id}")
    user_file = _read(args.user_prompt_file, label="user prompt")
    user_prompt = args.user_prompt if args.user_prompt is not None else user_file
    if not isinstance(user_prompt, str) or not user_prompt.strip():
        raise CLIError("user prompt must be non-empty")
    agent_prompt = _read(args.agent_prompt_file, label="agent prompt")
    expected = list(args.expected or [])
    if args.agent_assisted is False and not expected:
        raise CLIError("--expected is required when --agent-assisted false")
    if args.agent_assisted is not False and (not agent_prompt or not agent_prompt.strip()):
        raise CLIError("--agent-prompt-file is required when agent-assisted")
    atom = {
        "user_prompt": user_prompt,
        "agent_prompt": agent_prompt,
        "expected": expected,
        "agent_assisted": args.agent_assisted,
        "tags": _comma_list(args.tags),
        "topic": args.topic or "",
        "source": args.source or "",
        "created": datetime.now().astimezone().date().isoformat(),
        "archived": False,
        "state": "new",
        "streak": 0,
        "lapses": 0,
        "last_rating": None,
        "last_seen": None,
        "due": None,
        "notes": args.notes or "",
        "attempts": [],
    }
    db.setdefault("atoms", {})[args.id] = atom
    _save(db, args.db)
    return {"id": args.id, "atom": atom}


def _edit(args: argparse.Namespace) -> dict[str, Any]:
    db = store.load(args.db)
    atom = _atom(db, args.id)
    for assignment in args.set_values:
        _set_path(atom, assignment)
    if args.archive:
        atom["archived"] = True
    if args.unarchive:
        atom["archived"] = False
    _save(db, args.db)
    return {"id": args.id, "atom": atom}


def _queue_command(args: argparse.Namespace) -> dict[str, Any]:
    db = store.load(args.db)
    queues = db.setdefault("queues", {})
    command = args.queue_command
    if command == "list":
        return {"queues": [dict(value, id=key) for key, value in queues.items()]}
    if command == "show":
        return {"id": args.id, "queue": _queue(db, args.id)}
    if command == "create":
        if args.id in queues:
            raise CLIError(f"queue already exists: {args.id}")
        registry = db.get("meta", {}).get("queue_algorithms", {})
        if args.algorithm not in registry:
            raise CLIError(f"unknown algorithm: {args.algorithm}")
        missing = [atom_id for atom_id in args.members if atom_id not in db.get("atoms", {})]
        if missing:
            raise CLIError(f"unknown atom(s): {', '.join(missing)}")
        queue = {
            "label": args.label,
            "algorithm": args.algorithm,
            "members": list(dict.fromkeys(args.members)),
            "order": [],
            "status": "active",
            "agent_assisted": args.agent_assisted,
            "agent_instructions": args.agent_instructions,
            "created": datetime.now().astimezone().date().isoformat(),
            "deadline": args.deadline,
            "notes": args.notes or "",
        }
        queues[args.id] = queue
    else:
        queue = _queue(db, args.id)
        if command == "edit":
            for assignment in args.set_values:
                _set_path(queue, assignment)
            if args.archive:
                queue["status"] = "archived"
            if args.unarchive:
                queue["status"] = "active"
        elif command == "archive":
            queue["status"] = "archived"
        elif command in {"add-members", "remove-members"}:
            missing = [atom_id for atom_id in args.members if atom_id not in db.get("atoms", {})]
            if missing:
                raise CLIError(f"unknown atom(s): {', '.join(missing)}")
            members = queue.setdefault("members", [])
            if command == "add-members":
                for atom_id in args.members:
                    if atom_id not in members:
                        members.append(atom_id)
            else:
                remove = set(args.members)
                queue["members"] = [atom_id for atom_id in members if atom_id not in remove]
                if isinstance(queue.get("order"), list):
                    queue["order"] = [atom_id for atom_id in queue["order"] if atom_id not in remove]
        else:  # pragma: no cover - parser prevents this
            raise CLIError(f"unknown queue command: {command}")
    _save(db, args.db)
    return {"id": args.id, "queue": queues[args.id]}


def _algorithms_command(args: argparse.Namespace) -> dict[str, Any]:
    db = store.load(args.db)
    registry = db.setdefault("meta", {}).setdefault("queue_algorithms", {})
    if args.algorithms_command == "list":
        return {"algorithms": [dict(spec, name=name) for name, spec in registry.items()]}
    if args.name in registry:
        raise CLIError(f"algorithm already exists: {args.name}")
    raw = _read(args.spec_file, label="algorithm spec")
    try:
        spec = json.loads(raw or "")
    except json.JSONDecodeError as exc:
        raise CLIError(f"invalid algorithm JSON: {exc}") from exc
    if not isinstance(spec, dict):
        raise CLIError("algorithm spec must be a JSON object")
    test_db = dict(db)
    test_meta = dict(db.get("meta", {}))
    test_registry = dict(registry)
    test_registry[args.name] = spec
    test_meta["queue_algorithms"] = test_registry
    test_db["meta"] = test_meta
    errors, _ = schema.validate(test_db)
    relevant = [error for error in errors if f"queue_algorithms.{args.name}" in error]
    if relevant:
        raise CLIError("; ".join(relevant))
    registry[args.name] = spec
    _save(db, args.db)
    return {"name": args.name, "algorithm": spec}


def _stats(args: argparse.Namespace) -> dict[str, Any]:
    db = store.load(args.db)
    atoms = db.get("atoms", {})
    selected_ids = list(atoms)
    if args.queue:
        selected_ids = list(_queue(db, args.queue).get("members", []))
    tags = set(_comma_list(args.tags))
    selected = [
        atoms[atom_id]
        for atom_id in dict.fromkeys(selected_ids)
        if atom_id in atoms
        and isinstance(atoms[atom_id], dict)
        and not atoms[atom_id].get("archived", False)
        and (not tags or tags.intersection(atoms[atom_id].get("tags", [])))
    ]
    total = len(selected)
    seen = sum(bool(atom.get("attempts")) for atom in selected)
    mastery = sum(min(max(int(atom.get("streak", 0) or 0), 0), 3) / 3 for atom in selected) / total if total else 0.0
    ratings = {str(rating): 0 for rating in range(4)}
    per_day: dict[str, int] = {}
    cutoff = datetime.now().astimezone() - timedelta(days=args.days) if args.days is not None else None
    for atom in selected:
        for attempt in atom.get("attempts", []):
            if not isinstance(attempt, dict):
                continue
            try:
                when = datetime.fromisoformat(str(attempt.get("ts", "")).replace("Z", "+00:00"))
            except ValueError:
                continue
            if cutoff is not None and when < cutoff:
                continue
            rating = attempt.get("rating")
            if isinstance(rating, int) and not isinstance(rating, bool) and str(rating) in ratings:
                ratings[str(rating)] += 1
            day = when.astimezone().date().isoformat()
            per_day[day] = per_day.get(day, 0) + 1
    return {"stats": {
        "total": total,
        "seen": seen,
        "coverage": seen / total if total else 0.0,
        "mastery": mastery,
        "rating_distribution": ratings,
        "attempts_per_day": dict(sorted(per_day.items())),
    }}


def _inbox(args: argparse.Namespace) -> dict[str, Any]:
    inbox = store.load_inbox(args.db)
    if args.inbox_command == "list":
        return {"inbox": inbox}
    if args.id is None:
        cleared = len(inbox)
        inbox = []
    else:
        if args.id < 0 or args.id >= len(inbox):
            raise CLIError(f"unknown inbox id: {args.id}")
        inbox.pop(args.id)
        cleared = 1
    store.save_inbox(inbox, args.db)
    return {"cleared": cleared, "inbox": inbox}


def _validate(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    errors, warnings = schema.validate(store.load(args.db))
    return {"errors": errors, "warnings": warnings}, 1 if errors else 0


def _edit_meta(args: argparse.Namespace) -> dict[str, Any]:
    db = store.load(args.db)
    meta = db.setdefault("meta", {})
    for assignment in args.assignments:
        _set_path(meta, assignment)
    _save(db, args.db)
    return {"meta": meta}


def _external(module_name: str, extra: list[str]) -> int:
    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:
        raise CLIError(f"{module_name} is not available yet") from exc
    entry = getattr(module, "main", None)
    if not callable(entry):
        raise CLIError(f"{module_name} has no main()")
    result = entry(extra)
    return result if isinstance(result, int) else 0


def _require_module(module_name: str) -> None:
    """Fail before a command emits any startup output."""
    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:
        raise CLIError(f"{module_name} is not available yet") from exc
    if not callable(getattr(module, "main", None)):
        raise CLIError(f"{module_name} has no main()")


def _serve(args: argparse.Namespace) -> None:
    forwarded = ["--port", str(args.port)]
    if args.db:
        forwarded[:0] = ["--db", args.db]
    _require_module("etude.server")
    _print({"status": "starting", "handler": "etude.server", "port": args.port})
    # server.main emits a human startup line; the public etude CLI remains JSON-only.
    with contextlib.redirect_stdout(io.StringIO()):
        _external("etude.server", forwarded)


def _migrate(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    forwarded = ["--from", args.from_path]
    if args.db:
        forwarded.extend(["--to", args.db])
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        code = _external("etude.migrate_v2", forwarded)
    try:
        payload = json.loads(captured.getvalue())
    except json.JSONDecodeError as exc:
        raise CLIError("etude.migrate_v2 returned non-JSON output") from exc
    if not isinstance(payload, dict):
        raise CLIError("etude.migrate_v2 returned a non-object result")
    return payload, code


def build_parser() -> argparse.ArgumentParser:
    parser = JSONArgumentParser(prog="etude")
    parser.add_argument("--db")
    commands = parser.add_subparsers(dest="command", required=True, parser_class=JSONArgumentParser)

    commands.add_parser("status").set_defaults(handler=_status)
    next_p = commands.add_parser("next")
    next_p.add_argument("--queue", required=True)
    next_p.add_argument("-n", type=_positive, default=1)
    next_p.add_argument("--full", action="store_true")
    next_p.set_defaults(handler=_next)
    show = commands.add_parser("show")
    show.add_argument("id")
    show.set_defaults(handler=_show)
    context = commands.add_parser("context")
    context.add_argument("id")
    context.add_argument("--queue")
    context.set_defaults(handler=_context)

    attempt = commands.add_parser("attempt")
    attempt.add_argument("id")
    attempt.add_argument("--queue")
    attempt.add_argument("--rating", type=int)
    attempt.add_argument("--answer")
    attempt.add_argument("--answer-file")
    attempt.add_argument("--feedback-file")
    attempt.add_argument("--variant")
    attempt.add_argument("--variant-prompt-file")
    attempt.add_argument("--mode", default="spaced-repetition")
    attempt.add_argument("--via", choices=("chat", "widget", "applet"), default="chat")
    attempt.set_defaults(handler=_attempt)

    add = commands.add_parser("add")
    add.add_argument("--id", required=True)
    prompt = add.add_mutually_exclusive_group(required=True)
    prompt.add_argument("--user-prompt")
    prompt.add_argument("--user-prompt-file")
    add.add_argument("--agent-prompt-file")
    add.add_argument("--expected", action="append")
    add.add_argument("--tags")
    add.add_argument("--agent-assisted", type=_bool)
    add.add_argument("--topic")
    add.add_argument("--source")
    add.add_argument("--notes")
    add.set_defaults(handler=_add)

    edit = commands.add_parser("edit")
    edit.add_argument("id")
    edit.add_argument("--set", dest="set_values", action="append", default=[])
    archive = edit.add_mutually_exclusive_group()
    archive.add_argument("--archive", action="store_true")
    archive.add_argument("--unarchive", action="store_true")
    edit.set_defaults(handler=_edit)

    queue = commands.add_parser("queue")
    queue_commands = queue.add_subparsers(dest="queue_command", required=True, parser_class=JSONArgumentParser)
    queue_commands.add_parser("list").set_defaults(handler=_queue_command)
    queue_show = queue_commands.add_parser("show")
    queue_show.add_argument("id")
    queue_show.set_defaults(handler=_queue_command)
    queue_create = queue_commands.add_parser("create")
    queue_create.add_argument("id")
    queue_create.add_argument("--label", required=True)
    queue_create.add_argument("--algorithm", required=True)
    queue_create.add_argument("--members", nargs="*", default=[])
    queue_create.add_argument("--agent-assisted", type=_bool)
    queue_create.add_argument("--agent-instructions")
    queue_create.add_argument("--deadline")
    queue_create.add_argument("--notes")
    queue_create.set_defaults(handler=_queue_command)
    queue_edit = queue_commands.add_parser("edit")
    queue_edit.add_argument("id")
    queue_edit.add_argument("--set", dest="set_values", action="append", default=[])
    queue_edit_state = queue_edit.add_mutually_exclusive_group()
    queue_edit_state.add_argument("--archive", action="store_true")
    queue_edit_state.add_argument("--unarchive", action="store_true")
    queue_edit.set_defaults(handler=_queue_command)
    queue_archive = queue_commands.add_parser("archive")
    queue_archive.add_argument("id")
    queue_archive.set_defaults(handler=_queue_command)
    for name in ("add-members", "remove-members"):
        member_parser = queue_commands.add_parser(name)
        member_parser.add_argument("id")
        member_parser.add_argument("members", nargs="+")
        member_parser.set_defaults(handler=_queue_command)

    alg = commands.add_parser("algorithms")
    alg_commands = alg.add_subparsers(dest="algorithms_command", required=True, parser_class=JSONArgumentParser)
    alg_commands.add_parser("list").set_defaults(handler=_algorithms_command)
    alg_add = alg_commands.add_parser("add")
    alg_add.add_argument("name")
    alg_add.add_argument("--spec-file", required=True)
    alg_add.set_defaults(handler=_algorithms_command)

    stats = commands.add_parser("stats")
    stats.add_argument("--queue")
    stats.add_argument("--tags")
    stats.add_argument("--days", type=_positive)
    stats.set_defaults(handler=_stats)

    inbox = commands.add_parser("inbox")
    inbox_commands = inbox.add_subparsers(dest="inbox_command", required=True, parser_class=JSONArgumentParser)
    inbox_commands.add_parser("list").set_defaults(handler=_inbox)
    inbox_clear = inbox_commands.add_parser("clear")
    inbox_clear.add_argument("--id", type=int)
    inbox_clear.set_defaults(handler=_inbox)

    serve = commands.add_parser("serve")
    serve.add_argument("--port", type=int, default=2600)
    serve.set_defaults(handler=_serve, external=True)
    commands.add_parser("validate").set_defaults(handler=_validate)
    migrate = commands.add_parser("migrate-v2")
    migrate.add_argument("--from", dest="from_path", required=True)
    migrate.set_defaults(handler=_migrate)
    meta = commands.add_parser("edit-meta")
    meta.add_argument("assignments", nargs="+")
    meta.set_defaults(handler=_edit_meta)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        result = args.handler(args)
        if getattr(args, "external", False):
            return 0
        if isinstance(result, tuple):
            payload, code = result
        else:
            payload, code = result, 0
        _print(payload)
        return code
    except (CLIError, ValueError, KeyError, TypeError, OSError, json.JSONDecodeError) as exc:
        _print({"error": str(exc)})
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
