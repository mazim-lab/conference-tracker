#!/usr/bin/env node
/**
 * Pass 2: Enrich conferences with missing data by searching the web.
 * 
 * For each conference missing startDate (or with malformed data):
 * 1. If url exists → fetch that page, extract dates
 * 2. If no url or fetch fails → Brave search "{name} {year}" → fetch top result
 * 3. Extract dates via regex from page content
 * 4. Update conference record
 * 
 * Requires: BRAVE_API_KEY env var
 * Usage: node scripts/enrich-conferences.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const CONF_PATH = path.join(__dirname, '..', 'conferences.json');
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

const MONTH_NAMES = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location, headers).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function braveSearch(query) {
  if (!BRAVE_API_KEY) return null;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`;
  try {
    const res = await fetch(url, { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    return data.web?.results || [];
  } catch { return null; }
}

/**
 * Extract dates from text content.
 * Returns { startDate, endDate, location } or null.
 */
function extractDates(text, confName) {
  if (!text) return null;
  
  // Common patterns:
  // "March 19-20, 2026"
  // "19-20 March 2026"  
  // "May 21–22, 2026"
  // "October 14 - 17, 2026"
  // "June 4-5, 2026"
  // "January 3-5, 2027"
  
  const monthPat = Object.keys(MONTH_NAMES).join('|');
  const patterns = [
    // "Month DD-DD, YYYY" or "Month DD–DD, YYYY"
    new RegExp(`(${monthPat})\\s+(\\d{1,2})\\s*[-–—]\\s*\\d{1,2},?\\s*(\\d{4})`, 'gi'),
    // "Month DD, YYYY"
    new RegExp(`(${monthPat})\\s+(\\d{1,2}),?\\s*(\\d{4})`, 'gi'),
    // "DD-DD Month YYYY"
    new RegExp(`(\\d{1,2})\\s*[-–—]\\s*\\d{1,2}\\s+(${monthPat}),?\\s*(\\d{4})`, 'gi'),
    // "DD Month YYYY"
    new RegExp(`(\\d{1,2})\\s+(${monthPat}),?\\s*(\\d{4})`, 'gi'),
  ];
  
  // Try to find dates near the conference name or at the top of the page
  // Prioritize dates in 2025-2029 range
  const candidates = [];
  
  for (const pat of patterns) {
    let match;
    while ((match = pat.exec(text)) !== null) {
      try {
        let month, day, year;
        
        if (/^\d/.test(match[1])) {
          // DD-DD Month YYYY or DD Month YYYY
          day = match[1];
          month = MONTH_NAMES[match[2].toLowerCase()];
          year = match[3];
        } else {
          // Month DD YYYY
          month = MONTH_NAMES[match[1].toLowerCase()];
          day = match[2];
          year = match[3];
        }
        
        if (!month) continue;
        const y = parseInt(year);
        if (y < 2025 || y > 2030) continue;
        
        const dateStr = `${year}-${month}-${day.padStart(2, '0')}`;
        // Validate
        const d = new Date(dateStr + 'T12:00:00Z');
        if (isNaN(d.getTime())) continue;
        
        candidates.push({
          date: dateStr,
          year: y,
          index: match.index,
          raw: match[0]
        });
      } catch {}
    }
  }
  
  if (candidates.length === 0) return null;
  
  // Prefer 2026, then closest future year
  candidates.sort((a, b) => {
    if (a.year === 2026 && b.year !== 2026) return -1;
    if (b.year === 2026 && a.year !== 2026) return 1;
    return a.index - b.index; // Earlier in text = more likely to be the main date
  });
  
  return { startDate: candidates[0].date, raw: candidates[0].raw };
}

async function enrichConference(conf) {
  const name = conf.name;
  let text = null;
  let sourceUrl = null;
  
  // Try 1: Fetch existing URL
  if (conf.url && !conf.url.includes('conference-calendar')) {
    try {
      const res = await fetch(conf.url);
      if (res.status === 200) {
        text = res.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        sourceUrl = conf.url;
      }
    } catch {}
  }
  
  // Try 2: Brave search
  if (!text && BRAVE_API_KEY) {
    const year = name.match(/20\d{2}/)?.[0] || '2026';
    const results = await braveSearch(`"${name}" ${year} conference dates`);
    if (results && results.length > 0) {
      // Use snippet first (faster, no fetch needed)
      for (const r of results) {
        const snippet = r.description || '';
        const extracted = extractDates(snippet, name);
        if (extracted) {
          return { ...extracted, source: r.url, method: 'brave-snippet' };
        }
      }
      
      // Try fetching top result
      for (const r of results.slice(0, 2)) {
        try {
          const res = await fetch(r.url);
          if (res.status === 200) {
            text = res.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
            sourceUrl = r.url;
            break;
          }
        } catch {}
      }
    }
  }
  
  if (!text) return null;
  
  const extracted = extractDates(text, name);
  if (extracted) {
    return { ...extracted, source: sourceUrl, method: 'web-fetch' };
  }
  
  return null;
}

async function main() {
  console.log('=== Conference Enrichment (Pass 2) ===');
  if (DRY_RUN) console.log('DRY RUN — no changes will be written');
  if (!BRAVE_API_KEY) console.log('WARNING: No BRAVE_API_KEY — will only try existing URLs');
  
  const data = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
  
  // Find conferences needing enrichment
  const needsDate = data.filter(c => !c.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(c.startDate));
  console.log(`\n${needsDate.length} conferences need startDate enrichment\n`);
  
  let fixed = 0;
  let failed = [];
  
  for (const conf of needsDate) {
    console.log(`Enriching: ${conf.name.slice(0, 60)}...`);
    
    try {
      const result = await enrichConference(conf);
      
      if (result) {
        console.log(`  ✓ Found: ${result.startDate} (${result.method}) [${result.raw}]`);
        if (!DRY_RUN) {
          conf.startDate = result.startDate;
          if (result.source && !conf.url) conf.url = result.source;
        }
        fixed++;
      } else {
        console.log(`  ✗ No dates found`);
        failed.push(conf.name);
      }
    } catch (e) {
      console.log(`  ✗ Error: ${e.message}`);
      failed.push(conf.name);
    }
    
    // Rate limit: 1 req/sec for Brave
    await sleep(1100);
  }
  
  if (!DRY_RUN) {
    fs.writeFileSync(CONF_PATH, JSON.stringify(data, null, 2));
  }
  
  console.log(`\n=== Results ===`);
  console.log(`Fixed: ${fixed}/${needsDate.length}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log(`\nStill need dates (queue for AI pass 3):`);
    failed.forEach(n => console.log(`  - ${n.slice(0, 70)}`));
  }
}

main().catch(console.error);
