"""Contract tests for the multiple-choice answer surface.

One surface, two grading modes. A deterministic item is graded by the program:
`expected` travels with the payload, the widget POSTs to `/api/attempts`, and
only then marks the options. An agent-assisted item files the selection in the
inbox and reveals nothing.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import threading
import urllib.request
from pathlib import Path
from urllib.request import urlopen

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from etude import store
from etude.server import make_server

TEMPLATE_PATH = Path(__file__).parents[1] / "widgets" / "templates" / "multiple-choice.html"

CHOICES = [
    {"id": "a", "label": "O(1)"},
    {"id": "b", "label": "O(log n)", "description": "halving each step"},
    {"id": "c", "label": "O(n)"},
    {"id": "d", "label": "O(n log n)"},
]


@pytest.fixture(scope="module")
def template() -> str:
    assert TEMPLATE_PATH.exists(), f"{TEMPLATE_PATH} must exist"
    return TEMPLATE_PATH.read_text(encoding="utf-8")


def _atom(**overrides) -> dict:
    atom = {
        "user_prompt": "Binary search on a sorted array runs in which time?",
        "agent_prompt": "Correct: b (O(log n)). Reject O(n): the search halves.",
        "expected": "b",
        "agent_assisted": False,
        "tags": ["complexity"],
        "topic": "Complexity",
        "widget_data": {"choices": CHOICES},
        "source": "", "created": "2026-07-26", "archived": False,
        "state": "new", "streak": 0, "lapses": 0,
        "last_rating": None, "last_seen": None, "due": None, "notes": "", "attempts": [],
    }
    atom.update(overrides)
    return atom


@pytest.fixture()
def mc_db(tmp_path) -> Path:
    db = store.new_db()
    db["atoms"]["MC-001"] = _atom()
    db["atoms"]["MC-002"] = _atom(
        agent_assisted=True,
        expected=None,
        widget_data={"choices": CHOICES, "multiple": True},
        user_prompt="Which of these are logarithmic?",
    )
    db["queues"]["mc"] = {
        "label": "Multiple choice", "algorithm": "oldest-first",
        "members": ["MC-001", "MC-002"], "order": [], "status": "active",
        "agent_assisted": False, "agent_instructions": "Serve through multiple-choice.",
        "created": "2026-07-26", "deadline": None, "notes": "",
    }
    path = tmp_path / "db.json"
    store.save(db, path)
    return path


@pytest.fixture()
def serving(mc_db):
    httpd = make_server(db_path=mc_db, host="127.0.0.1", port=0)
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


def test_uses_semantic_tokens_and_shared_components(template):
    style = re.search(r"<style>.*?</style>", template, re.S)
    assert style
    assert not re.search(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(", style.group(0))
    assert re.search(r'class="[^"]*\bui-', template), "must compose shared shadcn primitives"
    assert ":focus-visible" in template
    assert "prefers-reduced-motion" in template


def test_uses_no_remote_resources(template):
    assert not re.search(r"https?://", template)
    assert not re.search(r"<(?:img|script|link)[^>]*\bsrc=|<link[^>]*href=", template)


def test_never_exposes_the_rubric(template):
    assert "agent_prompt" not in template
    assert "data.notes" not in template


def test_options_carry_a_letter_key_and_a_shape_not_only_color(template):
    """A colour-blind read must still separate the picked option from the
    correct one, so every mark also has a letter, a word, and a border style."""
    assert "KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'" in template
    assert re.search(r"\.choice\[data-mark=\"missed\"\][^}]*border-style: dashed", template)
    for word in ("markCorrect", "markWrong", "markMissed"):
        assert word in template
    assert 'class="mark"' in template or "'mark'" in template
    assert "picked ? '✓' : ''" in template, "a selected option needs a glyph, not only a fill"


def test_single_and_multiple_selection_use_the_right_roles(template):
    assert "config.multiple === true" in template
    assert "multiple ? 'checkbox' : 'radio'" in template
    assert "box.setAttribute('role', multiple ? 'group' : 'radiogroup')" in template
    assert "aria-checked" in template


def test_supports_click_letter_keys_and_arrow_navigation(template):
    assert "addEventListener('click'" in template
    assert "'keydown'" in template
    assert "ArrowDown" in template and "ArrowUp" in template
    assert "KEYS.indexOf(event.key.toUpperCase())" in template


def test_accepts_bare_strings_as_well_as_option_objects(template):
    assert "typeof entry === 'string'" in template
    assert "entry && typeof entry === 'object'" in template
    assert "seen.has(id)" in template, "duplicate ids must be dropped, not rendered twice"


def test_shuffling_never_changes_the_submitted_answer(template):
    """Presentation order may shuffle; the answer string is built from the
    configured order so `expected` matches regardless of the shuffle."""
    answer = re.search(r"function answerString\(\) \{(.*?)\n  \}", template, re.S)
    assert answer
    assert "choices.filter(choice => selected.has(choice.id))" in answer.group(1)
    assert "config.shuffle === true" in template


def test_deterministic_items_post_attempts_and_assisted_items_post_inbox(template):
    assert "data.assisted !== false" in template
    assert "'/api/inbox' : '/api/attempts'" in template
    assert "body.queue = data.queue" in template
    assert "via: 'widget'" in template


def test_reveals_the_answer_only_after_a_deterministic_submit(template):
    calls = re.findall(r"\breveal\(", template)
    assert len(calls) >= 2
    reveal_body = re.search(r"function reveal\(correct\) \{(.*?)\n  \}", template, re.S)
    assert reveal_body
    body = reveal_body.group(1)
    assert "acceptedSets()" in body
    assert "resolved = true" in body
    assisted_branch = re.search(r"if \(assisted\) \{(.*?)\n      \} else \{", template, re.S)
    assert assisted_branch and "reveal(" not in assisted_branch.group(1), (
        "an agent-assisted submission must never reveal an answer"
    )


def test_keeps_the_selection_and_offers_a_retry_after_a_failed_post(template):
    failure = re.search(r"\} catch \{(.*?)\n    \}", template, re.S)
    assert failure
    assert "$('submit').disabled = false" in failure.group(1)
    assert "ui.failed" in failure.group(1)
    assert "selected.clear()" not in failure.group(1)


def test_offers_a_replay_and_a_config_error_state(template):
    assert 'id="again"' in template
    restart = re.search(r"function restart\(\) \{(.*?)\n  \}", template, re.S)
    assert restart
    for reset in ("sent = false", "resolved = false", "selected.clear()"):
        assert reset in restart.group(1)
    assert 'id="configError"' in template
    assert "if (!choices.length)" in template


def test_localizes_chrome_in_portuguese_and_english(template):
    assert "portuguese" in template
    assert "Múltipla escolha" in template and "Multiple choice" in template


# ------------------------------------------------------------ served route


def test_route_renders_a_deterministic_atom_with_its_expected_answer(serving):
    html = urlopen(f"{serving}/widgets/multiple-choice?atom=MC-001").read().decode("utf-8")
    payload = payload_of(html)
    assert payload["template"] == "multiple-choice"
    assert payload["atom"]["id"] == "MC-001"
    assert payload["atom"]["widget_data"]["choices"][1]["label"] == "O(log n)"
    assert payload["queue"] == "mc"
    assert payload["assisted"] is False
    assert payload["expected"] == "b"
    assert "agent_prompt" not in json.dumps(payload)
    assert "Reject O(n)" not in html


def test_route_hides_the_answer_from_an_agent_assisted_atom(serving):
    html = urlopen(f"{serving}/widgets/multiple-choice?atom=MC-002").read().decode("utf-8")
    payload = payload_of(html)
    assert payload["assisted"] is True
    assert "expected" not in payload
    assert payload["atom"]["widget_data"]["multiple"] is True


def test_route_rejects_an_unknown_atom(serving):
    with pytest.raises(Exception) as excinfo:
        urlopen(f"{serving}/widgets/multiple-choice?atom=NOPE-1")
    assert "400" in str(excinfo.value)


def test_deterministic_attempt_grades_the_selected_option(serving):
    def post(answer: str) -> dict:
        request = urllib.request.Request(
            f"{serving}/api/attempts",
            data=json.dumps({"atom_id": "MC-001", "answer": answer, "via": "widget",
                             "mode": "widget", "queue": "mc"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return json.loads(urllib.request.urlopen(request).read())

    assert post("b")["attempt"]["rating"] == 3
    assert post("c")["attempt"]["rating"] == 0


def test_assisted_selection_lands_in_the_inbox(serving):
    request = urllib.request.Request(
        f"{serving}/api/inbox",
        data=json.dumps({
            "atom_id": "MC-002",
            "payload": {"kind": "multiple-choice", "selected": ["b"], "labels": ["O(log n)"], "multiple": True},
            "ts": "2026-07-26T12:00:00Z",
        }).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    result = json.loads(urllib.request.urlopen(request).read())
    assert result["payload"]["kind"] == "multiple-choice"
    assert result["payload"]["selected"] == ["b"]


# --------------------------------------------------- behaviour under Node
# Selection state and the answer string are the parts that can be silently
# wrong, so the template's own script runs for real against a DOM stub.

_DOM_STUB = """
function element() {
  const node = {
    dataset: {}, classList: {add(){}, remove(){}, toggle(){}}, style: {},
    children: [], textContent: '', innerHTML: '', tabIndex: 0, disabled: false,
    type: '', className: '', hidden: false, listeners: {},
    append(...kids){ this.children.push(...kids); },
    replaceChildren(){ this.children = []; },
    addEventListener(name, fn){ this.listeners[name] = fn; },
    click(){ if (this.listeners.click) this.listeners.click(); },
    setAttribute(name, value){ this.dataset['attr_' + name] = value; },
    getAttribute(name){ return this.dataset['attr_' + name]; },
    removeAttribute(){}, focus(){},
    querySelector(){ return this.children[0] || null; },
    querySelectorAll(){ return this.children; },
    closest(){ return null; },
  };
  return node;
}
const nodes = {};
globalThis.document = {
  getElementById(id){ return nodes[id] || (nodes[id] = element()); },
  createElement(){ return element(); },
  addEventListener(){},
  activeElement: null,
};
globalThis.window = globalThis;
globalThis.ETUDE_MD_INTO = () => {};
globalThis.ETUDE_MD_HAS_LEADING_HEADING = () => false;
globalThis.posted = [];
globalThis.fetch = async (url, options) => {
  posted.push({url, body: JSON.parse(options.body)});
  return {ok: true, json: async () => ({attempt: {rating: 3}})};
};
globalThis.documentElement = {lang: 'en'};
document.documentElement = globalThis.documentElement;
"""

_CASES = """
const results = [];
function check(name, condition, detail) { results.push({name, ok: !!condition, detail: String(detail || '')}); }

