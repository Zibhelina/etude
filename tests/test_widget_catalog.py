"""Contract tests for the catalog free-play instrument.

Unlike every other interactive template, catalog is not a drill: there is no
expected answer, nothing is graded, and it must open with no atom at all. New
material (sound presets and recordings) goes to the inbox for the agent to file,
never to /api/attempts.
"""

from __future__ import annotations

import json
import re
import sys
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from etude import store
from etude.server import make_server

TEMPLATE_PATH = Path(__file__).parents[1] / "widgets" / "templates" / "catalog.html"

SAVED_PRESET = {
    "kind": "preset",
    "name": "Ambient warm",
    "preset": {"timbre": "warm", "reverb": 0.85, "transpose": -5, "cc": {"70": "reverb"}},
}


@pytest.fixture(scope="module")
def template() -> str:
    assert TEMPLATE_PATH.exists(), f"{TEMPLATE_PATH} must exist"
    return TEMPLATE_PATH.read_text(encoding="utf-8")


@pytest.fixture()
def catalog_db(tmp_path) -> Path:
    db = store.new_db()
    # The anchor: the member that is not saved material. Saves attach to it
    # because POST /api/inbox requires an atom that already exists.
    db["atoms"]["CAT-00"] = {
        "user_prompt": "Free instrument.",
        "agent_prompt": "Delivery anchor; never serve as a drill.",
        "agent_assisted": True,
        "tags": ["catalog"], "topic": "Catalog",
        "source": "", "created": "2026-07-26", "archived": False,
        "state": "new", "streak": 0, "lapses": 0,
        "last_rating": None, "last_seen": None, "due": None, "notes": "", "attempts": [],
    }
    db["atoms"]["CAT-01"] = {
        "user_prompt": "Ambient warm",
        "agent_prompt": "Saved sound preset.",
        "agent_assisted": True,
        "tags": ["catalog"], "topic": "Ambient warm",
        "widget_data": SAVED_PRESET,
        "source": "", "created": "2026-07-26", "archived": False,
        "state": "new", "streak": 0, "lapses": 0,
        "last_rating": None, "last_seen": None, "due": None, "notes": "", "attempts": [],
    }
    db["queues"]["catalog"] = {
        "label": "Catalog", "algorithm": "newest-first",
        "members": ["CAT-00", "CAT-01"],
        "order": [], "status": "active", "agent_assisted": True,
        "agent_instructions": "Free creation, not practice.",
        "created": "2026-07-26", "deadline": None, "notes": "",
    }
    path = tmp_path / "db.json"
    store.save(db, path)
    return path


@pytest.fixture()
def serving(catalog_db):
    httpd = make_server(db_path=catalog_db, host="127.0.0.1", port=0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()
    httpd.server_close()


def payload_of(html: str) -> dict:
    match = re.search(r"const ETUDE = (\{.*?\});", html, re.S)
    assert match, "the rendered widget must carry an inline payload"
    return json.loads(
        match.group(1).replace("\\u003c", "<").replace("\\u003e", ">").replace("\\u0026", "&")
    )


# --------------------------------------------------------------- template


def test_declares_both_injection_markers_exactly_once(template):
    assert template.count("/*__THEME__*/") == 1
    assert template.count("/*__DATA__*/null") == 1
    assert "const ETUDE = /*__DATA__*/null;" in template


def test_body_is_transparent_natural_height_and_never_scrolls(template):
    assert "<body data-fit-content>" in template
    assert re.search(r"html, body \{[^}]*overflow-y: hidden", template)
    body_rule = re.search(r"\bbody \{[^}]*\}", template)
    assert body_rule and "background" not in body_rule.group(0)
    assert "min-height: 100%" not in template


def test_uses_semantic_tokens_and_no_literal_colors(template):
    style = re.search(r"<style>.*?</style>", template, re.S)
    assert style
    assert not re.search(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(", style.group(0))


def test_opts_into_no_vendored_library(template):
    # The synth is hand-written; catalog must not pull KaTeX or CodeMirror.
    assert "/*__KATEX__*/" not in template
    assert "/*__CODEMIRROR__*/" not in template


def test_never_posts_an_attempt(template):
    """Free play is not graded. A POST to /api/attempts here would write a
    rating for music the user merely improvised."""
    # Checked against code, not prose: the template's comments may name the
    # attempts route to explain why it is deliberately not used.
    code = re.sub(r"/\*.*?\*/|//[^\n]*", "", template, flags=re.S)
    assert "/api/attempts" not in code
    assert "/api/inbox" in code


def test_playable_without_a_midi_device(template):
    # The keyboard and pads are real buttons, so the instrument works by mouse
    # and keyboard before any controller is connected.
    assert 'button.type = \'button\'' in template
    assert "pointerdown" in template and "keydown" in template
    assert "requestMIDIAccess" in template


def test_pitch_bend_and_control_change_are_handled(template):
    # 0xb0 is CC (the knobs) and 0xe0 is pitch bend; a MIDI instrument that
    # ignores them silently drops half the controller's surface.
    assert "0xb0" in template
    assert "0xe0" in template


# ---------------------------------------------------------------- serving


def test_opens_blank_with_no_atom(serving):
    """The instrument is not a drill: it must open with nothing loaded."""
    html = urlopen(f"{serving}/widgets/catalog?queue=catalog").read().decode("utf-8")
    payload = payload_of(html)
    assert payload["template"] == "catalog"
    assert payload["atom"] is None
    assert payload["queue"] == "catalog"


def test_lists_saved_material_but_not_the_anchor(serving):
    html = urlopen(f"{serving}/widgets/catalog?queue=catalog").read().decode("utf-8")
    payload = payload_of(html)
    ids = [item["id"] for item in payload["library"]]
    assert ids == ["CAT-01"], "only preset/recording members are saved material"
    assert payload["anchor"] == "CAT-00"


def test_reloads_a_saved_preset(serving):
    html = urlopen(f"{serving}/widgets/catalog?atom=CAT-01&queue=catalog").read().decode("utf-8")
    payload = payload_of(html)
    assert payload["atom"]["id"] == "CAT-01"
    assert payload["atom"]["widget_data"]["preset"]["timbre"] == "warm"
    assert payload["atom"]["widget_data"]["preset"]["cc"] == {"70": "reverb"}


def test_never_exposes_agent_prompt(serving):
    html = urlopen(f"{serving}/widgets/catalog?atom=CAT-01&queue=catalog").read().decode("utf-8")
    payload = payload_of(html)
    assert "agent_prompt" not in payload["atom"]
    assert "Saved sound preset" not in html


def test_offers_a_top_level_url_for_the_midi_permission_gate(serving):
    """Web MIDI is permissions-policy gated, so a blocked frame must be able to
    point the user at the same instrument opened top-level."""
    html = urlopen(f"{serving}/widgets/catalog?queue=catalog").read().decode("utf-8")
    assert payload_of(html)["self_url"].endswith("/widgets/catalog?queue=catalog")


def test_rejects_an_unknown_queue(serving):
    with pytest.raises(HTTPError) as error:
        urlopen(f"{serving}/widgets/catalog?queue=nope")
    assert error.value.code == 400


def test_rejects_an_unknown_atom(serving):
    with pytest.raises(HTTPError) as error:
        urlopen(f"{serving}/widgets/catalog?atom=NOPE-1")
    assert error.value.code == 400
