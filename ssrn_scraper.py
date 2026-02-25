#!/usr/bin/env python3
"""
SSRN Conference Scraper
=======================
Scrapes SSRN professional announcements (FEN/ARN/ERN) to build and update
a conference tracker JSON file with deadlines, dates, and locations.

SSRN blocks simple HTTP requests, so this uses Playwright (headless browser).

Setup (one time):
    pip install playwright
    playwright install chromium

Usage:
    python ssrn_scraper.py                    # Full scrape: listing + deadlines
    python ssrn_scraper.py --deadlines-only   # Only visit pages for TBD deadlines
    python ssrn_scraper.py --list-only        # Only scrape listing pages (no detail pages)

Output:
    conferences.json  - Updated conference data
    scrape_log.txt    - Detailed log of what was found/changed
"""

import json, re, os, sys, time, argparse, logging, random
from datetime import datetime, date
from pathlib import Path

# --- Configuration ---

# SSRN network IDs (annsNet parameter) - confirmed from live SSRN pages:
#   https://www.ssrn.com/index.cfm/en/janda/professional-announcements/?annsNet=203
#   https://www.ssrn.com/index.cfm/en/janda/professional-announcements/?annsNet=204
#   https://www.ssrn.com/index.cfm/en/janda/professional-announcements/?annsNet=205
NETWORKS = {
    "Finance":    203,      # FEN
    "Accounting": 204,      # ARN
    "Economics":  205,      # ERN
}

# Conference-related section headings to include
CONFERENCE_SECTIONS = [
    "Call for Papers & Participants - Conference",
    "Call for Participants - Conference",
    "Call for Papers - Competitions",
]

PAGE_DELAY = 2.0
JSON_PATH = Path("conferences.json")
LOG_PATH = Path("scrape_log.txt")

# Non-conference items to filter out (prizes, PhD programs, summer schools, job posts, etc.)
NON_CONFERENCE_KEYWORDS = [
    'prize', 'award', 'ph.d.', 'phd in ', 'professorship', 'assistant professor',
    'finance theory insights', 'data grant', 'sbur collection',
    'farfe awards', 'pre-announcments:', 'ecomod school',
    'calling scholars interested', 'call for registration',
    'multinational finance journal', 'fully funded',
    'research programme', 'research program', 'monetary research',
    'call for proposals', 'call for applications', 'call for nominations',
    'call for research projects', 'dissertation proposal', 'dissertation grant',
    'doctoral internship', 'doctoral colloquium',
    'hackathon', 'webinar', 'student research competition',
    'postdoctoral', 'postdoc ', 'research associate',
    'memorial prize', 'memorial award',
    'graduate programme', 'graduate program',
    'advances in econometrics volume', 'bayesian macroeconometrics',
    'estimating the impact of', 'education policy hackathon',
    'open-bid applied research', 'data science summer school',
    'corporate governance summer school', 'lse corporate governance summer',
    'call for papers:', 'call for papers!',  # standalone CFP announcements (not conf titles)
    'now accepting submissions', 'research grants provided by',
]
NON_CONFERENCE_EXACT = [
    'summer school',  # filter unless "conference" also in name
    'call for job market paper',
]

# Safelist: items matching junk keywords but are real conferences
CONFERENCE_SAFELIST = [
    'annual meeting', 'annual conference', 'midyear meeting',
    'finance conference', 'accounting conference', 'economics conference',
    'annual congress', 'winter finance', 'research conference',
    'workshop', 'symposium', 'forum', 'summit',
]

def is_non_conference(name):
    """Return True if the item is not a real conference (prize, PhD program, etc.)."""
    name_lower = name.lower()
    for kw in NON_CONFERENCE_KEYWORDS:
        if kw in name_lower:
            # Check safelist — real conferences that happen to match a junk keyword
            for safe in CONFERENCE_SAFELIST:
                if safe in name_lower:
                    return False
            return True
    for kw in NON_CONFERENCE_EXACT:
        if kw in name_lower and 'conference' not in name_lower:
            return True
    return False

# --- Logging ---

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_PATH, mode="w", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# --- Date Parsing ---

MONTH_MAP = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6,
    "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}

def parse_date_flexible(text):
    if not text:
        return None
    text = text.strip().rstrip(".").replace(".", "")

    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", text)
    if m:
        return text[:10]

    # "MM/DD/YYYY"
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", text)
    if m:
        return f"{int(m.group(3))}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"

    # "Month DD, YYYY" or "Month DD YYYY"
    m = re.match(r"(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})", text)
    if m:
        month = MONTH_MAP.get(m.group(1).lower()[:3])
        if month:
            return f"{int(m.group(3))}-{month:02d}-{int(m.group(2)):02d}"

    # "DD Month, YYYY" or "DD Month YYYY"
    m = re.match(r"(\d{1,2})(?:st|nd|rd|th)?\s+(\w+),?\s+(\d{4})", text)
    if m:
        month = MONTH_MAP.get(m.group(2).lower()[:3])
        if month:
            return f"{int(m.group(3))}-{month:02d}-{int(m.group(1)):02d}"

    return None


