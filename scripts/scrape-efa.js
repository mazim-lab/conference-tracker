const https = require('https');
const cheerio = require('cheerio');
const crypto = require('crypto');

const URL = 'https://european-finance.org/r/news';

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
  return `efa-${hash}`;
}

// Helper to extract start date from various date formats
function extractStartDate(dateStr) {
  if (!dateStr) return '';
  
  const patterns = [
    /(\w+\s+\d{1,2}),?\s+(\d{4})/,  // "March 15, 2026"
    /(\w+\s+\d{1,2})-\d{1,2},?\s+(\d{4})/, // "March 15-17, 2026"
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/ // "03/15/2026"
  ];
  
  for (const pattern of patterns) {
    const match = dateStr.match(pattern);
    if (match) {
      try {
        if (match.length === 3) {
          const date = new Date(`${match[1]} ${match[2]}`);
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

// Check if text looks like a conference announcement
function isConferenceAnnouncement(text) {
  const keywords = [
    'conference', 'symposium', 'workshop', 'meeting', 'congress',
    'call for papers', 'submission', 'deadline', 'cfp', 'annual'
  ];
  const lowerText = text.toLowerCase();
  return keywords.some(keyword => lowerText.includes(keyword));
}

async function run() {
  try {
    console.error("Fetching EFA news page...");
    const html = await fetchHTML(URL);
    const $ = cheerio.load(html);
    
    const conferences = [];
    let processedItems = 0;

    // Try multiple selectors to find content
    const contentSelectors = [
      'div.content', 'div#content', 'main', 'article', 
      'div.news', 'div.post', 'div.entry-content', 'body'
    ];
    
    let content = null;
    for (const selector of contentSelectors) {
      content = $(selector).first();
      if (content.length > 0 && content.text().trim().length > 100) {
        console.error(`Using content selector: ${selector}`);
        break;
      }
    }
    
    if (!content || content.length === 0) {
      console.error("Could not find main content area");
      console.log(JSON.stringify([], null, 2));
      return;
    }

    // Look for news/article items with various patterns
    const itemSelectors = [
      'article', 'div.news-item', 'div.post', 'div.entry',
      'h1, h2, h3, h4', 'p:has(a)', 'div:has(h1)', 'div:has(h2)', 'div:has(h3)'
    ];
    
    const foundItems = new Set();
    
    // Try to find structured news items or headlines
    for (const selector of itemSelectors) {
      content.find(selector).each((i, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        
        // Skip if already processed or too short
        if (text.length < 20 || foundItems.has(text)) return;
        
        // Check if this looks like a conference announcement
        if (!isConferenceAnnouncement(text)) return;
        
        let title = '';
        let url = '';
        let descText = text;
        
        // Extract title and URL based on element type
        if ($el.is('h1, h2, h3, h4')) {
          title = text;
          url = $el.find('a').attr('href') || $el.next('p').find('a').attr('href') || '';
        } else if ($el.find('h1, h2, h3, h4').length > 0) {
          const headline = $el.find('h1, h2, h3, h4').first();
          title = headline.text().trim();
          url = headline.find('a').attr('href') || $el.find('a').first().attr('href') || '';
        } else {
          const firstLink = $el.find('a').first();
          if (firstLink.length > 0) {
            title = firstLink.text().trim();
            url = firstLink.attr('href') || '';
            if (title.length < 10) {
              title = text.substring(0, 100) + '...';
            }
          } else {
            title = text.substring(0, 100);
          }
        }
        
        // Clean up title
        title = title.replace(/\s+/g, ' ').trim();
        if (title.length < 10) return;
        
        // Fix relative URLs
        if (url && !url.startsWith('http')) {
          if (url.startsWith('/')) {
            url = 'https://european-finance.org' + url;
          } else if (url.startsWith('./')) {
            url = 'https://european-finance.org/r/' + url.substring(2);
          }
        }
        
        foundItems.add(text);
        
        const conf = {
          name: title,
          url: url,
          descText: descText
        };
        
        conferences.push(conf);
        processedItems++;
      });
    }
    
    console.error(`Found ${conferences.length} potential conference items`);
    
    // Process each item to extract structured data
    const finalConfs = conferences.map(conf => {
      const text = conf.descText;
      
      // Extract structured information
      const locationMatch = text.match(/(?:Location|Venue|held\s+(?:at|in)):\s*(.*?)(?:\n|$|\.)/i) ||
                           text.match(/(?:in|at)\s+([A-Z][a-z]+(?:,\s*[A-Z][a-z]+)*)/);
      const dateMatch = text.match(/(?:Date|Dates?):\s*(.*?)(?:\n|$|\.)/i) ||
                       text.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:-\d{1,2})?,?\s+\d{4}/);
      const deadlineMatch = text.match(/(?:Submission\s+Deadline|Deadline|Due\s+date):\s*(.*?)(?:\n|$|\.)/i) ||
                           text.match(/(?:submissions?\s+due|papers?\s+due|deadline).*?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i);
      
      let location = 'TBD';
      if (locationMatch) {
        location = locationMatch[1] ? locationMatch[1].trim() : locationMatch[0];
        location = location.replace(/[^\w\s,.-]/g, '').trim();
        if (location.length > 100) location = location.substring(0, 100) + '...';
      }
      
      let dates = '';
      if (dateMatch) {
        dates = dateMatch[1] ? dateMatch[1].trim() : dateMatch[0];
        dates = dates.replace(/[^\w\s,.-]/g, '').trim();
      }
      
      let deadline = '';
      if (deadlineMatch) {
        const deadlineText = deadlineMatch[1] ? deadlineMatch[1].trim() : deadlineMatch[0];
        deadline = formatDate(deadlineText);
      }
      
      const startDate = extractStartDate(dates);
      
      return {
        id: 0, // Will be assigned by merge script
        name: conf.name,
        dates: dates,
        startDate: startDate,
        location: location,
        country: '',
        disc: ["fin"],
        sid: generateSid(conf.name, conf.url),
        ssrnLink: '',
        deadline: deadline,
        url: conf.url,
        tier: "2"
      };
    }).filter(c => {
      // Filter out noise and duplicates
      return c.name && 
             c.name.length > 10 && 
             !c.name.toLowerCase().includes('finance journals') &&
             !c.name.toLowerCase().includes('click here');
    });
    
    // Remove duplicates by name similarity
    const uniqueConfs = [];
    for (const conf of finalConfs) {
      const isDuplicate = uniqueConfs.some(existing => {
        const name1 = existing.name.toLowerCase().replace(/[^\w]/g, '');
        const name2 = conf.name.toLowerCase().replace(/[^\w]/g, '');
        return name1 === name2 || name1.includes(name2) || name2.includes(name1);
      });
      
      if (!isDuplicate) {
        uniqueConfs.push(conf);
      }
    }
    
    console.error(`Found ${uniqueConfs.length} unique conferences from EFA`);
    console.log(JSON.stringify(uniqueConfs, null, 2));
    
  } catch (err) {
    console.error("Error scraping EFA:", err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };