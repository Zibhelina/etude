"""Checks the store text in store/listing.md against Apple's and Google's length limits."""
import re
import sys
from pathlib import Path

text = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent.parent / "listing.md").read_text()


def block(heading: str) -> str:
    m = re.search(r"^## " + re.escape(heading) + r".*?\n```\n(.*?)\n```", text, re.S | re.M)
    if not m:
        raise SystemExit(f"missing block: {heading}")
    return m.group(1)


m = re.search(r"`(Etude[^`]*)`", text)
if not m:
    raise SystemExit("missing app name")
name = m.group(1)
checks = [
    ("App name / Play title", name, 30),
    ("Apple subtitle", block("Apple: subtitle"), 30),
    ("Apple promotional text", block("Apple: promotional text"), 170),
    ("Apple keywords", block("Apple: keywords"), 100),
    ("Play short description", block("Play: short description"), 80),
    ("Description", block("Description"), 4000),
    ("Apple What's New", block("Apple: What's New"), 4000),
    ("Play release notes", block("Play: release notes"), 500),
]
bad = 0
for label, value, limit in checks:
    n = len(value)
    ok = n <= limit
    bad += not ok
    print(f"{'ok ' if ok else 'BAD'} {label}: {n}/{limit}")
kw = block("Apple: keywords")
if ", " in kw:
    print("BAD keywords have a space after a comma")
    bad += 1
sys.exit(1 if bad else 0)
