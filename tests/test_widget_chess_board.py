"""Contract tests for the chess-board answer surface.

The learner reads one position and plays the move they believe is best. A
complete legal move submits immediately; only then does the widget reveal
Stockfish's move applied to the board.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from urllib.request import urlopen

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from etude import store
from etude.server import make_server

TEMPLATE_PATH = Path(__file__).parents[1] / "widgets" / "templates" / "chess-board.html"

ITALIAN_FEN = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"


@pytest.fixture(scope="module")
def template() -> str:
    assert TEMPLATE_PATH.exists(), f"{TEMPLATE_PATH} must exist"
    return TEMPLATE_PATH.read_text(encoding="utf-8")


@pytest.fixture()
def chess_db(tmp_path) -> Path:
    db = store.new_db()
    db["meta"]["queue_algorithms"]["chess-phase-priority"] = {
        "label": "Chess phase priority",
        "tag_rank": ["opening", "middlegame", "endgame"],
        "order": [
            {"key": "ready", "dir": "desc"},
            {"key": "tag_rank", "dir": "asc"},
            {"key": "due", "dir": "asc"},
            {"key": "mastery", "dir": "asc"},
            {"key": "id", "dir": "asc"},
        ],
    }
    db["atoms"]["CHESS-001"] = {
        "user_prompt": "Best move for White.",
        "agent_prompt": "Stockfish 18, depth 20: f1b5, cp 32.",
        "expected": "f1b5",
        "agent_assisted": False,
        "tags": ["chess", "opening", "white-to-move"],
        "topic": "Italian setup",
        "widget_data": {"fen": ITALIAN_FEN, "phase": "opening", "side_to_move": "white"},
        "source": "", "created": "2026-07-25", "archived": False,
        "state": "new", "streak": 0, "lapses": 0,
        "last_rating": None, "last_seen": None, "due": None, "notes": "", "attempts": [],
    }
    db["queues"]["chess"] = {
        "label": "Chess", "algorithm": "chess-phase-priority", "members": ["CHESS-001"],
        "order": [], "status": "active", "agent_assisted": False,
        "agent_instructions": "Serve through the chess-board widget.",
        "created": "2026-07-25", "deadline": None, "notes": "",
    }
    path = tmp_path / "db.json"
    store.save(db, path)
    return path


@pytest.fixture()
def serving(chess_db):
    httpd = make_server(db_path=chess_db, host="127.0.0.1", port=0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()
    httpd.server_close()


def payload_of(html: str) -> dict:
    match = re.search(r"const ETUDE = (\{.*?\});", html, re.S)
    assert match, "the rendered widget must carry an inline payload"
    return json.loads(match.group(1).replace("\\u003c", "<").replace("\\u003e", ">").replace("\\u0026", "&"))


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
    assert not re.search(r"(?:linear|radial|conic)-gradient|box-shadow\s*:|blur\(", template)
    assert re.search(r'class="[^"]*\bui-', template), "must compose shared shadcn primitives"
    assert ":focus-visible" in template
    assert "prefers-reduced-motion" in template


def test_uses_no_remote_resources(template):
    assert not re.search(r"https?://", template)
    assert not re.search(r"<(?:img|script|link)[^>]*\bsrc=|<link[^>]*href=", template)


def test_never_exposes_grading_material(template):
    """The board reveals `expected` only after a submitted attempt; the agent's
    rubric and engine evidence must not appear in the sandbox at all."""
    assert "agent_prompt" not in template
    assert "notes" not in template
    for forbidden in ("pv", "centipawn", "score"):
        assert f"data.{forbidden}" not in template


def test_renders_the_board_from_a_fen_with_coordinates_and_side_to_move(template):
    assert "widget_data" in template and "widgetData.fen" in template
    assert "parseFen" in template
    assert re.search(r"FILES = 'abcdefgh'", template)
    assert "coord file" in template and "coord rank" in template
    assert "whiteToMove" in template and "blackToMove" in template
    assert "phaseBadge" in template


def test_supports_click_drag_and_keyboard_move_entry(template):
    assert "addEventListener('click'" in template
    assert "pointerdown" in template and "pointerup" in template
    assert "ArrowLeft" in template and "tabIndex" in template
    assert 'role="grid"' in template and "gridcell" in template
    assert "aria-label" in template


def test_complete_legal_move_submits_immediately_without_a_check_button(template):
    assert 'id="submit"' not in template
    commit_body = re.search(r"async function commit\(move\) \{(.*?)\n  \}", template, re.S)
    assert commit_body
    assert "await submitMove(move)" in commit_body.group(1)


def test_handles_promotion_choice(template):
    assert "askPromotion" in template
    assert "['q', 'r', 'b', 'n']" in template


def test_submits_lowercase_uci_to_the_attempts_api_with_its_queue(template):
    assert "/api/attempts" in template
    assert re.search(r"uciOf = move =>.*toLowerCase\(\)", template)
    assert "atom_id: atom.id" in template
    assert "via: 'widget'" in template
    assert "body.queue = data.queue" in template
    assert re.search(r"async function submitMove\(move\)", template)


def test_keeps_the_move_and_offers_a_retry_after_a_failed_post(template):
    failure = re.search(r"if \(!ok\) \{(.*?)\n    \}", template, re.S)
    assert failure
    assert "retry" in failure.group(1)
    assert "paint(view, null)" in failure.group(1)
    assert re.search(r"unsent = body", template)


def test_reveals_the_engine_move_only_after_submitting(template):
    """`reveal` is reachable from the submit and retry paths only, and it redraws
    the original FEN with the engine move applied and both squares marked."""
    calls = re.findall(r"\breveal\(", template)
    assert len(calls) >= 2
    assert "revealed = true" in template
    reveal_body = re.search(r"function reveal\(uci\) \{(.*?)\n  \}", template, re.S)
    assert reveal_body
    body = reveal_body.group(1)
    assert "applyMove(start, engineMove)" in body
    assert "'from'" in body and "'to'" in body
    assert "ui.yourMove" in body and "ui.engineMove" in body
    assert "revealed" in re.search(r"function paint\(state, marks\) \{(.*?)\n  \}", template, re.S).group(1)


def test_offers_a_replay_after_feedback_and_a_config_error_state(template):
    assert 'id="again"' in template
    assert 'id="tryAgain"' in template
    assert "restartPuzzle" in template
    restart_body = re.search(r"function restartPuzzle\(\) \{(.*?)\n  \}", template, re.S)
    assert restart_body
    for reset in ("sent = false", "revealed = false", "chosen = null", "view = start", "replaying = true"):
        assert reset in restart_body.group(1)
    assert "reveal').classList.add('hidden')" in restart_body.group(1)
    assert "paint(view, null)" in restart_body.group(1)
    assert 'id="configError"' in template
    assert "if (!start)" in template


def test_replay_checks_the_move_without_recording_or_rescheduling_it(template):
    submit_body = re.search(r"async function submitMove\(move\) \{(.*?)\n  \}", template, re.S)
    assert submit_body
    body = submit_body.group(1)
    replay_branch = re.search(r"if \(replaying\) \{(.*?)\n    \}", body, re.S)
    assert replay_branch
    assert "reveal(uci)" in replay_branch.group(1)
    assert "postAttempt" not in replay_branch.group(1)
    assert body.index("if (replaying)") < body.index("postAttempt")


def test_localizes_chrome_in_portuguese_and_english(template):
    assert "isPortuguese" in template
    assert "Conferindo lance" in template and "Checking move" in template


# ------------------------------------------------------------ served route


def test_route_renders_the_atom_and_hides_grading_data(serving):
    html = urlopen(f"{serving}/widgets/chess-board?atom=CHESS-001").read().decode("utf-8")
    payload = payload_of(html)
    assert payload["template"] == "chess-board"
    assert payload["atom"]["id"] == "CHESS-001"
    assert payload["atom"]["widget_data"]["fen"] == ITALIAN_FEN
    assert payload["queue"] == "chess"
    assert payload["expected"] == "f1b5"
    assert "agent_prompt" not in json.dumps(payload)
    assert "Stockfish 18, depth 20" not in html


def test_route_rejects_an_unknown_atom(serving):
    with pytest.raises(Exception) as excinfo:
        urlopen(f"{serving}/widgets/chess-board?atom=NOPE-1")
    assert "400" in str(excinfo.value)


def test_deterministic_attempt_grades_the_uci_move(serving):
    import urllib.request

    request = urllib.request.Request(
        f"{serving}/api/attempts",
        data=json.dumps({"atom_id": "CHESS-001", "answer": "f1b5", "via": "widget",
                         "mode": "widget", "queue": "chess"}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    result = json.loads(urllib.request.urlopen(request).read())
    assert result["attempt"]["rating"] == 3
    assert result["attempt"]["answer"] == "f1b5"


# --------------------------------------------------- behaviour under Node
# The move applier is the part of the widget that can be silently wrong, so it
# runs for real. The template script needs a DOM, which a minimal stub provides.

_DOM_STUB = """
const listeners = {};
function element() {
  const node = {
    dataset: {}, classList: {add(){}, remove(){}, toggle(){}}, style: {},
    children: [], textContent: '', innerHTML: '', tabIndex: 0, disabled: false,
    type: '', className: '',
    append(...kids){ this.children.push(...kids); }, replaceChildren(){ this.children = []; },
    addEventListener(){}, setAttribute(){}, removeAttribute(){}, focus(){},
    querySelector(){ return element(); }, closest(){ return null; },
  };
  return node;
}
const nodes = {};
globalThis.document = {
  getElementById(id){ return nodes[id] || (nodes[id] = element()); },
  createElement(){ return element(); },
};
globalThis.window = globalThis;
globalThis.Element = function(){};
globalThis.fetch = async () => ({ok: true});
"""

_CASES = """
const chess = window.etudeChess;
const results = [];
function check(name, condition, detail) { results.push({name, ok: !!condition, detail: detail || ''}); }

