"""Contract tests for the tree-explorer widget template.

The template is a search/traversal surface: the learner expands nodes in an
order that is itself the answer. These tests read the template source rather
than executing it, so they assert the contract the server and the design system
depend on — injection markers, token discipline, payload shape, accessibility
affordances, and a calm failure path when `widget_data` is missing or invalid.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

TEMPLATE = Path(__file__).parents[1] / "widgets" / "templates" / "tree-explorer.html"


@pytest.fixture(scope="module")
def source() -> str:
    assert TEMPLATE.is_file(), f"missing template: {TEMPLATE}"
    return TEMPLATE.read_text(encoding="utf-8")


def test_declares_both_injection_markers_exactly_once(source):
    """The server refuses to render a template that cannot receive the theme or
    the payload, and a duplicated marker would inject twice."""
    assert source.count("/*__THEME__*/") == 1
    assert source.count("/*__DATA__*/null") == 1
    assert "const ETUDE = /*__DATA__*/null;" in source
    # The server splits on these tags to inject the markdown helper and bridge.
    assert "</head>" in source and "</body>" in source


def test_body_is_transparent_and_sized_to_natural_content(source):
    """Lotus embeds the widget on a host surface: an opaque or pinned body
    paints a block around the card and blocks the resize bridge from shrinking."""
    assert re.search(r"<body[^>]*\sdata-fit-content", source)
    assert re.search(r"html,\s*body\s*\{[^}]*overflow-y:\s*hidden", source)
    assert not re.search(r"body\s*\{[^}]*background", source), "body must stay transparent"
    assert "min-height: 100%" not in source


def test_uses_semantic_tokens_and_no_literal_colors(source):
    """Colors, gradients, shadows and blur come from the theme contract only."""
    style = re.search(r"<style>(.*?)</style>", source, re.S).group(1)
    style = style.replace("/*__THEME__*/", "")
    assert not re.search(r"#[0-9a-fA-F]{3,8}\b", style), "no literal hex colors"
    assert not re.search(r"\brgba?\(", style), "no literal rgb colors"
    assert not re.search(r"\b(gradient|blur|box-shadow)\b", style)
    assert "var(--" in style
    assert "prefers-reduced-motion" in style


def test_composes_shared_shadcn_components(source):
    """Buttons and the card come from the shared layer, not widget-local CSS."""
    assert "ui-card" in source
    assert "ui-button" in source


def test_reads_only_public_widget_data_config(source):
    """`agent_prompt` and `expected` never reach the sandbox, so the template
    must never reference them."""
    assert "agent_prompt" not in source
    assert "expected" not in source
    for key in ("nodes", "edges", "start", "goals", "directed", "reveal_on_expand"):
        assert key in source, f"template must read widget_data.{key}"
    # Optional per-node and per-edge fields from the contract.
    for key in ("meta", "cost"):
        assert key in source


def test_submits_the_contract_answer_payload_to_the_inbox(source):
    """Answer shape is `{kind, expansion_order, labels, selected_goal?}` and it
    reaches the agent through the inbox, then a Lotus message."""
    assert "'tree-explorer'" in source or '"tree-explorer"' in source
    assert "/api/inbox" in source
    assert "expansion_order" in source
    assert "selected_goal" in source
    assert "atom_id" in source
    assert re.search(r"lotus:\s*1", source)
    assert re.search(r"type:\s*'submit'", source)
    assert "new Date().toISOString()" in source


def test_submits_only_on_explicit_action_and_keeps_work_after_failure(source):
    """A traversal is expensive to redo: a failed POST must not clear it."""
    assert re.search(r"getElementById\('submit'\)|\$\('submit'\)", source)
    submit = source[source.index("api/inbox") - 2000:]
    assert "catch" in submit, "a failed POST is caught, not thrown"
    assert re.search(r"disabled\s*=\s*false", source), "submit re-enables after failure"


def test_records_expansion_order_by_pointer_and_keyboard(source):
    """Activation is the core interaction and must work without a mouse."""
    assert "expansion" in source
    assert re.search(r"addEventListener\('click'", source)
    assert re.search(r"'Enter'", source) and re.search(r"' '|'Space'|Spacebar", source)


def test_offers_undo_and_reset(source):
    assert re.search(r"undo", source, re.I)
    assert re.search(r"reset", source, re.I)


def test_lays_out_missing_coordinates_deterministically(source):
    """Nodes may omit x/y. Layout must be computed in-template, with no library
    and no randomness, so the same config always renders the same picture."""
    assert "Math.random" not in source, "layout must be deterministic"
    assert re.search(r"\bx\b", source) and re.search(r"\by\b", source)
    assert "depth" in source or "layer" in source, "a deterministic layered layout"


def test_reveal_on_expand_starts_from_the_start_node(source):
    assert "reveal_on_expand" in source
    assert "start" in source
    assert "neighbor" in source.lower()


def test_goals_are_distinguishable_without_color(source):
    """Status never relies on color alone: goals carry a label or shape too."""
    assert "goals" in source
    assert re.search(r"goal", source, re.I)
    assert re.search(r"aria-label|aria-describedby|title=|textContent", source)


def test_nodes_are_accessible_controls_with_a_text_equivalent(source):
    """The graph is drawn, so it needs a keyboard path and a non-visual summary."""
    assert re.search(r"tabindex", source)
    assert re.search(r"role=\"img\"|role='img'|setAttribute\('role', 'img'\)", source), \
        "the drawn graph needs role=img"
    assert "aria-label" in source
    assert re.search(r"aria-live", source), "status updates are announced"


def test_chrome_is_bilingual(source):
    """Chrome follows the prompt/topic language, like the other templates."""
    assert re.search(r"portuguese|pt-BR", source, re.I)
    assert "Enviar" in source or "Limpar" in source


def test_invalid_or_missing_config_shows_a_calm_error_state(source):
    """A malformed atom must render a usable message, never an exception."""
    assert re.search(r"Array\.isArray", source), "config arrays are validated"
    assert re.search(r"try\s*\{", source), "startup is guarded"
    assert re.search(r"error|empty|invalid", source, re.I)


def test_is_self_contained_with_no_remote_resources(source):
    """No dependency may be added; the sandbox has no network besides the API."""
    assert not re.search(r"<script[^>]+\ssrc=", source)
    assert not re.search(r"<link[^>]+stylesheet", source)
    assert not re.search(r"https?://(?!127\.0\.0\.1|www\.w3\.org)", source)
