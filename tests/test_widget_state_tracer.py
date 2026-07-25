"""Contract tests for the state-tracer widget template.

The learner traces how a program's state evolves: for each operation they edit
the state fields to their prediction and capture a snapshot before advancing.
The template must never know or reveal the canonical future state — only the
public initial values in `widget_data` reach the sandbox.
"""

from __future__ import annotations

import json
import re
import sys
import threading
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from etude import store
from etude.server import make_server

TEMPLATE_PATH = Path(__file__).parents[1] / "widgets" / "templates" / "state-tracer.html"


WIDGET_DATA = {
    "initial_state": [
        {
            "id": "locals",
            "label": "Local variables",
            "fields": [
                {"id": "total", "label": "total", "value": 0, "type": "number"},
                {"id": "name", "label": "name", "value": "start", "type": "text"},
                {
                    "id": "phase",
                    "label": "phase",
                    "value": "idle",
                    "type": "select",
                    "options": ["idle", "running", "done"],
                },
            ],
        },
        {
            "id": "heap",
            "label": "Heap",
            "fields": [{"id": "items", "label": "items", "value": "[]"}],
        },
    ],
    "operations": [
        {"id": "op1", "label": "Step 1", "code": "total += 5", "description": "Add five."},
        {"id": "op2", "label": "Step 2", "code": "phase = 'running'"},
        {"id": "op3", "label": "Step 3"},
    ],
}


def _atom(**extra):
    value = {
        "user_prompt": "Trace the **state** after each step",
        "agent_prompt": "The answer is total=5. Grade strictly.",
        "expected": ["total=5"],
        "agent_assisted": True,
        "tags": ["python"],
        "topic": "State tracing",
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
    value.update(extra)
    return value


@pytest.fixture
def running_server(tmp_path):
    db_path = tmp_path / "db.json"
    db = store.new_db()
    db["atoms"] = {
        "TRACE-1": _atom(widget_data=WIDGET_DATA),
        "TRACE-PT": _atom(
            topic="Rastreamento de estado",
            user_prompt="Registre o estado após cada operação",
            widget_data=WIDGET_DATA,
        ),
        "TRACE-EMPTY": _atom(widget_data={}),
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
        if response.headers.get_content_type() == "application/json":
            return response.status, json.loads(raw)
        return response.status, raw.decode()


def _injected_payload(html):
    """The payload is inlined as `const ETUDE = {...};` on a single line."""
    line = html.split("const ETUDE = ")[1].split("\n")[0]
    return json.loads(line.rstrip().removesuffix(";"))


def _template():
    return TEMPLATE_PATH.read_text(encoding="utf-8")


def _style_block():
    match = re.search(r"<style>.*?</style>", _template(), re.S)
    assert match, "state-tracer must declare a style block"
    return match.group(0)


def _script_block():
    """Everything after the data marker: the template's own behavior."""
    return _template().split("/*__DATA__*/null")[1]


# --- template contract -------------------------------------------------------


def test_template_exists_and_declares_both_injection_markers():
    """The server refuses to render a template that is missing either marker,
    and a duplicated marker would inject the theme or payload twice."""
    template = _template()

    assert template.count("/*__THEME__*/") == 1
    assert template.count("/*__DATA__*/null") == 1
    assert "<body data-fit-content>" in template
    assert "</head>" in template and "</body>" in template
    assert 'name="color-scheme"' in template


def test_template_sizes_to_natural_height_on_a_transparent_body():
    """The widget is embedded in the Lotus chat canvas: an opaque body or a
    pinned document height paints a block and leaves dead space."""
    template = _template()
    style = _style_block()

    assert re.search(r"html, body \{[^}]*overflow-y: hidden", style)
    assert "min-height: 100%" not in style
    body_rule = re.search(r"\bbody \{[^}]*\}", style)
    assert body_rule, "state-tracer must declare a body rule"
    assert "background" not in body_rule.group(0)
    assert "<body data-fit-content>" in template


def test_template_uses_semantic_tokens_and_no_literal_colors():
    """Themes stay in control: every color resolves through a semantic token."""
    style = _style_block()

    literal = re.search(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(", style)
    assert not literal, f"state-tracer hardcodes {literal and literal.group(0)}"
    assert "var(--surface-" in style
    assert "var(--text-" in style
    for pattern in (
        r"(?:linear|radial|conic)-gradient",
        r"box-shadow\s*:",
        r"(?:backdrop-)?filter\s*:[^;]*blur",
        r"text-transform\s*:\s*uppercase",
        r"font-weight\s*:\s*[7-9]00",
    ):
        assert not re.search(pattern, style, re.I), f"forbidden style: {pattern}"


def test_template_composes_shared_shadcn_primitives():
    """Buttons, inputs, selects, and the card come from widgets/shadcn.css
    rather than being recreated locally."""
    template = _template()

    assert re.search(r'class="[^"]*\bui-card', template)
    assert re.search(r'class="[^"]*\bui-button', template)
    assert "ui-badge" in template
    # State controls are built per field at runtime, so the shared class may be
    # assigned in script rather than written as a static attribute.
    for primitive in ("ui-input", "ui-select"):
        assert re.search(rf'class="[^"]*\b{primitive}|className = \'{primitive}\'', template), (
            f"state-tracer does not compose {primitive}"
        )


def test_template_is_self_contained_and_pulls_in_no_vendor_bundle():
    """No network in the sandbox, and neither KaTeX nor CodeMirror is needed."""
    template = _template()

    assert "/*__KATEX__*/" not in template
    assert "/*__CODEMIRROR__*/" not in template
    assert not re.search(r'(?:src|href)="https?://', template)


# --- payload safety ----------------------------------------------------------


def test_widget_receives_public_config_only_and_never_the_expected_answer(running_server):
    """`initial_state` values are public starting values. The rubric and the
    canonical answer stay server-side."""
    base, _ = running_server
    _, html = request(base, "/widgets/state-tracer?atom=TRACE-1")
    payload = _injected_payload(html)

    assert payload["template"] == "state-tracer"
    assert payload["atom"]["id"] == "TRACE-1"
    assert payload["atom"]["widget_data"] == WIDGET_DATA
    assert "agent_prompt" not in payload["atom"]
    assert "expected" not in payload["atom"]
    assert "Grade strictly" not in html
    assert "total=5" not in html


def test_template_never_infers_or_exposes_canonical_future_state():
    """The learner's prediction is the answer. The template must not evaluate
    the operation code or read any answer-shaped key."""
    script = _script_block()

    for forbidden in ("agent_prompt", "expected", "solution", "answer_state", "correct"):
        assert forbidden not in script, f"state-tracer reads {forbidden}"
    for evaluator in ("eval(", "new Function", "Function(", "setTimeout('"):
        assert evaluator not in script, f"state-tracer evaluates code with {evaluator}"


# --- state, snapshots, and the answer payload --------------------------------


def test_template_renders_sections_fields_and_the_three_field_types():
    """`initial_state` is grouped into labelled sections; text, number, and
    select fields each get the right control."""
    script = _script_block()

    assert "initial_state" in script
    assert "sections" in script
    assert "fields" in script
    for field_type in ("number", "select", "text"):
        assert f"'{field_type}'" in script or f'"{field_type}"' in script
    # A select renders real options from the public config.
    assert "createElement('option')" in script or 'createElement("option")' in script
    assert "options" in script
    # Fields carry their stable id and human-readable label.
    assert "field.id" in script and "field.label" in script


def test_template_renders_operations_with_labels_code_and_descriptions():
    script = _script_block()

    assert "operations" in script
    for key in ("label", "code", "description"):
        assert key in script, f"operations must surface {key}"
    assert "operation_id" in script and "operation_label" in script


def test_snapshots_preserve_field_ids_and_values_in_the_answer_payload():
    """`{kind, snapshots:[{operation_id, operation_label, state:{field_id: value}}]}`
    is the contract the grading agent reads."""
    script = _script_block()

    assert "'state-tracer'" in script or '"state-tracer"' in script
    assert "kind" in script
    assert "snapshots" in script
    assert re.search(r"snapshots\s*[:=,)]", script)
    assert "/api/inbox" in script
    assert "atom_id" in script and "payload" in script
    assert "new Date().toISOString()" in script


def test_capture_advances_the_step_and_shows_a_captured_summary():
    """The learner captures a snapshot for the current operation, then advances.
    A step indicator and a list of captured snapshots make progress legible."""
    template = _template()
    script = _script_block()

    assert 'id="capture"' in template
    assert 'id="step"' in template or "stepIndicator" in template
    assert 'id="snapshots"' in template or "snapshotList" in template
    assert re.search(r"\bindex\b|\bstep\b|\bcurrent\b", script)


def test_reset_and_undo_are_available_and_only_enabled_when_meaningful():
    """Reset returns the state to the public initial values; undo removes the
    last snapshot. Neither is offered when there is nothing to act on."""
    template = _template()
    script = _script_block()

    assert 'id="reset"' in template
    assert 'id="undo"' in template
    assert "disabled" in script
    # Editing a field is enough to make Reset meaningful, so the control state
    # is recomputed on input — not only when a snapshot is captured.
    assert re.search(r"addEventListener\('input',[^)]*\n?[^}]*syncControls\(\)", script, re.S), (
        "an edit must refresh the control state"
    )
    # Control state is recomputed without rebuilding the inputs, so a keystroke
    # cannot steal focus from the field being edited.
    assert "function syncControls()" in script
    render_fields = script.split("function renderSections()")[1].split("function renderOperation()")[0]
    assert "refresh()" not in render_fields, "an edit must not re-render every field"


def test_submit_is_explicit_and_blocked_until_meaningful_work_exists():
    """Nothing is sent on edit or capture. The submit button is the only path,
    and it stays disabled until at least one snapshot is captured."""
    template = _template()
    script = _script_block()

    assert 'id="submit"' in template
    assert re.search(r"submit'\)\.disabled|submit\.disabled", script)
    assert "snapshots.length" in script
    # Submission happens in a click handler, not on field input.
    assert re.search(r"addEventListener\('click'", script)
    inbox_call = script.split("/api/inbox")[0]
    assert "addEventListener('input'" not in inbox_call.rsplit("addEventListener('click'", 1)[-1]


def test_lotus_message_names_the_atom_and_the_grading_instructions():
    """After a successful POST the widget tells the host agent what to do."""
    script = _script_block()

    assert "window.parent.postMessage" in script
    assert "lotus: 1" in script
    assert "type: 'submit'" in script or 'type: "submit"' in script
    message = re.search(r"text: `([^`]*)`", script)
    assert message, "the Lotus message must be a template string"
    body = message.group(1)
    assert "${atomId}" in body or "${atom" in body
    lowered = body.lower()
    assert "inbox" in lowered
    assert "grade" in lowered
    assert "record" in lowered
    assert "clear" in lowered


def test_unsent_work_survives_a_failed_submission():
    """A network failure must not discard captured snapshots; the button
    re-enables so the learner can retry."""
    script = _script_block()

    catch = re.search(r"\} catch[^{]*\{(.*?)\n  \}", script, re.S)
    assert catch, "submission must handle a failed POST"
    handler = catch.group(1)
    assert "disabled = false" in handler
    assert "snapshots = []" not in handler
    assert "snapshots.length = 0" not in handler


# --- localization, accessibility, and error states ---------------------------


def test_chrome_is_localized_to_portuguese_from_the_prompt_or_topic(running_server):
    base, _ = running_server
    script = _script_block()

    assert "portuguese" in script.lower()
    assert "pt-BR" in script
    # Both language tables exist in the template, chosen at runtime.
    assert "Capturar" in script or "Registrar" in script
    assert "Capture" in script

    _, html = request(base, "/widgets/state-tracer?atom=TRACE-PT")
    assert _injected_payload(html)["atom"]["topic"] == "Rastreamento de estado"


def test_prompt_is_rendered_as_markdown_not_raw_markers():
    """The prompt is markdown; dropping it into textContent shows literal **."""
    script = _script_block()

    assert "window.ETUDE_MD_INTO" in script
    for match in re.finditer(r"^\s*\w+\.textContent = ([^;]*user_prompt[^;]*);", script, re.M):
        assert re.search(r"\b(plain|firstLine|stripMarkdown)\s*\(", match.group(1)), match.group(1)


def test_keyboard_path_focus_ring_live_status_and_reduced_motion():
    """Every control is a real button or labelled input, focus is visible, and
    the status region announces captures and errors."""
    template = _template()
    style = _style_block()

    assert ":focus-visible" in style
    assert "prefers-reduced-motion" in style
    assert 'role="status"' in template
    assert 'aria-live="polite"' in template
    assert template.count('type="button"') >= 4
    # Fields are labelled, so a screen reader announces what is being edited.
    assert "<label" in template or "createElement('label')" in _script_block()
    assert "aria-label" in template or "setAttribute('aria-label'" in _script_block()


def test_touch_targets_are_large_enough_to_hit():
    style = _style_block()

    assert re.search(r"min-height:\s*(?:4[0-9]|[5-9][0-9])px|min-height:\s*2\.[5-9]rem", style) or (
        "ui-button" in _template()
    ), "controls must be at least 40px tall"


def test_missing_or_invalid_config_shows_a_calm_error_state_and_never_throws(running_server):
    """An atom without `initial_state`/`operations` must render a usable,
    explanatory card rather than a blank frame or a thrown exception."""
    base, _ = running_server
    template = _template()
    script = _script_block()

    status, html = request(base, "/widgets/state-tracer?atom=TRACE-EMPTY")
    assert status == 200
    assert _injected_payload(html)["atom"]["widget_data"] == {}

    assert 'id="setupError"' in template or 'id="configError"' in template
    assert "Array.isArray" in script
    # The guard disables submission instead of letting a click throw.
    assert re.search(r"if \(!?\w*(?:sections|operations)", script)


def test_widget_never_scrolls_vertically_and_declares_no_nested_scroller():
    style = _style_block()

    assert "overflow-y: hidden" in style
    assert "overflow-y: scroll" not in style
    assert "height: 100vh" not in style


def test_route_requires_an_existing_atom(running_server):
    """Without a valid atom there is no public config to trace."""
    base, _ = running_server

    for path in ("/widgets/state-tracer", "/widgets/state-tracer?atom=NOPE"):
        try:
            request(base, path)
        except Exception as exc:  # HTTPError
            assert getattr(exc, "code", None) == 400, path
        else:
            pytest.fail(f"{path} should have been rejected")


def test_served_widget_includes_the_shared_resize_bridge(running_server):
    base, _ = running_server
    _, html = request(base, "/widgets/state-tracer?atom=TRACE-1")

    assert html.count('type: "resize"') == 1
    assert html.count("ResizeObserver") == 1
    assert urlparse(_injected_payload(html)["api"]).hostname == "127.0.0.1"
