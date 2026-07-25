"""Etude's stdlib HTTP API, dashboard server, SSE feed, and widget renderer."""

from __future__ import annotations

import argparse
import json
import mimetypes
import threading
import time
from copy import deepcopy
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from typing import Any, Mapping
from urllib.parse import parse_qs, unquote, urlsplit

from . import algorithms, scheduler, schema, store

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DASHBOARD = _REPO_ROOT / "dashboard"
_WIDGETS = _REPO_ROOT / "widgets"

_AUTO_RESIZE_BRIDGE = """<script>
(() => {
  'use strict';
  let lastHeight = 0;
  let frame = 0;
  const measure = () => {
    frame = 0;
    const body = document.body;
    let height;
    if (body && body.hasAttribute("data-fit-content")) {
      const bodyRect = body.getBoundingClientRect();
      const style = getComputedStyle(body);
      const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
      const bottoms = [...body.children].map(child => {
        const margin = Number.parseFloat(getComputedStyle(child).marginBottom) || 0;
        return child.getBoundingClientRect().bottom + margin;
      });
      const contentBottom = bottoms.length ? Math.max(...bottoms) : bodyRect.top;
      // Round up past sub-pixel layout: reporting even a fraction short makes the
      // host draw a nested scrollbar. Never measure against scrollHeight here --
      // in a frame taller than the content it equals the viewport, which would
      // pin the widget open and stop it shrinking.
      height = Math.ceil(contentBottom - bodyRect.top + paddingBottom) + 2;
    } else {
      const bodyHeight = body ? body.scrollHeight : 0;
      height = Math.ceil(Math.max(document.documentElement.scrollHeight, bodyHeight));
    }
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      window.parent.postMessage({lotus: 1, type: "resize", height}, "*");
    }
  };
  const schedule = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(document.documentElement);
  if (document.body) observer.observe(document.body);
  window.addEventListener('load', schedule, {once: true});
  schedule();
})();
</script>"""


def _inline_script_json(value: Any) -> str:
    """Serialize JSON without leaving HTML-significant bytes in script data."""
    return (
        json.dumps(value, ensure_ascii=True, separators=(",", ":"))
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
    )

ATOM_FIELDS = frozenset({
    "user_prompt", "agent_prompt", "expected", "agent_assisted", "tags", "topic",
    "source", "created", "archived", "state", "streak", "lapses", "last_rating",
    "last_seen", "due", "notes", "attempts", "widget_data", "applet_data",
})
QUEUE_FIELDS = frozenset({
    "label", "algorithm", "members", "order", "status", "agent_assisted",
    "agent_instructions", "created", "deadline", "notes", "include_archived",
    "params", "algorithm_params",
})
SCHEDULER_FIELDS = ("state", "streak", "lapses", "last_rating", "last_seen", "due")


class APIError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _parse_bool(value: str, name: str) -> bool:
    normalized = value.strip().casefold()
    if normalized in {"true", "1", "yes"}:
        return True
    if normalized in {"false", "0", "no"}:
        return False
    raise APIError(400, f"{name} must be true or false")


def _positive_int(value: str | None, default: int, name: str) -> int:
    if value is None or value == "":
        return default
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise APIError(400, f"{name} must be an integer") from exc
    if result < 0:
        raise APIError(400, f"{name} must be non-negative")
    return result


def _mastery(atoms: list[Mapping[str, Any]]) -> float:
    if not atoms:
        return 0.0
    return sum(min(max(int(atom.get("streak", 0) or 0), 0), 3) / 3 for atom in atoms) / len(atoms)


def _seen(atom: Mapping[str, Any]) -> bool:
    return isinstance(atom.get("attempts"), list) and bool(atom["attempts"])


def _timestamp(value: Any) -> datetime | None:
    """Parse a stored timestamp. Tolerates 'Z' and the '+0000' offset form."""
    if not isinstance(value, str) or not value:
        return None
    text = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        if len(text) > 5 and (text[-5] in "+-") and text[-5:].lstrip("+-").isdigit():
            try:
                parsed = datetime.fromisoformat(f"{text[:-5]}{text[-5:-2]}:{text[-2:]}")
            except ValueError:
                return None
        else:
            return None
    return parsed if parsed.tzinfo is not None else parsed.astimezone()


def _due_datetime(atom: Mapping[str, Any]) -> datetime | None:
    return _timestamp(atom.get("due"))


def _attempt_datetime(attempt: Mapping[str, Any]) -> datetime | None:
    return _timestamp(attempt.get("ts"))


def _is_due(atom: Mapping[str, Any], now: datetime) -> bool:
    due = _due_datetime(atom)
    return due is not None and due <= now


