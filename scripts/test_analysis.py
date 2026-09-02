#!/usr/bin/env python3
"""Checks that reuse detection separates real copy-paste from coincidence.

The failure the previous version had was grouping unrelated stories because
both used a common phrase. These cases pin that behaviour down.
"""

import sys
from datetime import datetime, timezone

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from analysis import analyze, classify_stance, longest_common_run, normalize_words

NOW = datetime(2026, 9, 1, tzinfo=timezone.utc)


def item(id_, publisher, title, body, day=1):
    return {
        "id": id_,
        "url": f"https://example.com/{id_}",
        "publisher": publisher,
        "title": title,
        "summary": body,
        "published_at": f"2026-08-{day:02d}T12:00:00Z",
    }


PRESS_RELEASE_PARAGRAPH = (
    "The department said the technology provided an investigative lead that allowed "
    "detectives to identify the vehicle involved and make an arrest a short time later. "
    "Officials said the system is one tool among many and that all searches require a "
    "documented case number before an officer may run a query."
)

INDEPENDENT_A = (
    "Officers recovered the stolen sedan on Tuesday afternoon near the interstate exit "
    "after a camera alert. The owner told reporters she had given up hope of seeing the "
    "car again. Police said within minutes of the alert a patrol unit was in the area."
)

INDEPENDENT_B = (
    "A missing woman was found safe Wednesday evening after deputies followed a series "
    "of license plate alerts across two counties. Her family thanked investigators. "
    "The sheriff said within minutes of entering the plate the search area narrowed."
)

CRITICAL_STORY = (
    "A city audit found officers ran unauthorized lookups in the license plate system "
    "without a documented case number, raising civil liberties concerns. The council "
    "voted to end the contract after the ACLU questioned whether the cameras reduced crime."
)


def run():
    failures = []

    # 1. Two stories that share a lifted press-release paragraph must group.
    reuse_items = [
        item("wtvy", "WTVY", "Cameras help detectives make arrest", PRESS_RELEASE_PARAGRAPH, 10),
        item("wlbt", "WLBT", "Arrest follows camera lead in weekend shooting", PRESS_RELEASE_PARAGRAPH, 11),
    ]
    analyze(reuse_items, now=NOW)
    if not reuse_items[0].get("reuse_group"):
        failures.append("shared press-release paragraph was not detected")
    elif reuse_items[0]["reuse_group"] != reuse_items[1]["reuse_group"]:
        failures.append("shared paragraph produced two different groups")
    else:
        passage = reuse_items[0].get("shared_passage", "")
        if "investigative lead" not in passage:
            failures.append(f"shared passage not extracted, got: {passage[:80]!r}")

    # 2. Independent stories about different events that happen to share a
    #    common phrase must NOT group. This is the old false-positive case.
    independent = [
        item("a", "KXTV", "Stolen car recovered after camera alert", INDEPENDENT_A, 12),
        item("b", "Denver7", "Missing woman found safe after plate alerts", INDEPENDENT_B, 13),
    ]
    analyze(independent, now=NOW)
    if independent[0].get("reuse_group"):
        failures.append(
            "FALSE POSITIVE: unrelated stories grouped "
            f"(containment {independent[0].get('reuse_containment')}, "
            f"passage {independent[0].get('shared_passage', '')[:60]!r})"
        )

    # 3. Transitivity: three outlets running the same copy form one lane.
    three = [
        item("x", "Station X", "Camera helps solve case", PRESS_RELEASE_PARAGRAPH, 5),
        item("y", "Station Y", "Technology aids arrest", PRESS_RELEASE_PARAGRAPH, 6),
        item("z", "Station Z", "Police credit camera network", PRESS_RELEASE_PARAGRAPH, 7),
    ]
    analyze(three, now=NOW)
    lanes = {i.get("reuse_group") for i in three}
    if len(lanes) != 1 or None in lanes:
        failures.append(f"transitivity failed, lanes={lanes}")
    if three[0].get("reuse_role") != "earliest captured":
        failures.append("earliest capture not marked on the oldest item")
    if three[0].get("reuse_kind") != "syndication":
        failures.append(f"identical copy should read as syndication, got {three[0].get('reuse_kind')}")

    # 4. Stance detection must recognise critical coverage.
    stance, promo, crit = classify_stance(CRITICAL_STORY)
    if stance != "critical":
        failures.append(f"critical story classified as {stance} (promo={promo} crit={crit})")
    stance2, _, _ = classify_stance("Police credit Flock with a success story; the chief called it a game changer.")
    if stance2 != "promotional":
        failures.append(f"promotional story classified as {stance2}")

    # 5. Boilerplate must not create matches on its own.
    boiler = [
        item("p", "Outlet P", "Unrelated story one", "Copyright 2026 Scripps Media, Inc. All rights reserved. This material may not be published. " + INDEPENDENT_A, 3),
        item("q", "Outlet Q", "Unrelated story two", "Copyright 2026 Scripps Media, Inc. All rights reserved. This material may not be published. " + INDEPENDENT_B, 4),
    ]
    analyze(boiler, now=NOW)
    if boiler[0].get("reuse_group"):
        failures.append("boilerplate alone created a false match")

    # 6. longest_common_run sanity
    run_words = longest_common_run(normalize_words("the quick brown fox jumps"), normalize_words("a quick brown fox runs"))
    if " ".join(run_words) != "quick brown fox":
        failures.append(f"longest_common_run wrong: {run_words}")

    if failures:
        print("FAILED")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("all reuse-detection checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
