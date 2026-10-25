#!/usr/bin/env bash
# Records the agent session shown on the website: real commands against a fresh collection, with
# their real output. Writes site/src/assets/terminal.json. The last step calls the AI grader, so it
# needs a key in ~/.etude/.env (or $ETUDE_HOME/.env) and its feedback text changes on every run.
#   site/tools/terminal.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
tmp="${TMPDIR:-/tmp}/etude-site-terminal"
rm -rf "$tmp" && mkdir -p "$tmp"
export ETUDE_DB="$tmp/etude.db"
mkdir -p "$tmp/bin"
printf '#!/bin/sh\nexec node "%s/src/cli/main.ts" --compact "$@"\n' "$root" > "$tmp/bin/etude"
chmod +x "$tmp/bin/etude"
export PATH="$tmp/bin:$PATH"

cat > "$tmp/waves.pack.json" <<'EOF'
{
  "etude": "pack/1",
  "name": "Waves",
  "decks": [{ "name": "Physics::Waves", "description": "Wave basics for the midterm." }],
  "items": [
    { "id": "waves.speed", "type": "numeric", "deck": "Physics::Waves",
      "fields": { "prompt": "A wave has frequency $f = 50$ Hz and wavelength $\\lambda = 4$ m. Its speed?", "answer": 200, "unit": "m/s" } },
    { "id": "waves.why-beats", "type": "free", "deck": "Physics::Waves",
      "fields": { "prompt": "Why do two close frequencies produce beats?",
                  "reference": "The waves drift in and out of phase, so their sum swells and fades at the difference frequency.",
                  "rubric": "Must mention phase and the difference frequency." } }
  ]
}
EOF
cd "$tmp"
steps=()
run() { # run <shown command> <real command...>
  local shown="$1"; shift
  local out; out="$("$@")"
  steps+=("$(jq -n --arg cmd "$shown" --arg out "$out" '{cmd: $cmd, out: $out}')")
}
run 'etude pack check waves.pack.json | jq .ok' sh -c "etude pack check waves.pack.json | jq .ok"
run "etude pack import waves.pack.json | jq -c '.[0].items'" sh -c "etude pack import waves.pack.json | jq -c '.[0].items'"
run "etude deck set Physics::Waves deadline=2026-11-12T09:00-08:00 | jq -c .changed" sh -c "etude deck set Physics::Waves deadline=2026-11-12T09:00-08:00 | jq -c .changed"
next="$(etude study next --deck Physics::Waves)"
seed="$(jq -r .card.seed <<<"$next")"
steps+=("$(jq -n --arg cmd "etude study next --deck Physics::Waves | jq '.card | {cardId, seed, title, answerFormat}'" --arg out "$(jq '.card | {cardId, seed, title, answerFormat}' <<<"$next")" '{cmd: $cmd, out: $out}')")
run "etude study answer 1 --seed $seed --answer '[\"200 m/s\"]' | jq '{verdict: .grade.verdict, rated}'" sh -c "etude study answer 1 --seed $seed --answer '[\"200 m/s\"]' | jq '{verdict: .grade.verdict, rated}'"
card2="$(etude study card 2)"
seed2="$(jq -r .seed <<<"$card2")"
answer='They add up and get louder and quieter.'
run "etude study submit 2 --seed $seed2 --feedback --text -a \"$answer\" | jq '{verdict: .grade.verdict, feedback}'" sh -c "etude study submit 2 --seed $seed2 --feedback --text -a '$answer' | jq '{verdict: .grade.verdict, feedback}'"
# The AI-grading sample on the page: a real proof from the showcase, graded for real.
etude pack import "$root/examples/showcase.pack.json" >/dev/null
proof='Assume it holds for $n$: $1 + \dots + n = \frac{n(n+1)}{2}$. Adding $n+1$ to both sides gives $\frac{n(n+1)}{2} + (n+1) = \frac{(n+1)(n+2)}{2}$, which is the formula for $n+1$. So it holds for every $n$.'
pcard="$(etude study card showcase.free.induction)"
etude study submit showcase.free.induction --seed "$(jq -r .seed <<<"$pcard")" --practice --feedback --text -a "$proof" \
  | jq --arg prompt "$(jq -r .view.prompt <<<"$pcard")" '{prompt: $prompt, answer, verdict: .grade.verdict, score: .grade.score, model: .grade.grader.model, ms: .grade.grader.ms, feedback}' > "$root/site/src/assets/ai-sample.json"
cat "$root/site/src/assets/ai-sample.json"
printf '%s\n' "${steps[@]}" | jq -s '{recorded: now | todate, steps: .}' > "$root/site/src/assets/terminal.json"
jq -r '.steps[] | "$ " + .cmd + "\n" + .out + "\n"' "$root/site/src/assets/terminal.json"
