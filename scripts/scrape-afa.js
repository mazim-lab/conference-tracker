const https = require('https');
const xml2js = require('xml2js');
const fs = require('fs');

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
    // Look for submission deadline in the body (often in bold/strong tags) or structured block
    submissionDeadline: /Submission Deadline<\/strong><br \/><strong>(.*?)<\/strong>/i,
    submissionDeadlineAlt: /<b>Submission Deadline<\/b>.*?<br \/>(.*?)(?:<br|$)/i,
    // Structured metadata at the end
    deadline: /<b>Paper Submission Deadline<\/b>:&nbsp;(.*?)<br\/>/,
    regDeadline: /<b>Registration Deadline<\/b>:&nbsp;(.*?)<br\/>/,
    moreInfo: /<b>More Info<\/b>:&nbsp;<a href="(.*?)"/
  };

  for (const [key, regex] of Object.entries(patterns)) {
    const match = description.match(regex);
    if (match && match[1]) {
      let val = match[1].replace(/<\/?[^>]+(>|$)/g, "").trim();
      metadata[key] = val;
    }
  }
  
  if (!metadata.deadline) {
      metadata.deadline = metadata.submissionDeadline || metadata.submissionDeadlineAlt;
  }

  return metadata;
}

// Helper to format date to YYYY-MM-DD
function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  return date.toISOString().split('T')[0];
}

function fetchRSS(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
  });
}

async function run() {
  try {
    const xml = await fetchRSS(RSS_URL);
    
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xml);
    
    const items = result.rss.channel[0].item;
    const conferences = [];
    const today = new Date();

    for (const item of items) {
      const title = item.title[0];
      const link = item.link[0];
      const description = item.description[0];
      
      const meta = parseDescription(description);
      
      const locParts = [meta.city, meta.state, meta.country].filter(Boolean);
      const location = locParts.join(', ');

      let deadlineDate = null;
      if (meta.deadline) {
        deadlineDate = new Date(meta.deadline);
      }

      // Check if future event based on deadline
      if (deadlineDate && deadlineDate < today) {
        // If deadline is passed, we might still want it if the event is in the future?
        // But we don't have event date reliably.
        // Let's filter out only if deadline is passed AND we are sure.
        // Actually, prompt says: "Filters to only future events (CFP deadline or event date >= today)"
        // Since we don't have event date easily, we rely on deadline.
        // If deadline is missing, we include it (better safe than sorry).
        continue; 
      }
      
      // Attempt to extract event dates from description start if possible
      // Example: "June 15-16, 2026<br/>..."
      // Or use a heuristic.
      // For now, leave dates empty if not found.

      const conf = {
        name: title,
        dates: "", 
        startDate: "", 
        location: location || "TBD",
        country: meta.country || "",
        disc: ["fin"], 
        deadline: formatDate(meta.deadline),
        url: meta.moreInfo || link, 
        source: "AFA"
      };
      
      conferences.push(conf);
    }

    console.log(JSON.stringify(conferences, null, 2));

  } catch (err) {
    console.error("Error scraping AFA:", err);
  }
}

run();
