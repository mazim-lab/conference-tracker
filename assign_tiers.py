#!/usr/bin/env python3
"""
Conference Tier Assigner
========================
Assigns tier 1/2/3 to conferences in conferences.json using:
  1. A curated reference dictionary with fuzzy matching (~150+ known conferences)
  2. Claude API fallback for unknown conferences

Tier definitions:
  1 = Elite (NBER, AFA, WFA, SFS Cavalcade, JAR/JAE conferences, top invite-only)
  2 = Strong (EFA, FIRS, FMA, AAA Annual, NFA, CEPR, EEA-ESEM, good field conferences)
  3 = Regional/niche/newer (directional FAs, workshops, regional meetings, new conferences)

Setup:
    pip install anthropic           # Only needed for Claude API fallback
    set ANTHROPIC_API_KEY=sk-...    # Your API key (Windows)
    export ANTHROPIC_API_KEY=sk-... # Your API key (Mac/Linux)

Usage:
    python assign_tiers.py                  # Assign tiers to all untiered conferences
    python assign_tiers.py --all            # Re-assign ALL tiers (overwrites existing)
    python assign_tiers.py --no-api         # Reference dict only, skip Claude API
    python assign_tiers.py --dry-run        # Preview changes without saving
"""

import json, re, os, sys, argparse, logging
from pathlib import Path
from difflib import SequenceMatcher

# --- Configuration ---
JSON_PATH = Path("conferences.json")
LOG_PATH = Path("tier_log.txt")

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

# ─────────────────────────────────────────────────────────────────────────────
# TIER REFERENCE DICTIONARY
# ─────────────────────────────────────────────────────────────────────────────
# Each entry: (pattern, tier, discipline_hint)
# Pattern is matched against the conference name (case-insensitive, partial match)
# More specific patterns should come FIRST (matched top-to-bottom, first match wins)

