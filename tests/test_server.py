from __future__ import annotations

import base64
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

from etude import server as server_module
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
        "atom_id": "DET-1", "answer": "  paris ", "via": "widget",
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


def test_widget_render_injects_data_hides_expected_in_agent_mode_and_overrides_theme(running_server):
    base, _ = running_server
    _, _, html = request(base, "/widgets/flashcard-drill?queue=agent&theme=everforest&n=1")
    assert "/*__THEME__*/" not in html
    assert "/*__DATA__*/null" not in html
    assert "--background: #252e32" in html
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


def test_widget_payload_is_safe_inside_an_inline_script(running_server):
    base, db_path = running_server
    db = store.load(db_path)
    attack = "</ScRiPt><script>alert('x')</script>&"
    db["queues"]["det"]["label"] = attack
    db["atoms"]["DET-1"]["user_prompt"] = attack
    store.save(db, db_path)

    _, _, html = request(base, "/widgets/flashcard-drill?queue=det&n=1")

    assert "</ScRiPt>" not in html
    assert "\\u003c/ScRiPt\\u003e" in html
    assert "\\u0026" in html
    payload = _injected_payload(html)
    assert payload["queue_label"] == attack
    assert payload["atoms"][0]["user_prompt"] == attack


def test_widget_rejects_theme_that_closes_the_style_element(running_server, tmp_path, monkeypatch):
    base, _ = running_server
    template = tmp_path / "custom.html"
    theme = tmp_path / "unsafe.css"
    template.write_text("<style>/*__THEME__*/</style><body><script>const ETUDE = /*__DATA__*/null;</script></body>")
    theme.write_text(":root { color: red; }</StYlE><script>alert(1)</script>")

    monkeypatch.setattr(server_module, "_named_file", lambda kind, requested, suffix: template if kind == "template" else theme)

    with pytest.raises(HTTPError) as exc:
        request(base, "/widgets/custom?queue=det")
    assert exc.value.code == 400


def test_queue_items_widget_receives_ordered_practice_item_rows(running_server):
    base, _ = running_server

    _, _, html = request(base, "/widgets/queue-items?queue=det")
    payload = _injected_payload(html)

    assert payload["queue"] == "det"
    assert payload["queue_label"] == "Deterministic queue"
    assert payload["items"] == [{
        "id": "DET-1",
        "position": 1,
        "topic": "Topic",
        "user_prompt": "Capital of France?",
        "mode": "deterministic",
        "state": "new",
        "streak": 0,
        "attempt_count": 0,
        "last_rating": None,
        "due": None,
    }]


def test_recent_items_widget_returns_unique_items_in_latest_attempt_order(running_server):
    base, db_path = running_server
    db = store.load(db_path)
    db["atoms"]["DET-1"]["attempts"] = [
        {"ts": "2026-07-23T09:00:00-07:00", "rating": 3, "mode": "widget", "via": "widget", "answer": "Paris", "feedback": ""},
        {"ts": "2026-07-24T10:00:00-07:00", "rating": 0, "mode": "widget", "via": "widget", "answer": "Lyon", "feedback": ""},
    ]
    db["atoms"]["AG-2"]["attempts"] = [
        {"ts": "2026-07-24T09:30:00-08:00", "rating": 2, "mode": "spaced-repetition", "via": "chat", "answer": "SYN", "feedback": "Good."},
    ]
    store.save(db, db_path)

    _, _, html = request(base, "/widgets/recent-items?limit=2")
    payload = _injected_payload(html)

    assert payload["total_seen"] == 2
    assert payload["items"] == [
        {
            "id": "AG-2", "topic": "Topic", "user_prompt": "Explain TCP",
            "attempt_count": 1, "last_seen": "2026-07-24T09:30:00-08:00",
            "last_rating": 2, "mode": "spaced-repetition", "via": "chat",
        },
        {
            "id": "DET-1", "topic": "Topic", "user_prompt": "Capital of France?",
            "attempt_count": 2, "last_seen": "2026-07-24T10:00:00-07:00",
            "last_rating": 0, "mode": "widget", "via": "widget",
        },
    ]


def test_queue_items_template_localizes_portuguese_chrome():
    template = (Path(__file__).parents[1] / "widgets" / "templates" / "queue-items.html").read_text()

    assert "function isPortuguese" in template
    assert "Practice items" in template
    assert "Itens de prática" in template
    assert "Determinístico" in template
    assert "Tentativas" in template


