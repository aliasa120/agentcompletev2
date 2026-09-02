"""Feed-entry cleanup helpers.

Google News RSS (and most search RSS feeds) put NO real article description in
`<summary>` — the field is HTML junk that only contains:
  - an <a> tag whose text is THE SAME TITLE again (plus a <font> source label)
  - sometimes an <ol><li> list of SIBLING headlines from Google News' own
    editorial cluster (free same-story signal we would otherwise throw away)

This module:
  1. strips the trailing " - <Source>" suffix Google appends to every title
     (so "X - Arab News PK" and identical wire copy "X - Dawn" normalize equal)
  2. extracts the sibling cluster titles out of the summary HTML
  3. decides what to store as `description` ("" for Google junk instead of
     polluting the DB / LLM prompts with base64 redirect URLs)
"""
import re
from html import unescape

_TAG_RE = re.compile(r"<[^>]+>")
_ANCHOR_RE = re.compile(r'<a\b[^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)
_WS_RE = re.compile(r"\s+")


def strip_tags(html: str) -> str:
    """Plain text of a HTML fragment, whitespace-collapsed."""
    return _WS_RE.sub(" ", unescape(_TAG_RE.sub(" ", html or ""))).strip()


def clean_title(title: str, source_title: str = "") -> str:
    """Remove the trailing source suffix Google appends to every title.

    Tolerates the messy separators Google uses: "X - Dawn", "X - WKRC",
    "X - | Associated Press Of Pakistan", "X - سانا", etc. Only stripped when
    the suffix actually equals the feed's source title (so we never eat a
    legitimate "X - Y" headline fragment).
    """
    title = (title or "").strip()
    src = (source_title or "").strip()
    if src:
        pat = re.compile(r"[\s\-–—|:·]*" + re.escape(src) + r"\s*$", re.IGNORECASE)
        title = pat.sub("", title).rstrip(" -|").strip()
    return title


def extract_cluster_siblings(summary_html: str, own_title: str = "") -> list[str]:
    """Pull the anchor texts out of a Google News RSS summary.

    Google wraps its editorial cluster into the summary:
      single item : <a ...>Own title</a>&nbsp;<font>Source</font>
      clustered   : <ol><li><a>Own title</a> <font>Src</font></li>
                    <li><a>Same story, other outlet</a> <font>Src</font></li> ... </ol>

    Returns the OTHER headlines in the cluster (own title excluded) — these are
    near-100% same-story duplicates discovered for free.
    """
    if not summary_html or "<a" not in summary_html:
        return []
    anchors = []
    for raw in _ANCHOR_RE.findall(summary_html):
        text = strip_tags(unescape(raw))
        if text and len(text) >= 8:
            anchors.append(text)

    siblings = []
    own_norm = _normalize_for_compare(own_title)
    for idx, text in enumerate(anchors):
        an = _normalize_for_compare(text)
        # The first anchor is always the article itself in Google's format;
        # containment handles any source-suffix mismatch on the rest.
        is_self = idx == 0 or (own_norm and an and (an in own_norm or own_norm in an))
        if not is_self:
            siblings.append(text)
    return siblings


def clean_description(summary_html: str) -> str:
    """What to store as `description`.

    Google News summaries contain only the repeated title + source name +
    redirect URLs — no article text. Storing that junk (300-800 chars of HTML)
    pollutes the dedup LLM prompt and the content hash, so we store "" instead.
    If a feed DOES provide a real summary containing more text than just its
    anchors, keep the plain text.
    """
    if not summary_html:
        return ""
    text = strip_tags(summary_html)
    # Remove anchor contents — what remains tells us whether real text existed.
    residue = strip_tags(_ANCHOR_RE.sub(" ", summary_html))
    # Google residue is just the source name(s) in <font> tags — treat as junk.
    if len(residue) <= max(0, len(text) * 0.25):
        return ""
    return text[:2000]


def _normalize_for_compare(title: str) -> str:
    """Lowercase alnum-only — for 'is this the same headline string?' checks."""
    return re.sub(r"[^a-z0-9]", "", (title or "").lower())


def normalize_for_hash(title: str) -> str:
    """Canonical title form used by the Layer-2 content hash:
    lowercase, punctuation removed, whitespace collapsed, no source suffix."""
    cleaned = _WS_RE.sub(" ", re.sub(r"[^a-z0-9\s]", " ", (title or "").lower())).strip()
    return cleaned