const box = document.getElementById('choices');
const options = box.children;
check('renders one button per option', options.length === 4, options.length);
check('first option is keyed A', options[0].children[0].textContent === 'A', options[0].children[0].textContent);
check('description renders as a second line', options[1].children[1].children.length === 2);

// single-select replaces the previous choice
options[2].click();
check('third option is checked', options[2].getAttribute('aria-checked') === 'true');
options[1].click();
check('single select clears the previous pick', options[2].getAttribute('aria-checked') === 'false');
check('new pick is checked', options[1].getAttribute('aria-checked') === 'true');
check('submit is enabled once something is picked', document.getElementById('submit').disabled === false);

// submitting posts the configured id, not the click order or the label
await document.getElementById('submit').listeners.click();
check('one post', posted.length === 1, posted.length);
check('posts to the attempts API', posted[0].url.endsWith('/api/attempts'), posted[0].url);
check('answer is the option id', posted[0].body.answer === 'b', posted[0].body.answer);
check('carries its queue', posted[0].body.queue === 'mc', posted[0].body.queue);
check('marks the correct option', options[1].dataset.mark === 'correct', options[1].dataset.mark);
check('leaves unpicked wrong options unmarked', options[3].dataset.mark === undefined);

console.log(JSON.stringify(results));
"""


def _run_node(template: str, tmp_path: Path, etude_payload: dict, cases: str) -> list[dict]:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is required to execute the widget's selection logic")
    script = re.findall(r"<script>\n(.*?)</script>", template, re.S)
    assert script, "the template must carry its module script"
    # The payload line is supplied by the harness, not the template.
    body = script[0].replace("const ETUDE = /*__DATA__*/null;", "")
    harness = tmp_path / "harness.mjs"
    harness.write_text(
        _DOM_STUB
        + f"globalThis.ETUDE = {json.dumps(etude_payload)};\n"
        + body
        + "\n"
        + cases,
        encoding="utf-8",
    )
    process = subprocess.run([node, str(harness)], capture_output=True, text=True)
    assert process.returncode == 0, process.stderr
    return json.loads(process.stdout.strip().splitlines()[-1])


def test_selection_and_submission_behave_under_node(tmp_path, template):
    payload = {
        "api": "http://127.0.0.1:9999",
        "template": "multiple-choice",
        "queue": "mc",
        "assisted": False,
        "expected": "b",
        "atom": {"id": "MC-001", "user_prompt": "Binary search cost?", "topic": "Complexity",
                 "tags": [], "widget_data": {"choices": CHOICES}},
    }
    results = _run_node(template, tmp_path, payload, _CASES)
    failures = [row for row in results if not row["ok"]]
    assert not failures, failures
    assert len(results) >= 12


_MULTI_CASES = """
const results = [];
function check(name, condition, detail) { results.push({name, ok: !!condition, detail: String(detail || '')}); }

