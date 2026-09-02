#!/usr/bin/env python3
"""Refresh public Flock records from MuckRock, DocumentCloud, and GitHub submissions."""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
UA = "FlockWatch-Records-Monitor/1.0 (+public-interest research; GitHub Pages)"
SEARCHES = [
    'site:muckrock.com/foi/ "Flock Safety" (media OR press OR communications OR social)',
    'site:muckrock.com/foi/ "@flocksafety.com"',
    'site:documentcloud.org/documents/ "Flock Safety"',
]
ALLOWED_PUBLIC_HOSTS = {"muckrock.com", "www.muckrock.com", "documentcloud.org", "www.documentcloud.org"}
TOPIC_PATTERNS = {
    "Flock communications": r"\bcommunications?\b|@flocksafety\.com",
    "press releases": r"\bpress releases?\b|\bnews releases?\b",
    "social-media posts": r"\bsocial[ -]media\b|\bfacebook\b|\binstagram\b|\blinkedin\b",
    "public messaging": r"\btalking points?\b|\bpublic information\b|\bmedia statements?\b",
    "contracts": r"\bcontracts?\b|\bprocurement\b|\binvoices?\b",
    "audit logs": r"\baudit logs?\b|\bsearch logs?\b|\bqueries\b",
}


def fetch(url: str, headers: dict[str, str] | None = None) -> bytes:
    request_headers = {"User-Agent": UA, "Accept": "application/rss+xml, application/json, text/xml;q=0.9"}
    request_headers.update(headers or {})
    request = urllib.request.Request(url, headers=request_headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def clean(value: str | None) -> str:
    value = html.unescape(value or "")
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def parse_date(value: str | None) -> datetime:
    if value:
        try:
            parsed = parsedate_to_datetime(value)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            pass
    return datetime.now(timezone.utc)


def bing_results(query: str) -> list[dict]:
    url = "https://www.bing.com/search?" + urllib.parse.urlencode({"q": query, "format": "rss"})
    root = ET.fromstring(fetch(url))
    return [{
        "title": clean(node.findtext("title")),
        "summary": clean(node.findtext("description")),
        "url": clean(node.findtext("link")),
        "published": parse_date(node.findtext("pubDate")),
    } for node in root.findall(".//item")]


def normalize(item: dict, source: str = "public-index") -> dict | None:
    parsed = urllib.parse.urlparse(item.get("url", ""))
    if parsed.netloc.lower() not in ALLOWED_PUBLIC_HOSTS:
        return None
    combined = f"{item.get('title', '')} {item.get('summary', '')}"
    if not re.search(r"\bflock\b", combined, re.I):
        return None
    platform = "MuckRock" if "muckrock.com" in parsed.netloc else "DocumentCloud"
    topics = [label for label, pattern in TOPIC_PATTERNS.items() if re.search(pattern, combined, re.I)]
    agency_match = re.search(r"\(([^()]+(?:Police|Sheriff|Department|Office|County|City)[^()]*)\)", item.get("title", ""), re.I)
    fingerprint = hashlib.sha1(item["url"].encode()).hexdigest()[:14]
    published = item.get("published") or datetime.now(timezone.utc)
    if isinstance(published, str):
        try:
            published = datetime.fromisoformat(published.replace("Z", "+00:00"))
        except ValueError:
            published = datetime.now(timezone.utc)
    return {
        "id": f"public-{fingerprint}",
        "title": clean(item.get("title")),
        "agency": clean(agency_match.group(1)) if agency_match else clean(item.get("agency")),
        "state": clean(item.get("state")),
        "platform": platform,
        "url": item["url"],
        "published_at": published.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": "Public request" if platform == "MuckRock" else "Published document",
        "topics": topics or ["Flock records"],
        "summary": clean(item.get("summary"))[:500],
        "source": source,
    }


def issue_field(body: str, heading: str) -> str:
    match = re.search(rf"###\s+{re.escape(heading)}\s*\n+(.+?)(?=\n###|\Z)", body, re.I | re.S)
    if not match:
        return ""
    return clean(match.group(1)).replace("_No response_", "").strip()


def github_submissions() -> list[dict]:
    repository = os.environ.get("GITHUB_REPOSITORY", "").strip()
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not repository or not token:
        return []
    url = f"https://api.github.com/repos/{repository}/issues?" + urllib.parse.urlencode({"state": "all", "labels": "records-submission", "per_page": 100})
    issues = json.loads(fetch(url, {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}))
    results = []
    for issue in issues:
        body = issue.get("body") or ""
        public_url = issue_field(body, "Public MuckRock or DocumentCloud URL")
        if urllib.parse.urlparse(public_url).netloc.lower() not in ALLOWED_PUBLIC_HOSTS:
            continue
        results.append({
            "title": issue.get("title") or "Community records submission",
            "summary": issue_field(body, "What the records contain"),
            "url": public_url,
            "agency": issue_field(body, "Agency"),
            "state": issue_field(body, "State"),
            "published": parse_date(issue.get("created_at")),
        })
    return results


def main() -> int:
    path = DATA / "records.json"
    existing = json.loads(path.read_text())
    by_url = {item["url"]: item for item in existing}
    ok = 0
    for query in SEARCHES:
        try:
            for raw in bing_results(query):
                item = normalize(raw)
                if item:
                    by_url[item["url"]] = item
            ok += 1
        except Exception as exc:
            print(f"warning: records search failed: {exc}")
    try:
        for raw in github_submissions():
            item = normalize(raw, "community-submission")
            if item:
                by_url[item["url"]] = item
    except Exception as exc:
        print(f"warning: community records import failed: {exc}")
    records = sorted(by_url.values(), key=lambda item: item.get("published_at", ""), reverse=True)
    path.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n")
    status_path = DATA / "status.json"
    status = json.loads(status_path.read_text()) if status_path.exists() else {}
    status.update({
        "records_updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "records_count": len(records),
        "records_queries_ok": ok,
        "records_queries_total": len(SEARCHES),
    })
    status_path.write_text(json.dumps(status, indent=2) + "\n")
    print(f"records library contains {len(records)} public links; {ok}/{len(SEARCHES)} searches responded")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
