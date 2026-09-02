#!/usr/bin/env python3
"""Does promotional output rise when removal pressure rises?

The claim this supports is a timing claim, so it needs a time series rather
than a feed. Three things make the difference between a defensible chart and
a misleading one, and all three are enforced here.

1. Share, computed only over a stance-neutral sample.
   If Flock is simply in the news more, promotional items rise, critical items
   rise, and a raw promotional line goes up while nothing interesting has
   happened. The headline series is therefore promotional items as a share of
   Flock coverage in the same bucket.

   But a share is only meaningful if the sample was not selected on stance.
   Most of the collector's queries search explicitly for promotional or for
   critical material, so pooling them measures the query mix rather than the
   world: adding two promotional queries would lift the "share" with nothing
   having changed. The rate is therefore computed only over items found by
   baseline_queries, which contain no stance words. Stance-selecting queries
   still find items for the lanes, the event log and the leads; they are simply
   barred from the denominator.

2. A backfill guard.
   A monitor that started last month will always show an upward slope, because
   search indexes surface recent material and let older material decay. That is
   an artifact of the instrument, not a fact about the world. Every bucket
   before continuous monitoring began is marked backfill, excluded from every
   statistic, and shaded in the chart. Without this the tool would manufacture
   a hockey stick on day one and every conclusion drawn from it would be wrong.

3. Local windows, not a national aggregate.
   "Promotional coverage nationally went up in a month when opposition
   nationally went up" is weak: both track deployment growth. The stronger and
   more falsifiable version is local. When a specific council takes up removal,
   does promotional output in that jurisdiction rise in the following weeks
   relative to that jurisdiction's own prior baseline? That is what
   event_response measures, and it reports "insufficient evidence" rather than
   a number when there are too few events to support one.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

MIN_EVENTS_FOR_RESPONSE = 3
MIN_BUCKET_ITEMS = 3
DEFAULT_WINDOW_DAYS = 30


def parse_time(value, fallback=None):
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError):
        return fallback or datetime.now(timezone.utc)


def week_start(moment: datetime) -> datetime:
    day = moment.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return day - timedelta(days=day.weekday())


def month_start(moment: datetime) -> datetime:
    day = moment.astimezone(timezone.utc)
    return datetime(day.year, day.month, 1, tzinfo=timezone.utc)


def monitoring_start(items: list[dict], declared=None) -> datetime | None:
    """When continuous collection actually began.

    first_seen is stamped the first time the collector encounters a URL, so the
    earliest first_seen is the earliest moment the monitor was demonstrably
    running. Anything published before that entered the dataset as backfill:
    the collector found it retrospectively, at whatever rate the search index
    still surfaced it, which is not a measurement of how much was published.

    A declared start recorded by the collector on its first ever run always
    wins. Inferring the start from item data is fragile: a single record whose
    first_seen was backfilled from a publication date drags the inferred start
    backwards by months and silently switches the guard off, which is the exact
    failure it exists to prevent. The declared value cannot be moved earlier by
    bad data.

    Returns None when nothing is declared and no item carries first_seen.
    Callers must treat that as "provenance unknown, nothing is comparable"
    rather than "no backfill" — the absence of a stamp is the least safe case.
    """
    if declared:
        return parse_time(declared)
    seen = [parse_time(item["first_seen"]) for item in items if item.get("first_seen")]
    return min(seen) if seen else None


def bucket_series(items: list[dict], granularity: str = "week", declared_start=None) -> list[dict]:
    """Counts per period, with promotional share and a backfill flag."""
    bucket_of = week_start if granularity == "week" else month_start
    start = monitoring_start(items, declared_start)
    buckets: dict[datetime, dict] = defaultdict(
        lambda: {"promotional": 0, "critical": 0, "mixed": 0, "neutral": 0,
                 "baseline_promotional": 0, "baseline_critical": 0, "baseline_mixed": 0,
                 "baseline_neutral": 0, "opposition_events": 0, "agency_posts": 0, "sponsored": 0}
    )

    for item in items:
        published = parse_time(item.get("published_at"))
        key = bucket_of(published)
        bucket = buckets[key]
        stance = item.get("stance", "neutral")
        bucket[stance] = bucket.get(stance, 0) + 1
        if item.get("query_set") == "baseline":
            bucket[f"baseline_{stance}"] = bucket.get(f"baseline_{stance}", 0) + 1
        if item.get("opposition_event"):
            bucket["opposition_events"] += 1
        if item.get("channel") == "agency":
            bucket["agency_posts"] += 1
        if item.get("channel") == "sponsored":
            bucket["sponsored"] += 1

    series = []
    for key in sorted(buckets):
        bucket = buckets[key]
        total = bucket["promotional"] + bucket["critical"] + bucket["mixed"] + bucket["neutral"]
        # Denominator drawn only from the stance-neutral sample.
        stance_total = (bucket["baseline_promotional"] + bucket["baseline_critical"]
                        + bucket["baseline_mixed"])
        series.append({
            "period": key.date().isoformat(),
            "total": total,
            **bucket,
            # Share is undefined on a thin bucket; two items is noise, not a rate.
            "baseline_stance_items": stance_total,
            "promotional_share": round(bucket["baseline_promotional"] / stance_total, 3) if stance_total >= MIN_BUCKET_ITEMS else None,
            # No monitoring start means no way to tell measurement from
            # retrospective discovery, so nothing is treated as comparable.
            "backfill": True if start is None else key < bucket_of(start),
        })
    return series


def comparable_series(series: list[dict]) -> list[dict]:
    return [bucket for bucket in series if not bucket["backfill"]]


def trend(series: list[dict], field: str = "promotional_share") -> dict:
    """Least-squares slope over comparable buckets only.

    Reported with the number of buckets it rests on so a slope drawn from four
    weeks is not read the same way as one drawn from a year.
    """
    points = [(index, bucket[field]) for index, bucket in enumerate(comparable_series(series))
              if bucket.get(field) is not None]
    if len(points) < 4:
        return {"status": "insufficient", "buckets": len(points),
                "note": "At least four comparable periods are needed before a direction means anything."}
    n = len(points)
    mean_x = sum(x for x, _ in points) / n
    mean_y = sum(y for _, y in points) / n
    denominator = sum((x - mean_x) ** 2 for x, _ in points)
    if denominator == 0:
        return {"status": "insufficient", "buckets": n, "note": "No variation across periods."}
    slope = sum((x - mean_x) * (y - mean_y) for x, y in points) / denominator
    return {
        "status": "ok",
        "buckets": n,
        "slope_per_period": round(slope, 4),
        "first": points[0][1],
        "last": points[-1][1],
        "direction": "rising" if slope > 0.005 else "falling" if slope < -0.005 else "flat",
    }


def jurisdiction_of(item: dict) -> str | None:
    return item.get("jurisdiction") or item.get("state") or None


def event_response(items: list[dict], window_days: int = DEFAULT_WINDOW_DAYS, declared_start=None) -> dict:
    """Promotional output after a local opposition event vs. that place's own baseline.

    For each opposition event in a jurisdiction, promotional items in that same
    jurisdiction are counted in the window after the event and in an equal
    window immediately before it. Each jurisdiction is its own control, which
    removes the deployment-growth confound that makes a national comparison
    uninformative.
    """
    start = monitoring_start(items, declared_start)
    window = timedelta(days=window_days)
    if start is None:
        return {
            "status": "insufficient",
            "events_usable": 0,
            "events_needed": MIN_EVENTS_FOR_RESPONSE,
            "window_days": window_days,
            "measured": [],
            "note": ("No collection provenance on this dataset, so a before/after window "
                     "cannot be separated from the monitor starting up."),
        }

    by_place: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        place = jurisdiction_of(item)
        if place:
            by_place[place].append(item)

    events = []
    for item in items:
        place = jurisdiction_of(item)
        when = parse_time(item.get("published_at"))
        if not item.get("opposition_event") or not place:
            continue
        # An event needs a full baseline window inside the comparable period,
        # otherwise "before" is measuring the monitor's start rather than the place.
        if start and when - window < start:
            continue
        events.append((place, when))

    measured = []
    for place, when in events:
        pool = by_place[place]
        after = sum(1 for i in pool
                    if i.get("stance") == "promotional" and when <= parse_time(i.get("published_at")) < when + window)
        before = sum(1 for i in pool
                     if i.get("stance") == "promotional" and when - window <= parse_time(i.get("published_at")) < when)
        measured.append({"jurisdiction": place, "event_date": when.date().isoformat(),
                         "before": before, "after": after, "change": after - before})

    if len(measured) < MIN_EVENTS_FOR_RESPONSE:
        return {
            "status": "insufficient",
            "events_usable": len(measured),
            "events_needed": MIN_EVENTS_FOR_RESPONSE,
            "window_days": window_days,
            "measured": measured,
            "note": ("Not enough local opposition events with a full baseline window yet. "
                     "This stays unreported rather than being estimated from one or two cases."),
        }

    total_before = sum(m["before"] for m in measured)
    total_after = sum(m["after"] for m in measured)
    rose = sum(1 for m in measured if m["change"] > 0)
    fell = sum(1 for m in measured if m["change"] < 0)
    return {
        "status": "ok",
        "events_usable": len(measured),
        "window_days": window_days,
        "promotional_before": total_before,
        "promotional_after": total_after,
        "ratio": round(total_after / total_before, 2) if total_before else None,
        "events_rose": rose,
        "events_fell": fell,
        "events_flat": len(measured) - rose - fell,
        "measured": sorted(measured, key=lambda m: m["change"], reverse=True),
    }


def summarize(items: list[dict], granularity: str = "week", window_days: int = DEFAULT_WINDOW_DAYS,
              declared_start=None) -> dict:
    series = bucket_series(items, granularity, declared_start)
    comparable = comparable_series(series)
    start = monitoring_start(items, declared_start)
    return {
        "granularity": granularity,
        "monitoring_started": start.date().isoformat() if start else None,
        "periods_total": len(series),
        "periods_comparable": len(comparable),
        "periods_backfill": len(series) - len(comparable),
        "provenance": "ok" if start else "unknown",
        "baseline_items": sum(1 for i in items if i.get("query_set") == "baseline"),
        "series": series,
        "share_trend": trend(series, "promotional_share"),
        "opposition_trend": trend(
            [{**b, "opposition_rate": b["opposition_events"]} for b in series], "opposition_rate"
        ),
        "event_response": event_response(items, window_days, declared_start),
    }
