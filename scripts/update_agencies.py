#!/usr/bin/env python3
"""Build and gradually enrich a watchlist of documented Flock agencies.

The national seed comes from The News & Observer's MIT-licensed Private Eyes
dataset of official Flock transparency portals. Social accounts discovered by
public search are marked as candidates unless the result itself identifies the
page as official. Existing human-verified accounts are never downgraded.
"""

from __future__ import annotations

import argparse
import csv
import html
import io
import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
PRIVATE_EYES = "https://raw.githubusercontent.com/mcclatchy-southeast/private_eyes/main/data/latest_usage04262023.csv"
UA = "FlockWatch-Media-Monitor/1.1 (+public-interest research; GitHub Pages)"
SOCIAL_DOMAINS = {
    "facebook.com": "Facebook", "www.facebook.com": "Facebook",
    "instagram.com": "Instagram", "www.instagram.com": "Instagram",
    "x.com": "X", "twitter.com": "X", "www.twitter.com": "X",
    "youtube.com": "YouTube", "www.youtube.com": "YouTube",
    "linkedin.com": "LinkedIn", "www.linkedin.com": "LinkedIn",
}
STATE_NAMES = {
    "al":"Alabama","ak":"Alaska","az":"Arizona","ar":"Arkansas","ca":"California","co":"Colorado","ct":"Connecticut","de":"Delaware","fl":"Florida","ga":"Georgia","hi":"Hawaii","id":"Idaho","il":"Illinois","in":"Indiana","ia":"Iowa","ks":"Kansas","ky":"Kentucky","la":"Louisiana","me":"Maine","md":"Maryland","ma":"Massachusetts","mi":"Michigan","mn":"Minnesota","ms":"Mississippi","mo":"Missouri","mt":"Montana","ne":"Nebraska","nv":"Nevada","nh":"New Hampshire","nj":"New Jersey","nm":"New Mexico","ny":"New York","nc":"North Carolina","nd":"North Dakota","oh":"Ohio","ok":"Oklahoma","or":"Oregon","pa":"Pennsylvania","ri":"Rhode Island","sc":"South Carolina","sd":"South Dakota","tn":"Tennessee","tx":"Texas","ut":"Utah","vt":"Vermont","va":"Virginia","wa":"Washington","wv":"West Virginia","wi":"Wisconsin","wy":"Wyoming","dc":"District of Columbia"
}
STOP = {"police", "department", "sheriff", "office", "county", "city", "town", "village", "public", "safety", "of", "the"}


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/csv, application/rss+xml, text/xml;q=0.9"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def clean(value: str | None) -> str:
    value = html.unescape(value or "")
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def infer_state(url: str, agency: str) -> str:
    slug = urllib.parse.urlparse(url).path.strip("/").lower()
    for pattern in (r"-([a-z]{2})-(?:pd|so|sd|dps)-?$", r"-(?:pd|so|sd)-([a-z]{2})-?$"):
        match = re.search(pattern, slug)
        if match and match.group(1) in STATE_NAMES:
            return match.group(1).upper()
    for code, name in STATE_NAMES.items():
        if re.search(rf"\b{re.escape(name)}\b", agency, re.I):
            return code.upper()
    return ""


def display_agency_name(value: str, state: str) -> str:
    """Turn portal labels such as 'Akron OH PD' into readable agency names."""
    words = value.split()
    if state:
        words = [word for word in words if word.upper().strip(".,") != state]
    replacements = {
        "PD": "Police Department",
        "SO": "Sheriff's Office",
        "SD": "Sheriff's Department",
        "DPS": "Department of Public Safety",
    }
    normalized = []
    for word in words:
        normalized.extend(replacements.get(word.upper().strip(".,"), word).split())
    return " ".join(normalized).strip()


def load_private_eyes() -> list[dict]:
    raw = fetch(PRIVATE_EYES).decode("utf-8-sig", errors="replace")
    rows = []
    for row in csv.DictReader(io.StringIO(raw)):
        raw_agency = clean(row.get("agency"))
        url = clean(row.get("url"))
        if not raw_agency or "transparency.flocksafety.com" not in url:
            continue
        state = infer_state(url, raw_agency)
        agency = display_agency_name(raw_agency, state)
        rows.append({
            "id": slugify(f"{agency}-{state}"),
            "name": agency,
            "state": state,
            "jurisdiction": f"{agency}, {STATE_NAMES.get(state.lower(), state)}" if state else agency,
            "confirmation_url": url,
            "confirmation_type": "Flock transparency portal",
            "documented_at": clean(row.get("accessed") or row.get("updated") or "2024-04-26")[:10],
            "status": "documented",
            "socials": [],
            "last_checked": "",
            "source_credit": "The News & Observer / Private Eyes",
        })
    return rows