def _queue_atoms(db: Mapping[str, Any], queue_id: str) -> list[Mapping[str, Any]]:
    try:
        queue = db.get("queues", {})[queue_id]
    except KeyError as exc:
        raise APIError(404, f"queue not found: {queue_id}") from exc
    atoms = db.get("atoms", {})
    return [atoms[atom_id] for atom_id in queue.get("members", []) if atom_id in atoms]


def _queue_stats(db: Mapping[str, Any], queue_id: str) -> dict[str, Any]:
    atoms = _queue_atoms(db, queue_id)
    return {"member_count": len(atoms), "seen": sum(_seen(atom) for atom in atoms), "mastery": _mastery(atoms)}


def _stats(db: Mapping[str, Any], queue_id: str | None = None, days: int = 30) -> dict[str, Any]:
    all_atoms = db.get("atoms", {})
    if queue_id is None:
        atoms = list(all_atoms.values())
    else:
        atoms = _queue_atoms(db, queue_id)

    rating_dist = {str(rating): 0 for rating in range(4)}
    per_date: dict[str, int] = {}
    for atom in atoms:
        attempts = atom.get("attempts", [])
        if not isinstance(attempts, list):
            continue
        for attempt in attempts:
            if not isinstance(attempt, Mapping):
                continue
            rating = attempt.get("rating")
            if isinstance(rating, int) and not isinstance(rating, bool) and 0 <= rating <= 3:
                rating_dist[str(rating)] += 1
            ts = attempt.get("ts")
            if isinstance(ts, str) and len(ts) >= 10:
                day = ts[:10]
                per_date[day] = per_date.get(day, 0) + 1

    today = datetime.now().astimezone().date()
    per_day = []
    for offset in range(days - 1, -1, -1):
        day = (today - timedelta(days=offset)).isoformat()
        per_day.append({"date": day, "count": per_date.get(day, 0)})

    per_queue = []
    for current_id, queue in db.get("queues", {}).items():
        computed = _queue_stats(db, current_id)
        per_queue.append({
            "id": current_id,
            "label": queue.get("label", current_id),
            "total": computed["member_count"],
            "seen": computed["seen"],
            "mastery": computed["mastery"],
        })
    return {
        "total": len(atoms),
        "seen": sum(_seen(atom) for atom in atoms),
        "mastery": _mastery(atoms),
        "per_queue": per_queue,
        "per_day": per_day,
        "days": days,
        "rating_dist": rating_dist,
    }


def _validate_timestamp(value: Any, *, required: bool = False) -> str:
    if value is None and not required:
        return _now_iso()
    if not isinstance(value, str):
        raise APIError(400, "ts must be an ISO-8601 string with an offset")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise APIError(400, "ts must be ISO-8601 with an offset") from exc
    if parsed.utcoffset() is None:
        raise APIError(400, "ts must be ISO-8601 with an offset")
    return value


def _schema_check(db: Mapping[str, Any]) -> None:
    errors, _ = schema.validate(db)
    if errors:
        raise APIError(400, "; ".join(errors))


def _atom_defaults(body: Mapping[str, Any]) -> dict[str, Any]:
    atom = {
        "user_prompt": body.get("user_prompt"),
        "tags": [],
        "created": datetime.now().astimezone().date().isoformat(),
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
    atom.update({key: deepcopy(value) for key, value in body.items() if key in ATOM_FIELDS})
    return atom


def _canonical_atom_fields(body: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize the pre-widget field name at the API boundary."""
    normalized = deepcopy(dict(body))
    if "widget_data" in normalized and "applet_data" in normalized:
        raise APIError(400, "use widget_data, not widget_data and applet_data together")
    if "applet_data" in normalized:
        normalized["widget_data"] = normalized.pop("applet_data")
    return normalized


def _queue_defaults(body: Mapping[str, Any], queue_id: str) -> dict[str, Any]:
    queue = {
        "label": body.get("label", queue_id),
        "algorithm": body.get("algorithm", "fsrs"),
        "members": [],
        "order": [],
        "status": "active",
        "created": datetime.now().astimezone().date().isoformat(),
        "deadline": None,
        "notes": "",
    }
    queue.update({key: deepcopy(value) for key, value in body.items() if key in QUEUE_FIELDS})
    return queue


def _resolved_queue(db: Mapping[str, Any], atom_id: str, requested: Any = None) -> Mapping[str, Any] | None:
    queues = db.get("queues", {})
    if requested is not None:
        if not isinstance(requested, str) or requested not in queues:
            raise APIError(400, f"unknown queue: {requested}")
        if atom_id not in queues[requested].get("members", []):
            raise APIError(400, f"atom {atom_id} is not in queue {requested}")
        return queues[requested]
    memberships = [queue for queue in queues.values() if atom_id in queue.get("members", [])]
    # Widgets do not include their queue id in attempt bodies. Prefer a queue
    # that establishes deterministic inheritance so those submissions remain
    # gradable when an atom belongs to more than one queue.
    for queue in memberships:
        if queue.get("agent_assisted") is False:
            return queue
    if memberships:
        return memberships[0]
    return None


def _preset(queue: Mapping[str, Any] | None, now_iso: str) -> str | dict[str, Any]:
    deadline = queue.get("deadline") if queue else None
    name = scheduler.choose_preset(deadline if isinstance(deadline, str) else None, now_iso)
    if name == "exam-horizon" and deadline:
        return {"name": name, "deadline": deadline}
    return name


def _named_file(kind: str, requested: str, suffix: str) -> Path:
    if not requested or "/" in requested or "\\" in requested or requested in {".", ".."}:
        raise APIError(404, f"{kind} not found")
    filename = requested if requested.endswith(suffix) else requested + suffix
    if Path(filename).name != filename:
        raise APIError(404, f"{kind} not found")
    subdir = "templates" if kind == "template" else "themes"
    candidates = (
        Path.home() / ".etude" / "widgets" / subdir / filename,
        Path.home() / ".etude" / "applets" / subdir / filename,
        _WIDGETS / subdir / filename,
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise APIError(404, f"{kind} not found: {requested}")


class EtudeHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], db_path: Path):
        self.db_path = db_path
        self.write_lock = threading.Lock()
        super().__init__(address, handler)


class EtudeHandler(BaseHTTPRequestHandler):
    server: Any
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send(self, status: int, body: bytes, content_type: str, *, cors: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cors:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, value: Any, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False, indent=1).encode("utf-8") + b"\n"
        self._send(status, body, "application/json; charset=utf-8", cors=True)

    def _error(self, error: APIError) -> None:
        self._json({"error": error.message}, error.status)

    def _body(self) -> dict[str, Any]:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().casefold()
        if content_type != "application/json":
            raise APIError(415, "Content-Type must be application/json")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise APIError(400, "invalid Content-Length") from exc
        if length <= 0 or length > 10 * 1024 * 1024:
            raise APIError(400, "request body must be non-empty JSON under 10 MiB")
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise APIError(400, "invalid JSON body") from exc
        if not isinstance(value, dict):
            raise APIError(400, "JSON body must be an object")
        return value

    def _db(self) -> dict[str, Any]:
        try:
            return store.load(self.server.db_path)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise APIError(500, str(exc)) from exc

    def do_OPTIONS(self) -> None:
        if urlsplit(self.path).path.startswith("/api/"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self._error(APIError(404, "not found"))

    def do_GET(self) -> None:
        try:
            self._get()
        except APIError as exc:
            self._error(exc)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self._error(APIError(500, str(exc)))

    def do_POST(self) -> None:
        try:
            self._post()
        except APIError as exc:
            self._error(exc)
        except Exception as exc:
            self._error(APIError(500, str(exc)))

    def do_PATCH(self) -> None:
        try:
            self._patch()
        except APIError as exc:
            self._error(exc)
        except Exception as exc:
            self._error(APIError(500, str(exc)))

    def do_DELETE(self) -> None:
        try:
            self._delete()
        except APIError as exc:
            self._error(exc)
        except Exception as exc:
            self._error(APIError(500, str(exc)))

    def _get(self) -> None:
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query, keep_blank_values=True)
        if path == "/api/events":
            self._events()
            return
        if path == "/api/db":
            self._json(self._db())
            return
        if path == "/api/atoms":
            self._json(self._filter_atoms(self._db(), query))
            return
        if path.startswith("/api/atoms/"):
            atom_id = path.removeprefix("/api/atoms/")
            db = self._db()
            if not atom_id or atom_id not in db.get("atoms", {}):
                raise APIError(404, f"atom not found: {atom_id}")
            self._json({"id": atom_id, **db["atoms"][atom_id]})
            return
        if path == "/api/queues":
            db = self._db()
            result = []
            for queue_id, queue in db.get("queues", {}).items():
                result.append({"id": queue_id, **queue, **_queue_stats(db, queue_id)})
            self._json(result)
            return
        if path.startswith("/api/queues/") and path.endswith("/next"):
            queue_id = path[len("/api/queues/"):-len("/next")]
            db = self._db()
            if queue_id not in db.get("queues", {}):
                raise APIError(404, f"queue not found: {queue_id}")
            n = _positive_int(query.get("n", [None])[0], 1, "n")
            ids = algorithms.order(db, queue_id, _now_iso())[:n]
            self._json([{"id": atom_id, "user_prompt": db["atoms"][atom_id].get("user_prompt", "")} for atom_id in ids])
            return
        if path == "/api/stats":
            db = self._db()
            queue_id = query.get("queue", [None])[0] or None
            days = _positive_int(query.get("days", [None])[0], 30, "days")
            self._json(_stats(db, queue_id, days))
            return
        if path == "/api/inbox":
            self._json(store.load_inbox(self.server.db_path))
            return
        if path.startswith("/widgets/"):
            self._widget(path.removeprefix("/widgets/"), query)
            return
        if path.startswith("/applets/"):
            self._widget(path.removeprefix("/applets/"), query)
            return
        self._static(path)

    def _filter_atoms(self, db: Mapping[str, Any], query: Mapping[str, list[str]]) -> list[dict[str, Any]]:
        queue_id = query.get("queue", [None])[0]
        if queue_id:
            if queue_id not in db.get("queues", {}):
                raise APIError(404, f"queue not found: {queue_id}")
            members = set(db["queues"][queue_id].get("members", []))
        else:
            members = None
        tags_any = {tag for value in query.get("tags", []) for tag in value.split(",") if tag}
        tags_all = {tag for value in query.get("tags_all", []) for tag in value.split(",") if tag}
        state = query.get("state", [None])[0]
        archived_text = query.get("archived", [None])[0]
        archived = _parse_bool(archived_text, "archived") if archived_text is not None else None
        words = (query.get("q", [""])[0] or "").casefold().split()
        selected = []
        for atom_id, atom in db.get("atoms", {}).items():
            atom_tags = set(atom.get("tags", []))
            haystack = " ".join([
                atom_id, str(atom.get("user_prompt", "")), str(atom.get("topic", "")),
                " ".join(str(tag) for tag in atom.get("tags", [])),
            ]).casefold()
            if members is not None and atom_id not in members:
                continue
            if tags_any and not tags_any.intersection(atom_tags):
                continue
            if tags_all and not tags_all.issubset(atom_tags):
                continue
            if state and atom.get("state") != state:
                continue
            if archived is not None and bool(atom.get("archived", False)) != archived:
                continue
            if words and not all(word in haystack for word in words):
                continue
            selected.append({"id": atom_id, **atom})
        return selected

    def _post(self) -> None:
        path = unquote(urlsplit(self.path).path)
        body = self._body()
        if path == "/api/atoms":
            body = _canonical_atom_fields(body)
            atom_id = body.get("id")
            if not isinstance(atom_id, str) or not atom_id:
                raise APIError(400, "id is required")
            unknown = set(body).difference(ATOM_FIELDS | {"id"})
            if unknown:
                raise APIError(400, f"unknown atom fields: {', '.join(sorted(unknown))}")
            with self.server.write_lock:
                db = self._db()
                if atom_id in db.get("atoms", {}):
                    raise APIError(409, f"atom already exists: {atom_id}")
                db.setdefault("atoms", {})[atom_id] = _atom_defaults(body)
                _schema_check(db)
                store.save(db, self.server.db_path)
            self._json({"id": atom_id, **db["atoms"][atom_id]}, 201)
            return
        if path == "/api/queues":
            queue_id = body.get("id")
            if not isinstance(queue_id, str) or not queue_id:
                raise APIError(400, "id is required")
            unknown = set(body).difference(QUEUE_FIELDS | {"id"})
            if unknown:
                raise APIError(400, f"unknown queue fields: {', '.join(sorted(unknown))}")
            with self.server.write_lock:
                db = self._db()
                if queue_id in db.get("queues", {}):
                    raise APIError(409, f"queue already exists: {queue_id}")
                db.setdefault("queues", {})[queue_id] = _queue_defaults(body, queue_id)
                _schema_check(db)
                store.save(db, self.server.db_path)
            self._json({"id": queue_id, **db["queues"][queue_id]}, 201)
            return
        if path == "/api/attempts":
            self._attempt(body)
            return
        if path == "/api/inbox":
            atom_id = body.get("atom_id")
            if not isinstance(atom_id, str) or not atom_id or "payload" not in body or "ts" not in body:
                raise APIError(400, "atom_id, payload, and ts are required")
            if set(body) != {"atom_id", "payload", "ts"}:
                raise APIError(400, "inbox body allows only atom_id, payload, and ts")
            _validate_timestamp(body["ts"], required=True)
            with self.server.write_lock:
                db = self._db()
                if atom_id not in db.get("atoms", {}):
                    raise APIError(404, f"atom not found: {atom_id}")
                inbox = store.load_inbox(self.server.db_path)
                item = deepcopy(body)
                inbox.append(item)
                store.save_inbox(inbox, self.server.db_path)
            self._json({"index": len(inbox) - 1, **item}, 201)
            return
        raise APIError(404, "not found")

    def _attempt(self, body: Mapping[str, Any]) -> None:
        atom_id = body.get("atom_id")
        answer = body.get("answer")
        if not isinstance(atom_id, str) or not atom_id:
            raise APIError(400, "atom_id is required")
        if not isinstance(answer, str):
            raise APIError(400, "answer must be a string")
        allowed = {"atom_id", "answer", "via", "rating", "feedback", "mode", "variant", "variant_prompt", "ts", "queue"}
        unknown = set(body).difference(allowed)
        if unknown:
            raise APIError(400, f"unknown attempt fields: {', '.join(sorted(unknown))}")
        now_iso = _validate_timestamp(body.get("ts"))
        with self.server.write_lock:
            db = self._db()
            if atom_id not in db.get("atoms", {}):
                raise APIError(404, f"atom not found: {atom_id}")
            atom = db["atoms"][atom_id]
            queue = _resolved_queue(db, atom_id, body.get("queue"))
            assisted = scheduler.resolve_agent_assisted(atom, queue)
            rating = body.get("rating")
            if rating is None:
                if assisted:
                    raise APIError(400, "rating is required for agent-assisted atoms")
                rating = 3 if scheduler.check_expected(atom, answer) else 0
            if isinstance(rating, bool) or not isinstance(rating, int) or not 0 <= rating <= 3:
                raise APIError(400, "rating must be an integer from 0 through 3")
            feedback = body.get("feedback", "")
            if not isinstance(feedback, str):
                raise APIError(400, "feedback must be a string")
            if not assisted and "rating" not in body:
                feedback = ""
            attempt = {
                "ts": now_iso,
                "rating": rating,
                "mode": "widget" if body.get("mode", "widget") == "applet" else body.get("mode", "widget"),
                "variant": body.get("variant"),
                "variant_prompt": body.get("variant_prompt"),
                "answer": answer,
                "feedback": feedback,
                "via": "widget" if body.get("via", "widget") == "applet" else body.get("via", "widget"),
            }
            if not isinstance(attempt["mode"], str) or not isinstance(attempt["via"], str):
                raise APIError(400, "mode and via must be strings")
            atom.setdefault("attempts", []).append(attempt)
            scheduler.apply_attempt(atom, rating, now_iso, _preset(queue, now_iso))
            _schema_check(db)
            store.save(db, self.server.db_path)
            state = {key: atom.get(key) for key in SCHEDULER_FIELDS}
        self._json({"attempt": attempt, "scheduler": state}, 201)

    def _patch(self) -> None:
        path = unquote(urlsplit(self.path).path)
        body = self._body()
        if path.startswith("/api/atoms/"):
            body = _canonical_atom_fields(body)
            atom_id = path.removeprefix("/api/atoms/")
            unknown = set(body).difference(ATOM_FIELDS)
            if unknown:
                raise APIError(400, f"fields may not be patched: {', '.join(sorted(unknown))}")
            with self.server.write_lock:
                db = self._db()
                if atom_id not in db.get("atoms", {}):
                    raise APIError(404, f"atom not found: {atom_id}")
                db["atoms"][atom_id].update(deepcopy(body))
                _schema_check(db)
                store.save(db, self.server.db_path)
            self._json({"id": atom_id, **db["atoms"][atom_id]})
            return
        if path.startswith("/api/queues/"):
            queue_id = path.removeprefix("/api/queues/")
            unknown = set(body).difference(QUEUE_FIELDS)
            if unknown:
                raise APIError(400, f"fields may not be patched: {', '.join(sorted(unknown))}")
            with self.server.write_lock:
                db = self._db()
                if queue_id not in db.get("queues", {}):
                    raise APIError(404, f"queue not found: {queue_id}")
                db["queues"][queue_id].update(deepcopy(body))
                _schema_check(db)
                store.save(db, self.server.db_path)
            self._json({"id": queue_id, **db["queues"][queue_id]})
            return
        raise APIError(404, "not found")

    def _delete(self) -> None:
        path = unquote(urlsplit(self.path).path)
        if not path.startswith("/api/inbox/"):
            raise APIError(404, "not found")
        text = path.removeprefix("/api/inbox/")
        try:
            index = int(text)
        except ValueError as exc:
            raise APIError(400, "inbox index must be an integer") from exc
        with self.server.write_lock:
            inbox = store.load_inbox(self.server.db_path)
            if index < 0 or index >= len(inbox):
                raise APIError(404, f"inbox item not found: {index}")
            item = inbox.pop(index)
            store.save_inbox(inbox, self.server.db_path)
        self._json(item)

    def _static(self, path: str) -> None:
        filename = "index.html" if path in {"", "/"} else path.removeprefix("/")
        if filename not in {"index.html", "app.js", "style.css"}:
            raise APIError(404, "not found")
        file_path = _DASHBOARD / filename
        try:
            body = file_path.read_bytes()
        except OSError as exc:
            raise APIError(404, "not found") from exc
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        if filename.endswith(".js"):
            content_type = "text/javascript"
        self._send(200, body, f"{content_type}; charset=utf-8")

    def _widget(self, template_name: str, query: Mapping[str, list[str]]) -> None:
        db = self._db()
        theme_name = query.get("theme", [None])[0] or db.get("meta", {}).get("default_theme", "default")
        if not isinstance(theme_name, str):
            raise APIError(400, "theme must be a string")
        template_path = _named_file("template", template_name, ".html")
        theme_path = _named_file("theme", theme_name, ".css")
        try:
            template = template_path.read_text(encoding="utf-8")
            theme = theme_path.read_text(encoding="utf-8")
            components = (_WIDGETS / "shadcn.css").read_text(encoding="utf-8")
        except OSError as exc:
            raise APIError(404, str(exc)) from exc
        if "/*__THEME__*/" not in template or "/*__DATA__*/null" not in template:
            raise APIError(500, "widget template is missing injection markers")
        if "</style" in theme.casefold() or "</style" in components.casefold():
            raise APIError(400, "widget styles contain an unsafe closing style tag")

        payload = self._widget_payload(db, template_name, query)
        rendered = template.replace("/*__THEME__*/", f"{theme}\n{components}").replace(
            "/*__DATA__*/null", _inline_script_json(payload)
        )
        if "</body>" not in rendered:
            raise APIError(500, "widget template is missing a closing body tag")
        rendered = rendered.replace("</body>", f"{_AUTO_RESIZE_BRIDGE}\n</body>", 1)
        self._send(200, rendered.encode("utf-8"), "text/html; charset=utf-8")

    def _widget_payload(
        self, db: Mapping[str, Any], template_name: str, query: Mapping[str, list[str]]
    ) -> dict[str, Any]:
        """Per-template payload. Read-only widgets get focused payloads;
        everything else gets the classic drill payload (queue required, atoms
        ordered by algorithm)."""
        api = f"http://127.0.0.1:{self.server.server_port}"
        base = {"api": api, "template": template_name}

        if template_name == "streaks":
            days = _positive_int(query.get("days", [None])[0], 35, "days")
            stats = _stats(db, None, days)
            per_day = stats["per_day"]
            counts = [entry["count"] for entry in per_day]
            current = 0
            for count in reversed(counts):
                if count <= 0:
                    break
                current += 1
            best = run = 0
            for count in counts:
                run = run + 1 if count > 0 else 0
                best = max(best, run)
            return {**base, "stats": {
                "per_day": per_day,
                "current_streak": current,
                "best_streak": best,
                "total_attempts": sum(counts),
            }}

        if template_name == "recent-items":
            limit = _positive_int(query.get("limit", [None])[0], 10, "limit")
            ranked_items = []
            for atom_id, atom in db.get("atoms", {}).items():
                attempts = atom.get("attempts", [])
                if not isinstance(attempts, list):
                    continue
                valid_attempts = [
                    attempt for attempt in attempts
                    if isinstance(attempt, Mapping) and isinstance(attempt.get("ts"), str)
                ]
                if not valid_attempts:
                    continue
                latest = max(
                    valid_attempts,
                    key=lambda attempt: datetime.fromisoformat(attempt["ts"].replace("Z", "+00:00")).timestamp(),
                )
                item = {
                    "id": atom_id,
                    "topic": atom.get("topic", ""),
                    "user_prompt": atom.get("user_prompt", ""),
                    "attempt_count": len(valid_attempts),
                    "last_seen": latest["ts"],
                    "last_rating": latest.get("rating"),
                    "mode": latest.get("mode", ""),
                    "via": latest.get("via", ""),
                }
                rank = datetime.fromisoformat(latest["ts"].replace("Z", "+00:00")).timestamp()
                ranked_items.append((rank, atom_id, item))
            ranked_items.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
            items = [entry[2] for entry in ranked_items[:limit]]
            return {**base, "total_seen": len(ranked_items), "items": items}

        if template_name in ("atom-card", "item-inspector"):
            atom_id = query.get("atom", [None])[0]
            if not atom_id or atom_id not in db.get("atoms", {}):
                raise APIError(400, "atom must name an existing atom")
            return {**base, "atom": {"id": atom_id, **db["atoms"][atom_id]}}

        if template_name == "queue-overview":
            now = datetime.fromisoformat(_now_iso())
            queues = []
            for queue_id, queue in db.get("queues", {}).items():
                if queue.get("archived"):
                    continue
                members = _queue_atoms(db, queue_id)
                queues.append({
                    "id": queue_id,
                    "label": queue.get("label", queue_id),
                    "algorithm": queue.get("algorithm", ""),
                    "total": len(members),
                    "seen": sum(_seen(atom) for atom in members),
                    "due_count": sum(_is_due(atom, now) for atom in members),
                    "deadline": queue.get("deadline") or "",
                })
            queues.sort(key=lambda entry: (-entry["due_count"], entry["id"]))
            return {**base, "queues": queues}

        if template_name == "tag-breakdown":
            limit = _positive_int(query.get("limit", [None])[0], 12, "limit")
            buckets: dict[str, list[Mapping[str, Any]]] = {}
            for atom in db.get("atoms", {}).values():
                if atom.get("archived"):
                    continue
                tags = atom.get("tags")
                if not isinstance(tags, list):
                    continue
                for tag in tags:
                    if isinstance(tag, str) and tag:
                        buckets.setdefault(tag, []).append(atom)
            rows = [
                {
                    "tag": tag,
                    "total": len(atoms),
                    "seen": sum(_seen(atom) for atom in atoms),
                    "mastery": _mastery(atoms),
                }
                for tag, atoms in buckets.items()
            ]
            rows.sort(key=lambda entry: (-entry["total"], entry["tag"]))
            return {**base, "tags": rows[:limit]}

        if template_name == "due-forecast":
            days = _positive_int(query.get("days", [None])[0], 7, "days")
            requested_queue = query.get("queue", [None])[0]
            if requested_queue is not None and requested_queue not in db.get("queues", {}):
                raise APIError(400, "queue must name an existing queue")
            if requested_queue is None:
                atoms = [atom for atom in db.get("atoms", {}).values() if not atom.get("archived")]
                queue_label = ""
            else:
                atoms = [atom for atom in _queue_atoms(db, requested_queue) if not atom.get("archived")]
                queue_label = db["queues"][requested_queue].get("label", requested_queue)

            now = datetime.fromisoformat(_now_iso())
            today = now.date()
            per_day = [
                {"date": (today + timedelta(days=offset)).isoformat(), "count": 0}
                for offset in range(days)
            ]
            index = {entry["date"]: entry for entry in per_day}
            overdue = scheduled = 0
            for atom in atoms:
                due = _due_datetime(atom)
                if due is None:
                    continue
                scheduled += 1
                due_date = due.date()
                if due_date < today:
                    overdue += 1
                    per_day[0]["count"] += 1
                elif due_date.isoformat() in index:
                    index[due_date.isoformat()]["count"] += 1
            for offset, entry in enumerate(per_day):
                entry["label"] = "today" if offset == 0 else entry["date"][5:]
            return {
                **base,
                "queue_label": queue_label,
                "per_day": per_day,
                "overdue": overdue,
                "due_today": per_day[0]["count"] if per_day else 0,
                "due_week": sum(entry["count"] for entry in per_day),
                "scheduled": scheduled,
            }

        if template_name == "session-summary":
            hours = _positive_int(query.get("hours", [None])[0], 24, "hours")
            cutoff = datetime.fromisoformat(_now_iso()) - timedelta(hours=hours)
            ranked = []
            attempts_total = 0
            ratings = {0: 0, 1: 0, 2: 0, 3: 0}
            for atom_id, atom in db.get("atoms", {}).items():
                attempts = atom.get("attempts")
                if not isinstance(attempts, list):
                    continue
                recent = []
                for attempt in attempts:
                    if not isinstance(attempt, Mapping) or not isinstance(attempt.get("ts"), str):
                        continue
                    stamp = _attempt_datetime(attempt)
                    if stamp is None or stamp < cutoff:
                        continue
                    recent.append((stamp, attempt))
                if not recent:
                    continue
                attempts_total += len(recent)
                for _, attempt in recent:
                    rating = attempt.get("rating")
                    if isinstance(rating, int) and rating in ratings:
                        ratings[rating] += 1
                latest_stamp, latest = max(recent, key=lambda entry: entry[0])
                ranked.append((latest_stamp, atom_id, {
                    "id": atom_id,
                    "topic": atom.get("topic", ""),
                    "user_prompt": atom.get("user_prompt", ""),
                    "last_rating": latest.get("rating"),
                    "attempt_count": len(recent),
                }))
            ranked.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
            return {
                **base,
                "hours": hours,
                "attempts": attempts_total,
                "unique_items": len(ranked),
                "ratings": {str(key): value for key, value in ratings.items()},
                "items": [entry[2] for entry in ranked],
            }

        if template_name == "item-carousel":
            limit = _positive_int(query.get("limit", [None])[0], 12, "limit")
            requested_queue = query.get("queue", [None])[0]
            if requested_queue is not None and requested_queue not in db.get("queues", {}):
                raise APIError(400, "queue must name an existing queue")
            atoms = db.get("atoms", {})
            if requested_queue is None:
                ordered_ids = [
                    atom_id for atom_id, atom in atoms.items() if not atom.get("archived")
                ]
                ordered_ids.sort()
                queue_label = ""
            else:
                ordered_ids = [
                    atom_id
                    for atom_id in algorithms.order(db, requested_queue, _now_iso())
                    if not atoms[atom_id].get("archived")
                ]
                queue_label = db["queues"][requested_queue].get("label", requested_queue)
            items = []
            for atom_id in ordered_ids[:limit]:
                atom = atoms[atom_id]
                attempts = atom.get("attempts")
                items.append({
                    "id": atom_id,
                    "topic": atom.get("topic", ""),
                    "user_prompt": atom.get("user_prompt", ""),
                    "tags": [tag for tag in atom.get("tags", []) if isinstance(tag, str)],
                    "state": atom.get("state", "new"),
                    "streak": atom.get("streak", 0),
                    "attempt_count": len(attempts) if isinstance(attempts, list) else 0,
                    "last_rating": atom.get("last_rating"),
                    "due": atom.get("due"),
                })
            return {
                **base,
                "queue_label": queue_label,
                "total": len(ordered_ids),
                "items": items,
            }

        queue_id = query.get("queue", [None])[0]
        if not queue_id or queue_id not in db.get("queues", {}):
            raise APIError(400, "queue must name an existing queue")
        queue = db["queues"][queue_id]

        if template_name == "queue-progress":
            stats = _stats(db, queue_id, 30)
            stats["remaining"] = max(stats["total"] - stats["seen"], 0)
            return {**base, "queue": queue_id, "queue_label": queue.get("label", queue_id), "stats": stats}

        if template_name == "queue-items":
            ordered_ids = algorithms.order(db, queue_id, _now_iso())
            items = []
            for position, atom_id in enumerate(ordered_ids, start=1):
                atom = db["atoms"][atom_id]
                assisted = scheduler.resolve_agent_assisted(atom, queue)
                attempts = atom.get("attempts", [])
                items.append({
                    "id": atom_id,
                    "position": position,
                    "topic": atom.get("topic", ""),
                    "user_prompt": atom.get("user_prompt", ""),
                    "mode": "agent" if assisted else "deterministic",
                    "state": atom.get("state", "new"),
                    "streak": atom.get("streak", 0),
                    "attempt_count": len(attempts) if isinstance(attempts, list) else 0,
                    "last_rating": atom.get("last_rating"),
                    "due": atom.get("due"),
                })
            return {
                **base,
                "queue": queue_id,
                "queue_label": queue.get("label", queue_id),
                "items": items,
            }

        n = _positive_int(query.get("n", [None])[0], 20, "n")
        # Mode resolves PER ATOM (atom.agent_assisted > queue.agent_assisted > True);
        # the widget is deterministic when every included atom resolves deterministic.
        ordered_ids = algorithms.order(db, queue_id, _now_iso())[:n]
        resolved = {
            atom_id: scheduler.resolve_agent_assisted(db["atoms"][atom_id], queue)
            for atom_id in ordered_ids
        }
        mode = "deterministic" if ordered_ids and not any(resolved.values()) else "agent"
        atoms = []
        for atom_id in ordered_ids:
            atom = db["atoms"][atom_id]
            item = {
                "id": atom_id,
                "user_prompt": atom.get("user_prompt", ""),
                "topic": atom.get("topic", ""),
                "tags": atom.get("tags", []),
            }
            widget_data = atom.get("widget_data", atom.get("applet_data"))
            if widget_data is not None:
                item["widget_data"] = widget_data
            if mode == "deterministic":
                item["expected"] = atom.get("expected")
            atoms.append(item)
        return {
            **base,
            "queue": queue_id,
            "queue_label": queue.get("label", queue_id),
            "mode": mode,
            "atoms": atoms,
            "stats": _stats(db, queue_id, 30),
        }

    @staticmethod
    def _mtime(path: Path) -> int | None:
        try:
            return path.stat().st_mtime_ns
        except FileNotFoundError:
            return None

    def _events(self) -> None:
        db_path = self.server.db_path
        inbox_path = db_path.with_name("inbox.json")
        watched = (db_path, inbox_path)
        mtimes = tuple(self._mtime(path) for path in watched)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        last_ping = 0.0
        while True:
            current = tuple(self._mtime(path) for path in watched)
            now = time.monotonic()
            if current != mtimes:
                self.wfile.write(b"data: reload\n\n")
                self.wfile.flush()
                mtimes = current
                last_ping = now
            elif now - last_ping >= 1.5:
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                last_ping = now
            time.sleep(0.2)


def make_server(
    db_path: str | Path | None = None, *, host: str = "127.0.0.1", port: int = 2600
) -> EtudeHTTPServer:
    """Create, but do not start, an Etude HTTP server."""
    return EtudeHTTPServer((host, port), EtudeHandler, store.resolve_db_path(db_path))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serve the Etude dashboard and HTTP API")
    parser.add_argument("--port", type=int, default=2600)
    parser.add_argument("--db")
    args = parser.parse_args(argv)
    server = make_server(args.db, port=args.port)
    print(f"Etude serving http://127.0.0.1:{server.server_port} (db: {server.db_path})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