def parse_conf_dates(date_str):
    date_str = date_str.strip()
    if not date_str:
        return ("", "")

    m = re.match(r"(\d{1,2})\s+(\w+)\s+(\d{4})\s*-\s*(\d{1,2})\s+(\w+)\s+(\d{4})", date_str)
    if m:
        d1, m1, y1 = int(m.group(1)), m.group(2), int(m.group(3))
        d2, m2, y2 = int(m.group(4)), m.group(5), int(m.group(6))
        month1 = MONTH_MAP.get(m1.lower()[:3])
        month2 = MONTH_MAP.get(m2.lower()[:3])
        if month1 and month2:
            start = f"{y1}-{month1:02d}-{d1:02d}"
            if m1[:3] == m2[:3]:
                display = f"{m1[:3]} {d1}-{d2}"
            else:
                display = f"{m1[:3]} {d1} - {m2[:3]} {d2}"
            return (start, display)

    m = re.match(r"(\d{1,2})\s+(\w+)\s+(\d{4})", date_str)
    if m:
        d1, m1, y1 = int(m.group(1)), m.group(2), int(m.group(3))
        month1 = MONTH_MAP.get(m1.lower()[:3])
        if month1:
            start = f"{y1}-{month1:02d}-{d1:02d}"
            display = f"{m1[:3]} {d1}"
            return (start, display)

    return ("", date_str)

# --- Deadline Extraction ---

DEADLINE_PATTERNS = [
    # Allow optional timezone / filler words (e.g., "PST,", "11:59 PM EST,", "midnight") between keyword and date
    # The (?:.*?) bridges up to ~40 chars of filler between the keyword and the date

    # "Submission Deadline: [optional filler] February 25, 2026" (Month DD, YYYY)
    r"[Ss]ubmission\s+[Dd]eadline[:\s]+(?:[^,\n]{0,40}?,\s*)?(\w+\s+\d{1,2},?\s+\d{4})",
    # "Submission deadline: [optional filler] 30 April, 2026" (DD Month, YYYY)
    r"[Ss]ubmission\s+[Dd]eadline[:\s]+(?:[^,\n]{0,40}?,\s*)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # "The submission deadline is [optional filler/day name] ..."
    r"submission\s+deadline\s+is\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(?:[^,\n]{0,40}?,\s*)?(\w+\s+\d{1,2},?\s+\d{4})",
    r"submission\s+deadline\s+is\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(?:[^,\n]{0,40}?,\s*)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # "Deadline: [optional filler] ..."
    r"[Dd]eadline[:\s]+(?:[^,\n]{0,40}?,\s*)?(\w+\s+\d{1,2},?\s+\d{4})",
    r"[Dd]eadline[:\s]+(?:[^,\n]{0,40}?,\s*)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # "Deadline: MM/DD/YYYY or YYYY-MM-DD"
    r"[Dd]eadline[:\s]+(?:[^,\n]{0,40}?,\s*)?(\d{1,2}/\d{1,2}/\d{4})",
    r"[Dd]eadline[:\s]+(?:[^,\n]{0,40}?,\s*)?(\d{4}-\d{2}-\d{2})",
    # "submit papers by ..."
    r"submit\s+(?:papers?|manuscripts?)\s+by\s+(?:[^,\n]{0,40}?,\s*)?(\w+\s+\d{1,2},?\s+\d{4})",
    r"submit\s+(?:papers?|manuscripts?)\s+by\s+(?:[^,\n]{0,40}?,\s*)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # "submitted by ..."
    r"submitted?\s+by\s+(?:[^,\n]{0,40}?,\s*)?(\w+\s+\d{1,2},?\s+\d{4})",
    r"submitted?\s+by\s+(?:[^,\n]{0,40}?,\s*)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # "due by/on ..."
    r"due\s+(?:by|on)\s+(?:[^,\n]{0,40}?,\s*)?(\w+\s+\d{1,2},?\s+\d{4})",
    r"due\s+(?:by|on)\s+(?:[^,\n]{0,40}?,\s*)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # "no later than ..."
    r"no\s+later\s+than\s+(?:[^,\n]{0,40}?,\s*)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    r"no\s+later\s+than\s+(?:[^,\n]{0,40}?,\s*)?(\w+\s+\d{1,2},?\s+\d{4})",
    # "before ..."
    r"before\s+(\w+\s+\d{1,2},?\s+\d{4})",
    r"before\s+(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # "deadline for submission(s) is ..."
    r"[Dd]eadline\s+for\s+\w+\s+is\s+(?:[^,\n]{0,40}?,\s*)?(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})",
    r"[Dd]eadline\s+for\s+\w+\s+is\s+(?:[^,\n]{0,40}?,\s*)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # Generic "by [optional day name,] <date>" (broader catch)
    r"\bby\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\w+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})",
    r"\bby\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # "by Nov 19 2025" — abbreviated month, no comma
    r"\bby\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\w{3,9}\.?\s+\d{1,2}\s+\d{4})",
    # "on 31 March, 2025" / "on March 31, 2025" (date after "on")
    r"\bon\s+(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    r"\bon\s+(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})",
    # "until/through [day,] <date>"
    r"\b(?:until|through)\s+(?:(?:the\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(?:[^,\n]{0,40}?,\s*)?(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})",
    r"\b(?:until|through)\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # "Submissions Due: March 6, 2026" / "Due: ..."
    r"[Dd]ue[:\s]+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})",
    r"[Dd]ue[:\s]+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # "deadline of [day,] March 13, 2026"
    r"[Dd]eadline\s+of\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})",
    r"[Dd]eadline\s+of\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # "extended to [date]"
    r"extended\s+to\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})",
    r"extended\s+to\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # "Closing date/Closing of the call: <date>"
    r"[Cc]losing.{0,30}?(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})",
    r"[Cc]losing.{0,30}?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # Bare dates near deadline-related context (fallback)
    r"[Dd]eadline.{0,60}?(\w+\s+\d{1,2},\s+\d{4})",
    r"[Dd]eadline.{0,60}?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # Bare dates near submit-related context (fallback)
    r"[Ss]ubmi.{0,60}?(\w+\s+\d{1,2}(?:st|nd|rd|th)?,\s+\d{4})",
    r"[Ss]ubmi.{0,60}?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    # Reverse: date BEFORE keyword (e.g., "November 30th 2025 ... Closing")
    r"(\w+\s+\d{1,2}(?:st|nd|rd|th)?\s+\d{4}).{0,40}?(?:[Cc]losing|[Dd]eadline)",
    r"(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4}).{0,40}?(?:[Cc]losing|[Dd]eadline)",
]

def extract_deadline_from_text(text):
    for pattern in DEADLINE_PATTERNS:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            parsed = parse_date_flexible(match.group(1))
            if parsed:
                year = int(parsed[:4])
                if 2025 <= year <= 2028:
                    return parsed

    # Second pass: try patterns WITHOUT year (Month DD, DD Month, etc.)
    # and infer year from context
    NO_YEAR_PATTERNS = [
        # "is [Day,] DD Month" or "is [Day,] Month DD"
        r"deadline\s+is\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+)\b",
        r"deadline\s+is\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\w+\.?\s+\d{1,2}(?:st|nd|rd|th)?)\b",
        # "by/on/until [Day,] Month DDth" or "Month DD"
        r"(?:by|on|until|through|before)\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\w+\.?\s+\d{1,2}(?:st|nd|rd|th)?)\b",
        r"(?:by|on|until|through|before)\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+)\b",
        # "Deadline ... Month DD" / "Closing ... Month DD"
        r"[Dd]eadline.{0,60}?(\w+\s+\d{1,2}(?:st|nd|rd|th)?)\b",
        r"[Cc]losing.{0,30}?(\w+\s+\d{1,2}(?:st|nd|rd|th)?)\b",
        # "Due: Month DD"
        r"[Dd]ue[:\s]+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\w+\s+\d{1,2}(?:st|nd|rd|th)?)\b",
    ]
    from datetime import date as _date
    current_year = _date.today().year
    for pattern in NO_YEAR_PATTERNS:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            raw = match.group(1).strip().rstrip(".")
            # Try appending current year and next year, pick the one that makes sense
            for try_year in [current_year, current_year + 1, current_year - 1]:
                parsed = parse_date_flexible(raw + f", {try_year}")
                if not parsed:
                    parsed = parse_date_flexible(raw + f" {try_year}")
                if parsed:
                    return parsed

    return None

# --- Country Detection ---

INTERNATIONAL_CITIES = {
    "London": "UK", "Oxford": "UK", "Cambridge": "UK", "Edinburgh": "UK",
    "Manchester": "UK", "Durham": "UK", "Warwick": "UK", "Bristol": "UK",
    "Leeds": "UK", "Exeter": "UK", "Bath": "UK", "Lancaster": "UK",
    "Paris": "France", "Lyon": "France", "Toulouse": "France", "Megeve": "France",
    "Corsica": "France", "Nice": "France",
    "Berlin": "Germany", "Frankfurt": "Germany", "Munich": "Germany", "Mannheim": "Germany",
    "Bonn": "Germany", "Halle": "Germany",
    "Rome": "Italy", "Milan": "Italy", "Venice": "Italy", "Florence": "Italy",
    "Bologna": "Italy", "Capri": "Italy", "Naples": "Italy", "Rimini": "Italy",
    "Madrid": "Spain", "Barcelona": "Spain", "Bilbao": "Spain",
    "Amsterdam": "Netherlands", "Rotterdam": "Netherlands", "Tilburg": "Netherlands",
    "Maastricht": "Netherlands",
    "Zurich": "Switzerland", "Geneva": "Switzerland", "Lausanne": "Switzerland",
    "St. Gallen": "Switzerland", "Lugano": "Switzerland",
    "Brussels": "Belgium", "Leuven": "Belgium",
    "Copenhagen": "Denmark", "Lisbon": "Portugal",
    "Athens": "Greece", "Stockholm": "Sweden", "Helsinki": "Finland",
    "Dublin": "Ireland", "Oslo": "Norway", "Vienna": "Austria",
    "Prague": "Czech Republic", "Warsaw": "Poland", "Budapest": "Hungary",
    "Beijing": "China", "Shanghai": "China", "Hong Kong": "Hong Kong",
    "Shenzhen": "China", "Xiamen": "China",
    "Tokyo": "Japan", "Seoul": "South Korea", "Busan": "South Korea",
    "Singapore": "Singapore", "Sydney": "Australia", "Melbourne": "Australia",
    "Brisbane": "Australia", "Perth": "Australia",
    "Mumbai": "India", "Bangalore": "India",
    "Taipei": "Taiwan", "Bangkok": "Thailand", "Jakarta": "Indonesia",
    "Toronto": "Canada", "Vancouver": "Canada", "Montreal": "Canada",
    "Whistler": "Canada", "Calgary": "Canada", "Banff": "Canada",
    "Bali": "Indonesia", "Dubai": "UAE", "Sharjah": "UAE",
    "Reykjavik": "Iceland", "Vilnius": "Lithuania", "Tallinn": "Estonia",
    "Tel Aviv": "Israel", "Haifa": "Israel",
    "Hanoi": "Vietnam", "Ho Chi Minh": "Vietnam",
}

