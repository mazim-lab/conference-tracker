const https = require('https');
const cheerio = require('cheerio');
const crypto = require('crypto');

const URLS = [
    'https://eaa-online.org/arc/events/?event_category=association-conference',
    'https://eaa-online.org/arc/events/?event_category=journal-conference'
];

function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    };
    
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Helper to format date to YYYY-MM-DD
function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '';
    return date.toISOString().split('T')[0];
  } catch (e) {
    return '';
  }
}

// Helper to generate unique sid
function generateSid(name, url) {
  const input = `${name}|${url}`;
  const hash = crypto.createHash('md5').update(input).digest('hex').substring(0, 8);
  return `eaa-${hash}`;
}

// Helper to extract start date from various date formats
function extractStartDate(dateStr) {
  if (!dateStr) return '';
  
  const patterns = [
    /(\d{1,2})[\/\-–—](\d{1,2})[\/\-–—](\d{4})/,  // DD/MM/YYYY or DD-MM-YYYY
    /(\d{1,2})(?:st|nd|rd|th)?\s*[\/\-–—]\s*(\d{1,2})(?:st|nd|rd|th)?\s+(\w+)\s+(\d{4})/,  // "14–16 April 2026"
    /(\d{1,2})(?:st|nd|rd|th)?\s+(\w+)\s+(\d{4})/,  // "14 April 2026"
    /(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/,  // "April 14, 2026"
    /(\w+)\s+(\d{1,2})[\/\-–—](\d{1,2}),?\s+(\d{4})/  // "April 14-16, 2026"
  ];
  
  for (const pattern of patterns) {
    const match = dateStr.match(pattern);
    if (match) {
      try {
        // Handle "14–16 April 2026" format
        if (match.length === 5 && match[3] && match[4]) {
          const date = new Date(`${match[3]} ${match[1]} ${match[4]}`);
          if (!isNaN(date.getTime())) {
            return formatDate(date);
          }
        }
        // Handle "14 April 2026" format
        else if (match.length === 4 && match[2] && match[3]) {
          const date = new Date(`${match[2]} ${match[1]} ${match[3]}`);
          if (!isNaN(date.getTime())) {
            return formatDate(date);
          }
        }
        // Handle "April 14, 2026" format
        else if (match.length === 4 && match[1] && match[2] && match[3]) {
          const date = new Date(`${match[1]} ${match[2]} ${match[3]}`);
          if (!isNaN(date.getTime())) {
            return formatDate(date);
          }
        }
        // Handle numeric dates DD/MM/YYYY
        else if (match.length === 4 && match[1] && match[2] && match[3]) {
          const date = new Date(match[3], match[2] - 1, match[1]);
          if (!isNaN(date.getTime())) {
            return formatDate(date);
          }
        }
      } catch (e) {
        continue;
      }
    }
  }
  
  return '';
}

// Extract location from text
function extractLocation(text) {
  const patterns = [
    /hosted\s+by\s+(.*?)(?:,|$|\.|\n)/i,
    /(?:in|at)\s+([A-Z][a-z]+(?:,\s*[A-Z][a-z]+)*)/,
    /location:\s*(.*?)(?:,|$|\.|\n)/i,
    /venue:\s*(.*?)(?:,|$|\.|\n)/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      let location = match[1].trim();
      // Clean up common artifacts
      location = location.replace(/^(the\s+)?university\s+of\s+/i, '');
      location = location.replace(/\s+university$/i, '');
      if (location.length > 80) location = location.substring(0, 80) + '...';
      if (location.length > 5) return location;
    }
  }
  
  return 'TBD';
}

// Extract deadline from text
function extractDeadline(text) {
  const patterns = [
    /(?:submission\s+deadline|deadline|due\s+date|submit\s+by):\s*(.*?)(?:\n|$|\.)/i,
    /(?:papers?\s+due|submissions?\s+due).*?(\w+\s+\d{1,2},?\s+\d{4})/i,
    /(?:deadline).*?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const deadlineDate = formatDate(match[1].trim());
      if (deadlineDate) return deadlineDate;
    }
  }
  
  return '';
}

