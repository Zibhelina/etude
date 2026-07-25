"""Contract tests for the sequence-board answer surface.

The learner orders a list of items. The template must never reveal a canonical
order, must be fully operable from the keyboard, and must submit only when the
learner explicitly asks for it.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

TEMPLATE_PATH = Path(__file__).parents[1] / "widgets" / "templates" / "sequence-board.html"


@pytest.fixture(scope="module")
def template() -> str:
    assert TEMPLATE_PATH.exists(), f"{TEMPLATE_PATH} must exist"
    return TEMPLATE_PATH.read_text(encoding="utf-8")


def test_declares_both_injection_markers_exactly_once(template):
    """The server refuses to render a template without both markers, and a
    duplicate marker would inject the payload twice."""
    assert template.count("/*__THEME__*/") == 1
    assert template.count("/*__DATA__*/null") == 1
    assert "const ETUDE = /*__DATA__*/null;" in template


def test_body_is_transparent_natural_height_and_never_scrolls(template):
    """The widget sits on the Lotus canvas: it measures its own content, keeps
    the host background, and must not draw a nested scrollbar."""
    assert "<body data-fit-content>" in template
    assert re.search(r"html, body \{[^}]*overflow-y: hidden", template)
    body_rule = re.search(r"\bbody \{[^}]*\}", template)
    assert body_rule and "background" not in body_rule.group(0)
    assert "min-height: 100%" not in template


def test_uses_semantic_tokens_only(template):
    """Themes own every color. A literal color or a decorative effect would
    survive a theme switch and break the shared visual contract."""
    style = re.search(r"<style>.*?</style>", template, re.S)
    assert style
    assert not re.search(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(", style.group(0))
    assert not re.search(r"(?:linear|radial|conic)-gradient|box-shadow\s*:|blur\(", template)
    assert "var(--surface-" in template and "var(--text-" in template
    assert re.search(r'class="[^"]*\bui-', template), "must compose shared shadcn primitives"


def test_reads_items_from_widget_data_and_never_a_canonical_order(template):
    """`items` and the optional `initial_order` are the only public config. Any
    reference to an answer key would leak grading data into the sandbox."""
    assert "widget_data" in template
    assert re.search(r"\bitems\b", template)
    assert "initial_order" in template
    for forbidden in ("agent_prompt", "expected", "correct_order", "solution", "answer_key"):
        assert forbidden not in template, f"must not reference {forbidden}"


def test_supports_pointer_drag_and_keyboard_move_controls(template):
    """Dragging is the fast path; explicit Move up / Move down buttons make the
    same reordering reachable without a pointer."""
    assert "draggable" in template or "pointerdown" in template
    assert "moveBy" in template or "move(" in template
    assert re.search(r"dataset\.dir\b", template), "move buttons must carry their direction"
    assert "'up'" in template and "'down'" in template
    assert ":focus-visible" in template
    assert "prefers-reduced-motion" in template


def test_announces_positions_and_changes_to_assistive_tech(template):
    """Position is the answer, so it must be visible and spoken: a numbered
    position per row plus a polite live region for every move."""
    assert 'aria-live="polite"' in template
    assert "aria-label" in template
    assert re.search(r"\bposition\b", template, re.I)


def test_offers_reset_to_the_initial_order(template):
    assert 'id="reset"' in template
    assert "resetOrder" in template or "initialOrder" in template


def test_submits_the_structured_answer_only_on_explicit_action(template):
    """One POST, triggered by the submit button, carrying stable ids plus the
    human-readable labels the agent grades against."""
    assert "/api/inbox" in template
    assert "kind: 'sequence-board'" in template
    assert re.search(r"order:\s*\w", template)
    assert re.search(r"\blabels\b", template), "payload must carry human-readable labels"
    assert "atom_id" in template and "new Date().toISOString()" in template
    submit_handlers = re.findall(r"\$\('submit'\)\.addEventListener\('click'", template)
    assert len(submit_handlers) == 1
    assert not re.search(r"fetch\(.*\)\s*;?\s*//\s*auto", template)


def test_posts_the_lotus_message_after_a_successful_submit(template):
    """The agent only learns the attempt exists through this message; it must
    name the atom and ask for grading, recording, and inbox cleanup."""
    assert "window.parent.postMessage" in template
    assert "lotus: 1" in template and "type: 'submit'" in template
    assert re.search(r"text: ui\.lotus\(", template), "the message must be localized"

    messages = re.findall(r"lotus: \(count, atomId, list\) => `([^`]*)`", template)
    assert len(messages) == 2, "both languages need a Lotus message"
    for body in messages:
        assert "${atomId}" in body, "the message must name the atom"
        assert "${list}" in body, "the message must carry the ordering"
    english, portuguese = (m.casefold() for m in sorted(messages, key=lambda m: "Etude inbox" not in m))
    for word in ("inbox", "grade", "record", "clear"):
        assert word in english, f"English message must ask the agent to {word}"
    for word in ("inbox", "corrija", "registre", "limpe"):
        assert word in portuguese, f"Portuguese message must ask the agent to {word}"


def test_keeps_unsent_work_after_a_network_failure(template):
    """A failed POST must re-enable submit and leave the learner's ordering
    untouched, not discard it or lock the board."""
    failure = re.search(r"\} catch \{(.*?)\}", template, re.S)
    assert failure
    assert "disabled = false" in failure.group(1)
    assert "sent = true" not in failure.group(1)


def test_localizes_chrome_in_portuguese_and_english(template):
    assert "portuguese" in template
    assert "Enviar ao agente" in template and "Send to agent" in template
    assert "pt-BR" in template


def test_degrades_to_a_calm_error_state_when_config_is_missing(template):
    """A malformed atom must render an explanation, not a blank card or a
    thrown exception that leaves the iframe empty."""
    assert 'id="configError"' in template
    assert re.search(r"Array\.isArray\(", template)
    # An empty or malformed `items` must short-circuit into the notice.
    assert re.search(r"if \(!items\.(?:size|length)\)", template)
    assert re.search(r"configError'\)\.classList\.remove\('hidden'\)", template)
