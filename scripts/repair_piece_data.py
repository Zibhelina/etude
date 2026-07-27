"""Repair timing defects in midi-rhythm atom data.

The pieces were captured from performance MIDI and never quantized, which
produces exactly the three symptoms the user reported:

  "muito lento / gap que nao deveria ter"  <- onsets off the beat grid, so notes
                                              land a few ms early or late and the
                                              pulse reads as uneven
  "overlap de uma nota na outra"           <- a note still sounding when the next
                                              begins; in a single-hand part that
                                              is a merged second voice, not music
  repeated note swallowed                  <- note ends exactly where the next
                                              starts, so the release kills it

This module fixes the mechanical defects only. It never invents pitches and
never transposes: wrong NOTES are a content problem that needs a score, not a
script. What it does:

  1. quantize onsets and durations to a musical grid (default 1/4 beat)
  2. clip a note that runs into the next onset of the SAME pitch, leaving a
     small gap so the repeat re-articulates
  3. for a single-voice part, clip any note that overlaps the next onset at all
  4. drop zero/negative-length notes left behind by clipping

Everything is reported, so a caller can see what changed rather than trusting it.
"""

from __future__ import annotations

import json
from typing import Any

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def pitch_number(value: Any) -> int:
    """Accept a MIDI number or a scientific name (C4, F#3, Bb5), as the widget does."""
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    step = text[0].upper()
    index = 1
    semitone = NAMES.index(step)
    while index < len(text) and text[index] in "#b":
        semitone += 1 if text[index] == "#" else -1
        index += 1
    octave = int(text[index:])
    return (octave + 1) * 12 + semitone


def snap(value: float, grid: float) -> float:
    return round(value / grid) * grid


def repair(
    notes: list[dict],
    grid: float = 0.25,
    min_gap: float = 0.06,
    monophonic: bool = True,
) -> tuple[list[dict], dict]:
    """Return (repaired notes, report). `grid` and `min_gap` are in beats."""
    report = {
        "input": len(notes),
        "onsets_snapped": 0,
        "durations_snapped": 0,
        "repeat_gaps_opened": 0,
        "overlaps_clipped": 0,
        "dropped": 0,
    }
    if not notes:
        return [], report

    work = []
    for note in notes:
        start = float(note["time"])
        length = float(note["duration"])
        snapped_start = snap(start, grid)
        # A duration never rounds to nothing: the shortest real note is one grid
        # unit, and snapping a 0.215 grace note to 0 would delete it.
        snapped_len = max(grid, snap(length, grid))
        if abs(snapped_start - start) > 1e-9:
            report["onsets_snapped"] += 1
        if abs(snapped_len - length) > 1e-9:
            report["durations_snapped"] += 1
        entry = dict(note)
        entry["time"] = round(snapped_start, 6)
        entry["duration"] = round(snapped_len, 6)
        work.append(entry)

    work.sort(key=lambda n: (n["time"], pitch_number(n["pitch"])))

    # Deduplicate: quantizing can collapse two jittered strikes of the same
    # pitch onto one onset. Keep the longer of the two — the second is a capture
    # artefact, not a note anybody plays.
    deduped = []
    for note in work:
        twin = next(
            (
                other
                for other in deduped
                if abs(other["time"] - note["time"]) < 1e-9
                and pitch_number(other["pitch"]) == pitch_number(note["pitch"])
            ),
            None,
        )
        if twin is None:
            deduped.append(note)
            continue
        twin["duration"] = max(twin["duration"], note["duration"])
        report["dropped"] += 1
    work = deduped

    # A single-hand part is one voice: a note overlapping the next onset is a
    # merged second voice and reads as mud on a keyboard drill. Done BEFORE the
    # repeat pass, because clipping to the next onset is what creates the
    # end==next-start collisions the repeat pass exists to open up.
    if monophonic:
        for i in range(len(work) - 1):
            note, nxt = work[i], work[i + 1]
            if nxt["time"] <= note["time"] + 1e-9:
                continue                      # a real chord; leave it alone
            end = note["time"] + note["duration"]
            if end > nxt["time"] + 1e-9:
                note["duration"] = round(max(grid / 2, nxt["time"] - note["time"]), 6)
                report["overlaps_clipped"] += 1

    # Finally open a gap before any repeat of the same pitch. This runs last so
    # it also catches the collisions the clip above just produced: a note ending
    # exactly where its twin begins is the case where the release timer silences
    # the second strike.
    for i, note in enumerate(work):
        here = pitch_number(note["pitch"])
        end = note["time"] + note["duration"]
        for later in work[i + 1:]:
            if later["time"] > end + 1e-9:
                break
            if pitch_number(later["pitch"]) == here:
                new_len = later["time"] - note["time"] - min_gap
                note["duration"] = round(max(grid / 2, new_len), 6)
                report["repeat_gaps_opened"] += 1
                break

    out = [n for n in work if n["duration"] > 1e-6]
    report["dropped"] = len(work) - len(out)
    report["output"] = len(out)
    return out, report


def describe(notes: list[dict]) -> dict:
    """Structural summary, for before/after comparison."""
    if not notes:
        return {"n": 0}
    events = []
    for note in notes:
        events.append((note["time"], 1))
        events.append((note["time"] + note["duration"], -1))
    events.sort()
    current = peak = 0
    for _, delta in events:
        current += delta
        peak = max(peak, current)
    ordered = sorted(notes, key=lambda n: n["time"])
    overlaps = sum(
        1
        for i in range(len(ordered) - 1)
        if ordered[i + 1]["time"] < ordered[i]["time"] + ordered[i]["duration"] - 1e-9
    )
    off_grid = sum(1 for n in notes if abs(round(n["time"] * 4) - n["time"] * 4) > 1e-6)
    zero_gap_repeats = 0
    for i in range(len(ordered) - 1):
        if pitch_number(ordered[i]["pitch"]) == pitch_number(ordered[i + 1]["pitch"]):
            end = ordered[i]["time"] + ordered[i]["duration"]
            if abs(end - ordered[i + 1]["time"]) < 1e-9:
                zero_gap_repeats += 1
    return {
        "n": len(notes),
        "max_polyphony": peak,
        "overlaps": overlaps,
        "off_grid_onsets": off_grid,
        "zero_gap_repeats": zero_gap_repeats,
    }


if __name__ == "__main__":
    import sys

    data = json.load(sys.stdin)
    fixed, rep = repair(data["notes"], monophonic=data.get("monophonic", True))
    print(json.dumps({"notes": fixed, "report": rep}, ensure_ascii=False))
