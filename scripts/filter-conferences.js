const fs = require('fs');
const path = require('path');

const CONF_PATH = path.join(__dirname, '..', 'conferences.json');

const MONTH_MAP = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  january: '01', february: '02', march: '03', april: '04', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
};

function normalizeDate(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // "Month DD, YYYY" or "Mon DD, YYYY"
  let m = s.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (m) {
    const mon = MONTH_MAP[m[1].toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[2].padStart(2, '0')}`;
  }

  // "Mon DD" or "Month DD" (no year — assume 2026)
  m = s.match(/^([a-z]+)\s+(\d{1,2})$/i);
  if (m) {
    const mon = MONTH_MAP[m[1].toLowerCase()];
    if (mon) return `2026-${mon}-${m[2].padStart(2, '0')}`;
  }

  return null;
}

// Items that are clearly NOT conferences
const JUNK_PATTERNS = [
  /\bsummer school\b/i,
  /\bdoctoral (internship|colloquium|consortium)\b/i,
  /\bph\.?d\.?\s+(in |program)/i,
  /\b(research |data )?grant/i,
  /\bcall for (proposals|applications|registration|research projects)\b/i,
  /\b(prize|award)\b.*\b(call|nomination|winner|recipient)\b/i,
  /\b(winner|recipient).*\b(prize|award)\b/i,
  /\bhackathon\b/i,
  /\bwebinar\b/i,
  /\bstudent research competition\b/i,
  /\bdissertation (proposal |grant)/i,
  /\bpostdoc(toral)?\s+(research |position)/i,
  /\bassistant professor(ship)?\b/i,
  /\bfully funded\b/i,
  /\bcall for papers!\s/i,  // "Call for papers!" standalone announcements (not conf titles)
  /\bfinance theory insights:/i,
  /\bregistrations? (now )?open\b/i,
  /\bcollaborating with fintechs\b/i,
  /\bdata science.*call\b/i,
  /\b(econometrics|bayesian).*volume\b/i,
  /\bestimating the impact\b/i,  // research paper announcements
  /\becomod school\b/i,
  /\bmemorial (prize|award)\b/i,
];

// Safelist: real conferences that might match junk patterns
const SAFELIST_PATTERNS = [
  /annual meeting/i,
  /annual conference/i,
  /midyear meeting/i,
  /finance conference/i,
  /accounting conference/i,
  /economics conference/i,
  /annual congress/i,
  /ski conference/i,
  /winter finance/i,
  /summer (finance|accounting)/i,
  /\bworkshop\b/i,
  /\bsymposium\b/i,
  /\bforum\b/i,
  /\bsummit\b/i,
];

function isJunk(name) {
  const n = name.trim();
  for (const pat of JUNK_PATTERNS) {
    if (pat.test(n)) {
      // Check safelist — if it also matches a conference pattern, keep it
      for (const safe of SAFELIST_PATTERNS) {
        if (safe.test(n)) return false;
      }
      return true;
    }
  }
  return false;
}

function run() {
  const data = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
  const initial = data.length;

  let normalized = 0, removed = 0;
  const kept = [];
  const removedItems = [];

  for (const c of data) {
    // Step 1: Normalize startDate
    if (c.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(c.startDate)) {
      const nd = normalizeDate(c.startDate);
      if (nd) {
        console.log(`[NORM] startDate: "${c.startDate}" -> "${nd}" | ${c.name.slice(0, 60)}`);
        c.startDate = nd;
        normalized++;
      }
    }

    // Step 1b: Normalize deadline
    if (c.deadline && c.deadline !== 'TBD' && !/^\d{4}-\d{2}-\d{2}$/.test(c.deadline)) {
      const nd = normalizeDate(c.deadline);
      if (nd) {
        console.log(`[NORM] deadline: "${c.deadline}" -> "${nd}" | ${c.name.slice(0, 60)}`);
        c.deadline = nd;
      } else if (c.deadline === 'Closed') {
        c.deadline = 'TBD';
      }
    }

    // Step 2: Remove items with no startDate at all
    if (!c.startDate) {
      // Check if it's a real conference (has dates string suggesting a real event)
      if (isJunk(c.name)) {
        removedItems.push({ name: c.name, reason: 'No startDate + junk name' });
        removed++;
        continue;
      }
      // Keep conferences without startDate but warn
      console.log(`[WARN] No startDate but keeping: ${c.name.slice(0, 70)}`);
      kept.push(c);
      continue;
    }

    // Step 3: Remove pure junk with no valid startDate
    if (!c.startDate && isJunk(c.name)) {
      removedItems.push({ name: c.name, reason: 'Junk name, no date' });
      removed++;
      continue;
    }

    kept.push(c);
  }

  fs.writeFileSync(CONF_PATH, JSON.stringify(kept, null, 2));

  console.log(`\n=== Results ===`);
  console.log(`Before: ${initial}`);
  console.log(`After:  ${kept.length}`);
  console.log(`Removed: ${removed}`);
  console.log(`Dates normalized: ${normalized}`);

  if (removedItems.length > 0) {
    console.log(`\nRemoved items:`);
    removedItems.forEach(r => console.log(`  [${r.reason}] ${r.name.slice(0, 80)}`));
  }
}

run();