def agency_key(agency: dict) -> str:
    return re.sub(r"\W+", "", agency.get("name", "").lower()) + agency.get("state", "").lower()


def merge(existing: list[dict], imported: list[dict]) -> list[dict]:
    output = {agency_key(item): item for item in imported}
    imported_by_url = {item.get("confirmation_url"): item for item in imported}
    for item in existing:
        # Preserve social-enrichment work across source-name normalization.
        if item.get("source_credit") == "The News & Observer / Private Eyes":
            base = imported_by_url.get(item.get("confirmation_url"))
            if not base:
                continue
            if item.get("socials"):
                base["socials"] = item["socials"]
            if item.get("last_checked"):
                base["last_checked"] = item["last_checked"]
            continue
        key = agency_key(item)
        if key in output:
            base = output[key]
            base.update({field: value for field, value in item.items() if value not in (None, "", [])})
            base["socials"] = item.get("socials", [])
            output[key] = base
        else:
            output[key] = item
    return sorted(output.values(), key=lambda item: item.get("name", ""))


def rss_results(query: str) -> list[dict]:
    url = "https://www.bing.com/search?" + urllib.parse.urlencode({"q": query, "format": "rss"})
    root = ET.fromstring(fetch(url))
    return [{"title": clean(node.findtext("title")), "summary": clean(node.findtext("description")), "url": clean(node.findtext("link"))} for node in root.findall(".//item")]


def canonical_social(url: str, platform: str) -> str:
    parsed = urllib.parse.urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    if not parts:
        return url
    if platform in {"Facebook", "Instagram", "X"}:
        return f"https://{parsed.netloc}/{parts[0]}/"
    if platform == "LinkedIn":
        count = 2 if parts[0] in {"company", "in", "school"} and len(parts) > 1 else 1
        return f"https://{parsed.netloc}/{'/'.join(parts[:count])}/"
    if platform == "YouTube":
        count = 2 if parts[0] in {"channel", "c", "user"} and len(parts) > 1 else 1
        return f"https://{parsed.netloc}/{'/'.join(parts[:count])}/"
    return url


def name_tokens(agency: dict) -> list[str]:
    return [token for token in re.findall(r"[a-z0-9]+", agency["name"].lower()) if token not in STOP and len(token) > 2]


def relevance(agency: dict, result: dict) -> tuple[int, bool]:
    text = f"{result['title']} {result['summary']}".lower()
    tokens = name_tokens(agency)
    hits = sum(token in text for token in tokens)
    needed = max(1, min(2, len(tokens)))
    verified = "official" in text and hits >= needed
    return hits, verified


def discover_socials(agencies: list[dict], batch: int) -> int:
    # Do not let weak, unverified search candidates become sticky across runs.
    for agency in agencies:
        agency["socials"] = [
            social for social in agency.get("socials", [])
            if social.get("verified") or social.get("discovered_via") != "public search"
        ]
    unresolved = [a for a in agencies if not a.get("socials")]
    if not unresolved:
        return 0
    offset = (date.today().toordinal() * batch) % len(unresolved)
    selected = (unresolved + unresolved)[offset:offset + min(batch, len(unresolved))]
    checked = 0
    for agency in selected:
        query = f'"{agency["name"]}" official (site:facebook.com OR site:instagram.com OR site:x.com OR site:youtube.com OR site:linkedin.com)'
        try:
            candidates = {}
            for result in rss_results(query):
                host = urllib.parse.urlparse(result["url"]).netloc.lower()
                platform = SOCIAL_DOMAINS.get(host)
                if not platform:
                    continue
                score, verified = relevance(agency, result)
                if score < max(1, min(2, len(name_tokens(agency)))):
                    continue
                current = candidates.get(platform)
                if not current or score > current[0]:
                    candidates[platform] = (score, {"platform": platform, "url": canonical_social(result["url"], platform), "verified": verified, "discovered_via": "public search"})
            agency["socials"] = [value[1] for value in candidates.values()]
            agency["last_checked"] = date.today().isoformat()
            checked += 1
        except Exception as exc:
            print(f"warning: social discovery failed for {agency['name']}: {exc}")
    return checked


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--discover-socials", action="store_true")
    parser.add_argument("--batch", type=int, default=24)
    args = parser.parse_args()
    path = DATA / "agencies.json"
    existing = json.loads(path.read_text())
    try:
        imported = load_private_eyes()
        agencies = merge(existing, imported)
    except Exception as exc:
        print(f"warning: national agency import failed; preserving current list: {exc}")
        agencies = existing
    checked = discover_socials(agencies, max(1, min(args.batch, 50))) if args.discover_socials else 0
    path.write_text(json.dumps(agencies, indent=2, ensure_ascii=False) + "\n")
    print(f"watchlist contains {len(agencies)} documented agencies; checked {checked} social discovery targets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
