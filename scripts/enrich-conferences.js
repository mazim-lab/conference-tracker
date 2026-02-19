#!/usr/bin/env node
/**
 * Conference Enrichment Pipeline (Pass 2)
 * 
 * Fills missing data (deadlines, dates, locations) using:
 *   1. Direct web_fetch of conference URL or SSRN link
 *   2. Brave Search API for conferences without URLs
 *   3. AAA-specific: fetch /Submissions pages for deadlines
 * 
 * SSRN is Cloudflare-blocked for HTTP — those go to a "needs browser" queue.
 * 
 * Usage:
 *   node scripts/enrich-conferences.js                    # enrich all gaps
 *   node scripts/enrich-conferences.js --deadlines-only   # only fill deadlines
 *   node scripts/enrich-conferences.js --dry-run          # show what would change
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const JSON_PATH = path.join(__dirname, '..', 'conferences.json');
const BRAVE_KEY = process.env.BRAVE_API_KEY || '';
const RATE_LIMIT_MS = 1100; // Brave free tier: 1 req/sec

// --- HTTP helpers ---

function httpGet(url, headers = {}, _depth = 0) {
  return new Promise((resolve) => {
    if (!url || !url.startsWith('http') || _depth > 3) { resolve({ status: 0, body: '' }); return; }
    const mod = url.startsWith('https') ? https : require('http');
    const opts = {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', ...headers },
      timeout: 15000,
    };
    mod.get(url, opts, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (!loc) { resolve({ status: res.statusCode, body: '' }); return; }
        // Handle relative redirects
        let redirectUrl = loc;
        if (loc.startsWith('/')) {
          try {
            const u = new URL(url);
            redirectUrl = `${u.protocol}//${u.host}${loc}`;
          } catch { resolve({ status: 0, body: '' }); return; }
        }
        return httpGet(redirectUrl, headers, _depth + 1).then(resolve);
      }
      if (res.statusCode !== 200) { resolve({ status: res.statusCode, body: '' }); return; }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: 200, body }));
    }).on('error', () => resolve({ status: 0, body: '' }));
  });
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Date parsing ---

const MONTHS = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

function parseToISO(monthStr, day, year) {
  const m = MONTHS[monthStr.toLowerCase()];
  if (!m || !day || !year || year < 2025 || year > 2030) return null;
  return `${year}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

// --- Extractors ---

function extractDeadline(text) {
  const patterns = [
    // "Submission Deadline: Month DD, YYYY" (with optional EXTENDED:)
    /(?:submission\s+)?deadline[:\s]+.*?(?:EXTENDED[:\s]+)?(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\w+)\s+(\d{1,2}),?\s+(\d{4})/i,
    /(?:submission\s+)?deadline[:\s]+.*?(\d{1,2})(?:st|nd|rd|th)?\s+(\w+),?\s+(\d{4})/i,
    // "submit by / due by"
    /(?:submit|due|submitted?)\s+(?:papers?\s+)?(?:by|on)\s+(?:\w+,?\s+)?(\w+)\s+(\d{1,2}),?\s+(\d{4})/i,
    /(?:submit|due|submitted?)\s+(?:papers?\s+)?(?:by|on)\s+(?:\w+,?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(\w+),?\s+(\d{4})/i,
    // "deadline of"
    /deadline\s+of\s+(?:\w+,?\s+)?(\w+)\s+(\d{1,2}),?\s+(\d{4})/i,
    // "no later than"
    /no\s+later\s+than\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})/i,
    // "extended to"
    /extended\s+to\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})/i,
    // "Closing date"
    /closing.{0,20}?(\w+)\s+(\d{1,2}),?\s+(\d{4})/i,
  ];
  
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      let iso;
      if (/^\d+$/.test(m[1])) {
        // DD Month YYYY
        iso = parseToISO(m[2], parseInt(m[1]), parseInt(m[3]));
      } else {
        // Month DD YYYY
        iso = parseToISO(m[1], parseInt(m[2]), parseInt(m[3]));
      }
      if (iso) return iso;
    }
  }
  return null;
}

function extractConfDate(text) {
  const patterns = [
    // "Conference Date(s): DD Month YYYY"
    /conference\s+dates?\s*[:\-]\s*(\d{1,2})(?:st|nd|rd|th)?\s+(\w+)\s+(\d{4})/i,
    /conference\s+dates?\s*[:\-]\s*(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i,
    // "will be held on/takes place"
    /(?:held|take[s]?\s+place)\s+(?:on\s+)?(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*[-–]\s*\d+)?,?\s+(\d{4})/i,
    /(?:held|take[s]?\s+place)\s+(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(\w+),?\s+(\d{4})/i,
    // "Month DD-DD, YYYY" standalone
    /(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?[-–]\d+,?\s+(\d{4})/i,
    // "DD-DD Month YYYY"
    /(\d{1,2})(?:st|nd|rd|th)?[-–]\d+\s+(\w+),?\s+(\d{4})/i,
    // "Date: Month DD, YYYY"
    /\bdate\s*:\s*(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i,
    /\bdate\s*:\s*(\d{1,2})(?:st|nd|rd|th)?\s+(\w+),?\s+(\d{4})/i,
  ];
  
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      let iso;
      if (/^\d+$/.test(m[1])) {
        iso = parseToISO(m[2], parseInt(m[1]), parseInt(m[3]));
      } else {
        iso = parseToISO(m[1], parseInt(m[2]), parseInt(m[3]));
      }
      if (iso) return iso;
    }
  }
  return null;
}

function extractLocation(text) {
  // Look for "Location: <text>" pattern
  const m = text.match(/location\s*:\s*([^\n.]{5,80})/i);
  if (m) return m[1].trim();
  return null;
}

// --- Brave Search ---

async function braveSearch(query) {
  if (!BRAVE_KEY) return [];
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`;
  const res = await httpGet(url, { 'X-Subscription-Token': BRAVE_KEY });
  if (res.status !== 200) return [];
  try {
    const data = JSON.parse(res.body);
    return (data.web?.results || []).map(r => ({
      title: r.title,
      url: r.url,
      description: r.description || '',
    }));
  } catch { return []; }
}

// --- Main enrichment ---

async function enrichConference(conf, opts = {}) {
  const changes = {};
  const needDeadline = !conf.deadline || conf.deadline === 'TBD';
  const needDate = !conf.startDate || conf.startDate.endsWith('-01');
  const needLocation = !conf.location || conf.location === 'TBD';
  
  if (opts.deadlinesOnly && !needDeadline) return changes;
  if (!needDeadline && !needDate && !needLocation) return changes;
  
  // Strategy 1: AAA conferences — fetch /Submissions page
  if (conf.url && conf.url.includes('aaahq.org') && needDeadline) {
    const subUrl = conf.url + '/Submissions';
    const res = await httpGet(subUrl);
    if (res.status === 200 && !res.body.includes('Page not found')) {
      const text = stripHtml(res.body);
      const dl = extractDeadline(text);
      if (dl) changes.deadline = dl;
    }
    await sleep(300);
  }
  
  // Strategy 2: Fetch conference URL directly
  if (conf.url && !conf.url.includes('ssrn.com')) {
    const res = await httpGet(conf.url);
    if (res.status === 200) {
      const text = stripHtml(res.body);
      if (needDeadline && !changes.deadline) {
        const dl = extractDeadline(text);
        if (dl) changes.deadline = dl;
      }
      if (needDate) {
        const sd = extractConfDate(text);
        if (sd) changes.startDate = sd;
      }
      if (needLocation) {
        const loc = extractLocation(text);
        if (loc) changes.location = loc;
      }
    }
    await sleep(300);
  }
  
  // Strategy 3: Brave search for conferences with only SSRN link or no URL
  if ((!conf.url || conf.url.includes('ssrn.com')) && (needDeadline || needDate)) {
    const query = `${conf.name} submission deadline ${new Date().getFullYear()}`;
    const results = await braveSearch(query);
    await sleep(RATE_LIMIT_MS);
    
    for (const r of results) {
      // Skip SSRN results (Cloudflare blocked)
      if (r.url.includes('ssrn.com')) continue;
      if (!r.url.startsWith('http')) continue;
      
      // Relevance check: search result must clearly be about this conference
      const stopWords = new Set(['conference','workshop','annual','international','call','papers','for','the',
        'submission','deadline','research','meeting','finance','accounting','economics','economic','financial']);
      const confWords = conf.name.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w));
      const resultText = (r.title + ' ' + r.description + ' ' + r.url).toLowerCase();
      const matchCount = confWords.filter(w => resultText.includes(w)).length;
      // Need at least 2 distinctive words matching, or >50% of distinctive words
      const threshold = Math.max(2, Math.ceil(confWords.length * 0.4));
      if (confWords.length > 0 && matchCount < Math.min(threshold, confWords.length)) {
        continue; // Insufficient keyword overlap — likely wrong conference
      }
      
      // Try to extract from search snippet first
      if (needDeadline && !changes.deadline) {
        const dl = extractDeadline(r.description);
        if (dl) { changes.deadline = dl; changes.deadlineSource = r.url; }
      }
      
      // Fetch the page for more data
      if ((needDeadline && !changes.deadline) || needDate) {
        const pageRes = await httpGet(r.url);
        if (pageRes.status === 200) {
          const text = stripHtml(pageRes.body);
          
          // Sanity: page should mention the conference (at least 2 keywords)
          const pageLC = text.toLowerCase();
          const pageMatches = confWords.filter(w => pageLC.includes(w)).length;
          if (confWords.length > 0 && pageMatches < Math.min(2, confWords.length)) continue;
          
          if (needDeadline && !changes.deadline) {
            const dl = extractDeadline(text);
            if (dl) { changes.deadline = dl; changes.deadlineSource = r.url; }
          }
          if (needDate && !changes.startDate) {
            const sd = extractConfDate(text);
            if (sd) changes.startDate = sd;
          }
          if (needLocation && !changes.location) {
            const loc = extractLocation(text);
            // Validate location: should be short, no HTML garbage
            if (loc && loc.length < 80 && !/[<>{}]/.test(loc) && !/var |function |-->/.test(loc)) {
              changes.location = loc;
            }
          }
        }
        await sleep(500);
      }
      
      if (changes.deadline || changes.startDate) break;
    }
    
    // Final validation: deadline should be before conference start date
    if (changes.deadline && conf.startDate) {
      if (changes.deadline >= conf.startDate) {
        console.error(`  ⚠️ Discarding deadline ${changes.deadline} (after startDate ${conf.startDate})`);
        delete changes.deadline;
        delete changes.deadlineSource;
      }
    }
  }
  
  return changes;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const deadlinesOnly = args.includes('--deadlines-only');
  const upcomingOnly = !args.includes('--all');
  
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const today = new Date().toISOString().split('T')[0];
  
  // Filter to conferences that need enrichment
  const candidates = data.filter(c => {
    if (upcomingOnly && c.startDate && c.startDate < today) return false;
    const needDl = !c.deadline || c.deadline === 'TBD';
    const needDate = !c.startDate || c.startDate.endsWith('-01');
    const needLoc = !c.location || c.location === 'TBD';
    if (deadlinesOnly) return needDl;
    return needDl || needDate || needLoc;
  });
  
  console.error(`Enrichment pipeline: ${candidates.length} candidates (${dryRun ? 'DRY RUN' : 'LIVE'})`);
  console.error(`Mode: ${deadlinesOnly ? 'deadlines only' : 'all fields'} | ${upcomingOnly ? 'upcoming only' : 'all'}`);
  
  let enriched = 0;
  let needsBrowser = [];
  
  for (let i = 0; i < candidates.length; i++) {
    const conf = candidates[i];
    console.error(`\n[${i+1}/${candidates.length}] ${conf.name.substring(0, 55)}`);
    
    const changes = await enrichConference(conf, { deadlinesOnly });
    
    if (Object.keys(changes).length === 0) {
      // If SSRN-only and still missing data, queue for browser
      if (conf.ssrnLink && !conf.url && (!conf.deadline || conf.deadline === 'TBD')) {
        needsBrowser.push(conf);
        console.error(`  → Queued for browser (SSRN-only)`);
      } else {
        console.error(`  → No data found`);
      }
      continue;
    }
    
    enriched++;
    // Validate changes before applying
    const validChanges = {};
    for (const [key, val] of Object.entries(changes)) {
      if (key === 'deadlineSource') continue;
      if (key === 'startDate' || key === 'deadline') {
        // Must be valid ISO date in reasonable range
        if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) continue;
        const year = parseInt(val.substring(0, 4));
        if (year < 2025 || year > 2030) continue;
      }
      if (key === 'location') {
        // No garbage
        if (val.length > 80 || /[<>{}]|var |function |-->|\.js|\.css/.test(val)) continue;
      }
      validChanges[key] = val;
    }
    
    for (const [key, val] of Object.entries(validChanges)) {
      const old = conf[key] || '';
      console.error(`  → ${key}: "${old}" -> "${val}"${changes.deadlineSource && key === 'deadline' ? ` (from ${changes.deadlineSource})` : ''}`);
      if (!dryRun) conf[key] = val;
    }
  }
  
  if (!dryRun && enriched > 0) {
    fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2));
    console.error(`\nSaved. ${enriched} conferences enriched.`);
  } else {
    console.error(`\n${enriched} conferences would be enriched.`);
  }
  
  if (needsBrowser.length > 0) {
    console.error(`\n=== NEEDS BROWSER (Pass 3): ${needsBrowser.length} ===`);
    const browserQueue = needsBrowser.map(c => ({
      id: c.id, name: c.name, ssrnLink: c.ssrnLink, missing: []
    }));
    for (const c of needsBrowser) {
      const missing = [];
      if (!c.deadline || c.deadline === 'TBD') missing.push('deadline');
      if (!c.startDate) missing.push('startDate');
      if (!c.location || c.location === 'TBD') missing.push('location');
      console.error(`  [${c.id}] ${c.name.substring(0, 50)} — missing: ${missing.join(', ')}`);
    }
    // Write browser queue for Pass 3
    const queuePath = path.join(__dirname, '..', 'browser-queue.json');
    fs.writeFileSync(queuePath, JSON.stringify(browserQueue, null, 2));
    console.error(`\nBrowser queue saved to ${queuePath}`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
