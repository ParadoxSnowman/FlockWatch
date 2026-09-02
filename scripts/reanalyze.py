#!/usr/bin/env python3
"""Recompute stance and text-reuse fields from stored data. No network.

Useful when a threshold in analysis.py changes: rerun this instead of waiting
for the hourly collector, and diff the result to see exactly which groupings
the change added or removed.

    python3 scripts/reanalyze.py            # rewrite data/live.json
    python3 scripts/reanalyze.py --dry-run  # report only
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analysis import analyze  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    live = DATA / "live.json"
    items = json.loads(live.read_text())

    before_groups = Counter(i.get("reuse_group") for i in items if i.get("reuse_group"))
    findings = analyze(items)
    after_groups = Counter(i.get("reuse_group") for i in items if i.get("reuse_group"))
    stances = Counter(i.get("stance", "unset") for i in items)

    print(f"items                 {len(items)}")
    print(f"long enough to compare{findings['analyzed']:>5}")
    print(f"reuse groups          {findings['reuse_groups']} (was {len(before_groups)})")
    print(f"syndication groups    {findings['syndication_groups']}")
    print(f"stance                {dict(stances)}")

    for group_id in after_groups:
        members = [i for i in items if i.get("reuse_group") == group_id]
        passage = next((m.get("shared_passage") for m in members if m.get("shared_passage")), "")
        print(f"\n  {group_id} · {len(members)} items · {members[0].get('reuse_kind')}")
        for member in members:
            print(f"    - {member.get('publisher', '?')}: {member.get('title', '')[:70]}")
        if passage:
            print(f'    shared: "{passage[:150]}"')

    if dry_run:
        print("\ndry run, nothing written")
        return 0

    live.write_text(json.dumps(items, indent=2, ensure_ascii=False) + "\n")

    status_path = DATA / "status.json"
    try:
        status = json.loads(status_path.read_text())
    except (OSError, ValueError):
        status = {}
    status.update(
        {
            "signals_retained": len(items),
            "stance_counts": dict(stances),
            "reuse_groups": findings["reuse_groups"],
            "syndication_groups": findings["syndication_groups"],
            "reuse_window_words": findings["shingle_default"],
            "bodies_captured": sum(1 for i in items if i.get("body_text")),
        }
    )
    status_path.write_text(json.dumps(status, indent=2) + "\n")
    print("\nwrote data/live.json and data/status.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