def test_queue_items_uses_compact_mode_labels_at_narrow_widths():
    template = (Path(__file__).parents[1] / "widgets" / "templates" / "queue-items.html").read_text()

    assert "className = 'mode-short'" in template
    assert ".mode-short { display: none; }" in template
    assert ".mode-short { display: inline; }" in template


def test_queue_items_scrolls_sideways_instead_of_squeezing_cells():
    """Narrow frames scroll the table rather than compressing columns: squeezing
    pushed pill labels outside their own border and clipped the last column.
    The scrollbar chrome stays hidden — scrolling works, the bar is not drawn."""
    template = (Path(__file__).parents[1] / "widgets" / "templates" / "queue-items.html").read_text()

    shell = re.search(r"\.table-shell \{[^}]*\}", template)
    assert shell and "overflow-x: auto" in shell.group(0), "table must scroll horizontally"
    assert "scrollbar-width: none" in shell.group(0), "scrollbar chrome must be hidden"
    assert ".table-shell::-webkit-scrollbar { display: none; }" in template

    table = re.search(r"\btable \{[^}]*\}", template)
    assert table and "min-width:" in table.group(0), "table needs a floor width to scroll past"
    assert "table-layout: fixed" not in template, "fixed layout is what squeezed the cells"

    pill = re.search(r"\.pill \{[^}]*\}", template)
    assert pill and "flex: none" in pill.group(0), "the pill must not be compressed by its cell"
    assert "max-width: 100%" not in pill.group(0), "capping the pill re-clips its label"


def test_matching_pairs_widget_receives_structured_atom_data(running_server):
    base, _ = running_server
    pairs = [["200", "OK"], ["404", "Not Found"]]

    _, _, atom = request(
        base,
        "/api/atoms/AG-2",
        method="PATCH",
        body={"widget_data": {"pairs": pairs}},
    )
    assert atom["widget_data"] == {"pairs": pairs}

    _, _, html = request(base, "/widgets/matching-pairs?queue=agent&n=1")
    payload = _injected_payload(html)
    assert payload["atoms"][0]["widget_data"] == {"pairs": pairs}
    assert "atom.widget_data" in html


def test_widget_data_must_be_an_object(running_server):
    base, _ = running_server

    with pytest.raises(HTTPError) as exc:
        request(
            base,
            "/api/atoms/AG-2",
            method="PATCH",
            body={"widget_data": [["200", "OK"]]},
        )

    assert exc.value.code == 400
    assert "widget_data must be an object" in json.loads(exc.value.read())["error"]


def test_flashcard_template_has_question_aware_binary_controls():
    template = (Path(__file__).parents[1] / "widgets" / "templates" / "flashcard-drill.html").read_text()

    assert "function renderBinary" in template
    assert "true-false" in template
    assert 'className = "binary-grid"' in template
    assert "stripDuplicateHeading" in template


def test_flashcard_template_localizes_portuguese_study_chrome():
    template = (Path(__file__).parents[1] / "widgets" / "templates" / "flashcard-drill.html").read_text()

    assert "function isPortuguese" in template
    assert "Mostrar resposta" in template
    assert "function displayQueueLabel" in template


def test_flashcard_completion_is_compact_localized_and_can_shrink():
    template = (Path(__file__).parents[1] / "widgets" / "templates" / "flashcard-drill.html").read_text()

    assert "data-fit-content" in template
    assert "Sessão concluída" in template
    assert "completion-label" in template
    assert "min-height: 330px" not in template


def test_atom_card_localizes_chrome_and_removes_duplicate_topic_heading():
    template = (Path(__file__).parents[1] / "widgets" / "templates" / "atom-card.html").read_text()

    assert "function isPortuguese" in template
    assert "function uiFor" in template
    assert "function stripDuplicateHeading" in template
    assert "Mostrar notas do agente" in template
    assert "aria-label" in template


def test_matching_completion_is_compact_and_can_shrink():
    template = (Path(__file__).parents[1] / "widgets" / "templates" / "matching-pairs.html").read_text()

    assert "<body data-fit-content>" in template
    assert "html, body { min-height: 0; }" in template
    assert ".confirmation { min-height: 0;" in template
    assert "min-height: 420px" not in template


def test_matching_widget_localizes_chrome_and_does_not_show_raw_markdown():
    template = (Path(__file__).parents[1] / "widgets" / "templates" / "matching-pairs.html").read_text()

    assert "function isPortuguese" in template
    assert "function uiFor" in template
    assert "Escolha um item de cada coluna" in template
    assert "function cleanInstruction" in template
    assert "aria-pressed" in template


