#!/usr/bin/env python3
"""Collect public Flock-related coverage signals without API keys.

This is a lead generator, not an authorship detector.

Two design rules matter more than anything else here:

1. Collect coverage that contradicts the hypothesis, not only coverage that
   supports it. The earlier version scored stories for promotional language and
   discarded everything below a threshold, so critical reporting could never
   enter the dataset. That made every derived statistic meaningless: an outlet
   with twelve promotional stories looked identical whether it had also run
   five accountability pieces or none. Stance is now recorded, not filtered.

2. Never present coincidence as coordination. Grouping is done by contiguous
   word-run overlap in scripts/analysis.py, and the shared passage is stored so
   a reader can check the claim rather than trust a score.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analysis import analyze, classify_stance  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
UA = "FlockWatch-Media-Monitor/2.0 (+public-interest research; GitHub Pages)"

RETENTION_DAYS = 400
MAX_ITEMS = 4000
ENRICH_LIMIT = 30  # full-text fetches per run
ENRICH_TIMEOUT = 12

RELEVANCE = re.compile(r"\bflock\b", re.I)

POSITIVE_PATTERNS = {
    "credits Flock": r"\bcredit(?:s|ed)?\s+flock\b",
    "within minutes": r"\bwithin\s+(?:\w+\s+)?minutes?\b|\bjust\s+\d+\s+minutes?\b",
    "success story": r"\bsuccess\s+stor(?:y|ies)\b",
    "helped locate": r"\bhelp(?:s|ed|ing)?\s+(?:police\s+)?(?:to\s+)?(?:locate|find|track|identify|capture)\b",
    "helped solve": r"\bhelp(?:s|ed|ing)?\s+(?:police\s+)?(?:to\s+)?solve\b",
    "instrumental": r"\binstrumental\b|\bcritical\s+(?:tool|lead|evidence)\b",
    "real outcomes": r"\breal\s+outcomes?\b",
    "safer community": r"\bsafer\s+(?:community|communities|future)\b",
    "recovered vehicle": r"\brecover(?:ed|y|ing)?\s+(?:a\s+)?(?:stolen\s+)?vehicle\b",
    "led to arrest": r"\b(?:led\s+to|resulted\s+in|made)\s+(?:an?\s+)?arrests?\b",
}
ORIGIN_PATTERNS = {
    "agency release cited": r"\b(?:according to|in) (?:a |the )?(?:police|department|agency|sheriff|news )?(?:release|statement)\b",
    "press-release language": r"\b(?:announced today|is proud to announce|news release|press release)\b",
    "single-source police attribution": r"\bpolice (?:say|said|credit|credited|report|reported)\b",
    "company quote": r"\bflock (?:safety )?(?:said|says|spokesperson|representative|founder|ceo)\b",
}
SPONSORED = re.compile(
    r"\b(sponsored by|presented by|paid content|brandvoice|partner content|sponsored content)\b", re.I
)
PRESS_RELEASE = re.compile(r"\b(press release|news release|globenewswire|business wire|pr newswire)\b", re.I)
WIRE_HOSTS = {"globenewswire.com", "businesswire.com", "prnewswire.com", "accesswire.com"}
SOCIAL_DOMAINS = {
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "x.com",
    "twitter.com",
    "youtube.com",
    "nextdoor.com",
}


def fetch(url: str, timeout: int = 25) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/rss+xml, application/xml, text/xml, text/html;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read(3_000_000)


def clean(value: str | None) -> str:
    text = html.unescape(value or "")
    text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_date(value: str | None) -> datetime:
    if value:
        try:
            parsed = parsedate_to_datetime(value)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                pass
    return datetime.now(timezone.utc)


def domain(url: str) -> str:
    return urllib.parse.urlparse(url).netloc.lower().removeprefix("www.")


def safe_url(url: str) -> str:
    """Only http(s) links are ever stored. Feed content is third-party input."""
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return ""
    return url if parsed.scheme in {"http", "https"} and parsed.netloc else ""


def rss_items(raw: bytes, fallback_publisher: str = "") -> list[dict]:
    root = ET.fromstring(raw)
    results = []
    for node in root.findall(".//item"):
        source = node.find("source")
        url = safe_url(clean(node.findtext("link")))
        if not url:
            continue
        results.append(
            {
                "title": clean(node.findtext("title")),
                "summary": clean(node.findtext("description")),
                "url": url,
                "published": parse_date(node.findtext("pubDate")),
                "publisher": clean(source.text if source is not None else fallback_publisher),
            }
        )
    return results


def score_text(text: str) -> tuple[int, list[str]]:
    terms = [label for label, pattern in POSITIVE_PATTERNS.items() if re.search(pattern, text, re.I)]
    return min(5, len(terms)), terms


def classify(item: dict) -> dict | None:
    combined = f"{item['title']} {item['summary']}"
    if not RELEVANCE.search(combined) and not item.get("agency_id"):
        return None

    score, terms = score_text(combined)
    stance, promotional_hits, critical_hits = classify_stance(combined)

    # Keep anything recognisably about Flock that takes a position in either
    # direction. Neutral items are kept only when they carry promotional
    # framing, which filters routine mentions without silently deleting the
    # accountability coverage the balance metrics depend on.
    if stance == "neutral" and score < 2:
        return None

    origin_indicators = [
        label for label, pattern in ORIGIN_PATTERNS.items() if re.search(pattern, combined, re.I)
    ]

    host = domain(item["url"])
    publisher = item.get("publisher") or host
    if host == "flocksafety.com" or publisher == "Flock Safety":
        channel, disclosure = "flock", "disclosed"
    elif SPONSORED.search(combined):
        channel, disclosure = "sponsored", "disclosed"
    elif PRESS_RELEASE.search(combined) or host in WIRE_HOSTS:
        channel, disclosure = "wire", "disclosed"
    elif any(host == social or host.endswith(f".{social}") for social in SOCIAL_DOMAINS):
        channel, disclosure = "agency", "editorial"
    else:
        channel, disclosure = "news", "editorial"

    fingerprint = hashlib.blake2b(f"{item['url']}|{item['title']}".encode(), digest_size=7).hexdigest()
    record = {
        "id": f"auto-{fingerprint}",
        "published_at": item["published"].astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "title": item["title"],
        "summary": item["summary"][:600],
        "publisher": publisher,
        "url": item["url"],
        "domain": host,
        "channel": channel,
        "disclosure": disclosure,
        "promotion_score": score,
        "stance": stance,
        "promotional_hits": promotional_hits,
        "critical_hits": critical_hits,
        "matched_terms": terms[:5],
        "origin_indicators": origin_indicators,
    }
    if item.get("agency_id"):
        record["agency_id"] = item["agency_id"]
    return record


def enrich_body(record: dict) -> bool:
    """Fetch article text so reuse detection sees more than a feed snippet.

    Reuse detection on a 30-word RSS description is a weak lower bound: two
    outlets can share an entire lifted paragraph that appears in neither
    snippet. Failures are swallowed on purpose. A monitor that dies because one
    newsroom blocks an unfamiliar user agent is worse than one with partial
    body coverage, and body_status records which is which.
    """
    if record.get("body_text") or record["channel"] == "agency":
        return False
    try:
        raw = fetch(record["url"], timeout=ENRICH_TIMEOUT)
        text = raw.decode("utf-8", errors="ignore")
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        record["body_status"] = "unavailable"
        return False

    paragraphs = re.findall(r"<p[^>]*>([\s\S]{40,3000}?)</p>", text, re.I)
    body = re.sub(r"\s+", " ", " ".join(clean(p) for p in paragraphs)).strip()
    if len(body.split()) < 40:
        record["body_status"] = "too short"
        return False

    record["body_text"] = body[:6000]
    record["body_status"] = "captured"
    stance, promotional_hits, critical_hits = classify_stance(f"{record['title']} {body}")
    record["stance"] = stance
    record["promotional_hits"] = promotional_hits
    record["critical_hits"] = critical_hits
    if SPONSORED.search(body) and record["channel"] == "news":
        record["channel"] = "sponsored"
        record["disclosure"] = "disclosed"
        record.setdefault("origin_indicators", []).append("sponsorship disclosed in body")
    return True


def google_news(query: str) -> list[dict]:
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"}
    )
    return rss_items(fetch(url), "Google News")


def bing_social(query: str) -> list[dict]:
    url = "https://www.bing.com/search?" + urllib.parse.urlencode({"q": query, "format": "rss"})
    return rss_items(fetch(url), "Bing social lead")


def flock_sitemap(url: str) -> list[dict]:
    root = ET.fromstring(fetch(url))
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    out = []
    cutoff = datetime.now(timezone.utc) - timedelta(days=45)
    for node in root.findall("s:url", ns):
        loc = safe_url(clean(node.findtext("s:loc", namespaces=ns)))
        if not loc:
            continue
        lastmod = parse_date(node.findtext("s:lastmod", namespaces=ns))
        if lastmod < cutoff or not any(
            part in loc for part in ("/blog/", "/customers/", "/press/", "/video/")
        ):
            continue
        slug = urllib.parse.urlparse(loc).path.rstrip("/").split("/")[-1]
        out.append(
            {
                "title": slug.replace("-", " ").title(),
                "summary": "Flock-owned page discovered through the company sitemap.",
                "url": loc,
                "published": lastmod,
                "publisher": "Flock Safety",
            }
        )
    return out


def agencies_for_hour(agencies: list[dict], hour: int) -> list[dict]:
    """One stable shard per hour so the watchlist is covered every 24 hours."""
    documented = sorted(
        (a for a in agencies if a.get("status") == "documented"), key=lambda a: a.get("id", "")
    )
    return [agency for index, agency in enumerate(documented) if index % 24 == hour]


def agency_query(agency: dict) -> str:
    name = agency.get("name", "")
    state = agency.get("state", "")
    return (
        f'"{name}" "Flock" {state} '
        '(success OR helped OR credit OR located OR recovered OR arrested OR "within minutes") '
        "(site:facebook.com OR site:instagram.com OR site:x.com OR "
        "site:youtube.com OR site:linkedin.com)"
    )


def prune(items: list[dict]) -> list[dict]:
    """Age out ordinary coverage, but never the documentary record.

    Disclosed sponsored content, wire distribution and company-owned pages are
    the evidence that the paid pipeline exists at all, and there are few of
    them. Expiring a 2024 "Sponsored by Flock Safety" page on a rolling news
    retention window would quietly delete the strongest documented fact in the
    dataset, so those channels are kept regardless of age.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    permanent = {"sponsored", "wire", "flock"}
    kept = []
    for item in items:
        if item.get("channel") in permanent:
            kept.append(item)
            continue
        try:
            when = datetime.fromisoformat(item.get("published_at", "").replace("Z", "+00:00"))
        except ValueError:
            when = datetime.now(timezone.utc)
        if when >= cutoff:
            kept.append(item)
    kept.sort(key=lambda item: item.get("published_at", ""), reverse=True)
    return kept[:MAX_ITEMS]


def main() -> int:
    config = json.loads((DATA / "sources.json").read_text())
    existing = json.loads((DATA / "live.json").read_text())
    agencies = json.loads((DATA / "agencies.json").read_text())

    collected: list[dict] = []
    ok = total = agencies_checked = 0
    hour = datetime.now(timezone.utc).hour
    agency_shard = agencies_for_hour(agencies, hour)

    jobs = (
        [("google", q, None) for q in config.get("google_news_queries", [])]
        + [("google", q, None) for q in config.get("accountability_queries", [])]
        + [("google", q, None) for q in config.get("newsroom_queries", [])]
        + [("bing", q, None) for q in config.get("bing_social_queries", [])]
        + [("flock", u, None) for u in config.get("owned_feeds", [])]
        + [("agency", agency_query(agency), agency) for agency in agency_shard]
    )

    for kind, value, agency in jobs:
        total += 1
        try:
            if kind == "google":
                raw_items = google_news(value)
            elif kind in {"bing", "agency"}:
                raw_items = bing_social(value)
            else:
                raw_items = flock_sitemap(value)
            if agency:
                for entry in raw_items:
                    entry["publisher"] = agency["name"]
                    entry["agency_id"] = agency["id"]
                agencies_checked += 1
            ok += 1
            collected.extend(raw_items)
        except Exception as exc:  # one blocked feed must not erase the monitor
            print(f"warning: {kind} source failed: {exc}", file=sys.stderr)

    normalized = [record for entry in collected if (record := classify(entry))]
    by_url = {item["url"]: item for item in existing if safe_url(item.get("url", ""))}
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for record in normalized:
        prior = by_url.get(record["url"])
        if prior:
            # Keep body text and first-seen date across runs.
            if prior.get("body_text"):
                record["body_text"] = prior["body_text"]
            if prior.get("body_status"):
                record["body_status"] = prior["body_status"]
            record["first_seen"] = prior.get("first_seen", prior.get("published_at"))
        else:
            record["first_seen"] = now_iso
        by_url[record["url"]] = record

    merged = prune(list(by_url.values()))

    enriched = 0
    if config.get("fetch_article_text", True):
        candidates = [
            item
            for item in merged
            if item.get("channel") in {"news", "sponsored", "wire"}
            and not item.get("body_text")
            and item.get("body_status") != "unavailable"
        ][:ENRICH_LIMIT]
        for record in candidates:
            if enrich_body(record):
                enriched += 1

    findings = analyze(merged)
    (DATA / "live.json").write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n")

    stances: dict[str, int] = {}
    for item in merged:
        key = item.get("stance", "neutral")
        stances[key] = stances.get(key, 0) + 1

    status = {
        "updated_at": now_iso,
        "collector": "public-rss",
        "queries_ok": ok,
        "queries_total": total,
        "agencies_checked": agencies_checked,
        "agency_total": len(agencies),
        "article_cadence_minutes": 60,
        "agency_rotation_hours": 24,
        "signals_retained": len(merged),
        "bodies_captured": sum(1 for i in merged if i.get("body_text")),
        "bodies_enriched_this_run": enriched,
        "stance_counts": stances,
        "reuse_groups": findings["reuse_groups"],
        "syndication_groups": findings["syndication_groups"],
        "reuse_window_words": findings["shingle_default"],
    }
    try:
        previous = json.loads((DATA / "status.json").read_text())
    except (OSError, ValueError):
        previous = {}
    for key in ("records_updated_at", "records_count", "records_queries_ok", "records_queries_total"):
        if key in previous:
            status[key] = previous[key]
    (DATA / "status.json").write_text(json.dumps(status, indent=2) + "\n")

    print(
        f"kept {len(merged)} signals; {ok}/{total} sources responded; "
        f"checked {agencies_checked}/{len(agencies)} agencies; "
        f"{enriched} bodies fetched; "
        f"{findings['reuse_groups']} reuse / {findings['syndication_groups']} syndication groups; "
        f"stance {stances}"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
