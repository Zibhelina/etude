"""Contract tests for the hotspot-select widget template.

The template is a self-contained answer surface: the learner clicks (or
keyboard-activates) labelled regions of a diagram and sends the selection to
the Etude inbox. These tests read the template source, because the template
must satisfy its contract before a browser ever renders it.
"""

import re
from pathlib import Path

import pytest

TEMPLATE_PATH = Path(__file__).parents[1] / "widgets" / "templates" / "hotspot-select.html"


@pytest.fixture(scope="module")
def template() -> str:
    assert TEMPLATE_PATH.exists(), f"{TEMPLATE_PATH.name} must exist"
    return TEMPLATE_PATH.read_text()


def test_template_declares_both_injection_markers_exactly_once(template):
    """The server injects the theme and the payload by marker. A missing or
    duplicated marker means the widget renders unthemed or with stale data."""
    assert template.count("/*__THEME__*/") == 1
    assert template.count("/*__DATA__*/null") == 1
    assert "const ETUDE = /*__DATA__*/null;" in template
    # Vendored libraries are opt-in per template; this one needs neither.
    assert "/*__KATEX__*/" not in template
    assert "/*__CODEMIRROR__*/" not in template


def test_body_is_transparent_natural_height_and_never_scrolls_vertically(template):
    """The widget sits on the Lotus chat canvas: an opaque body paints a block
    around the card, and a fixed height leaves dead space under it."""
    assert "<body data-fit-content>" in template
    assert 'name="color-scheme"' in template
    body_rule = re.search(r"\bbody \{[^}]*\}", template)
    assert body_rule and "background" not in body_rule.group(0)
    html_body = re.findall(r"html, body \{([^}]*)\}", template)
    assert any("overflow-y: hidden" in rule for rule in html_body)
    assert "min-height: 100%" not in template