const options = document.getElementById('choices').children;
options[0].click();
options[2].click();
check('multi keeps both picks', options[0].getAttribute('aria-checked') === 'true'
  && options[2].getAttribute('aria-checked') === 'true');
options[0].click();
check('clicking again unselects', options[0].getAttribute('aria-checked') === 'false');
options[1].click();

await document.getElementById('submit').listeners.click();
check('assisted submission goes to the inbox', posted[0].url.endsWith('/api/inbox'), posted[0].url);
check('payload names the widget', posted[0].body.payload.kind === 'multiple-choice');
check('selection is in configured order', JSON.stringify(posted[0].body.payload.selected) === '["b","c"]',
  JSON.stringify(posted[0].body.payload.selected));
check('assisted mode reveals nothing', options[1].dataset.mark === undefined);

console.log(JSON.stringify(results));
"""


def test_multiple_selection_files_the_inbox_without_revealing(tmp_path, template):
    payload = {
        "api": "http://127.0.0.1:9999",
        "template": "multiple-choice",
        "queue": "mc",
        "assisted": True,
        "atom": {"id": "MC-002", "user_prompt": "Which are logarithmic?", "topic": "Complexity",
                 "tags": [], "widget_data": {"choices": CHOICES, "multiple": True}},
    }
    results = _run_node(template, tmp_path, payload, _MULTI_CASES)
    failures = [row for row in results if not row["ok"]]
    assert not failures, failures
