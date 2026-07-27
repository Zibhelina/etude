"""Contract tests for the midi-rhythm answer surface.

The learner reads notes falling toward a hit line and plays them on a MIDI
keyboard. A wrong pitch, an early/late strike, or a missed note restarts the
run; a clean pass through the whole snippet is submitted deterministically.
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
from urllib.error import HTTPError
from urllib.request import urlopen

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from etude import store
from etude.server import make_server

TEMPLATE_PATH = Path(__file__).parents[1] / "widgets" / "templates" / "midi-rhythm.html"

# "Twinkle" opening, in beats: two C4s, two G4s, two A4s, a held G4.
TWINKLE = [
    {"pitch": "C4", "time": 0, "duration": 0.5},
    {"pitch": "C4", "time": 1, "duration": 0.5},
    {"pitch": "G4", "time": 2, "duration": 0.5},
    {"pitch": "G4", "time": 3, "duration": 0.5},
    {"pitch": "A4", "time": 4, "duration": 0.5},
    {"pitch": "A4", "time": 5, "duration": 0.5},
    {"pitch": "G4", "time": 6, "duration": 1.0},
]


@pytest.fixture(scope="module")
def template() -> str:
    assert TEMPLATE_PATH.exists(), f"{TEMPLATE_PATH} must exist"
    return TEMPLATE_PATH.read_text(encoding="utf-8")


@pytest.fixture()
def midi_db(tmp_path) -> Path:
    db = store.new_db()
    db["atoms"]["PIANO-001"] = {
        "user_prompt": "Play the opening phrase in time.",
        "agent_prompt": "Restart-on-miss drill; MPK mini, right hand only.",
        "expected": "pass",
        "agent_assisted": False,
        "tags": ["piano", "rhythm"],
        "topic": "Twinkle — opening",
        "widget_data": {"notes": TWINKLE, "tempo": 90, "unit": "beats", "tolerance_ms": 150},
        "source": "", "created": "2026-07-25", "archived": False,
        "state": "new", "streak": 0, "lapses": 0,
        "last_rating": None, "last_seen": None, "due": None, "notes": "", "attempts": [],
    }
    db["queues"]["piano"] = {
        "label": "Piano", "algorithm": "fsrs", "members": ["PIANO-001"],
        "order": [], "status": "active", "agent_assisted": False,
        "agent_instructions": "Serve through the midi-rhythm widget.",
        "created": "2026-07-25", "deadline": None, "notes": "",
    }
    path = tmp_path / "db.json"
    store.save(db, path)
    return path


@pytest.fixture()
def serving(midi_db):
    httpd = make_server(db_path=midi_db, host="127.0.0.1", port=0)
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
    assert "prefers-reduced-motion" in template


def test_uses_no_remote_resources(template):
    assert not re.search(r"https?://", template)
    assert not re.search(r"<(?:img|script|link)[^>]*\bsrc=|<link[^>]*href=", template)


def test_never_exposes_grading_material(template):
    """The drill is graded by the server against `expected`; the agent's rubric
    must never reach the sandbox."""
    assert "agent_prompt" not in template


def test_roll_height_is_fixed_so_scroll_speed_does_not_track_frame_width(template):
    """Note geometry is pixels-per-second. An aspect-ratio height would make the
    drill run faster in a wide frame and slower in a narrow one."""
    assert "PIXELS_PER_SEC" in template
    roll_rule = re.search(r"\.roll \{[^}]*\}", template)
    assert roll_rule and "aspect-ratio" not in roll_rule.group(0)
    assert re.search(r"\.roll \{[^}]*height: \d+px", template)


def test_sounds_the_played_notes_because_a_controller_makes_no_audio(template):
    """An MPK mini sends messages, not sound. Without synthesis the learner
    plays in silence, so the widget voices each note it receives."""
    assert "AudioContext" in template
    assert "createOscillator" in template
    assert "startVoice" in template and "stopVoice" in template
    # A plain oscillator reads as synthetic. A struck string needs stretched
    # partials, a continuous decay, and a hammer transient to sound like a piano.
    assert "INHARMONIC" in template and "PARTIALS" in template
    assert "createBuffer" in template, "hammer noise transient"
    # Autoplay policy: the context may only start from a user gesture.
    assert "resume()" in template
    # A toggle, so the drill stays usable when the learner has their own sound.
    assert 'id="sound"' in template and "audioOn" in template


def test_the_widget_still_runs_where_web_audio_is_unavailable(tmp_path, template):
    """The Node harness has no AudioContext at all: the timing engine must not
    depend on audio, or a sandbox without it would break the whole drill."""
    results = _run_node(
        tmp_path, template,
        {"notes": TWINKLE, "tempo": 90, "unit": "beats", "tolerance_ms": 150},
    )
    assert not [row for row in results if not row["ok"]]


def test_roll_and_keyboard_share_one_width(template):
    """They must stay the same width or a falling note stops landing on the key
    it names. Both live in `.stage`, which fills its host: an 88-key piece needs
    the whole canvas, and the roll grows taller with it so the runway (pixels per
    second of music) does not shrink as the keys spread out."""
    assert re.search(r'class="stage"', template)
    # One element sets the width for both surfaces, and it is not capped.
    stage = re.search(r"\.stage \{[^}]*\}", template, re.S)
    assert stage and "width: 100%" in stage.group(0)
    assert "max-width" not in stage.group(0), "the stage must fill its host"
    # Prose keeps its own readable measure so a wide canvas does not stretch
    # sentences across the full width.
    assert re.search(r"\.prompt[^{]*\{[^}]*max-width: \d+px", template, re.S) or \
        re.search(r"\.label, h1\.title, \.prompt[^{]*\{[^}]*max-width: \d+px", template, re.S)
    # Taller roll on a wider canvas, so reading ahead survives the extra width.
    assert re.search(r"@media \(min-width: \d+px\) \{ \.roll \{ height: \d+px", template)


def test_draws_a_beat_grid_so_timing_has_something_to_read_against(template):
    assert "beatsPerBar" in template
    assert "--roll-grid" in template and "--roll-grid-bar" in template


def test_the_due_note_is_marked_by_outline_and_not_colour_alone(template):
    """Colour-only emphasis disappears for anyone who cannot separate the two
    fills, so the due note also carries a stroke."""
    assert "isNext" in template
    outline = re.search(r"if \(isNext\) \{[^}]*stroke\(\)", template, re.S)
    assert outline, "the due note must be outlined, not just recoloured"


def test_the_keyboard_never_draws_keys_past_the_top_note_when_it_is_a_c(tmp_path, template):
    """A piece spanning exactly C3-C5 is a 25-key controller's whole range.
    Rounding the top up to the end of C5's octave drew a keyboard through B5 —
    keys the player does not physically have, inviting notes onto them."""
    span = [
        {"pitch": "C3", "time": 0, "duration": 1},
        {"pitch": "G4", "time": 1, "duration": 1},
        {"pitch": "C5", "time": 2, "duration": 1},
    ]
    results = _run_node(tmp_path, template, {"notes": span, "tempo": 90})
    by_name = {row["name"]: row for row in results}
    assert by_name["every note has a lane"]["ok"], "the required notes must be drawable"
    # Every pitch above the top C must fall outside the drawn keyboard.
    assert by_name["nothing is drawn above the top C"]["ok"], \
        by_name["nothing is drawn above the top C"]["detail"]


def test_a_miss_rewinds_to_the_section_not_the_whole_piece(template):
    """On a full-length song, restarting from bar 1 for a slip in the last bar
    trains frustration rather than the music."""
    assert "sections" in template and "firstStepOfSection" in template
    assert "resumeStep" in template and "resumeAt" in template
    assert "restartSection" in template
    # The resume offset must reach song time, or a section restart would replay
    # the whole piece silently.
    # The run's clock is anchored to the resume point (the section start), not
    # to zero. `re.S` because the expression spans lines once speed scaling is
    # folded in.
    assert re.search(r"startedAt = .*?resumeAt\(\)", template, re.S)


def test_a_note_never_overlaps_the_same_key_sounding(tmp_path, template):
    """One key cannot be held and re-struck at the same instant. A source
    arrangement that voices one pitch in two parts produces exactly that, and it
    draws as two blocks stacked on one lane — unplayable."""
    overlapping = [
        {"pitch": "C3", "time": 0, "duration": 0.5},    # anchors the drawn range
        {"pitch": "F#3", "time": 0, "duration": 2.0},   # still sounding at 1.5
        {"pitch": "F#3", "time": 1.5, "duration": 1.0},
        {"pitch": "C4", "time": 3, "duration": 0.5},
    ]
    results = _run_node(tmp_path, template, {"notes": overlapping, "tempo": 90})
    check = {row["name"]: row for row in results}["no key overlaps itself"]
    assert check["ok"], check["detail"]


def test_reverb_places_the_piece_in_a_room(template):
    """A dry piano reads as a sample; the space around the note is much of what
    makes a piece recognisable."""
    assert "createConvolver" in template and "buildImpulse" in template
    assert "widgetData.reverb" in template
    # The impulse must be synthesised: the sandbox cannot fetch an IR file.
    assert "createBuffer" in template
    # Wet must not simply add level on top of dry.
    assert re.search(r"dryBus\.gain\.value = 1 - reverbAmount", template)


def test_timbre_is_selectable_per_piece(template):
    """The same notes carry a different piece depending on the voice, so each
    song picks its own colour rather than sharing one generic piano."""
    assert "TIMBRES" in template and "widgetData.timbre" in template
    for preset in ("soft", "piano", "bright", "musicBox", "celeste", "warm"):
        assert preset in template, f"missing timbre preset: {preset}"
    # An unknown or absent name must fall back rather than break the synth.
    assert re.search(r"\.\.\.TIMBRES\.piano", template), "must default to the piano voice"
    # A tremolo LFO outlives its partials unless stopped explicitly.
    assert re.search(r"voice\.lfo[\s\S]{0,120}stop\(", template), "tremolo LFO must be stopped"


def test_offers_a_listen_mode_that_is_not_graded(template):
    """Hearing the target is part of learning it; playback must never post an
    attempt or be judged as a run."""
    assert 'id="listen"' in template
    assert "playDemo" in template and "stopDemo" in template
    demo = re.search(r"function playDemo\(\) \{.*?\n  \}", template, re.S)
    assert demo, "demo playback must exist"
    assert "postAttempt" not in demo.group(0), "listening must not record an attempt"
    assert "submit(" not in demo.group(0), "listening must not submit"


def test_names_a_midi_fallback_when_the_host_frame_blocks_web_midi(template):
    """Web MIDI is permissions-policy gated, so the widget must tell the learner
    how to reach it rather than failing silently."""
    assert "requestMIDIAccess" in template
    assert "data.self_url" in template
    assert "midiBlocked" in template


# ------------------------------------------------------------ served payload


def test_payload_carries_public_atom_data_and_a_self_url(serving):
    html = urlopen(f"{serving}/widgets/midi-rhythm?atom=PIANO-001").read().decode("utf-8")
    payload = payload_of(html)

    assert payload["template"] == "midi-rhythm"
    assert payload["atom"]["id"] == "PIANO-001"
    assert payload["atom"]["widget_data"]["tempo"] == 90
    assert len(payload["atom"]["widget_data"]["notes"]) == len(TWINKLE)
    assert payload["queue"] == "piano"
    assert "agent_prompt" not in payload["atom"]
    assert payload["self_url"].endswith("/widgets/midi-rhythm?atom=PIANO-001&queue=piano")


def test_a_bare_queue_request_serves_the_next_playable_item(serving):
    """`?queue=` alone must serve something to play. It used to fall through to
    the generic drill payload and fail with "queue must name an existing queue"
    even though the queue existed."""
    html = urlopen(f"{serving}/widgets/midi-rhythm?queue=piano").read().decode("utf-8")
    payload = payload_of(html)

    assert payload["atom"]["id"] == "PIANO-001"
    assert payload["queue"] == "piano"
    assert payload["atom"]["widget_data"]["notes"]


def test_an_atom_alone_resolves_its_own_queue(serving):
    html = urlopen(f"{serving}/widgets/midi-rhythm?atom=PIANO-001").read().decode("utf-8")
    assert payload_of(html)["queue"] == "piano"


def test_a_bare_unknown_queue_is_rejected_by_name(serving):
    with pytest.raises(HTTPError) as excinfo:
        urlopen(f"{serving}/widgets/midi-rhythm?queue=nope")
    assert excinfo.value.code == 400


def test_unknown_atom_is_rejected(serving):
    with pytest.raises(HTTPError) as excinfo:
        urlopen(f"{serving}/widgets/midi-rhythm?atom=NOPE-1")
    assert excinfo.value.code == 400


def test_a_clean_run_is_graded_deterministically_by_the_server(serving):
    request = urllib.request.Request(
        f"{serving}/api/attempts",
        data=json.dumps({"atom_id": "PIANO-001", "answer": "pass", "via": "widget",
                         "mode": "widget", "queue": "piano"}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    result = json.loads(urllib.request.urlopen(request).read())
    assert result["attempt"]["rating"] == 3
    assert result["attempt"]["via"] == "widget"


def test_a_failed_run_is_graded_wrong(serving):
    request = urllib.request.Request(
        f"{serving}/api/attempts",
        data=json.dumps({"atom_id": "PIANO-001", "answer": "fail", "via": "widget",
                         "mode": "widget", "queue": "piano"}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    result = json.loads(urllib.request.urlopen(request).read())
    assert result["attempt"]["rating"] == 0


# --------------------------------------------------- behaviour under Node
# Pitch parsing, chord grouping and the beats->seconds conversion decide whether
# a note is judged against the right moment, so they run for real.

_DOM_STUB = """
function element() {
  const node = {
    dataset: {}, classList: {add(){}, remove(){}, toggle(){}}, style: {},
    children: [], textContent: '', innerHTML: '', tabIndex: 0, disabled: false,
    value: '', type: '', className: '',
    append(...kids){ this.children.push(...kids); }, replaceChildren(){ this.children = []; },
    addEventListener(){}, setAttribute(){}, removeAttribute(){}, focus(){},
    getContext(){ return ctx; },
    getBoundingClientRect(){ return {width: 640, height: 260, top: 0, bottom: 260}; },
    querySelector(){ return element(); }, closest(){ return null; },
  };
  return node;
}
const ctx = new Proxy({}, {get: () => () => {}});
const nodes = {};
globalThis.document = {
  documentElement: element(),
  getElementById(id){ return nodes[id] || (nodes[id] = element()); },
  createElement(){ return element(); },
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.setTimeout = () => 0;
globalThis.devicePixelRatio = 1;
// Node 22 defines navigator as a getter-only global, so it is redefined rather
// than assigned. The widget only probes it for requestMIDIAccess.
Object.defineProperty(globalThis, 'navigator', {value: {}, configurable: true});
globalThis.performance = {now: () => 0};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.getComputedStyle = () => ({getPropertyValue: () => '#111111'});
globalThis.fetch = async () => ({ok: true});
"""

_CASES = """
const midi = window.etudeMidiRhythm;
const results = [];
function check(name, condition, detail) { results.push({name, ok: !!condition, detail: String(detail || '')}); }

// Scientific pitch names map onto the MIDI numbers the keyboard actually sends.
check('C4 is 60', midi.pitchOf('C4') === 60, midi.pitchOf('C4'));
check('A4 is 69', midi.pitchOf('A4') === 69, midi.pitchOf('A4'));
check('F#3 is 54', midi.pitchOf('F#3') === 54, midi.pitchOf('F#3'));
check('Bb5 is 82', midi.pitchOf('Bb5') === 82, midi.pitchOf('Bb5'));
check('raw numbers pass through', midi.pitchOf(60) === 60);
check('numeric strings parse', midi.pitchOf('72') === 72);
check('garbage is rejected', midi.pitchOf('banana') === null);
check('labels round-trip', midi.noteLabel(60) === 'C4', midi.noteLabel(60));
check('black keys label sharp', midi.noteLabel(61) === 'C#4', midi.noteLabel(61));

// Beats convert with the tempo: at 90 BPM one beat is 2/3 s, so note 2 lands there.
const second = midi.steps[1];
check('beat 1 lands at 60/90 s', Math.abs(second.at - (60 / 90)) < 1e-9, second.at);
check('all seven notes became steps', midi.steps.length === 7, midi.steps.length);
check('every step holds one note', midi.steps.every(s => s.notes.length === 1));
check('steps are chronological',
  midi.steps.every((s, i) => i === 0 || s.at >= midi.steps[i - 1].at));

// The hit window is the pass/fail boundary and is clamped into a sane range.
check('tolerance is honoured', midi.hitWindow === 150, midi.hitWindow);

// Lanes: every required pitch must map to a drawable key, or a note would fall
// onto nothing and be impossible to hit.
check('every note has a lane',
  midi.notes.every(n => midi.laneOf(n.pitch, 640) !== null));
// These probes are only meaningful when both pitches are on the drawn
// keyboard; a deck that does not span them skips the comparison rather than
// dereferencing null.
const cLane = midi.laneOf(60, 640);
const gLane = midi.laneOf(67, 640);
if (!cLane || !gLane) {
  check('C4 sits left of G4', true, 'outside this deck\\'s range');
  check('white lanes are not black', true, 'outside this deck\\'s range');
  check('a black key is narrower than a white one', true, 'outside this deck\\'s range');
}
if (cLane && gLane) {
check('C4 sits left of G4', cLane.x < gLane.x, `${cLane.x} ${gLane.x}`);
check('white lanes are not black', cLane.black === false);
const blackLane = midi.laneOf(61, 640);
check('a black key is narrower than a white one',
  !blackLane || blackLane.w < cLane.w);
}

// Accompaniment must sound alongside the graded part without becoming part of
// it: the learner is judged only on what they play.
const accompPitches = new Set(midi.accompaniment.map(n => n.pitch));
const stepPitches = new Set(midi.steps.flatMap(s => s.notes.map(n => n.pitch)));
check('accompaniment is separate from graded steps',
  midi.steps.every(s => s.notes.every(n => midi.notes.includes(n))),
  `steps=${midi.steps.length} accomp=${midi.accompaniment.length}`);
check('the graded range is narrower than the drawn range',
  midi.accompaniment.length === 0
    || (midi.playLow >= midi.rangeLow && midi.playHigh <= midi.rangeHigh
        && midi.accompaniment.every(n => !midi.inPlayRange(n.pitch) ? midi.laneOf(n.pitch, 560) !== null : true)),
  `play=${midi.playLow}..${midi.playHigh} drawn=${midi.rangeLow}..${midi.rangeHigh}`);

check('accompaniment has a lane to be drawn in',
  midi.accompaniment.every(n => midi.laneOf(n.pitch, 560) !== null),
  midi.accompaniment.map(n => `${n.pitch}:${midi.laneOf(n.pitch, 560) !== null}`).join(','));

// One key cannot be held and re-struck at once: no note may still be sounding
// when the same pitch starts again.
let selfOverlap = [];
for (let i = 0; i < midi.notes.length; i += 1) {
  const a = midi.notes[i];
  for (let j = i + 1; j < midi.notes.length; j += 1) {
    const b = midi.notes[j];
    if (b.at >= a.at + a.len - 1e-6) break;
    if (b.pitch === a.pitch) selfOverlap.push(`${a.pitch}@${a.at}`);
  }
}
check('no key overlaps itself', selfOverlap.length === 0, selfOverlap.join(','));

// The keyboard must not extend past the top note when that note is a C: those
// would be keys a 25-key controller does not have.
const top = Math.max(...midi.notes.map(n => n.pitch));
if (top % 12 === 0) {
  const above = [top + 1, top + 4, top + 11].filter(p => midi.laneOf(p, 560) !== null);
  check('nothing is drawn above the top C', above.length === 0, above.join(','));
} else {
  check('nothing is drawn above the top C', true, 'top note is not a C');
}

// Sections: a miss must rewind to the section being played, not to the top.
check('sections always start at 0', midi.sections[0].at === 0, midi.sections[0].at);
check('every step maps to a section',
  midi.sectionOfStep.length === midi.steps.length &&
  midi.sectionOfStep.every(i => i >= 0 && i < midi.sections.length));
check('sections are chronological',
  midi.sections.every((s, i) => i === 0 || s.at >= midi.sections[i - 1].at));
check('each section resolves to a real resume step',
  midi.firstStepOfSection.every(i => i >= 0 && i <= midi.steps.length));

console.log(JSON.stringify(results));
"""


def _run_node(tmp_path, template, widget_data):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is required to execute the widget's timing engine")
    script = re.findall(r"<script>\n(\(\(\) => \{.*?)</script>", template, re.S)
    assert script, "the template must carry its module script"
    harness = tmp_path / "harness.mjs"
    harness.write_text(
        _DOM_STUB
        + "globalThis.ETUDE = {atom: {id: 'PIANO-001', widget_data: "
        + json.dumps(widget_data)
        + "}};\n"
        + script[0]
        + "\n"
        + _CASES,
        encoding="utf-8",
    )
    process = subprocess.run([node, str(harness)], capture_output=True, text=True)
    assert process.returncode == 0, process.stderr
    return json.loads(process.stdout.strip().splitlines()[-1])


def test_pitch_parsing_tempo_conversion_and_lane_layout(tmp_path, template):
    results = _run_node(
        tmp_path, template,
        {"notes": TWINKLE, "tempo": 90, "unit": "beats", "tolerance_ms": 150},
    )
    failures = [row for row in results if not row["ok"]]
    assert not failures, failures
    assert len(results) >= 15


def test_every_required_note_is_drawable_even_at_the_midi_extremes(tmp_path, template):
    """`laneOf` returns null off-keyboard and the roll skips those notes, so a
    note outside the drawn range would be required but invisible — unhittable."""
    extremes = [
        {"pitch": 0, "time": 0, "duration": 1},
        {"pitch": 127, "time": 1, "duration": 1},
        {"pitch": 60, "time": 2, "duration": 1},
        {"pitch": 61, "time": 3, "duration": 1},
    ]
    results = _run_node(tmp_path, template, {"notes": extremes, "tempo": 120})
    lane_check = {row["name"]: row for row in results}["every note has a lane"]
    assert lane_check["ok"], "a required note fell outside the drawn keyboard"


def test_simultaneous_notes_group_into_one_chord_step(tmp_path, template):
    """A chord must be judged as one step: otherwise half a chord would satisfy
    the drill and the other half would register as a miss."""
    chord = [
        {"pitch": "C4", "time": 0, "duration": 1},
        {"pitch": "E4", "time": 0, "duration": 1},
        {"pitch": "G4", "time": 0, "duration": 1},
        {"pitch": "F4", "time": 2, "duration": 1},
    ]
    results = _run_node(tmp_path, template, {"notes": chord, "tempo": 90})
    by_name = {row["name"]: row for row in results}
    assert by_name["all seven notes became steps"]["detail"] == "2", "three-note chord must be one step"
    assert not by_name["every step holds one note"]["ok"], "the chord step must hold three notes"


def test_accompaniment_is_visible_on_the_keyboard(tmp_path, template):
    """Playing one hand alone loses the harmony that tells you where you are, so
    the widget fills in the other part. That part must also be *visible*: when
    the keyboard was clipped to the graded range the automatic hand played notes
    with nowhere to land (119 of Sweden's 133 backing notes vanished), so the
    learner heard a part they could not see. The backing part is drawn on its
    own keys, in its own colour, while staying out of the graded steps."""
    data = {
        "notes": [{"pitch": "C4", "time": 0, "duration": 1},
                  {"pitch": "E4", "time": 1, "duration": 1}],
        "accompaniment": [{"pitch": "C2", "time": 0, "duration": 2},
                          {"pitch": "G2", "time": 1, "duration": 1}],
        "tempo": 90,
    }
    results = _run_node(tmp_path, template, data)
    by = {row["name"]: row for row in results}
    assert by["accompaniment is separate from graded steps"]["ok"], \
        by["accompaniment is separate from graded steps"]["detail"]
    shown = by["accompaniment has a lane to be drawn in"]
    assert shown["ok"], shown["detail"]


def test_a_repeated_note_is_not_silenced_by_the_previous_one(template):
    """`voices` is keyed by pitch, so a repeated note reuses the key. Without a
    per-strike token the first note's release timer fires after the second has
    begun and silences it: the learner hears one note where the score has two.
    Every scheduled release must therefore name the instance it is releasing."""
    assert re.search(r"function stopVoice\(pitch, token\)", template)
    assert re.search(r"if \(token !== undefined && voice\.token !== token\) return", template)
    # Every timed release passes its token; a bare stopVoice(pitch) on a timer
    # is exactly the bug.
    for scheduled in re.findall(r"setTimeout\(\(\) => stopVoice\([^)]*\)", template):
        assert "token" in scheduled, f"untokened scheduled release: {scheduled}"
    for block in re.findall(r"setTimeout\(\(\) => \{\s*stopVoice\([^)]*\)", template):
        assert "token" in block, f"untokened scheduled release: {block}"


def test_the_practice_range_and_the_drawn_range_are_distinct(tmp_path, template):
    """The graded part sets what must be playable; the accompaniment may widen
    what is drawn. Collapsing the two either hides the backing part or invites
    notes onto keys the controller does not have."""
    data = {
        # The shared harness inspects steps[1], so a fixture needs two notes.
        "notes": [{"pitch": "C4", "time": 0, "duration": 1},
                  {"pitch": "E4", "time": 1, "duration": 1}],
        "accompaniment": [{"pitch": "C2", "time": 0, "duration": 1}],
        "tempo": 90,
    }
    results = _run_node(tmp_path, template, data)
    by = {row["name"]: row for row in results}
    split = by["the graded range is narrower than the drawn range"]
    assert split["ok"], split["detail"]


def test_speed_scales_the_clock_but_not_the_hit_window(template):
    """Practising slower is a change of clock rate, not of the score: note times
    stay as written and `speed` divides only where song time meets wall time.
    The hit window must NOT scale — widening the tolerance at half speed would
    flatter the learner instead of making the passage easier to play."""
    assert re.search(r'id="speed"', template), "the widget needs a speed control"
    # Every song-time -> wall-time conversion carries the factor.
    assert "* speed" in template and "/ speed" in template
    # The tolerance is computed once from widget_data and never divided by speed.
    window = re.search(r"const hitWindow = [^;]+;", template, re.S)
    assert window and "speed" not in window.group(0)


def test_one_atom_carries_both_hands(tmp_path, template):
    """A song is one card. `widget_data.hands` holds the two parts once and the
    learner picks which is graded; the other becomes the automatic hand. Three
    atoms per song instead gave one piece of music three scheduler histories."""
    data = {
        "hands": {
            "right": [{"pitch": "C5", "time": 0, "duration": 1},
                      {"pitch": "E5", "time": 1, "duration": 1}],
            "left": [{"pitch": "C3", "time": 0, "duration": 2},
                     {"pitch": "G3", "time": 2, "duration": 1}],
        },
        "tempo": 90,
    }
    # No hand requested: the whole piece is graded and nothing is automatic.
    results = _run_node(tmp_path, template, data)
    by = {row["name"]: row for row in results}
    assert by["all seven notes became steps"]["detail"] != "0"
    # The selector only appears when a piece actually has two parts to choose.
    assert 'id="handCtl"' in template
    # The server resolves ?hand=, because a sandboxed frame cannot read the query.
    assert "data.hand" in template
    # Which hand was played belongs in the recorded attempt.
    assert re.search(r"mode: hands \? `widget:\$\{hand\}", template)


def test_accompaniment_is_cancelled_on_restart(template):
    """A section restart re-schedules the backing part; without cancelling the
    previous run's timers the old take keeps playing over the new one."""
    assert "stopAccompaniment" in template and "scheduleAccompaniment" in template
    assert re.search(r"function fail\(reason\) \{\s*stopAccompaniment\(\)", template)