// kingside castling moves the rook too
let state = chess.parseFen('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5');
let move = chess.moveFromUci(state, 'e1g1');
check('castling move is legal', move);
let after = chess.applyMove(state, move);
check('king lands on g1', after.board[chess.squareIndex('g1')] === 'K', after.board[chess.squareIndex('g1')]);
check('rook lands on f1', after.board[chess.squareIndex('f1')] === 'R', after.board[chess.squareIndex('f1')]);
check('h1 is empty', after.board[chess.squareIndex('h1')] === '');
check('white castling rights drop', !/[KQ]/.test(after.castling), after.castling);

// queenside castling
state = chess.parseFen('r3kbnr/pppqpppp/2np4/8/8/2NP1N2/PPPQPPPP/R3KB1R w KQkq - 6 6');
after = chess.applyMove(state, chess.moveFromUci(state, 'e1c1'));
check('queenside king on c1', after.board[chess.squareIndex('c1')] === 'K');
check('queenside rook on d1', after.board[chess.squareIndex('d1')] === 'R');

// en passant removes the passed pawn from its own square
state = chess.parseFen('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
move = chess.moveFromUci(state, 'e5f6');
check('en passant is legal', move);
after = chess.applyMove(state, move);
check('pawn arrives on f6', after.board[chess.squareIndex('f6')] === 'P');
check('captured pawn left f5', after.board[chess.squareIndex('f5')] === '');
check('e5 vacated', after.board[chess.squareIndex('e5')] === '');

// promotion, including underpromotion, and the uci suffix
state = chess.parseFen('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8');
const promotions = chess.legalMoves(state).filter(m => chess.uciOf(m).startsWith('d7c8'));
check('four promotion choices', promotions.length === 4, String(promotions.map(chess.uciOf)));
after = chess.applyMove(state, chess.moveFromUci(state, 'd7c8r'));
check('underpromotes to rook', after.board[chess.squareIndex('c8')] === 'R', after.board[chess.squareIndex('c8')]);
check('black to move after promotion', after.turn === 'b');

// black promotion keeps the piece black
state = chess.parseFen('8/8/8/8/8/4k3/6p1/K7 b - - 0 1');
after = chess.applyMove(state, chess.legalMoves(state).find(m => chess.uciOf(m) === 'g2g1q'));
check('black promotes to a black queen', after.board[chess.squareIndex('g1')] === 'q', after.board[chess.squareIndex('g1')]);

// illegal moves are rejected: a pinned piece may not leave the pin
state = chess.parseFen('4k3/8/8/8/8/4R3/8/4K3 b - - 0 1');
check('escaping the check is legal', !!chess.moveFromUci(state, 'e8d8'));
check('staying on the checked file is illegal', chess.moveFromUci(state, 'e8e7') === null);
state = chess.parseFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
check('a move leaving the king in check is illegal', chess.moveFromUci(state, 'a2a3') === null);

// pawn forward motion is not an attack: a king may stand directly in front of a pawn
state = chess.parseFen('k7/8/8/4p3/8/4K3/8/8 w - - 0 1');
check('pawn forward square is not treated as attacked', !!chess.moveFromUci(state, 'e3e4'));

// engine moves from the live deck all apply
const deck = JSON.parse(process.argv[2] || '[]');
for (const item of deck) {
  const position = chess.parseFen(item.fen);
  const engineMove = position && chess.moveFromUci(position, item.expected);
  check(`${item.id} ${item.expected} is legal`, !!engineMove, item.fen);
  if (engineMove) chess.applyMove(position, engineMove);
}

console.log(JSON.stringify(results));
"""


def test_move_applier_handles_castling_en_passant_and_promotion(tmp_path, template):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is required to execute the widget's move applier")
    script = re.findall(r"<script>\n(\(\(\) => \{.*?)</script>", template, re.S)
    assert script, "the template must carry its module script"
    harness = tmp_path / "harness.mjs"
    harness.write_text(
        _DOM_STUB
        + "globalThis.ETUDE = {atom: {id: 'X-1', widget_data: {fen: '"
        + ITALIAN_FEN
        + "'}}};\n"
        + script[0]
        + "\n"
        + _CASES,
        encoding="utf-8",
    )
    deck = json.dumps([{"id": "CHESS-001", "fen": ITALIAN_FEN, "expected": "f1b5"}])
    process = subprocess.run([node, str(harness), deck], capture_output=True, text=True)
    assert process.returncode == 0, process.stderr
    results = json.loads(process.stdout.strip().splitlines()[-1])
    failures = [row for row in results if not row["ok"]]
    assert not failures, failures
    assert len(results) >= 15
