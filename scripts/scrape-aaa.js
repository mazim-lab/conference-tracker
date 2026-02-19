const { chromium } = require('playwright');
const crypto = require('crypto');
const https = require('https');

const MEETINGS_URL = 'https://aaahq.org/Meetings/AAA-Meetings';

// Fetch a URL and return the body text (no browser needed for AAA)
function fetchPage(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) { resolve(''); return; }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    }).on('error', () => resolve(''));
  });
}

// Extract deadline from AAA submission page HTML
function extractDeadlineFromHtml(html) {
  // Strip HTML tags for text matching
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  
  const MONTH_MAP = {
    january:1, february:2, march:3, april:4, may:5, june:6,
    july:7, august:8, september:9, october:10, november:11, december:12
  };
  
  const patterns = [
    // "Submission Deadline: Month DD, YYYY" or "EXTENDED: Month DD, YYYY"  
    /(?:submission\s+)?deadline[:\s]+.*?(?:EXTENDED[:\s]+)?(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\w+)\s+(\d{1,2}),?\s+(\d{4})/i,
    // "deadline of Month DD, YYYY"
    /deadline\s+of\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\w+)\s+(\d{1,2}),?\s+(\d{4})/i,
    // "submit.*by Month DD, YYYY"
    /submit.*?\bby\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(\w+)\s+(\d{1,2}),?\s+(\d{4})/i,
    // "due.*Month DD, YYYY"
    /due[:\s]+.*?(\w+)\s+(\d{1,2}),?\s+(\d{4})/i,
    // "Deadline: DD Month YYYY"
    /deadline[:\s]+.*?(\d{1,2})(?:st|nd|rd|th)?\s+(\w+),?\s+(\d{4})/i,
  ];
  
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      let month, day, year;
      // Check if first capture is a month name or a day number
      if (/^\d+$/.test(m[1])) {
        // DD Month YYYY format
        day = parseInt(m[1]);
        month = MONTH_MAP[(m[2] || '').toLowerCase()];
        year = parseInt(m[3]);
      } else {
        // Month DD YYYY format
        month = MONTH_MAP[(m[1] || '').toLowerCase()];
        day = parseInt(m[2]);
        year = parseInt(m[3]);
      }
      if (month && day && year >= 2025 && year <= 2028) {
        return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      }
    }
  }
  return '';
}