TIER_REFERENCE = [
    # ══════════════════════════════════════════════════════════════════════════
    # TIER 1 — FINANCE
    # ══════════════════════════════════════════════════════════════════════════
    ("American Finance Association", 1, "fin"),
    ("AFA Annual Meeting", 1, "fin"),
    ("Western Finance Association", 1, "fin"),
    ("WFA Annual Meeting", 1, "fin"),
    ("WFA Meeting", 1, "fin"),
    ("Society for Financial Studies Cavalcade", 1, "fin"),
    ("SFS Cavalcade", 1, "fin"),
    ("SFS Finance Cavalcade", 1, "fin"),
    ("NBER Corporate Finance", 1, "fin"),
    ("NBER Asset Pricing", 1, "fin"),
    ("NBER Summer Institute", 1, "econ"),
    ("NBER Behavioral Finance", 1, "fin"),
    ("NBER Monetary Economics", 1, "econ"),
    ("NBER International Finance", 1, "fin"),
    ("NBER Macro", 1, "econ"),
    ("NBER Risk", 1, "fin"),
    ("NBER Household Finance", 1, "fin"),
    ("NBER Entrepreneurship", 1, "fin"),
    ("NBER Insurance", 1, "fin"),
    ("Utah Winter Finance", 1, "fin"),
    ("Texas Finance Festival", 1, "fin"),
    ("Financial Research Association", 1, "fin"),
    ("FRA Annual Meeting", 1, "fin"),
    ("FRA Conference", 1, "fin"),
    ("Jackson Hole Finance", 1, "fin"),
    ("Finance Theory Group", 1, "fin"),
    ("FTG Meeting", 1, "fin"),
    ("FTG Summer", 1, "fin"),
    ("Macro Finance Society", 1, "fin"),
    ("Duke-UNC Corporate Finance", 1, "fin"),
    ("Labor and Finance Group", 1, "fin"),
    ("Five Star Conference", 1, "fin"),
    ("Red Rock Finance", 1, "fin"),
    ("Napa Conference on Financial Markets", 1, "fin"),
    ("FMA Napa Conference", 1, "fin"),
    ("Colorado Finance Summit", 1, "fin"),
    ("Olin Business School Finance Conference", 1, "fin"),
    ("Wharton Conference on Liquidity", 1, "fin"),
    ("RCFS Winter Conference", 1, "fin"),
    ("Review of Corporate Finance Studies", 1, "fin"),
    ("Tuck School of Business Conference", 1, "fin"),

    # ══════════════════════════════════════════════════════════════════════════
    # TIER 1 — ACCOUNTING
    # ══════════════════════════════════════════════════════════════════════════
    ("Journal of Accounting Research Conference", 1, "acct"),
    ("JAR Conference", 1, "acct"),
    ("Journal of Accounting and Economics Conference", 1, "acct"),
    ("JAE Conference", 1, "acct"),
    ("Review of Accounting Studies Conference", 1, "acct"),
    ("RAST Conference", 1, "acct"),
    ("Contemporary Accounting Research Conference", 1, "acct"),
    ("CAR Conference", 1, "acct"),
    ("Stanford Accounting Research Summer Camp", 1, "acct"),
    ("Columbia Burton Conference", 1, "acct"),
    ("London Business School Accounting Symposium", 1, "acct"),
    ("LBS Accounting Symposium", 1, "acct"),
    ("MIT Asia Accounting Conference", 1, "acct"),
    ("MIT Asia Conference", 1, "acct"),
    ("Dartmouth Accounting Research Conference", 1, "acct"),
    ("Yale Accounting Conference", 1, "acct"),
    ("Chicago Booth Accounting", 1, "acct"),
    ("Accounting Organizations and Society", 1, "acct"),

    # ══════════════════════════════════════════════════════════════════════════
    # TIER 1 — ECONOMICS
    # ══════════════════════════════════════════════════════════════════════════
    ("American Economic Association", 1, "econ"),
    ("AEA Annual Meeting", 1, "econ"),
    ("AEA/ASSA", 1, "econ"),
    ("ASSA Annual Meeting", 1, "econ"),
    ("ASSA Meeting", 1, "econ"),
    ("Econometric Society World Congress", 1, "econ"),
    ("Econometric Society North American", 1, "econ"),
    ("Econometric Society European", 1, "econ"),
    ("Econometric Society Meeting", 1, "econ"),
    ("NBER Summer Institute", 1, "econ"),
    ("NBER Economic Fluctuations", 1, "econ"),
    ("NBER Public Economics", 1, "econ"),
    ("NBER Labor", 1, "econ"),
    ("NBER International Trade", 1, "econ"),
    ("NBER Industrial Organization", 1, "econ"),
    ("NBER Development", 1, "econ"),
    ("NBER Productivity", 1, "econ"),
    ("NBER Political Economy", 1, "econ"),
    ("NBER Health", 1, "econ"),
    ("NBER Education", 1, "econ"),
    ("NBER Children", 1, "econ"),
    ("NBER Aging", 1, "econ"),
    ("NBER Law and Economics", 1, "econ"),
    ("NBER Environmental", 1, "econ"),
    ("NBER China", 1, "econ"),
    ("Jackson Hole Economic Symposium", 1, "econ"),
    ("Federal Reserve Jackson Hole", 1, "econ"),

    # ══════════════════════════════════════════════════════════════════════════
    # TIER 2 — FINANCE
    # ══════════════════════════════════════════════════════════════════════════
    ("European Finance Association", 2, "fin"),
    ("EFA Annual Meeting", 2, "fin"),
    ("EFA Meeting", 2, "fin"),
    ("Financial Intermediation Research Society", 2, "fin"),
    ("FIRS Conference", 2, "fin"),
    ("FIRS Annual", 2, "fin"),
    ("Financial Management Association", 2, "fin"),
    ("FMA Annual Meeting", 2, "fin"),
    ("FMA Asia", 2, "fin"),
    ("FMA European", 2, "fin"),
    ("Northern Finance Association", 2, "fin"),
    ("NFA Annual Meeting", 2, "fin"),
    ("NFA Conference", 2, "fin"),
    ("China International Conference in Finance", 2, "fin"),
    ("CICF", 2, "fin"),
    ("European Financial Management Association", 2, "fin"),
    ("EFMA Annual Meeting", 2, "fin"),
    ("EFMA Conference", 2, "fin"),
    ("Paris December Finance Meeting", 2, "fin"),
    ("EUROFIDAI", 2, "fin"),
    ("Paris Finance Meeting", 2, "fin"),
    ("CEPR Annual Symposium", 2, "fin"),
    ("CEPR European Corporate Governance", 2, "fin"),
    ("CEPR Household Finance", 2, "fin"),
    ("CEPR Financial Economics", 2, "fin"),
    ("ECGI", 2, "fin"),
    ("Adam Smith Workshop", 2, "fin"),
    ("Helsinki Finance Summit", 2, "fin"),
    ("Swiss Finance Institute", 2, "fin"),
    ("SFI Research Days", 2, "fin"),
    ("European Winter Finance Summit", 2, "fin"),
    ("European Winter Finance Conference", 2, "fin"),
    ("ABFER Annual Conference", 2, "fin"),
    ("Frontiers in Finance", 2, "fin"),
    ("Frontiers of Factor Investing", 2, "fin"),
    ("Front Range Finance", 2, "fin"),
    ("Finance Down Under", 2, "fin"),
    ("FIRN Annual", 2, "fin"),
    ("Asian Finance Association", 2, "fin"),
    ("AsianFA", 2, "fin"),
    ("Pacific Basin Finance", 2, "fin"),
    ("Australasian Finance and Banking", 2, "fin"),
    ("AFBC", 2, "fin"),
    ("European Banking Center", 2, "fin"),
    ("Federal Reserve Bank", 2, "fin"),
    ("Fed Conference", 2, "fin"),
    ("Mitsui Finance Symposium", 2, "fin"),
    ("Financial Stability Conference", 2, "fin"),
    ("Systemic Risk", 2, "fin"),
    ("SAFE Conference", 2, "fin"),
    ("Macro Finance Workshop", 2, "fin"),
    ("SFS Cavalcade Asia-Pacific", 2, "fin"),
    ("Finance Forum", 2, "fin"),
    ("Spanish Finance Forum", 2, "fin"),
    ("Swiss Society for Financial Market Research", 2, "fin"),
    ("SGF Conference", 2, "fin"),
    ("Financial Globalization", 2, "fin"),
    ("Behavioral Finance Working Group", 2, "fin"),
    ("Cass Business School", 2, "fin"),
    ("European Market Microstructure", 2, "fin"),
    ("Market Microstructure", 2, "fin"),
    ("Financial Econometrics", 2, "fin"),
    ("Risk Management Conference", 2, "fin"),
    ("Corporate Governance Conference", 2, "fin"),
    ("FinTech Conference", 2, "fin"),
    ("AI in Finance Conference", 2, "fin"),
    ("ABFER", 2, "fin"),
    ("AFFI", 2, "fin"),
    ("French Finance Association", 2, "fin"),
    ("German Finance Association", 2, "fin"),
    ("DGF Annual Meeting", 2, "fin"),

    # ══════════════════════════════════════════════════════════════════════════
    # TIER 2 — ACCOUNTING
    # ══════════════════════════════════════════════════════════════════════════
    ("American Accounting Association Annual", 2, "acct"),
    ("AAA Annual Meeting", 2, "acct"),
    ("AAA/AICPA", 2, "acct"),
    ("AAA Auditing Section", 2, "acct"),
    ("AAA FARS", 2, "acct"),
    ("AAA Financial Accounting", 2, "acct"),
    ("AAA Management Accounting", 2, "acct"),
    ("AAA International Accounting", 2, "acct"),
    ("AAA Tax Section", 2, "acct"),
    ("CAAA Annual Conference", 2, "acct"),
    ("Canadian Academic Accounting", 2, "acct"),
    ("Journal of Business Finance and Accounting", 2, "acct"),
    ("JBFA Conference", 2, "acct"),
    ("European Accounting Association", 2, "acct"),
    ("EAA Annual Congress", 2, "acct"),
    ("European Auditing Research", 2, "acct"),
    ("International Accounting Section", 2, "acct"),
    ("Accounting Research Workshop", 2, "acct"),
    ("Tax Symposium", 2, "acct"),
    ("Hawaii Accounting Research", 2, "acct"),
    ("BYU Accounting Research", 2, "acct"),
    ("Colorado Summer Accounting", 2, "acct"),
    ("Lone Star Accounting Research", 2, "acct"),
    ("Midwest Accounting Research", 2, "acct"),
    ("MARC Conference", 2, "acct"),
    ("USC Leventhal Accounting", 2, "acct"),
    ("AFAANZ", 2, "acct"),

    # ══════════════════════════════════════════════════════════════════════════
    # TIER 2 — ECONOMICS
    # ══════════════════════════════════════════════════════════════════════════
    ("European Economic Association", 2, "econ"),
    ("EEA Annual Congress", 2, "econ"),
    ("EEA-ESEM", 2, "econ"),
    ("Royal Economic Society", 2, "econ"),
    ("RES Annual Conference", 2, "econ"),
    ("CEPR Annual", 2, "econ"),
    ("CEPR European Summer Symposium", 2, "econ"),
    ("ESSLE", 2, "econ"),
    ("CEPR ESSIM", 2, "econ"),
    ("CEPR/NBER International Seminar", 2, "econ"),
    ("Society of Labor Economists", 2, "econ"),
    ("SOLE Annual Meeting", 2, "econ"),
    ("European Association of Labour Economists", 2, "econ"),
    ("EALE Conference", 2, "econ"),
    ("International Industrial Organization", 2, "econ"),
    ("IIOC Conference", 2, "econ"),
    ("Society for Economic Dynamics", 2, "econ"),
    ("SED Annual Meeting", 2, "econ"),
    ("Midwest Economics Association", 2, "econ"),
    ("Midwest Macro", 2, "econ"),
    ("Barcelona Summer Forum", 2, "econ"),
    ("Barcelona GSE Summer Forum", 2, "econ"),
    ("Cowles Foundation", 2, "econ"),
    ("Society for Computational Economics", 2, "econ"),
    ("International Association for Applied Econometrics", 2, "econ"),
    ("IAAE Annual Conference", 2, "econ"),
    ("Association for Public Economic Theory", 2, "econ"),
    ("PET Annual Conference", 2, "econ"),
    ("Society for the Advancement of Economic Theory", 2, "econ"),
    ("SAET Conference", 2, "econ"),
    ("North American Econometric Society", 2, "econ"),
    ("European Econometric Society", 2, "econ"),
    ("Asian Econometric Society", 2, "econ"),
    ("International Finance and Banking Society", 2, "fin"),
    ("IFABS", 2, "fin"),
    ("World Finance Conference", 2, "fin"),
    ("Annual Bank Research Conference", 2, "econ"),
    ("Community Bank Research", 2, "fin"),
    ("Bank of England", 2, "econ"),
    ("Bank of Finland", 2, "econ"),
    ("Bundesbank", 2, "econ"),
    ("ECB Conference", 2, "econ"),

    # ══════════════════════════════════════════════════════════════════════════
    # TIER 3 — FINANCE
    # ══════════════════════════════════════════════════════════════════════════
    ("Southern Finance Association", 3, "fin"),
    ("SFA Annual Meeting", 3, "fin"),
    ("Southwestern Finance Association", 3, "fin"),
    ("SWFA Annual Meeting", 3, "fin"),
    ("Eastern Finance Association", 3, "fin"),
    ("EFA Eastern", 3, "fin"),
    ("Midwest Finance Association", 3, "fin"),
    ("MFA Annual Meeting", 3, "fin"),
    ("Academy of Economics and Finance", 3, "fin"),
    ("AEF Annual Meeting", 3, "fin"),
    ("Global Finance Conference", 3, "fin"),
    ("Global Finance Association", 3, "fin"),
    ("International Atlantic Economic", 3, "fin"),
    ("Multinational Finance", 3, "fin"),
    ("MFS Conference", 3, "fin"),
    ("Wolpertinger Conference", 3, "fin"),
    ("FEBS Conference", 3, "fin"),
    ("Financial Engineering and Banking Society", 3, "fin"),
    ("Infiniti Conference", 3, "fin"),
    ("International Finance and Banking", 3, "fin"),
    ("Emerging Markets Finance", 3, "fin"),
    ("Vietnam Symposium", 3, "fin"),
    ("Indonesian Finance Association", 3, "fin"),
    ("New Zealand Finance", 3, "fin"),
    ("Indian Finance", 3, "fin"),
    ("African Finance", 3, "fin"),
    ("International Conference on Accounting and Finance", 3, "fin"),
    ("Islamic Finance", 3, "fin"),
    ("Sustainable Finance", 3, "fin"),
    ("World Finance & Banking Symposium", 3, "fin"),
    ("International Risk Management", 3, "fin"),
    ("IRMC", 3, "fin"),
    ("Annual Conference on Finance", 3, "fin"),
    ("Behavioral Finance Conference", 3, "fin"),

    # ══════════════════════════════════════════════════════════════════════════
    # TIER 3 — ACCOUNTING
    # ══════════════════════════════════════════════════════════════════════════
    ("AAA Regional", 3, "acct"),
    ("AAA Midwest", 3, "acct"),
    ("AAA Southeast", 3, "acct"),
    ("AAA Ohio", 3, "acct"),
    ("AAA Northeast", 3, "acct"),
    ("AAA Southwest", 3, "acct"),
    ("AAA Western", 3, "acct"),
    ("Accounting PhD Rookie Camp", 3, "acct"),
    ("International Accounting Conference", 3, "acct"),
    ("Asian Academic Accounting", 3, "acct"),
    ("Japanese Accounting Review", 3, "acct"),
    ("JAAF Symposium", 3, "acct"),
    ("Global Management Accounting", 3, "acct"),
    ("GMARS", 3, "acct"),

    # ══════════════════════════════════════════════════════════════════════════
    # TIER 3 — ECONOMICS
    # ══════════════════════════════════════════════════════════════════════════
    ("Southern Economic Association", 3, "econ"),
    ("SEA Annual Meeting", 3, "econ"),
    ("Eastern Economic Association", 3, "econ"),
    ("Western Economic Association", 3, "econ"),
    ("WEAI Annual Conference", 3, "econ"),
    ("Missouri Valley Economic", 3, "econ"),
    ("Atlantic Economic Conference", 3, "econ"),
    ("International Economics and Finance", 3, "econ"),
    ("Rimini Centre for Economic Analysis", 3, "econ"),
    ("Asia-Pacific Applied Economics", 3, "econ"),
    ("International Conference on Economics", 3, "econ"),
    ("Annual International Conference", 3, "econ"),
]


