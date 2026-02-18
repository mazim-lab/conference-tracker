const https = require('https');
const { parseStringPromise } = require('xml2js');

async function fetchFull(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
  });
}

function decodeHtml(html) {
  return html
    .replace(/&amp;#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

function extractField(desc, field) {
  const re = new RegExp(`<b>${field}</b>:\\s*(?:&nbsp;|\\s)?(.+?)(?:\\s*<br|$)`, 'i');
  const m = desc.match(re);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, '').trim();
}

function extractUrl(desc, field) {
  const re = new RegExp(`<b>${field}</b>[^<]*<a\\s+href="([^"]+)"`, 'i');
  const m = desc.match(re);
  return m ? m[1] : null;
}

// Extract location from the first line of description (before first <br/>)
function extractLocation(desc) {
  const m = desc.match(/^(.+?)\s*<br/i);
  if (!m) return null;
  const loc = m[1].replace(/<[^>]+>/g, '').trim();
  if (loc.length > 200 || loc.startsWith('The ') || loc.startsWith('We ')) return null;
  return loc;
}

// Extract dates like "Ongoing through Monday, August 31, 2026"
function extractEventDate(desc) {
  const m = desc.match(/Ongoing through \w+,\s+(\w+ \d+, \d{4})/i);
  if (m) return m[1];
  // Try other date patterns
  const m2 = desc.match(/(\w+ \d+-\d+, \d{4})/);
  if (m2) return m2[1];
  return null;
}

(async () => {
  const xml = await fetchFull('https://trumba.com/calendars/afa-conferences.rss');
  const parsed = await parseStringPromise(xml);
  const items = parsed.rss.channel[0].item || [];
  
  console.log(`Total items in AFA RSS: ${items.length}\n`);
  
  const conferences = [];
  for (const item of items) {
    const title = item.title?.[0] || '';
    const desc = decodeHtml(item.description?.[0] || '');
    const link = item.link?.[0] || '';
    const weblink = item['x-trumba:weblink']?.[0] || '';
    
    const country = extractField(desc, 'Country');
    const eventType = extractField(desc, 'Event Type');
    const cfpDeadline = extractField(desc, 'Call for Papers Deadline');
    const host = extractField(desc, 'Host Institution');
    const regDeadline = extractField(desc, 'Registration Deadline');
    const moreInfo = extractUrl(desc, 'More info') || weblink;
    const location = extractLocation(desc);
    const eventDate = extractEventDate(desc);
    
    conferences.push({
      title, country, eventType, cfpDeadline, host,
      regDeadline, url: moreInfo || link, location, eventDate
    });
  }
  
  // Show summary
  const types = {};
  const countries = {};
  for (const c of conferences) {
    const t = c.eventType || 'Unknown';
    types[t] = (types[t] || 0) + 1;
    const co = c.country || 'Unknown';
    countries[co] = (countries[co] || 0) + 1;
  }
  
  console.log('By type:', JSON.stringify(types, null, 2));
  console.log('\nBy country:', JSON.stringify(countries, null, 2));
  
  // Show future conferences (CFP 2026+)
  const future = conferences.filter(c => {
    if (!c.cfpDeadline) return false;
    const parts = c.cfpDeadline.split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[2]);
      return year >= 2026;
    }
    return false;
  });
  
  console.log(`\nFuture conferences (CFP deadline 2026+): ${future.length}`);
  for (const c of future) {
    console.log(`  - ${c.title}`);
    console.log(`    CFP: ${c.cfpDeadline} | ${c.country} | ${c.host}`);
    console.log(`    URL: ${c.url}`);
  }
  
  // Also show all unique titles
  console.log(`\n--- ALL ${conferences.length} titles ---`);
  for (const c of conferences) {
    console.log(`  ${c.title} | ${c.eventType || '?'} | ${c.country || '?'} | CFP: ${c.cfpDeadline || 'n/a'}`);
  }
})();