function generateSid(name, url) {
  const input = `${name}|${url}`;
  return `aaa-${crypto.createHash('md5').update(input).digest('hex').substring(0, 8)}`;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parseDateRange(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (isNaN(start.getTime())) return { dates: '', startDate: '' };
  const startDate = start.toISOString().split('T')[0];
  const mon = MONTHS[start.getMonth()];
  if (isNaN(end.getTime())) return { dates: `${mon} ${start.getDate()}`, startDate };
  if (start.getMonth() === end.getMonth()) {
    return { dates: `${mon} ${start.getDate()}-${end.getDate()}`, startDate };
  }
  return { dates: `${mon} ${start.getDate()}-${MONTHS[end.getMonth()]} ${end.getDate()}`, startDate };
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    console.error('Fetching AAA meetings page...');
    await page.goto(MEETINGS_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    
    // Extract structured data from .event-item rows
    const rawData = await page.evaluate(() => {
      const items = document.querySelectorAll('.event-item');
      return Array.from(items).map(item => {
        const link = item.querySelector('a[href*="/Meetings/20"]');
        if (!link) return null;
        
        const col7 = item.querySelector('.col-7');
        const col3 = item.querySelector('.col-3');
        
        // Title is the link text
        const title = link.textContent.trim();
        const url = link.href;
        
        // Location is text after the badge, before the dates column
        // It's the text content of col-7 minus the title and badge
        let location = '';
        if (col7) {
          const texts = col7.innerText.split('\n').map(t => t.trim()).filter(t => t.length > 0);
          // Location is usually the last text line in col-7 (after title and badge)
          for (const t of texts) {
            if (t !== title && !t.match(/^[A-Z]{2,}$/) && t.length > 2 && 
                !t.match(/deadline|call for|submission|register/i)) {
              location = t;
            }
          }
        }
        
        // Dates from col-3
        const dateText = col3 ? col3.textContent.trim() : '';
        
        // Check for deadline/CFP info
        const fullText = item.textContent;
        const deadlineMatch = fullText.match(/DEADLINE:\s*\n?\s*(\w+\s+\d{1,2},?\s+\d{4})/i);
        const deadline = deadlineMatch ? deadlineMatch[1] : '';
        
        return { title, url, location, dateText, deadline };
      }).filter(Boolean);
    });
    
    await browser.close();
    
    // Deduplicate by URL
    const seen = new Set();
    const conferences = [];
    
    for (const item of rawData) {
      const url = item.url.split('?')[0];
      if (seen.has(url)) continue;
      seen.add(url);
      
      // Parse dates "02/19/2026 - 02/21/2026"
      const dateMatch = item.dateText.match(/(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/);
      let dates = '', startDate = '';
      if (dateMatch) {
        const parsed = parseDateRange(dateMatch[1], dateMatch[2]);
        dates = parsed.dates;
        startDate = parsed.startDate;
      }
      
      // Parse deadline
      let deadline = '';
      if (item.deadline) {
        const d = new Date(item.deadline);
        if (!isNaN(d.getTime())) deadline = d.toISOString().split('T')[0];
      }
      
      // Determine country
      let country = 'USA';
      const loc = item.location || '';
      if (loc.includes('Korea')) country = 'South Korea';
      else if (loc.includes('Canada')) country = 'Canada';
      else if (loc.toLowerCase().includes('virtual')) country = 'Online';
      
      const conf = {
        id: 0,
        name: item.title,
        dates,
        startDate,
        location: loc,
        country,
        disc: ["acct"],
        sid: generateSid(item.title, url),
        ssrnLink: '',
        deadline,
        url,
        tier: "2",
        source: "aaa"
      };
      
      console.error(`  ${conf.name} | ${conf.dates} | ${conf.location} | deadline: ${conf.deadline}`);
      conferences.push(conf);
    }
    
    // Phase 2: Fetch each conference's main page for accurate dates/location
    console.error(`\n--- Phase 2: Verifying dates/locations from conference pages ---`);
    for (const conf of conferences) {
      const html = await fetchPage(conf.url);
      if (!html || html.includes('Page not found')) continue;
      
      const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
      
      // Extract date ranges like "March 13-14, 2026" or "June 25-28, 2026"
      const datePatterns = [
        /(\w+)\s+(\d{1,2})[-–](\d{1,2}),?\s+(\d{4})/,           // Month DD-DD, YYYY
        /(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*[-–]\s*(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/, // Month DD - Month DD, YYYY
        /(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/,        // Month DD, YYYY (single day)
      ];
      
      const MMAP = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
      
      for (const pat of datePatterns) {
        const m = text.match(pat);
        if (m) {
          const month = MMAP[m[1].toLowerCase()];
          if (month) {
            const day = parseInt(m[2]);
            const year = parseInt(m[m.length - 1]);
            if (year >= 2026 && year <= 2029) {
              const newStart = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
              if (conf.startDate !== newStart) {
                console.error(`  ${conf.name}: startDate ${conf.startDate} -> ${newStart}`);
                conf.startDate = newStart;
              }
              break;
            }
          }
        }
      }
      
      // Extract location from common patterns
      const locPatterns = [
        /(?:held (?:at|in)|taking place (?:at|in)|•)\s+(?:the\s+)?([^.•<]{10,80})/i,
        /(?:in\s+)([\w\s]+,\s*(?:[A-Z]{2}|[A-Za-z]+(?:\s+[A-Za-z]+)?))\s/,
      ];
      
      await new Promise(r => setTimeout(r, 300));
    }

    // Phase 3: Fetch /Submissions pages for conferences missing deadlines
    console.error(`\n--- Phase 3: Fetching deadlines from /Submissions pages ---`);
    for (const conf of conferences) {
      if (conf.deadline) continue; // already have one
      const subUrl = conf.url + '/Submissions';
      console.error(`  Checking ${subUrl}`);
      const html = await fetchPage(subUrl);
      if (html && !html.includes('Page not found')) {
        const dl = extractDeadlineFromHtml(html);
        if (dl) {
          conf.deadline = dl;
          console.error(`    → Found deadline: ${dl}`);
        } else {
          console.error(`    → Page exists but no deadline found`);
        }
      } else {
        console.error(`    → No submissions page (404)`);
      }
      // Small delay to be polite
      await new Promise(r => setTimeout(r, 500));
    }
    
    console.error(`\nTotal: ${conferences.length} AAA conferences`);
    const withDl = conferences.filter(c => c.deadline).length;
    console.error(`With deadlines: ${withDl} | Without: ${conferences.length - withDl}`);
    console.log(JSON.stringify(conferences, null, 2));
    
  } catch (err) {
    await browser.close();
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