# ─────────────────────────────────────────────────────────────────────────────
# FUZZY MATCHING
# ─────────────────────────────────────────────────────────────────────────────

def normalize_name(name):
    """Normalize conference name for matching."""
    name = name.lower()
    # Remove common prefixes
    for prefix in ["call for papers:", "call for papers -", "call for papers", "cfp:", "cfp -"]:
        if name.startswith(prefix):
            name = name[len(prefix):]
    # Remove year patterns
    name = re.sub(r'\b20\d{2}\b', '', name)
    # Remove ordinal numbers (1st, 2nd, 3rd, 4th, 5th, etc.)
    name = re.sub(r'\b\d+(st|nd|rd|th)\b', '', name)
    # Remove standalone numbers
    name = re.sub(r'\b\d+\b', '', name)
    # Clean up extra spaces
    name = re.sub(r'\s+', ' ', name).strip()
    return name


def match_reference(conf_name):
    """
    Try to match conference name against reference dictionary.
    Returns (tier, method) or (None, None) if no match.
    """
    normalized = normalize_name(conf_name)
    name_lower = conf_name.lower()

    # Pass 1: Direct substring match (fast, high confidence)
    for pattern, tier, disc in TIER_REFERENCE:
        if pattern.lower() in name_lower:
            return tier, f"exact:{pattern}"

    # Pass 2: Normalized substring match
    for pattern, tier, disc in TIER_REFERENCE:
        if pattern.lower() in normalized:
            return tier, f"normalized:{pattern}"

    # Pass 3: Fuzzy match (slower, for slight variations)
    best_score = 0
    best_tier = None
    best_pattern = None

    for pattern, tier, disc in TIER_REFERENCE:
        # Use SequenceMatcher for fuzzy comparison
        score = SequenceMatcher(None, normalized, normalize_name(pattern)).ratio()
        if score > best_score:
            best_score = score
            best_tier = tier
            best_pattern = pattern

    if best_score >= 0.70:  # 70% similarity threshold
        return best_tier, f"fuzzy({best_score:.0%}):{best_pattern}"

    return None, None


# ─────────────────────────────────────────────────────────────────────────────
# CLAUDE API FALLBACK
# ─────────────────────────────────────────────────────────────────────────────

def assign_tier_via_api(conferences):
    """
    Use Claude API to assign tiers to unknown conferences.
    Sends conferences in batches for efficiency.
    Returns dict of {conf_id: tier}.
    """
    try:
        import anthropic
    except ImportError:
        log.warning("anthropic package not installed. Run: pip install anthropic")
        return {}

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log.warning("ANTHROPIC_API_KEY not set. Skipping API tier assignment.")
        return {}

    client = anthropic.Anthropic(api_key=api_key)
    results = {}

    # Process in batches of 20
    batch_size = 20
    for i in range(0, len(conferences), batch_size):
        batch = conferences[i:i+batch_size]

        conf_list = ""
        for conf in batch:
            disc_str = ", ".join(conf.get("disc", []))
            location = conf.get("location", "Unknown")
            conf_list += f'- ID:{conf["id"]} | Name: {conf["name"]} | Discipline: {disc_str} | Location: {location}\n'

        prompt = f"""You are an expert in academic finance, accounting, and economics conferences. 
Assign a tier (1, 2, or 3) to each conference below.

Tier definitions:
- Tier 1: Elite conferences. Very selective, invite-only or <10% acceptance rate. Papers presented here frequently appear in top-5 journals (JF, JFE, RFS for finance; JAR, JAE, TAR for accounting; AER, QJE, JPE, Ecta, RES for economics). Examples: AFA, WFA, NBER workshops, SFS Cavalcade, Utah Winter Finance, JAR Conference.
- Tier 2: Strong, well-regarded conferences. Respected association meetings and good field conferences. Regular acceptance rates, strong programs. Examples: EFA, FIRS, FMA, AAA Annual, NFA, EEA-ESEM, CEPR workshops, Paris December Finance Meeting.
- Tier 3: Regional, niche, or newer conferences. Broader acceptance, less selective, or focused on a narrow audience. Examples: directional FAs (SFA, SWFA), regional economics meetings, country-specific conferences, newer/smaller workshops.

If you cannot determine the tier with reasonable confidence, assign tier 3 as default.

Conferences to classify:
{conf_list}

Respond with ONLY a JSON object mapping IDs to tiers, like:
{{"123": 2, "456": 3, "789": 1}}

No other text. Just the JSON object."""

        try:
            response = client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=1000,
                messages=[{"role": "user", "content": prompt}],
            )
            text = response.content[0].text.strip()
            # Parse JSON response
            text = re.sub(r'```json\s*', '', text)
            text = re.sub(r'```\s*', '', text)
            tier_map = json.loads(text)

            for conf_id_str, tier in tier_map.items():
                conf_id = int(conf_id_str)
                tier = int(tier)
                if tier in (1, 2, 3):
                    results[conf_id] = tier

            log.info(f"  API batch {i//batch_size + 1}: classified {len(tier_map)} conferences")

        except Exception as e:
            log.warning(f"  API batch {i//batch_size + 1} failed: {e}")
            continue

    return results


