#!/usr/bin/env python3
"""The timeline must be able to come back negative.

A tool that can only ever show the pattern its author expects is not evidence.
These cases pin down the refusals: backfill is excluded, thin buckets produce
no rate, too few events produce no ratio, and a dataset with no real effect
produces no effect.
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from timeline import bucket_series, comparable_series, event_response, summarize, trend

START = datetime(2026, 3, 2, tzinfo=timezone.utc)


def item(day, stance="promotional", *, first_seen_day=None, opposition=False, place=None,
         channel="news", query_set="baseline"):
    published = START + timedelta(days=day)
    seen = START + timedelta(days=first_seen_day if first_seen_day is not None else day)
    record = {
        "url": f"https://example.com/{stance}-{day}-{place}-{opposition}-{id(published) % 9999}",
        "published_at": published.isoformat().replace("+00:00", "Z"),
        "first_seen": seen.isoformat().replace("+00:00", "Z"),
        "stance": stance,
        "channel": channel,
        "query_set": query_set,
    }
    if opposition:
        record["opposition_event"] = True
    if place:
        record["jurisdiction"] = place
    return record


def run():
    failures = []

    # 1. Items published before monitoring began are backfill and excluded.
    items = [item(-60, first_seen_day=0), item(-40, first_seen_day=0), item(5), item(12), item(19), item(26)]
    series = bucket_series(items)
    if not any(b["backfill"] for b in series):
        failures.append("pre-monitoring items were not marked as backfill")
    if any(b["backfill"] for b in comparable_series(series)):
        failures.append("backfill buckets leaked into the comparable series")

    # 2. A dataset that is entirely backfill must not yield a trend.
    backfill_only = [item(-d, first_seen_day=0) for d in (10, 20, 30, 40, 50, 60)]
    result = trend(bucket_series(backfill_only))
    if result["status"] != "insufficient":
        failures.append(f"trend reported on backfill-only data: {result}")

    # 3. Thin buckets must not produce a share.
    thin = [item(1), item(40, "critical")]
    if any(b["promotional_share"] is not None for b in bucket_series(thin)):
        failures.append("a share was computed from a one- or two-item bucket")

    # 4. Rising raw counts with a FLAT share must read as flat.
    #    This is the confound that would otherwise fake the whole finding:
    #    more Flock coverage overall lifts promotional counts by itself.
    flat_share = []
    for week in range(8):
        volume = 2 + week  # coverage grows every week
        for n in range(volume):
            flat_share.append(item(week * 7 + n % 5, "promotional"))
        for n in range(volume):
            flat_share.append(item(week * 7 + n % 5, "critical"))
    direction = trend(bucket_series(flat_share))["direction"]
    if direction != "flat":
        failures.append(f"growing volume with constant ratio was read as '{direction}', not flat")

    # 5. A share that genuinely rises must be detected.
    rising = []
    for week in range(8):
        promotional = 2 + week * 2
        critical = 6
        for n in range(promotional):
            rising.append(item(week * 7 + n % 5, "promotional"))
        for n in range(critical):
            rising.append(item(week * 7 + n % 5, "critical"))
    rise = trend(bucket_series(rising))
    if rise["status"] != "ok" or rise["direction"] != "rising":
        failures.append(f"a genuinely rising share was not detected: {rise}")

    # 6. Too few local events must produce no ratio.
    sparse = [item(30, "critical", opposition=True, place="OH"), item(35, "promotional", place="OH")]
    response = event_response(sparse)
    if response["status"] != "insufficient":
        failures.append(f"a ratio was reported from {response.get('events_usable')} event(s)")

    # 7. With enough events and a real local response, it reports.
    #    Warm-up items establish an early monitoring start so every event has a
    #    complete baseline window inside the comparable period.
    local = [item(0, "neutral", place="WARMUP"), item(3, "neutral", place="WARMUP")]
    for index, place in enumerate(["OH", "TX", "CA", "GA"]):
        event_day = 90 + index * 10
        local.append(item(event_day, "critical", opposition=True, place=place))
        for n in range(1):  # quiet before
            local.append(item(event_day - 20 + n, "promotional", place=place))
        for n in range(4):  # busy after
            local.append(item(event_day + 3 + n, "promotional", place=place))
    measured = event_response(local)
    if measured["status"] != "ok":
        failures.append(f"a real local response was not reported: {measured}")
    elif not measured["ratio"] or measured["ratio"] <= 1:
        failures.append(f"local response ratio should exceed 1, got {measured['ratio']}")
    elif measured["events_rose"] != 4:
        failures.append(f"expected 4 rising events, got {measured['events_rose']}")

    # 7b. An event whose baseline window predates monitoring must be dropped,
    #     because "before" would otherwise measure the collector starting up.
    edge = [item(day, "critical", opposition=True, place=f"P{day}") for day in (5, 100, 130, 160)]
    edge += [item(day + 2, "promotional", place=f"P{day}") for day in (5, 100, 130, 160)]
    edge_result = event_response(edge)
    if edge_result["status"] == "ok" and any(m["event_date"].endswith("-03-07") for m in edge_result["measured"]):
        failures.append("an event without a full baseline window was measured anyway")

    # 7c. Items found by stance-selecting queries must not move the rate.
    #     This is the sampling trap: most queries search explicitly for
    #     promotional or for critical material, so pooling them would measure
    #     the query mix rather than what is being published. Adding critical
    #     queries would otherwise crater the "share" with nothing having changed.
    neutral_sample = []
    for week in range(6):
        for n in range(4):
            neutral_sample.append(item(week * 7 + n, "promotional", query_set="baseline"))
        for n in range(4):
            neutral_sample.append(item(week * 7 + n, "critical", query_set="baseline"))
    balanced = [b["promotional_share"] for b in bucket_series(neutral_sample) if b["promotional_share"] is not None]

    skewed = list(neutral_sample)
    for week in range(6):
        for n in range(40):  # a flood from accountability queries
            skewed.append(item(week * 7 + n % 5, "critical", query_set="accountability"))
    skewed_shares = [b["promotional_share"] for b in bucket_series(skewed) if b["promotional_share"] is not None]
    if balanced != skewed_shares:
        failures.append(
            f"stance-selected items changed the rate: {balanced[:3]} -> {skewed_shares[:3]}"
        )

    # 7d. A declared collector start must override a first_seen dragged
    #     backwards by a publication-date fallback, or the guard silently dies.
    poisoned = [item(-300, first_seen_day=-300), item(5), item(12), item(19), item(26)]
    declared = (START + timedelta(days=1)).isoformat().replace("+00:00", "Z")
    guarded = bucket_series(poisoned, declared_start=declared)
    if not any(b["backfill"] for b in guarded):
        failures.append("declared start did not re-enable the backfill guard")
    ungarded = bucket_series(poisoned)
    if sum(1 for b in ungarded if b["backfill"]) >= sum(1 for b in guarded if b["backfill"]):
        failures.append("declared start did not tighten the comparable window")

    # 8. No local effect must report a ratio near 1, not a finding.
    null = []
    for index, place in enumerate(["OH", "TX", "CA", "GA"]):
        event_day = 90 + index * 10
        null.append(item(event_day, "critical", opposition=True, place=place))
        for n in range(3):
            null.append(item(event_day - 20 + n, "promotional", place=place))
        for n in range(3):
            null.append(item(event_day + 3 + n, "promotional", place=place))
    null_result = event_response(null)
    if null_result["status"] == "ok" and null_result["ratio"] != 1.0:
        failures.append(f"a null local effect produced ratio {null_result['ratio']}, expected 1.0")

    # 9. summarize() must run end to end and carry the monitoring start date.
    full = summarize(rising + local)
    if not full["monitoring_started"]:
        failures.append("summarize did not report a monitoring start date")
    if full["periods_comparable"] < 1:
        failures.append("summarize found no comparable periods")

    if failures:
        print("FAILED")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("all timeline checks passed (including six refusal cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