def test_auto_resize_bridge_supports_content_fit_opt_in(running_server):
    base, _ = running_server
    _, _, html = request(base, "/widgets/flashcard-drill?queue=det")

    assert "data-fit-content" in html
    assert "getBoundingClientRect" in html


def test_compact_widgets_measure_natural_content_instead_of_iframe_height(running_server):
    base, _ = running_server

    for path in ("/widgets/queue-progress?queue=det", "/widgets/streaks?days=7"):
        _, _, html = request(base, path)
        assert "<body data-fit-content>" in html
        assert ".wrap { display: flex; flex-direction: column; height: 100%;" not in html


def test_templates_never_hardcode_colors_so_themes_stay_in_control():
    """Every color must come from a semantic token, so switching themes (or the
    host's own background) restyles the widget instead of leaving fixed colors."""
    literal_color = re.compile(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(")
    for template_path in WIDGET_TEMPLATE_DIR.glob("*.html"):
        style = re.search(r"<style>.*?</style>", template_path.read_text(), re.S)
        assert style, f"{template_path.name} must declare a style block"
        found = literal_color.search(style.group(0))
        assert not found, f"{template_path.name} hardcodes the color {found.group(0)}"


def test_progress_fills_use_status_tokens_across_the_value_range():
    """Progress fills band low→full through semantic status tokens, so each
    theme supplies its own ramp and the bar stays legible against the track."""
    for name in ("queue-overview.html", "tag-breakdown.html", "queue-progress.html", "progress.html"):
        template = (WIDGET_TEMPLATE_DIR / name).read_text()
        for band, token in (
            ("low", "--status-critical"),
            ("mid", "--status-severe"),
            ("high", "--status-warning"),
            ("full", "--status-good"),
        ):
            assert f'[data-band="{band}"] {{ background: var({token}); }}' in template, (
                f"{name} is missing the {band} band"
            )
        assert 'dataset.band' in template or '.dataset.band' in template, (
            f"{name} never assigns a band"
        )


def test_drawing_upload_saves_a_png_beside_the_database(running_server):
    """Drawings are saved as files and referenced by path: base64 inlined into
    inbox.json bloats the database and cannot be opened by the agent."""
    base, db_path = running_server
    png = (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"
        + b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    image = "data:image/png;base64," + base64.b64encode(png).decode()

    status, _, saved = request(
        base, "/api/drawings", method="POST", body={"atom_id": "DET-1", "image": image}
    )
    assert status == 201
    path = Path(saved["path"])
    assert path.exists() and path.read_bytes() == png
    assert path.parent == Path(db_path).parent / "drawings"
    assert path.suffix == ".png"


def test_drawing_upload_rejects_non_png_oversize_and_unknown_atoms(running_server):
    base, _ = running_server
    png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\nrest").decode()

    for body, expected in (
        ({"atom_id": "DET-1", "image": "data:image/jpeg;base64,AAAA"}, 400),
        ({"atom_id": "DET-1", "image": "data:image/png;base64," + base64.b64encode(b"nope").decode()}, 400),
        ({"atom_id": "MISSING", "image": "data:image/png;base64," + png_b64}, 400),
        ({"atom_id": "DET-1"}, 400),
        ({"atom_id": "DET-1", "image": "data:image/png;base64," + "A" * (4 * 1024 * 1024 + 4)}, 413),
    ):
        with pytest.raises(HTTPError) as exc:
            request(base, "/api/drawings", method="POST", body=body)
        assert exc.value.code == expected, body.get("atom_id")


def test_draw_canvas_widget_gets_its_prompt_without_leaking_the_answer(running_server):
    """The canvas shows the atom's prompt; agent_prompt holds the answer and the
    grading rubric, so it must never reach the sandbox."""
    base, _ = running_server
    _, _, html = request(base, "/widgets/draw-canvas?atom=AG-2")

    assert "toDataURL('image/png')" in html
    assert "/api/drawings" in html
    assert "agent_prompt" not in html.split("const ETUDE = ")[1].split("\n")[0]


def test_widgets_receive_a_shared_markdown_renderer(running_server):
    """Prompts are markdown. Templates that drop them into textContent show
    literal ** and backticks, so the server injects one shared renderer into
    <head> — before the template's own script runs."""
    base, _ = running_server
    _, _, html = request(base, "/widgets/atom-card?atom=DET-1")

    assert "window.ETUDE_MD" in html
    assert html.index("window.ETUDE_MD") < html.index("const ETUDE = ")
    assert "</head>" in html and html.index("window.ETUDE_MD") < html.index("</head>")
    # Escaping happens before rendering, so markup in a prompt cannot inject HTML.
    assert "replace(/&/g, '&amp;')" in html


def test_templates_never_show_raw_markdown_markers_for_prompts():
    """Every template that displays a prompt either renders it as markdown
    (block context) or strips the markers (single-line cells and clamped
    previews). Dropping a raw prompt into textContent shows literal ** to
    the user."""
    for template_path in WIDGET_TEMPLATE_DIR.glob("*.html"):
        template = template_path.read_text()
        for match in re.finditer(r"^\s*\w+\.textContent = ([^;]*user_prompt[^;]*);", template, re.M):
            expression = match.group(1)
            assert re.search(r"\b(plain|firstLine|stripMarkdown)\s*\(", expression), (
                f"{template_path.name} shows a raw prompt: {expression.strip()}"
            )


def test_widgets_never_scroll_vertically_inside_their_frame():
    """The host sizes the frame to the reported height, so a widget must never
    scroll vertically: sub-pixel rounding used to leave a few pixels of overflow
    and the host drew a nested scrollbar beside the card."""
    for template_path in WIDGET_TEMPLATE_DIR.glob("*.html"):
        template = template_path.read_text()
        rules = re.findall(r"html, body \{([^}]*)\}", template)
        assert any("overflow-y: hidden" in rule for rule in rules), (
            f"{template_path.name} must not scroll vertically"
        )


def test_resize_bridge_reports_a_height_that_clears_subpixel_rounding(running_server):
    """The measured height carries a small margin and includes child bottom
    margins. Without it the frame lands a pixel or two short and scrolls."""
    base, _ = running_server
    _, _, html = request(base, "/widgets/streaks?days=7")

    assert "marginBottom" in html, "child bottom margins must count toward height"
    assert re.search(r"paddingBottom\) \+ 2", html), "height needs slack past sub-pixel rounding"
    assert "document.documentElement.scrollHeight)" not in html.split("else {")[0], (
        "fit-content measurement must not use scrollHeight; it equals the viewport "
        "in a tall frame and would stop the widget shrinking"
    )


def test_widget_bodies_are_transparent_so_hosts_show_their_own_background():
    """Widgets sit on the host's canvas (Lotus chat). An opaque body paints a
    visible block around the card whenever the host background differs."""
    for template_path in WIDGET_TEMPLATE_DIR.glob("*.html"):
        template = template_path.read_text()
        body_rule = re.search(r"\bbody \{[^}]*\}", template)
        assert body_rule, f"{template_path.name} must declare a body rule"
        assert "background" not in body_rule.group(0), (
            f"{template_path.name} paints an opaque body background"
        )


def test_every_template_measures_natural_height_and_never_pins_full_height():
    """A body without data-fit-content falls back to scrollHeight, which cannot
    shrink below the descriptor's initial height and leaves dead space."""
    for template_path in WIDGET_TEMPLATE_DIR.glob("*.html"):
        template = template_path.read_text()
        assert "<body data-fit-content>" in template, (
            f"{template_path.name} must opt into natural-height measurement"
        )
        assert "html, body { min-height: 100%; }" not in template, (
            f"{template_path.name} pins the document to the full iframe height"
        )


def test_every_widget_template_includes_the_auto_resize_bridge(running_server):
    base, _ = running_server
    paths = [
        "/widgets/flashcard-drill?queue=det",
        "/widgets/matching-pairs?queue=agent",
        "/widgets/progress?queue=det",
        "/widgets/queue-progress?queue=det",
        "/widgets/queue-items?queue=det",
        "/widgets/recent-items?limit=5",
        "/widgets/streaks?days=7",
        "/widgets/atom-card?atom=DET-1",
        "/widgets/item-carousel?limit=5",
        "/widgets/item-inspector?atom=DET-1",
        "/widgets/queue-overview",
        "/widgets/tag-breakdown?limit=5",
        "/widgets/due-forecast?days=7",
        "/widgets/session-summary?hours=24",
    ]

    for path in paths:
        _, _, template_html = request(base, path)
        assert template_html.count('type: "resize"') == 1
        assert template_html.count("ResizeObserver") == 1

    _, _, atom_card_html = request(base, "/widgets/atom-card?atom=DET-1")
    assert "overflow-y: auto" not in atom_card_html


def test_progress_widget_gets_stats_and_template_path_traversal_is_rejected(running_server):
    base, _ = running_server
    _, _, html = request(base, "/widgets/progress?queue=det")
    stats = _injected_payload(html)["stats"]
    assert set(stats) >= {"total", "seen", "mastery", "per_queue", "per_day", "rating_dist"}
    assert len(stats["per_day"]) == 30

    for path in ("/widgets/../../etc/passwd", "/widgets/%2e%2e%2f%2e%2e%2fetc%2fpasswd"):
        with pytest.raises(HTTPError) as exc:
            request(base, path)
        assert 400 <= exc.value.code < 500


WIDGET_TEMPLATE_DIR = Path(__file__).parents[1] / "widgets" / "templates"
WIDGET_THEME_DIR = Path(__file__).parents[1] / "widgets" / "themes"


def test_widget_themes_expose_the_shared_visual_design_tokens():
    required = {
        "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
        "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground",
        "accent", "accent-foreground", "destructive", "border", "input", "ring", "radius",
        "chart-1", "chart-2", "chart-3", "chart-4", "chart-5",
        "surface-0", "surface-1", "surface-2",
        "text-primary", "text-secondary", "text-muted",
        "border", "border-strong", "radius-control", "radius-card",
        "orange", "aqua", "yellow", "magenta", "green", "violet", "red",
        "accent-text", "yellow-text", "green-text", "red-text", "violet-text", "accent-strong", "on-accent",
        "status-good", "status-warning", "status-severe", "status-critical",
        "mono", "sans",
    }

    for theme_path in WIDGET_THEME_DIR.glob("*.css"):
        theme = theme_path.read_text()
        variables = set(re.findall(r"--([a-z0-9-]+)\s*:", theme))
        assert required <= variables, f"{theme_path.name} is missing {sorted(required - variables)}"


def test_theme_text_tokens_meet_wcag_contrast_on_every_surface():
    def luminance(hex_color: str) -> float:
        channels = [int(hex_color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
        linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]

    def contrast(first: str, second: str) -> float:
        bright, dark = sorted((luminance(first), luminance(second)), reverse=True)
        return (bright + 0.05) / (dark + 0.05)

    pairs = (
        ("foreground", "background"),
        ("card-foreground", "card"),
        ("popover-foreground", "popover"),
        ("primary-foreground", "primary"),
        ("secondary-foreground", "secondary"),
        ("muted-foreground", "muted"),
        ("accent-foreground", "accent"),
    )
    for theme_path in WIDGET_THEME_DIR.glob("*.css"):
        values = dict(re.findall(r"--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})", theme_path.read_text()))
        for foreground, background in pairs:
            assert contrast(values[foreground], values[background]) >= 4.5, (
                theme_path.name, foreground, background,
            )


def test_widget_templates_follow_the_visual_design_contract():
    forbidden = {
        "gradient": re.compile(r"(?:linear|radial|conic)-gradient", re.I),
        "decorative shadow": re.compile(r"box-shadow\s*:", re.I),
        "blur": re.compile(r"(?:backdrop-)?filter\s*:[^;]*blur", re.I),
        "all-caps transform": re.compile(r"text-transform\s*:\s*uppercase", re.I),
        "heavy font weight": re.compile(r"font-weight\s*:\s*(?:[7-9]00|[7-9][0-9]{2})", re.I),
    }

    for template_path in WIDGET_TEMPLATE_DIR.glob("*.html"):
        template = template_path.read_text()
        assert 'name="color-scheme"' in template, f"{template_path.name} must declare color-scheme"
        assert "var(--surface-" in template, f"{template_path.name} must use shared surface tokens"
        assert "var(--text-" in template, f"{template_path.name} must use shared text tokens"
        for label, pattern in forbidden.items():
            assert not pattern.search(template), f"{template_path.name} uses forbidden {label}"


def test_palette_fill_colors_are_not_used_directly_for_small_text():
    raw_palette = "accent|orange|aqua|yellow|magenta|green|violet|red"
    direct_text_color = re.compile(rf"(?<![-\w])color:\s*var\(--(?:{raw_palette})\)")

    for template_path in WIDGET_TEMPLATE_DIR.glob("*.html"):
        assert not direct_text_color.search(template_path.read_text()), template_path.name


def test_visualizations_have_accessible_text_equivalents():
    queue_progress = (WIDGET_TEMPLATE_DIR / "queue-progress.html").read_text()
    streaks = (WIDGET_TEMPLATE_DIR / "streaks.html").read_text()
    progress = (WIDGET_TEMPLATE_DIR / "progress.html").read_text()

    assert queue_progress.count('role="progressbar"') >= 2
    assert "aria-valuetext" in queue_progress
    assert 'role="img"' in streaks and 'aria-label="Daily practice activity"' in streaks
    assert 'role="img"' in progress and "aria-label" in progress
    assert 'class="sr-only"' in progress


def test_progress_chart_keeps_edge_dates_outside_the_bar_cells():
    template = (WIDGET_TEMPLATE_DIR / "progress.html").read_text()

    assert 'class="chart-dates"' in template
    assert 'id="chartDateStart"' in template
    assert 'id="chartDateEnd"' in template


def test_widget_route_is_canonical_and_applet_route_remains_a_compatibility_alias(running_server):
    base, _ = running_server

    _, _, widget_html = request(base, "/widgets/flashcard-drill?queue=det&n=1")
    _, _, legacy_html = request(base, "/applets/flashcard-drill?queue=det&n=1")

    assert _injected_payload(widget_html)["template"] == "flashcard-drill"
    assert widget_html == legacy_html


def test_widget_data_is_canonical_and_legacy_applet_data_is_normalized(running_server):
    base, _ = running_server
    pairs = [["200", "OK"], ["404", "Not Found"]]

    _, _, atom = request(
        base,
        "/api/atoms/AG-2",
        method="PATCH",
        body={"applet_data": {"pairs": pairs}},
    )
    assert atom["widget_data"] == {"pairs": pairs}
    assert "applet_data" not in atom

    _, _, html = request(base, "/widgets/matching-pairs?queue=agent&n=1")
    payload = _injected_payload(html)
    assert payload["atoms"][0]["widget_data"] == {"pairs": pairs}
    assert "atom.widget_data" in html


def test_widget_defaults_record_widget_provenance(running_server):
    base, _ = running_server

    _, _, result = request(base, "/api/attempts", method="POST", body={
        "atom_id": "DET-1", "answer": "Paris",
    })

    assert result["attempt"]["mode"] == "widget"
    assert result["attempt"]["via"] == "widget"


def test_widget_themes_expose_shadcn_semantic_tokens_and_shared_components():
    root = Path(__file__).parents[1] / "widgets"
    required = {
        "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
        "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground",
        "accent", "accent-foreground", "destructive", "border", "input", "ring", "radius",
        "chart-1", "chart-2", "chart-3", "chart-4", "chart-5",
    }

    for theme_path in (root / "themes").glob("*.css"):
        variables = set(re.findall(r"--([a-z0-9-]+)\s*:", theme_path.read_text()))
        assert required <= variables, f"{theme_path.name} is missing {sorted(required - variables)}"

    components = (root / "shadcn.css").read_text()
    for class_name in (".ui-card", ".ui-button", ".ui-input", ".ui-badge", ".ui-progress"):
        assert class_name in components


def test_every_widget_composes_shared_shadcn_primitives():
    for template_path in WIDGET_TEMPLATE_DIR.glob("*.html"):
        template = template_path.read_text()
        assert re.search(r'class="[^"]*\bui-', template), f"{template_path.name} does not compose a shared shadcn primitive"


def test_matching_pairs_marks_the_selected_tile_before_it_resolves():
    """Clicking one side must be visible on its own. Border-color alone reads as
    the hover state, so the user cannot tell what they picked while waiting for
    the second choice."""
    template = (WIDGET_TEMPLATE_DIR / "matching-pairs.html").read_text()
    selected = re.search(r"\.pair\.selected \{[^}]*\}", template)
    assert selected, "matching-pairs must style the selected tile"
    rule = selected.group(0)
    assert "outline:" in rule, "selection needs a ring, not only a border color"
    assert "background:" in rule, "selection needs its own surface"
    hover = re.search(r"\.pair:hover:not\(:disabled\) \{[^}]*\}", template)
    assert hover and hover.group(0) != rule, "selection must not look identical to hover"
    assert 'aria-pressed' in template, "selection must be exposed to assistive tech"


def test_interactive_widgets_expose_keyboard_focus_and_reduced_motion_modes():
    for name in ("flashcard-drill.html", "matching-pairs.html"):
        template = (WIDGET_TEMPLATE_DIR / name).read_text()
        assert ":focus-visible" in template
        assert "prefers-reduced-motion" in template
