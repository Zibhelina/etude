"""Focused contract for the coordinate-plane answer surface.

The learner plots points, polylines, vectors, or a region on a configurable
grid. These tests read the template as text: they pin the public data contract,
the answer payload, the interaction affordances, and the visual/accessibility
rules that the shared suite only checks generically.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

TEMPLATE_PATH = Path(__file__).parents[1] / "widgets" / "templates" / "coordinate-plane.html"


@pytest.fixture(scope="module")
def template() -> str:
    assert TEMPLATE_PATH.exists(), "widgets/templates/coordinate-plane.html must exist"
    return TEMPLATE_PATH.read_text(encoding="utf-8")


def test_template_carries_each_injection_marker_exactly_once(template):
    """The server refuses to render a template without both markers, and a
    duplicate marker would inject the theme or payload twice."""
    assert template.count("/*__THEME__*/") == 1
    assert template.count("/*__DATA__*/null") == 1
    assert template.count("const ETUDE = /*__DATA__*/null;") == 1
    # Vendored libraries are opt-in; this widget needs neither.
    assert "/*__KATEX__*/" not in template
    assert "/*__CODEMIRROR__*/" not in template


def test_body_is_transparent_natural_height_and_never_scrolls(template):
    assert "<body data-fit-content>" in template
    assert re.search(r"html, body \{[^}]*overflow-y: hidden[^}]*\}", template)
    assert "min-height: 100%" not in template
    body_rule = re.search(r"\bbody \{[^}]*\}", template)
    assert body_rule and "background" not in body_rule.group(0)


def test_styling_uses_semantic_tokens_and_no_literal_colors(template):
    assert 'name="color-scheme"' in template
    assert "var(--surface-" in template and "var(--text-" in template
    assert re.search(r'class="[^"]*\bui-', template), "must compose shared shadcn primitives"

    style = re.search(r"<style>(.*?)</style>", template, re.S)
    assert style
    css = style.group(1).replace("/*__THEME__*/", "")
    assert not re.search(r"#[0-9a-fA-F]{3,8}\b", css), "no literal hex colors"
    assert not re.search(r"\b(rgb|rgba|hsl|hsla)\(", css), "no literal color functions"
    for pattern in (r"(?:linear|radial|conic)-gradient", r"box-shadow\s*:",
                    r"(?:backdrop-)?filter\s*:[^;]*blur", r"text-transform\s*:\s*uppercase",
                    r"font-weight\s*:\s*[7-9]00"):
        assert not re.search(pattern, css, re.I), f"forbidden style: {pattern}"


def test_reads_only_public_configuration_from_widget_data(template):
    """agent_prompt and expected never reach the sandbox; the template must not
    even look for them."""
    for key in ("x_min", "x_max", "y_min", "y_max", "step", "snap", "mode", "background"):
        assert f"{key}" in template, f"widget_data.{key} must be read"
    assert "widget_data" in template
    assert "agent_prompt" not in template
    assert "expected" not in template


def test_supports_every_declared_mode(template):
    for mode in ("points", "polyline", "vector", "region"):
        assert f"'{mode}'" in template or f'"{mode}"' in template
    # Vector mode carries from/to semantics, not a bare point list.
    assert "from" in template and "to" in template
    assert re.search(r"vector\s*[:=]", template), "vector payload branch"


def test_submits_the_structured_answer_payload_to_the_inbox(template):
    assert "/api/inbox" in template
    assert "kind: 'coordinate-plane'" in template or 'kind: "coordinate-plane"' in template
    assert "atom_id" in template and "payload" in template
    assert "new Date().toISOString()" in template
    # Submission is explicit: one submit handler, no auto-post on interaction.
    assert template.count("fetch(") == 1


def test_lotus_message_names_the_atom_and_the_agent_workflow(template):
    message = re.search(r"window\.parent\.postMessage\(\{(.*?)\}, '\*'\)", template, re.S)
    assert message, "a Lotus submit message must be posted after a successful POST"
    body = message.group(1)
    assert "lotus: 1" in body
    assert "type: 'submit'" in body
    assert "atomId" in body, "the message must name the atom"
    lowered = body.lower()
    assert "inbox" in lowered and "grade" in lowered and "record" in lowered


def test_pointer_and_keyboard_editing_are_both_wired(template):
    assert "pointerdown" in template and "pointermove" in template and "pointerup" in template
    assert "keydown" in template
    for key in ("ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"):
        assert key in template, f"focused point must move with {key}"
    assert "Delete" in template or "Backspace" in template
    assert "tabindex" in template, "plotted points must be reachable by keyboard"


def test_points_are_listed_accessibly_and_individually_removable(template):
    assert re.search(r"aria-label", template)
    assert re.search(r"(Remove|Remover)", template), "each point needs a remove control"
    assert 'role="status"' in template and "aria-live" in template, "live coordinate status"
    assert ":focus-visible" in template
    assert "prefers-reduced-motion" in template


def test_grid_and_axes_render_responsively_in_svg(template):
    assert "<svg" in template
    assert "viewBox" in template
    assert "preserveAspectRatio" in template
    assert re.search(r"svg \{[^}]*width: 100%", template), "the plane must scale to its container"


def test_interaction_hint_is_not_duplicated_when_the_plane_is_empty(template):
    assert "$('emptyHint').textContent = points.length ? '' : ui.hints[mode]" not in template


def test_coordinate_readout_is_hidden_until_a_point_exists(template):
    assert "$('readout').classList.toggle('hidden', points.length === 0)" in template


def test_coordinates_are_clamped_snapped_and_rounded(template):
    assert "Math.min" in template and "Math.max" in template, "clamp to bounds"
    assert "Math.round" in template, "round to meaningful precision"
    assert re.search(r"\bsnap\b", template)


def test_invalid_configuration_shows_a_calm_error_instead_of_throwing(template):
    """A malformed or missing widget_data must degrade to a readable message;
    an exception would leave the learner staring at a blank card."""
    assert re.search(r"Number\.isFinite", template), "bounds must be validated numerically"
    assert re.search(r"configError|configIssue|invalidConfig", template), (
        "an explicit invalid-configuration branch is required"
    )
    assert "try {" in template


def test_chrome_is_available_in_portuguese_and_english(template):
    assert "portuguese" in template.lower()
    assert "pt-BR" in template
    for word in ("Enviar", "Limpar", "Send", "Clear"):
        assert word in template, f"missing chrome word: {word}"


def test_prompt_is_rendered_as_markdown_not_raw_text(template):
    assert "window.ETUDE_MD_INTO" in template
    for match in re.finditer(r"^\s*\w+\.textContent = ([^;]*user_prompt[^;]*);", template, re.M):
        assert re.search(r"\b(plain|firstLine|stripMarkdown)\s*\(", match.group(1))