def test_all_colors_come_from_semantic_tokens(template):
    """Switching themes must restyle the widget; a literal color would survive
    the theme and break contrast in the other mode."""
    style = re.search(r"<style>.*?</style>", template, re.S)
    assert style, "template must declare a style block"
    literal = re.search(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(", style.group(0))
    assert not literal, f"hardcoded color {literal.group(0) if literal else ''}"
    assert "var(--surface-" in template and "var(--text-" in template
    for pattern in (r"(?:linear|radial|conic)-gradient", r"box-shadow\s*:", r"filter\s*:[^;]*blur"):
        assert not re.search(pattern, template, re.I), f"forbidden decoration {pattern}"
    assert re.search(r'class="[^"]*\bui-', template), "must compose shared shadcn primitives"


def test_renders_every_supported_region_geometry(template):
    """widget_data regions carry one of four geometries. A geometry the
    template cannot draw would silently disappear from the diagram."""
    for geometry in ("path", "rect", "circle", "polygon"):
        assert f"'{geometry}'" in template or f'"{geometry}"' in template, geometry
    assert "createElementNS" in template
    assert "http://www.w3.org/2000/svg" in template
    # Geometry attributes are set from public config, not hardcoded shapes.
    for attribute in ("'d'", "'x'", "'y'", "'width'", "'height'", "'cx'", "'cy'", "'r'", "'points'"):
        assert attribute in template, attribute
    assert "view_box" in template, "the diagram frame comes from widget_data.view_box"
    assert "image" in template and "preserveAspectRatio" in template, (
        "an optional data-URL image must be drawn behind the regions"
    )


def test_supports_single_and_multiple_selection_modes(template):
    """`multiple` defaults to true; a single-select atom must replace the
    previous choice instead of accumulating answers."""
    assert "multiple" in template
    assert re.search(r"multiple[^\n]*!==\s*false|multiple\s*===\s*false", template), (
        "multiple must default to true when the key is absent"
    )
    assert "radio" in template and "checkbox" in template, (
        "the ARIA role must follow the selection mode"
    )


def test_regions_are_operable_by_pointer_and_by_keyboard(template):
    """Every action works by keyboard with a visible focus ring, and touch
    targets stay large enough to hit."""
    assert "'Enter'" in template and "' '" in template
    assert "tabindex" in template
    assert ":focus-visible" in template
    assert "prefers-reduced-motion" in template
    assert "touch-action" in template, "touch drags must not scroll the host"
    assert re.search(r"min-height:\s*4[0-9]px|min-height:\s*4[4-9]px", template), (
        "controls need at least a 40px touch target"
    )


def test_selection_state_is_exposed_to_assistive_technology(template):
    """Color alone cannot carry state: the region reports its own checked
    state and the live region announces what changed."""
    assert "aria-checked" in template
    assert 'aria-live="polite"' in template
    assert "aria-label" in template
    assert "data-selected" in template


def test_regions_and_legend_share_visible_number_markers(template):
    """Anonymous diagram shapes need a visible mapping to their labelled pills."""
    assert "getBBox" in template
    assert "region.index" in template
    assert "legendIndex" in template
    assert re.search(r"class[^\n]*pin", template)


def test_chips_clear_and_submit_are_separate_explicit_controls(template):
    """The learner removes one selection with its chip, clears everything, and
    submits only on an explicit action — never on every click."""
    assert 'id="chips"' in template
    assert 'id="clear"' in template
    assert 'id="submit"' in template
    submit_handler = re.search(
        r"\$\('submit'\)\.addEventListener\('click'.*?\n  \}\);", template, re.S
    )
    assert submit_handler, "submit must be driven by an explicit click handler"
    assert "/api/inbox" in submit_handler.group(0), "only submit posts to the inbox"
    assert template.count("/api/inbox") == 1, "no other interaction may post an answer"


def test_submission_posts_the_structured_payload_and_notifies_lotus(template):
    """The agent grades from the inbox item, so the payload carries stable IDs
    and human-readable labels, and the Lotus message names the atom."""
    assert "'hotspot-select'" in template
    for key in ("kind:", "ids", "labels", "count"):
        assert key in template, key
    assert "atom_id" in template and "new Date().toISOString()" in template
    assert "lotus: 1" in template and "type: 'submit'" in template
    assert "window.parent.postMessage" in template
    message = re.search(r"text: `([^`]*)`", template)
    assert message, "the Lotus message must be a template literal naming the atom"
    body = message.group(1)
    assert "${atomId}" in body or "${atom" in body, "the message must name the atom"
    for instruction in ("inbox", "grade", "record", "clear"):
        assert instruction in body.lower(), f"the agent must be told to {instruction}"


def test_unsent_work_survives_a_failed_post(template):
    """A network failure must not discard the selection: the learner keeps
    their work and can retry."""
    failure = re.search(r"\} catch \{(.*?)\}", template, re.S)
    assert failure, "the POST must be wrapped in a try/catch"
    handled = failure.group(1)
    assert "disabled = false" in handled, "submit must become available again"
    assert "selected.clear()" not in handled, "a failure must not drop the selection"
    assert "setStatus" in handled, "the learner must be told what happened"


def test_chrome_is_localized_for_portuguese_and_english(template):
    """Chrome follows the atom's language, inferred from its prompt and topic."""
    assert "portuguese" in template.lower()
    assert "pt-BR" in template
    assert "Enviar" in template and "Limpar" in template
    assert "Send to agent" in template and "Clear" in template


def test_missing_or_invalid_config_shows_a_calm_error_instead_of_throwing(template):
    """An atom can carry no widget_data, a malformed view_box, or regions with
    no usable geometry. The widget must stay readable and never throw."""
    assert 'id="configError"' in template
    assert "Array.isArray" in template
    assert "Number.isFinite" in template
    assert re.search(r"regions\.length\s*===\s*0|!regions\.length", template), (
        "an empty region list must be handled explicitly"
    )
    assert "disabled = true" in template, "submit stays disabled without a usable diagram"


def test_prompt_is_rendered_as_markdown_and_never_leaks_the_answer(template):
    """Prompts are markdown; dropping one into textContent shows literal **.
    The rubric never reaches the sandbox, so the template must not read it."""
    assert "window.ETUDE_MD_INTO" in template
    assert "agent_prompt" not in template
    assert "expected" not in template


def test_template_is_self_contained_with_no_remote_resources(template):
    """The widget renders offline inside the sandbox; the only network call is
    the inbox POST to the local API."""
    remote = re.findall(r'(?:src|href)="(https?:)?//[^"]*"', template)
    assert not remote, f"remote resources: {remote}"
    assert "fetch(" in template
    assert template.count("fetch(") == 1, "the inbox POST is the only request"