# ─────────────────────────────────────────────────────────────────────────────
# MAIN PIPELINE
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Assign tiers to conferences")
    parser.add_argument("--all", action="store_true", help="Re-assign ALL tiers (overwrite existing)")
    parser.add_argument("--no-api", action="store_true", help="Skip Claude API fallback")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without saving")
    parser.add_argument("--json", type=str, default="conferences.json", help="Path to conferences.json")
    args = parser.parse_args()

    global JSON_PATH
    JSON_PATH = Path(args.json)

    log.info("===========================================")
    log.info("  Conference Tier Assigner")
    log.info("===========================================")

    # Load conferences
    with open(JSON_PATH, encoding="utf-8") as f:
        conferences = json.load(f)

    log.info(f"Loaded {len(conferences)} conferences")

    # Determine which conferences need tiers
    if args.all:
        to_assign = conferences
        log.info("Mode: Re-assign ALL tiers")
    else:
        to_assign = [c for c in conferences if not c.get("tier")]
        log.info(f"Conferences without tiers: {len(to_assign)}")

    if not to_assign:
        log.info("Nothing to assign!")
        return

    # Phase 1: Reference dictionary matching
    log.info("\n=== Phase 1: Reference dictionary matching ===")
    matched = 0
    unmatched = []

    for conf in to_assign:
        tier, method = match_reference(conf["name"])
        if tier is not None:
            conf["tier"] = str(tier)
            matched += 1
            log.info(f"  [{tier}] {conf['name'][:60]} ({method})")
        else:
            unmatched.append(conf)

    log.info(f"\nMatched: {matched}/{len(to_assign)} | Unmatched: {len(unmatched)}")

    # Phase 2: Claude API fallback
    if unmatched and not args.no_api:
        log.info(f"\n=== Phase 2: Claude API for {len(unmatched)} unknowns ===")
        api_results = assign_tier_via_api(unmatched)

        api_assigned = 0
        for conf in unmatched:
            if conf["id"] in api_results:
                conf["tier"] = str(api_results[conf["id"]])
                api_assigned += 1
                log.info(f"  [{conf['tier']}] {conf['name'][:60]} (api)")

        still_unmatched = [c for c in unmatched if not c.get("tier")]
        log.info(f"\nAPI assigned: {api_assigned} | Still unmatched: {len(still_unmatched)}")

        # Default remaining to tier 3
        for conf in still_unmatched:
            conf["tier"] = "3"
            log.info(f"  [3] {conf['name'][:60]} (default)")

    elif unmatched and args.no_api:
        log.info(f"\n=== Skipping API (--no-api flag) ===")
        log.info(f"{len(unmatched)} conferences left untiered:")
        for conf in unmatched[:20]:
            log.info(f"  ? {conf['name'][:60]}")
        if len(unmatched) > 20:
            log.info(f"  ... and {len(unmatched) - 20} more")

    # Summary
    tier_counts = {"1": 0, "2": 0, "3": 0, "": 0}
    for c in conferences:
        t = c.get("tier", "")
        tier_counts[t] = tier_counts.get(t, 0) + 1

    log.info(f"\n=== SUMMARY ===")
    log.info(f"Tier 1: {tier_counts.get('1', 0)}")
    log.info(f"Tier 2: {tier_counts.get('2', 0)}")
    log.info(f"Tier 3: {tier_counts.get('3', 0)}")
    log.info(f"No tier: {tier_counts.get('', 0)}")

    # Save
    if not args.dry_run:
        with open(JSON_PATH, "w", encoding="utf-8") as f:
            json.dump(conferences, f, indent=2, ensure_ascii=False)
        log.info(f"\nSaved to {JSON_PATH}")
    else:
        log.info(f"\n(Dry run — no changes saved)")

    log.info("\nDone! Check tier_log.txt for details.")


if __name__ == "__main__":
    main()
