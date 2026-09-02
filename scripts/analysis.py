#!/usr/bin/env python3
"""Text-reuse, syndication, and stance analysis for FlockWatch.

Why this module exists
----------------------
The first version of FlockWatch grouped stories by *which watch phrase they
contained*. Every story containing "within minutes" landed in the same
"amplification cluster," which is not evidence of anything: two departments in
different states can independently tell a reporter a plate hit came back within
minutes. That produced a stream of confident-looking false leads.

This module replaces that with the method text-reuse researchers actually use:
contiguous word-sequence (shingle) overlap. Independent writers describing the
same event share *vocabulary*; they do not share long *word runs*. A shared run
of eight or more words is very hard to produce by coincidence and is the
signature of copied press-release or syndicated copy.

Three distinct relationships are detected and kept separate, because conflating
them is what makes a monitor misleading:

  syndication  Near-identical copy under different publisher names. Usually a
               station group running one story across its properties, or a wire
               pickup. Expected, benign, but it must be collapsed or it inflates
               counts and fakes the appearance of broad independent interest.

  reuse        Substantial shared passages between otherwise different stories.
               This is the press-release-pickup signal worth reading.

  co-coverage  Shared topic vocabulary only. Normal journalism. Recorded at low
               weight so it never gets presented as an amplification finding.
"""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict

# A run this long is the practical threshold where coincidence stops being a
# plausible explanation for two independently written news stories.
SHINGLE_SIZE = 8
# Shorter window used only for very short captured snippets.
SHORT_SHINGLE_SIZE = 5
MIN_WORDS_FOR_REUSE = 25

SYNDICATION_CONTAINMENT = 0.72
REUSE_CONTAINMENT = 0.22
REUSE_MIN_SHINGLES = 2

_WORD = re.compile(r"[a-z0-9']+")
# Boilerplate that appears on many news pages and would otherwise create
# spurious verbatim matches between unrelated stories.
_BOILERPLATE = re.compile(
    r"(all rights reserved|copyright \d{4}|this material may not be published"
    r"|sign up for our newsletter|click here to|follow us on|read more at"
    r"|the associated press contributed|scripps media, inc|gray media group"
    r"|nexstar media inc|download the .{0,30} app)",
    re.I,
)

STANCE_CRITICAL = re.compile(
    r"\b(privacy concern|civil liberties|surveillance state|mass surveillance"
    r"|warrantless|fourth amendment|misuse|abuse[sd]?|abused|wrongful"
    r"|false (?:positive|match|hit|arrest)|misidentif|sued|lawsuit|litigation"
    r"|audit found|improperly|unauthorized (?:access|search|lookup)"
    r"|data breach|shared with ice|immigration enforcement|ice agents"
    r"|voted (?:to )?(?:remove|end|cancel|reject|terminate)|declined to renew"
    r"|moratorium|banned|ban on|pulled the plug|took down the cameras"
    r"|no evidence (?:that|of)|did not reduce|failed to|questioned whether"
    r"|watchdog|eff\b|aclu\b|electronic frontier)\b",
    re.I,
)
STANCE_PROMOTIONAL = re.compile(
    r"\b(credit(?:s|ed)? flock|success stor|game.?chang|instrumental"
    r"|within (?:\w+ )?minutes|invaluable|force multiplier|solved within"
    r"|thanks to (?:the )?flock|proved? itself|safer communit)\b",
    re.I,
)


def normalize_words(text: str) -> list[str]:
    """Lowercase word list with page boilerplate stripped out."""
    cleaned = _BOILERPLATE.sub(" ", text or "")
    return _WORD.findall(cleaned.lower())


def shingle_size_for(*word_lists: list[str]) -> int:
    """Use a shorter window when we only captured short snippets.

    Google News RSS descriptions are often 25-40 words. Demanding an 8-word run
    from a 30-word snippet is possible but insensitive, so the window shrinks
    for short text. This is recorded on the finding so a reader knows a 5-word
    match is weaker evidence than an 8-word one.
    """
    shortest = min((len(words) for words in word_lists if words), default=0)
    return SHINGLE_SIZE if shortest >= 60 else SHORT_SHINGLE_SIZE


def shingles(words: list[str], size: int) -> set[str]:
    if len(words) < size:
        return set()
    return {
        hashlib.blake2b(" ".join(words[i : i + size]).encode(), digest_size=8).hexdigest()
        for i in range(len(words) - size + 1)
    }


def containment(left: set[str], right: set[str]) -> float:
    """Overlap normalized by the smaller set.

    Containment rather than Jaccard: when a 200-word wire item is quoted inside
    a 900-word local story, Jaccard stays low and hides a real pickup.
    """
    if not left or not right:
        return 0.0
    return len(left & right) / min(len(left), len(right))


def longest_common_run(left: list[str], right: list[str], cap: int = 60) -> list[str]:
    """Longest contiguous shared word sequence, for showing the actual evidence.

    A score tells a reader something is similar. The shared sentence lets them
    judge for themselves, which is the whole point of the tool.
    """
    if not left or not right:
        return []
    previous = [0] * (len(right) + 1)
    best_len = 0
    best_end = 0
    for i in range(1, len(left) + 1):
        current = [0] * (len(right) + 1)
        li = left[i - 1]
        for j in range(1, len(right) + 1):
            if li == right[j - 1]:
                current[j] = previous[j - 1] + 1
                if current[j] > best_len:
                    best_len = current[j]
                    best_end = i
        previous = current
    return left[max(0, best_end - best_len) : best_end][:cap]


def text_of(item: dict) -> str:
    return f"{item.get('title', '')} {item.get('body_text') or item.get('summary', '')}"


def classify_stance(text: str) -> tuple[str, int, int]:
    """Return (stance, promotional_hits, critical_hits).

    The original collector discarded anything that did not read as a Flock win,
    which made the dataset structurally incapable of contradicting the
    hypothesis it existed to test. Stance is recorded here so an outlet's
    promotional coverage can be reported against its critical coverage, rather
    than in a vacuum.
    """
    promotional = len(set(STANCE_PROMOTIONAL.findall(text)))
    critical = len(set(STANCE_CRITICAL.findall(text)))
    if critical and critical >= promotional:
        return "critical", promotional, critical
    if critical and promotional:
        return "mixed", promotional, critical
    if promotional:
        return "promotional", promotional, critical
    return "neutral", promotional, critical


def normalize_title(title: str) -> str:
    words = normalize_words(title)
    return " ".join(words)


def analyze(items: list[dict], window_days: int = 120, now=None) -> dict:
    """Attach reuse/syndication findings to items; return a summary.

    Mutates each item, adding: reuse_group, reuse_role, reuse_kind,
    reuse_containment, shared_passage, shared_passage_words, syndication_group.
    """
    from datetime import datetime, timedelta, timezone

    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=window_days)

    def published(item):
        raw = item.get("published_at", "")
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            return now

    for item in items:
        item.pop("reuse_group", None)
        item.pop("reuse_role", None)
        item.pop("reuse_kind", None)
        item.pop("reuse_containment", None)
        item.pop("shared_passage", None)
        item.pop("shared_passage_words", None)
        item.pop("syndication_group", None)

    scope = [i for i in items if published(i) >= cutoff]
    prepared = []
    for item in scope:
        words = normalize_words(text_of(item))
        if len(words) < MIN_WORDS_FOR_REUSE:
            continue
        prepared.append((item, words))

    # Union-find keeps groups transitive: if A matches B and B matches C, all
    # three belong to one lane. The previous implementation broke after the
    # first match and produced inconsistent pairwise groups.
    parent: dict[int, int] = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    edges = []
    for i in range(len(prepared)):
        left_item, left_words = prepared[i]
        for j in range(i + 1, len(prepared)):
            right_item, right_words = prepared[j]
            size = shingle_size_for(left_words, right_words)
            ls = shingles(left_words, size)
            rs = shingles(right_words, size)
            if not ls or not rs:
                continue
            shared = len(ls & rs)
            if shared < REUSE_MIN_SHINGLES:
                continue
            score = containment(ls, rs)
            if score < REUSE_CONTAINMENT:
                continue
            same_publisher = (left_item.get("publisher") or "").lower() == (
                right_item.get("publisher") or ""
            ).lower()
            kind = (
                "syndication"
                if score >= SYNDICATION_CONTAINMENT and not same_publisher
                else "reuse"
            )
            edges.append((i, j, score, kind, size, shared))
            union(i, j)

    groups: dict[int, list[int]] = defaultdict(list)
    for index in range(len(prepared)):
        if index in parent:
            groups[find(index)].append(index)

    edge_lookup: dict[int, list] = defaultdict(list)
    for i, j, score, kind, size, shared in edges:
        edge_lookup[i].append((j, score, kind, size, shared))
        edge_lookup[j].append((i, score, kind, size, shared))

    reuse_groups = 0
    syndication_groups = 0
    for root, members in groups.items():
        if len(members) < 2:
            continue
        member_edges = [e for e in edges if e[0] in members and e[1] in members]
        kinds = {e[3] for e in member_edges}
        group_kind = "syndication" if kinds == {"syndication"} else (
            "mixed" if "syndication" in kinds else "reuse"
        )
        signature = hashlib.blake2b(
            "|".join(sorted(prepared[m][0].get("url", "") for m in members)).encode(),
            digest_size=6,
        ).hexdigest()
        group_id = f"{group_kind[:4]}-{signature}"
        ordered = sorted(members, key=lambda m: published(prepared[m][0]))
        if group_kind == "syndication":
            syndication_groups += 1
        else:
            reuse_groups += 1

        for position, member in enumerate(ordered):
            item, words = prepared[member]
            item["reuse_group"] = group_id
            item["reuse_kind"] = group_kind
            # "Earliest captured", never "original". Feed timestamps are the
            # publisher's claim and the collector only sees what it indexed.
            item["reuse_role"] = "earliest captured" if position == 0 else "later capture"
            best = max(edge_lookup[member], key=lambda e: e[1], default=None)
            if best:
                other_index, score, _kind, size, shared = best
                item["reuse_containment"] = round(score, 3)
                item["shared_shingle_count"] = shared
                item["shared_shingle_size"] = size
                passage = longest_common_run(words, prepared[other_index][1])
                if len(passage) >= size:
                    item["shared_passage"] = " ".join(passage)
                    item["shared_passage_words"] = len(passage)
            if group_kind in {"syndication", "mixed"}:
                item["syndication_group"] = group_id

    for item in items:
        stance, promotional, critical = classify_stance(text_of(item))
        item["stance"] = stance
        item["promotional_hits"] = promotional
        item["critical_hits"] = critical

    return {
        "analyzed": len(prepared),
        "reuse_groups": reuse_groups,
        "syndication_groups": syndication_groups,
        "shingle_default": SHINGLE_SIZE,
        "shingle_short": SHORT_SHINGLE_SIZE,
    }
