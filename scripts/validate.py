#!/usr/bin/env python3
"""Validate an etude database for CI or manual checks."""

from __future__ import annotations

import argparse
import json

from etude import schema, store


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db")
    args = parser.parse_args()
    try:
        errors, warnings = schema.validate(store.load(args.db))
        print(json.dumps({"errors": errors, "warnings": warnings}, ensure_ascii=False, separators=(",", ":")))
        return 1 if errors else 0
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
