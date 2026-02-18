const https = require('https');
const cheerio = require('cheerio');

// Updated URLs from user
const URLS = [
    'https://eaa-online.org/arc/events/?event_category=association-conference',
    'https://eaa-online.org/arc/events/?event_category=journal-conference'
];

function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
  });
}

async function scrapeUrl(url) {
    console.log(`Fetching ${url}...`);
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);
    const found = [];

    $('a[href*="/arc/events/"]').each((i, el) => {
        const $el = $(el);
        const link = $el.attr('href');
        const title = $el.text().trim();
        
        // Filter out junk or "click here" or duplicate links to same event
        if (title.length < 5 || title.toLowerCase().includes('click here') || title.toLowerCase().includes('read more')) return;
        
        // Check if we already have this URL in this batch
        if (found.some(c => c.url === link)) return;

        // "from 14–16 April 2026"
        // Let's get the parent text context. 
        const parent = $el.closest('div, li, p');
        const descText = parent.text().replace(/\s+/g, ' ').trim();
        
        found.push({
            name: title,
            url: link,
            descText: descText,
            source: "EAA"
        });
    });
    return found;
}

async function run() {
  try {
    const allConferences = [];
    
    for (const url of URLS) {
        const confs = await scrapeUrl(url);
        allConferences.push(...confs);
    }
    
    // Deduplicate by URL
    const uniqueConferences = [];
    const seenUrls = new Set();
    
    for (const conf of allConferences) {
        if (!seenUrls.has(conf.url)) {
            seenUrls.add(conf.url);
            uniqueConferences.push(conf);
        }
    }
    
    console.log(`Found ${uniqueConferences.length} unique events total.`);
    
    // Refine output
    const finalConfs = uniqueConferences.map(conf => {
        const text = conf.descText;
        
        // Try to extract dates
        // Pattern: "14–16 April 2026" or "May 2026"
        // Look for typical date patterns
        const dateMatch = text.match(/(\d{1,2}.*?\d{4})/);
        // Look for location
        const locationMatch = text.match(/hosted by\s*(.*?)(?:,|$|\.)/i) || text.match(/in\s+([A-Z][a-z]+(?:, [A-Z][a-z]+)?)/);
        
        let dates = dateMatch ? dateMatch[1] : "";
        let location = locationMatch ? locationMatch[1].trim() : "TBD";
        
        // Clean up location if it captured too much
        if (location.length > 50) location = location.substring(0, 50) + "...";
        
        return {
            name: conf.name,
            url: conf.url,
            dates: dates,
            startDate: "", // Placeholder
            location: location,
            country: "",
            disc: ["fin", "acc"], // Accounting/Finance
            deadline: "",
            source: "EAA"
        };
    });

    console.log(JSON.stringify(finalConfs, null, 2));

  } catch (err) {
    console.error("Error scraping EAA:", err);
  }
}

run();