US_STATES = {
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
    "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
    "VA","WA","WV","WI","WY","DC",
}

def detect_country(location):
    if not location:
        return "Unknown"
    loc = location.strip()

    country_keywords = {
        "United Kingdom": "UK", "United States": "USA", "Australia": "Australia",
        "Canada": "Canada", "China": "China", "Japan": "Japan", "Germany": "Germany",
        "France": "France", "Italy": "Italy", "Spain": "Spain", "India": "India",
        "Singapore": "Singapore", "South Korea": "South Korea", "Brazil": "Brazil",
        "Switzerland": "Switzerland", "Netherlands": "Netherlands",
        "Sweden": "Sweden", "Denmark": "Denmark", "Finland": "Finland", "Norway": "Norway",
        "Ireland": "Ireland", "Portugal": "Portugal", "Greece": "Greece",
        "Israel": "Israel", "UAE": "UAE", "Saudi Arabia": "Saudi Arabia",
        "Turkey": "Turkey", "Indonesia": "Indonesia", "Thailand": "Thailand",
        "Taiwan": "Taiwan", "Vietnam": "Vietnam", "New Zealand": "New Zealand",
        "Czech Republic": "Czech Republic", "Poland": "Poland", "Hungary": "Hungary",
        "Austria": "Austria", "Belgium": "Belgium", "Korea": "South Korea",
        "Mexico": "Mexico", "Chile": "Chile", "Iceland": "Iceland",
    }

    for keyword, country in country_keywords.items():
        if keyword.lower() in loc.lower():
            return country

    for city, country in INTERNATIONAL_CITIES.items():
        if city.lower() in loc.lower():
            return country

    for state in US_STATES:
        if re.search(r'\b' + state + r'\b', loc):
            return "USA"

    if re.search(r'\b(virtual|online|zoom|remote)\b', loc, re.IGNORECASE):
        return "Virtual"

    return "Unknown"


def detect_disciplines(category, name):
    discs = set()
    cat = category.lower()
    nm = name.lower()
    if "finance" in cat: discs.add("fin")
    if "accounting" in cat: discs.add("acct")
    if "economics" in cat or "econ" in cat: discs.add("econ")
    if "accounting" in nm and "acct" not in discs: discs.add("acct")
    if any(w in nm for w in ["economics", "economic", "macroeconom"]) and "econ" not in discs: discs.add("econ")
    if "finance" in nm and "fin" not in discs: discs.add("fin")
    return sorted(discs) if discs else ["fin"]


# --- SSRN Scraping ---

def scrape_listing_page(page, network_name, network_id):
    """Scrape one SSRN network listing page. All entries are on a single page."""
    url = f"https://www.ssrn.com/index.cfm/en/janda/professional-announcements/?annsNet={network_id}"
    log.info(f"  [{network_name}] Loading {url}")

    try:
        page.goto(url, wait_until="networkidle", timeout=60000)
        time.sleep(PAGE_DELAY)
    except Exception as e:
        log.warning(f"  [{network_name}] Page load failed: {e}")
        return []

    # Extract conference entries from the listing page HTML
    entries = page.evaluate("""(confSections) => {
        const results = [];
        const headings = document.querySelectorAll('h4, h3');
        headings.forEach(heading => {
            const headingText = heading.textContent.trim();
            const isConference = confSections.some(s => headingText.includes(s));
            if (!isConference) return;
            let nextEl = heading.nextElementSibling;
            if (!nextEl || (nextEl.tagName !== 'UL' && nextEl.tagName !== 'OL')) return;
            const items = nextEl.querySelectorAll('li');
            items.forEach(li => {
                const link = li.querySelector('a[href*="/announcement/?id="]');
                if (!link) return;
                const entry = { name: link.textContent.trim(), href: link.href, dates: '', location: '', posted: '' };
                li.querySelectorAll('p').forEach(p => {
                    const text = p.textContent.trim();
                    if (text.startsWith('Conference Dates:') || text.startsWith('Date:'))
                        entry.dates = text.replace(/^(Conference Dates:|Date:)\\s*/, '').trim();
                    if (text.startsWith('Location:'))
                        entry.location = text.replace('Location:', '').trim();
                    if (text.startsWith('Posted:'))
                        entry.posted = text.replace('Posted:', '').trim();
                });
                const idMatch = link.href.match(/id=(\\d+)/);
                entry.sid = idMatch ? idMatch[1] : '';
                results.push(entry);
            });
        });
        if (results.length === 0) {
            document.querySelectorAll('a[href*="/announcement/?id="]').forEach(link => {
                const li = link.closest('li');
                if (!li) return;
                const entry = { name: link.textContent.trim(), href: link.href, dates: '', location: '', posted: '' };
                li.querySelectorAll('p').forEach(p => {
                    const text = p.textContent.trim();
                    if (text.startsWith('Conference Dates:') || text.startsWith('Date:'))
                        entry.dates = text.replace(/^(Conference Dates:|Date:)\\s*/, '').trim();
                    if (text.startsWith('Location:'))
                        entry.location = text.replace('Location:', '').trim();
                    if (text.startsWith('Posted:'))
                        entry.posted = text.replace('Posted:', '').trim();
                });
                const idMatch = link.href.match(/id=(\\d+)/);
                entry.sid = idMatch ? idMatch[1] : '';
                results.push(entry);
            });
        }
        return results;
    }""", CONFERENCE_SECTIONS)

    conferences = []
    for entry in entries:
        name_lower = entry["name"].lower()
        skip_keywords = [
            "phd", "doctoral position", "faculty position", "professor of",
            "call for chapters", "special issue", "journal of", "edited book",
            "tenure track", "research associate", "instructor", "lecturer",
            "fellowship", "scholarship",
        ]
        if any(kw in name_lower for kw in skip_keywords):
            continue
        entry["category"] = network_name
        entry["ssrnLink"] = entry.pop("href")
        conferences.append(entry)

    log.info(f"  [{network_name}] Found {len(conferences)} conferences (from {len(entries)} total entries)")
    return conferences


CONF_DATE_PATTERNS = [
    # "Conference Date(s): 11 Jul 2026" or "Conference Date: July 11-12, 2026"
    r"[Cc]onference\s+[Dd]ates?\s*[:\-]\s*(\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}(?:\s*[-–]\s*\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4})?)",
    r"[Cc]onference\s+[Dd]ates?\s*[:\-]\s*(\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*[-–]\s*\d{1,2}(?:st|nd|rd|th)?)?,?\s+\d{4})",
    # "Date(s) of Conference: ..."
    r"[Dd]ates?\s+of\s+(?:the\s+)?[Cc]onference\s*[:\-]\s*(\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}(?:\s*[-–]\s*\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4})?)",
    r"[Dd]ates?\s+of\s+(?:the\s+)?[Cc]onference\s*[:\-]\s*(\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*[-–]\s*\d{1,2}(?:st|nd|rd|th)?)?,?\s+\d{4})",
    # "Date: 11 Jul 2026" (standalone, typically at top of detail page)
    r"(?:^|\n)\s*[Dd]ate\s*:\s*(\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}(?:\s*[-–]\s*\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4})?)",
    r"(?:^|\n)\s*[Dd]ate\s*:\s*(\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*[-–]\s*\d{1,2}(?:st|nd|rd|th)?)?,?\s+\d{4})",
    # "will be held on 11 July 2026" / "takes place on July 11, 2026"
    r"(?:held|take[s]?\s+place)\s+(?:on\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    r"(?:held|take[s]?\s+place)\s+(?:on\s+)?(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})",
    # "will be held on DD-DD Month YYYY" / "Month DD-DD, YYYY"
    r"(?:held|take[s]?\s+place)\s+(?:on\s+)?(\d{1,2}(?:st|nd|rd|th)?[-–]\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    r"(?:held|take[s]?\s+place)\s+(?:on\s+)?(\w+\s+\d{1,2}(?:st|nd|rd|th)?[-–]\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})",
    # "scheduled for July 11, 2026"
    r"scheduled\s+for\s+(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})",
    r"scheduled\s+for\s+(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
]


def extract_conf_date_from_text(text):
    """Extract conference date from detail page text. Returns (startDate, displayDates) or (None, None)."""
    for pattern in CONF_DATE_PATTERNS:
        match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
        if match:
            raw = match.group(1).strip()
            start_date, display = parse_conf_dates(raw)
            if not start_date:
                # Try parse_date_flexible as fallback
                start_date = parse_date_flexible(raw)
                if start_date:
                    display = raw
            if start_date:
                year = int(start_date[:4])
                if 2025 <= year <= 2028:
                    return (start_date, display)
    return (None, None)


def scrape_detail_page(page, url):
    """Visit one SSRN announcement page and extract deadline + conference dates."""
    try:
        page.goto(url, wait_until="networkidle", timeout=30000)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(3000)
        
        # Check for Cloudflare
        content = page.content()
        if "Cloudflare" in content or "security verification" in content:
            log.warning(f"    Cloudflare detected on {url}. Waiting and retrying...")
            page.wait_for_timeout(8000)
            page.reload(wait_until="networkidle")
            page.wait_for_timeout(3000)
            content = page.content()
            if "Cloudflare" in content or "security verification" in content:
                log.error(f"    Cloudflare block persisted after retry on {url}")
                return {"deadline": None, "conf_date": (None, None)}

    except Exception as e:
        log.warning(f"    Page load failed for {url}: {e}")
        return {"deadline": None, "conf_date": (None, None)}

    full_text = page.evaluate("() => document.body ? document.body.innerText : ''")
    time.sleep(random.uniform(2, 5))
    
    deadline = extract_deadline_from_text(full_text)
    conf_date = extract_conf_date_from_text(full_text)
    
    return {"deadline": deadline, "conf_date": conf_date}


def scrape_deadline_from_page(page, url):
    """Legacy wrapper — returns just the deadline."""
    result = scrape_detail_page(page, url)
    return result["deadline"]


# --- Main Pipeline ---

def load_existing_json():
    if JSON_PATH.exists():
        with open(JSON_PATH, encoding="utf-8") as f:
            return json.load(f)
    return []


def merge_scraped_into_existing(existing, scraped):
    existing_by_sid = {str(c.get("sid", "")): c for c in existing}
    next_id = max((c.get("id", 0) for c in existing), default=0) + 1
    new_count = 0
    updated_count = 0

    for s in scraped:
        sid = str(s["sid"])
        if not sid:
            continue

        if sid in existing_by_sid:
            ex = existing_by_sid[sid]
            if s.get("deadline") and (not ex.get("deadline") or ex["deadline"] == "TBD"):
                ex["deadline"] = s["deadline"]
                updated_count += 1
                log.info(f"  Updated deadline: {ex['name'][:50]} -> {s['deadline']}")
            # Update dates from detail page extraction (conf_start/conf_display) or listing dates
            if s.get("conf_start"):
                old_start = ex.get("startDate", "")
                if not old_start or old_start.endswith("-01"):
                    ex["startDate"] = s["conf_start"]
                    if s.get("conf_display"):
                        ex["dates"] = s["conf_display"]
                    log.info(f"  Updated date from detail: {ex['name'][:50]} -> {s['conf_start']}")
            elif s.get("dates") and not ex.get("dates"):
                start_date, display = parse_conf_dates(s["dates"])
                if display: ex["dates"] = display
                if start_date and not ex.get("startDate"): ex["startDate"] = start_date
            if s.get("location") and not ex.get("location"):
                ex["location"] = s["location"]
                ex["country"] = detect_country(s["location"])
            for d in detect_disciplines(s.get("category", ""), s.get("name", "")):
                if d not in ex.get("disc", []):
                    ex.setdefault("disc", []).append(d)
        else:
            start_date, display_dates = parse_conf_dates(s.get("dates", ""))
            # Prefer detail-page dates over listing dates
            if s.get("conf_start"):
                start_date = s["conf_start"]
                display_dates = s.get("conf_display", display_dates)
            location = s.get("location", "")
            new_conf = {
                "id": next_id,
                "name": s["name"],
                "dates": display_dates or s.get("dates", ""),
                "startDate": start_date,
                "location": location,
                "country": detect_country(location),
                "disc": detect_disciplines(s.get("category", ""), s.get("name", "")),
                "sid": sid,
                "ssrnLink": s["ssrnLink"],
                "deadline": s.get("deadline", "TBD"),
                "url": "",
                "tier": "",
            }
            existing.append(new_conf)
            existing_by_sid[sid] = new_conf
            next_id += 1
            new_count += 1
            log.info(f"  NEW: {s['name'][:60]}")

    log.info(f"\nMerge: {new_count} new, {updated_count} deadlines updated")
    return existing


def run_full_scrape():
    from playwright.sync_api import sync_playwright

    existing = load_existing_json()
    existing_sids = {str(c.get("sid", "")) for c in existing}
    log.info(f"Loaded {len(existing)} existing conferences")

    all_scraped = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
            locale="en-US",
            timezone_id="America/New_York",
        )
        page = ctx.new_page()
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")


        # Phase 1: Listing pages
        log.info("\n=== PHASE 1: Scraping listing pages ===")
        for name, nid in NETWORKS.items():
            confs = scrape_listing_page(page, name, nid)
            all_scraped.extend(confs)
            time.sleep(random.uniform(2, 5))


        # Deduplicate by SID
        seen = {}
        for c in all_scraped:
            sid = c["sid"]
            if sid not in seen:
                seen[sid] = c
            else:
                old_cat = seen[sid].get("category", "")
                if c["category"] not in old_cat:
                    seen[sid]["category"] = old_cat + "," + c["category"]
        all_scraped = list(seen.values())

        log.info(f"\nTotal unique: {len(all_scraped)}")
        new_entries = [c for c in all_scraped if str(c["sid"]) not in existing_sids]
        log.info(f"New (not in JSON): {len(new_entries)}")

        # Phase 2: Visit pages for deadlines
        log.info("\n=== PHASE 2: Scraping deadlines ===")
        tbd_sids = {str(c.get("sid", "")) for c in existing if not c.get("deadline") or c["deadline"] == "TBD"}
        new_sids = {str(c["sid"]) for c in new_entries}
        sids_to_visit = new_sids | tbd_sids

        sid_to_url = {}
        for c in all_scraped:
            sid_to_url[c["sid"]] = c["ssrnLink"]
        for c in existing:
            sid = str(c.get("sid", ""))
            if sid in tbd_sids and c.get("ssrnLink"):
                sid_to_url[sid] = c["ssrnLink"]

        # Also visit pages for conferences with vague/missing dates
        vague_date_sids = set()
        for c in existing:
            sid = str(c.get("sid", ""))
            if not sid: continue
            start = c.get("startDate", "")
            # Vague = no startDate, or startDate ends in -01 (likely month-only guess)
            if not start or start.endswith("-01"):
                vague_date_sids.add(sid)
        
        sids_to_visit = sids_to_visit | vague_date_sids
        log.info(f"Pages to visit: {len(sids_to_visit)} ({len(new_sids)} new + {len(tbd_sids)} TBD deadlines + {len(vague_date_sids)} vague dates)")

        visited = 0
        deadlines_found = 0
        dates_found = 0
        
        for sid in sids_to_visit:
            url = sid_to_url.get(sid)
            if not url: continue

            visited += 1
            if visited % 20 == 0:
                log.info(f"  Progress: {visited}/{len(sids_to_visit)}...")

            result = scrape_detail_page(page, url)
            
            if result["deadline"]:
                deadlines_found += 1
                if sid in seen:
                    seen[sid]["deadline"] = result["deadline"]
                    log.info(f"  Deadline: {seen[sid]['name'][:50]} -> {result['deadline']}")
                for c in existing:
                    if str(c.get("sid", "")) == sid and (not c.get("deadline") or c["deadline"] == "TBD"):
                        c["deadline"] = result["deadline"]
                        break
            
            conf_start, conf_display = result["conf_date"]
            if conf_start:
                dates_found += 1
                # Update in seen dict
                if sid in seen:
                    seen[sid]["conf_start"] = conf_start
                    seen[sid]["conf_display"] = conf_display
                    log.info(f"  Conf date: {seen[sid]['name'][:50]} -> {conf_start} ({conf_display})")
                # Update in existing entries (if vague)
                for c in existing:
                    if str(c.get("sid", "")) == sid:
                        old_start = c.get("startDate", "")
                        if not old_start or old_start.endswith("-01"):
                            c["startDate"] = conf_start
                            if conf_display:
                                c["dates"] = conf_display
                            log.info(f"  Updated existing: {c['name'][:50]} startDate -> {conf_start}")
                        break

        log.info(f"\nPhase 2: visited {visited}, found {deadlines_found} deadlines, {dates_found} conference dates")
        browser.close()

    # Phase 3: Merge and save
    log.info("\n=== PHASE 3: Merge and save ===")
    result = merge_scraped_into_existing(existing, list(seen.values()))

    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    dl_set = sum(1 for c in result if c.get("deadline") and c["deadline"] != "TBD")
    tbd = sum(1 for c in result if not c.get("deadline") or c["deadline"] == "TBD")
    tiered = sum(1 for c in result if c.get("tier"))
    log.info(f"\nSaved {len(result)} conferences to {JSON_PATH}")
    log.info(f"Deadlines set: {dl_set} | TBD: {tbd} | Tiered: {tiered}")


def run_deadlines_only():
    from playwright.sync_api import sync_playwright

    existing = load_existing_json()
    tbd_confs = [c for c in existing if not c.get("deadline") or c["deadline"] == "TBD"]
    log.info(f"Loaded {len(existing)} conferences, {len(tbd_confs)} with TBD deadlines")

    if not tbd_confs:
        log.info("No TBD deadlines to check!")
        return

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
            locale="en-US",
            timezone_id="America/New_York",
        )
        page = ctx.new_page()
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

        found = 0
        for i, conf in enumerate(tbd_confs):
            if (i + 1) % 20 == 0:
                log.info(f"  Progress: {i+1}/{len(tbd_confs)}...")
            url = conf.get("ssrnLink", "")
            if not url: continue
            
            deadline = scrape_deadline_from_page(page, url)
            
            if deadline:
                conf["deadline"] = deadline
                found += 1
                log.info(f"  Found: {conf['name'][:50]} -> {deadline}")
            
            time.sleep(random.uniform(3, 7))


        browser.close()

    log.info(f"\nFound {found} deadlines out of {len(tbd_confs)} checked")
    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(existing, f, indent=2, ensure_ascii=False)
    log.info(f"Saved to {JSON_PATH}")


def run_new_only():
    """Check for new conferences only. Fast daily mode.
    1. Scrapes 3 listing pages (~30 sec)
    2. Finds new conferences not in JSON
    3. Visits only those pages for deadlines
    4. Adds them to JSON
    """
    from playwright.sync_api import sync_playwright

    existing = load_existing_json()
    existing_sids = {str(c.get("sid", "")) for c in existing}
    log.info(f"Loaded {len(existing)} existing conferences")

    all_scraped = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
            locale="en-US",
            timezone_id="America/New_York",
        )
        page = ctx.new_page()
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")


        # Phase 1: Scrape listing pages
        log.info("\n=== Checking for new conferences ===")
        for name, nid in NETWORKS.items():
            confs = scrape_listing_page(page, name, nid)
            all_scraped.extend(confs)
            time.sleep(random.uniform(2, 5))

        # Deduplicate
        seen = {}
        for c in all_scraped:
            sid = c["sid"]
            if sid not in seen:
                seen[sid] = c
            else:
                old_cat = seen[sid].get("category", "")
                if c["category"] not in old_cat:
                    seen[sid]["category"] = old_cat + "," + c["category"]

        new_entries = {sid: c for sid, c in seen.items() if sid not in existing_sids}
        log.info(f"\nTotal on SSRN: {len(seen)} | New: {len(new_entries)}")

        if not new_entries:
            log.info("No new conferences found. JSON unchanged.")
            browser.close()
            return

        # Phase 2: Visit only NEW conference pages for deadlines
        log.info(f"\n=== Fetching deadlines for {len(new_entries)} new conferences ===")
        deadlines_found = 0
        for i, (sid, conf) in enumerate(new_entries.items()):
            if (i + 1) % 10 == 0:
                log.info(f"  Progress: {i+1}/{len(new_entries)}...")

            deadline = scrape_deadline_from_page(page, conf["ssrnLink"])
            if deadline:
                conf["deadline"] = deadline
                deadlines_found += 1
                log.info(f"  Deadline: {conf['name'][:50]} -> {deadline}")

        log.info(f"Found deadlines for {deadlines_found}/{len(new_entries)} new conferences")
        browser.close()

    # Phase 3: Merge new entries into existing
    log.info("\n=== Adding new conferences ===")
    result = merge_scraped_into_existing(existing, list(new_entries.values()))

    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    dl_set = sum(1 for c in result if c.get("deadline") and c["deadline"] != "TBD")
    tbd = sum(1 for c in result if not c.get("deadline") or c["deadline"] == "TBD")
    log.info(f"\nSaved {len(result)} conferences to {JSON_PATH}")
    log.info(f"Deadlines set: {dl_set} | TBD: {tbd}")


def run_list_only():
    from playwright.sync_api import sync_playwright

    existing = load_existing_json()
    existing_sids = {str(c.get("sid", "")) for c in existing}
    log.info(f"Loaded {len(existing)} existing conferences")

    all_scraped = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
            locale="en-US",
            timezone_id="America/New_York",
        )
        page = ctx.new_page()
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

        for name, nid in NETWORKS.items():
            confs = scrape_listing_page(page, name, nid)
            all_scraped.extend(confs)
        browser.close()

    seen = {}
    for c in all_scraped:
        if c["sid"] not in seen:
            seen[c["sid"]] = c

    new_sids = [sid for sid in seen if sid not in existing_sids]
    log.info(f"\nTotal unique: {len(seen)} | New: {len(new_sids)}")
    for sid in new_sids[:30]:
        log.info(f"  NEW: {seen[sid]['name'][:60]}  (SID: {sid})")
    if len(new_sids) > 30:
        log.info(f"  ... and {len(new_sids) - 30} more")


# --- CLI ---

def main():
    parser = argparse.ArgumentParser(description="SSRN Conference Scraper")
    parser.add_argument("--new-only", action="store_true", help="Check for new conferences only (fast daily mode)")
    parser.add_argument("--deadlines-only", action="store_true", help="Only check TBD deadlines")
    parser.add_argument("--list-only", action="store_true", help="Only scrape listing pages (dry run)")
    parser.add_argument("--json", type=str, default="conferences.json", help="Path to conferences.json")
    args = parser.parse_args()

    global JSON_PATH
    JSON_PATH = Path(args.json)

    log.info("===========================================")
    log.info("  SSRN Conference Scraper")
    log.info(f"  Date: {date.today()}")
    log.info(f"  JSON: {JSON_PATH}")
    log.info("===========================================")

    try:
        if args.new_only:
            run_new_only()
        elif args.deadlines_only:
            run_deadlines_only()
        elif args.list_only:
            run_list_only()
        else:
            run_full_scrape()
    except ImportError:
        print("\n  Playwright not installed. Run:")
        print("    pip install playwright")
        print("    playwright install chromium")
        sys.exit(1)

    log.info("\nDone! Check scrape_log.txt for details.")

if __name__ == "__main__":
    main()

