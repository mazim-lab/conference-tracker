const { chromium } = require('playwright');
const crypto = require('crypto');

const MEETINGS_URL = 'https://aaahq.org/Meetings/AAA-Meetings';

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
    
    console.error(`\nTotal: ${conferences.length} AAA conferences`);
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
