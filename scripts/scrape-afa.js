const https = require('https');
const xml2js = require('xml2js');
const crypto = require('crypto');

const RSS_URL = 'https://trumba.com/calendars/afa-conferences.rss';

// Helper to parse description HTML for metadata
function parseDescription(description) {
  const metadata = {};
  
  // Regex patterns for the structured data in description
  const patterns = {
    country: /<b>Country<\/b>:&nbsp;(.*?)<br\/>/,
    state: /<b>State\/Province<\/b>:&nbsp;(.*?)<br\/>/,
    city: /<b>City<\/b>:&nbsp;(.*?)<br\/>/,
    eventType: /<b>Event Type<\/b>:&nbsp;(.*?)<br\/>/,
    host: /<b>Host Institution<\/b>:&nbsp;(.*?)<br\/>/,
    // Look for submission deadline in various formats
    submissionDeadline: /Submission Deadline<\/strong><br \/><strong>(.*?)<\/strong>/i,
    submissionDeadlineAlt: /<b>Submission Deadline<\/b>.*?<br \/>(.*?)(?:<br|$)/i,
    deadline: /<b>Paper Submission Deadline<\/b>:&nbsp;(.*?)<br\/>/,
    regDeadline: /<b>Registration Deadline<\/b>:&nbsp;(.*?)<br\/>/,
    moreInfo: /<b>More Info<\/b>:&nbsp;<a href="(.*?)"/,
    // Try to extract event dates from the beginning
    eventDate: /^(.*?)<br\/>/,
    // Look for date patterns in various formats
    datePattern: /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:-\d{1,2})?,?\s+\d{4}/gi
  };

  for (const [key, regex] of Object.entries(patterns)) {
    const match = description.match(regex);
    if (match && match[1]) {
      let val = match[1].replace(/<\/?[^>]+(>|$)/g, "").trim();
      metadata[key] = val;
    }
  }
  
  // Consolidate deadline information
  if (!metadata.deadline) {
    metadata.deadline = metadata.submissionDeadline || metadata.submissionDeadlineAlt;
  }

  // Try to extract dates from the content
  const dateMatches = description.match(patterns.datePattern);
  if (dateMatches && dateMatches.length > 0) {
    metadata.extractedDates = dateMatches[0];
  }

  return metadata;
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
  return `afa-trumba-${hash}`;
}

// Helper to extract start date from various date formats
function extractStartDate(dateStr) {
  if (!dateStr) return '';
  
  // Try to find a date pattern and extract the start date
  const patterns = [
    /(\w+\s+\d{1,2}),?\s+(\d{4})/,  // "March 15, 2026" or "March 15 2026"
    /(\w+\s+\d{1,2})-\d{1,2},?\s+(\d{4})/, // "March 15-17, 2026"
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/ // "03/15/2026" or "15-03-2026"
  ];
  
  for (const pattern of patterns) {
    const match = dateStr.match(pattern);
    if (match) {
      try {
        if (match.length === 3) {
          // Month name format
          const date = new Date(`${match[1]} ${match[2]}`);
          if (!isNaN(date.getTime())) {
            return formatDate(date);
          }
        } else if (match.length === 4) {
          // Numeric format - assume MM/DD/YYYY
          const date = new Date(match[3], match[1] - 1, match[2]);
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

function fetchRSS(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function run() {
  try {
    console.error("Fetching AFA RSS feed...");
    const xml = await fetchRSS(RSS_URL);
    
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xml);
    
    const items = result.rss.channel[0].item || [];
    const conferences = [];
    const today = new Date();

    console.error(`Processing ${items.length} items from RSS feed...`);

    for (const item of items) {
      const title = item.title[0];
      const link = item.link[0];
      const description = item.description[0];
      const pubDate = item.pubDate ? item.pubDate[0] : '';
      
      const meta = parseDescription(description);
      
      // Build location from parsed metadata
      const locParts = [meta.city, meta.state, meta.country].filter(Boolean);
      const location = locParts.length > 0 ? locParts.join(', ') : 'TBD';

      // Skip PhD programs and non-conference items
      const titleLower = title.toLowerCase();
      if (titleLower.includes('phd program') || titleLower.includes('doctoral program') ||
          titleLower.includes('master program') || titleLower.includes('mba program')) {
        continue;
      }

      // Try to extract dates and start date
      const dates = meta.extractedDates || '';
      const startDate = extractStartDate(dates);
      
      // Skip past events (by event date or deadline)
      if (startDate) {
        const eventDate = new Date(startDate);
        if (eventDate < today) continue;
      } else if (meta.deadline) {
        const deadlineDate = new Date(meta.deadline);
        if (deadlineDate < today) continue;
      }
      
      const conf = {
        id: 0, // Will be assigned by merge script
        name: title.trim(),
        dates: dates,
        startDate: startDate,
        location: location,
        country: meta.country || '',
        disc: ["fin"],
        sid: generateSid(title, link),
        ssrnLink: '',
        deadline: formatDate(meta.deadline),
        url: meta.moreInfo || link,
        tier: "2"
      };
      
      conferences.push(conf);
    }

    console.error(`Found ${conferences.length} future conferences from AFA`);
    console.log(JSON.stringify(conferences, null, 2));

  } catch (err) {
    console.error("Error scraping AFA:", err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };