from __future__ import annotations

import http.client
import json
import re
import sys
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from etude import store
from etude.server import make_server


def _atom(*, prompt="Question?", assisted=True, expected=None, tags=None, **extra):
    value = {
        "user_prompt": prompt,
        "agent_prompt": "Grade this." if assisted else "Reference answer.",
        "agent_assisted": assisted,
        "tags": tags or [],
        "topic": extra.pop("topic", "Topic"),
        "created": "2026-01-01",
        "archived": extra.pop("archived", False),
        "state": extra.pop("state", "new"),
        "streak": extra.pop("streak", 0),
        "lapses": extra.pop("lapses", 0),
        "last_rating": None,
        "last_seen": None,
        "due": None,
        "attempts": [],
    }
    if expected is not None:
        value["expected"] = expected
    value.update(extra)
    return value


@pytest.fixture
def running_server(tmp_path):
    db_path = tmp_path / "db.json"
    db = store.new_db()
    db["future_extension"] = {"preserved": True}
    db["atoms"] = {
        "DET-1": _atom(prompt="Capital of France?", assisted=False, expected=["Paris"], tags=["geo", "exam"]),
        "AG-2": _atom(prompt="Explain TCP", assisted=True, tags=["network"], state="learning"),
        "ARC-3": _atom(prompt="Old geography", assisted=True, tags=["geo"], archived=True),
    }
    db["queues"] = {
        "det": {
            "label": "Deterministic queue", "algorithm": "manual",
            "members": ["DET-1"], "order": ["DET-1"], "status": "active",
            "agent_assisted": False, "deadline": None,
        },
        "agent": {
            "label": "Agent queue", "algorithm": "manual",
            "members": ["AG-2"], "order": ["AG-2"], "status": "active",
            "agent_assisted": True, "deadline": None,
        },
    }
    store.save(db, db_path)
    server = make_server(db_path=db_path, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        yield base, db_path
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def request(base, path, *, method="GET", body=None):
    data = None if body is None else json.dumps(body).encode()
    req = Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urlopen(req, timeout=3) as response:
        raw = response.read()
        content_type = response.headers.get_content_type()
        return response.status, response.headers, json.loads(raw) if content_type == "application/json" else raw.decode()


def test_get_db_and_dashboard_static_files(running_server):
    base, _ = running_server
    status, headers, db = request(base, "/api/db")
    assert status == 200
    assert headers["Access-Control-Allow-Origin"] == "*"
    assert db["future_extension"] == {"preserved": True}
    assert set(db["atoms"]) == {"DET-1", "AG-2", "ARC-3"}

    status, headers, html = request(base, "/")
    assert status == 200 and "<title>Etude</title>" in html
    assert headers.get_content_type() == "text/html"
    assert request(base, "/app.js")[1].get_content_type() == "text/javascript"
    assert request(base, "/style.css")[1].get_content_type() == "text/css"


def test_atom_filters_support_queue_tags_state_archived_and_text(running_server):
    base, _ = running_server

    def ids(**params):
        _, _, atoms = request(base, "/api/atoms?" + urlencode(params))
        return [atom["id"] for atom in atoms]

    assert ids(queue="det") == ["DET-1"]
    assert ids(tags="geo,network") == ["DET-1", "AG-2", "ARC-3"]
    assert ids(tags_all="geo,exam") == ["DET-1"]
    assert ids(state="learning") == ["AG-2"]
    assert ids(archived="true") == ["ARC-3"]
    assert ids(archived="false") == ["DET-1", "AG-2"]
    assert ids(q="tcp network") == ["AG-2"]
    assert request(base, "/api/atoms/DET-1")[2]["user_prompt"] == "Capital of France?"


def test_deterministic_attempt_computes_ratings_updates_scheduler_and_persists(running_server):
    base, db_path = running_server
    _, _, right = request(base, "/api/attempts", method="POST", body={
        "atom_id": "DET-1", "answer": "  paris ", "via": "applet",
    })
    assert right["attempt"]["rating"] == 3
    assert right["attempt"]["feedback"] == ""
    assert right["scheduler"]["streak"] == 1
    assert right["scheduler"]["state"] == "learning"
    assert right["scheduler"]["due"]

    _, _, wrong = request(base, "/api/attempts", method="POST", body={
        "atom_id": "DET-1", "answer": "Lyon",
    })
    assert wrong["attempt"]["rating"] == 0
    assert wrong["scheduler"]["streak"] == 0
    assert wrong["scheduler"]["lapses"] == 1
    persisted = json.loads(db_path.read_text())
    assert [attempt["rating"] for attempt in persisted["atoms"]["DET-1"]["attempts"]] == [3, 0]
    assert persisted["future_extension"] == {"preserved": True}


def test_agent_assisted_attempt_requires_and_records_rating(running_server):
    base, db_path = running_server
    with pytest.raises(HTTPError) as exc:
        request(base, "/api/attempts", method="POST", body={"atom_id": "AG-2", "answer": "..."})
    assert exc.value.code == 400

    _, _, result = request(base, "/api/attempts", method="POST", body={
        "atom_id": "AG-2", "answer": "SYN, SYN-ACK, ACK", "rating": 2,
        "feedback": "Good.", "via": "chat", "mode": "spaced-repetition",
    })
    assert result["attempt"]["rating"] == 2
    assert result["attempt"]["feedback"] == "Good."
    assert result["attempt"]["via"] == "chat"
    assert json.loads(db_path.read_text())["atoms"]["AG-2"]["last_rating"] == 2


def test_inbox_post_get_delete_roundtrip(running_server):
    base, _ = running_server
    item = {"atom_id": "AG-2", "payload": {"matches": [["a", "b"]]}, "ts": "2026-07-23T12:00:00+00:00"}
    _, _, created = request(base, "/api/inbox", method="POST", body=item)
    assert created == {"index": 0, **item}
    assert request(base, "/api/inbox")[2] == [item]
    _, _, deleted = request(base, "/api/inbox/0", method="DELETE")
    assert deleted == item
    assert request(base, "/api/inbox")[2] == []


def _injected_payload(html):
    match = re.search(r"const ETUDE = (.*?);\n\(\(\) =>", html, re.DOTALL)
    assert match
    return json.loads(match.group(1))


def test_atom_and_queue_create_patch_next_and_stats(running_server):
    base, db_path = running_server
    _, _, created = request(base, "/api/atoms", method="POST", body={
        "id": "NEW-4", "user_prompt": "2 + 2?", "agent_assisted": False,
        "expected": "4", "topic": "Arithmetic",
    })
    assert created["id"] == "NEW-4" and created["state"] == "new"
    _, _, patched = request(base, "/api/atoms/NEW-4", method="PATCH", body={"notes": "keep me"})
    assert patched["notes"] == "keep me"

    _, _, queue = request(base, "/api/queues", method="POST", body={
        "id": "new", "label": "New queue", "algorithm": "manual",
        "members": ["NEW-4"], "order": ["NEW-4"], "agent_assisted": False,
    })
    assert queue["id"] == "new"
    _, _, queue = request(base, "/api/queues/new", method="PATCH", body={"notes": "updated"})
    assert queue["notes"] == "updated"
    assert request(base, "/api/queues/new/next?n=1")[2] == [{"id": "NEW-4", "user_prompt": "2 + 2?"}]
    queues = request(base, "/api/queues")[2]
    assert next(item for item in queues if item["id"] == "new")["member_count"] == 1
    stats = request(base, "/api/stats?queue=new&days=2")[2]
    assert stats["total"] == 1 and len(stats["per_day"]) == 2
    assert json.loads(db_path.read_text())["future_extension"] == {"preserved": True}


def test_create_validation_returns_json_400(running_server):
    base, _ = running_server
    with pytest.raises(HTTPError) as exc:
        request(base, "/api/atoms", method="POST", body={"id": "bad", "user_prompt": ""})
    assert exc.value.code == 400
    assert json.loads(exc.value.read())["error"]
    assert exc.value.headers["Access-Control-Allow-Origin"] == "*"


def test_sse_reports_ping_and_reload_after_db_change(running_server):
    base, _ = running_server
    host, port = base.removeprefix("http://").split(":")
    connection = http.client.HTTPConnection(host, int(port), timeout=3)
    connection.request("GET", "/api/events")
    response = connection.getresponse()
    assert response.status == 200
    assert response.headers.get_content_type() == "text/event-stream"
    assert response.readline() == b": ping\n"
    assert response.readline() == b"\n"
    request(base, "/api/atoms/AG-2", method="PATCH", body={"notes": "changed"})
    assert response.readline() == b"data: reload\n"
    assert response.readline() == b"\n"
    connection.close()


def test_applet_render_injects_data_hides_expected_in_agent_mode_and_overrides_theme(running_server):
    base, _ = running_server
    _, _, html = request(base, "/applets/flashcard-drill?queue=agent&theme=everforest&n=1")
    assert "/*__THEME__*/" not in html
    assert "/*__DATA__*/null" not in html
    assert "--bg: #2d353b" in html
    assert 'type: "resize"' in html
    assert "ResizeObserver" in html
    payload = _injected_payload(html)
    assert payload["api"] == base
    assert payload["queue"] == "agent"
    assert payload["queue_label"] == "Agent queue"
    assert payload["mode"] == "agent"
    assert payload["atoms"] == [{
        "id": "AG-2", "user_prompt": "Explain TCP", "topic": "Topic", "tags": ["network"],
    }]


def test_flashcard_template_has_question_aware_binary_controls():
    template = (Path(__file__).parents[1] / "applets" / "templates" / "flashcard-drill.html").read_text()

    assert "function renderBinary" in template
    assert "true-false" in template
    assert 'className = "binary-grid"' in template
    assert "stripDuplicateHeading" in template


def test_flashcard_template_localizes_portuguese_study_chrome():
    template = (Path(__file__).parents[1] / "applets" / "templates" / "flashcard-drill.html").read_text()

    assert "function isPortuguese" in template
    assert "Mostrar resposta" in template
    assert "function displayQueueLabel" in template


def test_every_applet_template_includes_the_auto_resize_bridge(running_server):
    base, _ = running_server
    paths = [
        "/applets/flashcard-drill?queue=det",
        "/applets/matching-pairs?queue=agent",
        "/applets/progress?queue=det",
        "/applets/queue-progress?queue=det",
        "/applets/streaks?days=7",
        "/applets/atom-card?atom=DET-1",
    ]

    for path in paths:
        _, _, template_html = request(base, path)
        assert template_html.count('type: "resize"') == 1
        assert template_html.count("ResizeObserver") == 1

    _, _, atom_card_html = request(base, "/applets/atom-card?atom=DET-1")
    assert ".card { min-height: 100%; }" in atom_card_html
    assert "overflow-y: auto" not in atom_card_html


def test_progress_applet_gets_stats_and_template_path_traversal_is_rejected(running_server):
    base, _ = running_server
    _, _, html = request(base, "/applets/progress?queue=det")
    stats = _injected_payload(html)["stats"]
    assert set(stats) >= {"total", "seen", "mastery", "per_queue", "per_day", "rating_dist"}
    assert len(stats["per_day"]) == 30

    for path in ("/applets/../../etc/passwd", "/applets/%2e%2e%2f%2e%2e%2fetc%2fpasswd"):
        with pytest.raises(HTTPError) as exc:
            request(base, path)
        assert 400 <= exc.value.code < 500