async function scrapeUrl(url) {
    console.error(`Fetching ${url}...`);
    try {
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      const found = [];

      // Look for event links and their context
      $('a[href*="/arc/events/"]').each((i, el) => {
          const $el = $(el);
          const link = $el.attr('href');
          let title = $el.text().trim();
          
          // Skip junk links
          if (title.length < 5 || 
              title.toLowerCase().includes('click here') || 
              title.toLowerCase().includes('read more') ||
              title.toLowerCase().includes('more info')) {
              return;
          }
          
          // Make sure URL is absolute
          const fullUrl = link.startsWith('http') ? link : `https://eaa-online.org${link}`;
          
          // Check if we already have this URL
          if (found.some(c => c.url === fullUrl)) return;

          // Get context from parent elements
          let context = '';
          let $parent = $el.parent();
          for (let depth = 0; depth < 3 && $parent.length > 0; depth++) {
              const parentText = $parent.text().replace(/\s+/g, ' ').trim();
              if (parentText.length > context.length && parentText.length < 1000) {
                  context = parentText;
              }
              $parent = $parent.parent();
          }
          
          // If title is very short, try to get a better title from context
          if (title.length < 20) {
              const sentences = context.split(/[.!?]/);
              for (const sentence of sentences) {
                  if (sentence.toLowerCase().includes(title.toLowerCase()) && 
                      sentence.length > title.length && 
                      sentence.length < 150) {
                      title = sentence.trim();
                      break;
                  }
              }
          }
          
          found.push({
              name: title,
              url: fullUrl,
              descText: context
          });
      });
      
      console.error(`Found ${found.length} events from ${url}`);
      return found;
    } catch (error) {
      console.error(`Error scraping ${url}:`, error.message);
      return [];
    }
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
    
    console.error(`Found ${uniqueConferences.length} unique events total`);
    
    // Process and structure the output
    const finalConfs = uniqueConferences.map(conf => {
        const text = conf.descText;
        
        // Extract dates - look for patterns like "14–16 April 2026"
        const datePatterns = [
            /(\d{1,2})[–—-](\d{1,2})\s+(\w+)\s+(\d{4})/,  // "14–16 April 2026"
            /(\d{1,2})(?:st|nd|rd|th)?\s+(\w+)\s+(\d{4})/,  // "14th April 2026"
            /(\w+)\s+(\d{1,2})[–—-](\d{1,2}),?\s+(\d{4})/,  // "April 14-16, 2026"
            /(\w+)\s+(\d{1,2}),?\s+(\d{4})/  // "April 14, 2026"
        ];
        
        let dates = '';
        let startDate = '';
        
        for (const pattern of datePatterns) {
            const match = text.match(pattern);
            if (match) {
                dates = match[0];
                startDate = extractStartDate(dates);
                break;
            }
        }
        
        const location = extractLocation(text);
        const deadline = extractDeadline(text);
        
        return {
            id: 0, // Will be assigned by merge script
            name: conf.name.trim(),
            dates: dates,
            startDate: startDate,
            location: location,
            country: '',
            disc: ["acct"],  // As specified in requirements
            sid: generateSid(conf.name, conf.url),
            ssrnLink: '',
            deadline: deadline,
            url: conf.url,
            tier: "2"
        };
    }).filter(conf => {
        // Filter out very short names or obvious junk
        return conf.name.length >= 10 && 
               !conf.name.toLowerCase().includes('undefined') &&
               !conf.name.toLowerCase().includes('null');
    });

    console.error(`Processed ${finalConfs.length} valid conferences from EAA`);
    console.log(JSON.stringify(finalConfs, null, 2));

  } catch (err) {
    console.error("Error scraping EAA:", err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };