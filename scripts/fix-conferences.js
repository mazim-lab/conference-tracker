const fs = require('fs');
const { parseStringPromise } = require('xml2js');

function decodeHtml(html) {
  return html
    .replace(/&amp;#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&nbsp;/g, ' ');
}

function extractField(desc, field) {
  const re = new RegExp(`<b>${field}</b>:(?:\\s|&nbsp;)*(.*?)(?:\\s*<br|$)`, 'i');
  const m = desc.match(re);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, '').trim();
}

function extractUrl(desc, field) {
  const re = new RegExp(`<b>${field}</b>[^<]*<a\\s+href="([^"]+)"`, 'i');
  const m = desc.match(re);
  return m ? m[1] : null;
}

function parseCfpDate(dateStr) {
  if (!dateStr) return '';
  // Handle MM-DD-YYYY
  let m = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  // Handle DD-MM-YYYY (less common)
  m = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  // Handle "10 April 2026" or "March 15, 2026"
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return '';
}

function extractEventDates(desc) {
  // "Ongoing through Monday, August 31, 2026"
  const m = desc.match(/Ongoing through \w+,\s+(\w+ \d+, \d{4})/i);
  if (m) return m[1];
  return null;
}

function formatDates(startDate, endDateStr) {
  if (!startDate) return '';
  const s = new Date(startDate + 'T12:00:00');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (!endDateStr) return `${months[s.getMonth()]} ${s.getDate()}`;
  const e = new Date(endDateStr + 'T12:00:00');
  if (s.getMonth() === e.getMonth()) {
    return `${months[s.getMonth()]} ${s.getDate()}-${e.getDate()}`;
  }
  return `${months[s.getMonth()]} ${s.getDate()}-${months[e.getMonth()]} ${e.getDate()}`;
}

function normalize(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isSimilar(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Check first 30 chars
  if (na.substring(0, 30) === nb.substring(0, 30) && na.length > 20) return true;
  return false;
}

(async () => {
  // Load existing data
  const data = JSON.parse(fs.readFileSync('conferences.json', 'utf-8'));
  let maxId = Math.max(...data.map(c => c.id || 0));
  
  // Parse AFA RSS
  const xml = fs.readFileSync('/tmp/afa-rss.xml', 'utf-8');
  const parsed = await parseStringPromise(xml);
  const items = parsed.rss.channel[0].item || [];
  
  console.log(`AFA RSS items: ${items.length}`);
  console.log(`Existing conferences: ${data.length}`);
  
  // Build AFA conference map from RSS
  const afaConfs = [];
  for (const item of items) {
    const title = item.title?.[0] || '';
    const desc = decodeHtml(item.description?.[0] || '');
    const link = item.link?.[0] || '';
    const weblink = item['x-trumba:weblink']?.[0] || '';
    const category = item.category?.[0] || '';
    
    const country = extractField(desc, 'Country');
    const eventType = extractField(desc, 'Event Type');
    const cfpDeadline = extractField(desc, 'Call for Papers Deadline');
    const host = extractField(desc, 'Host Institution');
    const regDeadline = extractField(desc, 'Registration Deadline');
    const moreInfo = extractUrl(desc, 'More info') || weblink;
    const confCost = extractField(desc, 'Conference Cost \\(USD\\)');
    
    // Extract location from first line
    const firstLine = desc.split(/<br\s*\/?>/i)[0]?.replace(/<[^>]+>/g, '').trim();
    let location = '';
    if (firstLine && firstLine.length < 150 && !firstLine.startsWith('The ') && !firstLine.startsWith('We ')) {
      location = firstLine;
    }
    
    // Parse dates
    const endDate = extractEventDates(desc);
    const cfpDateParsed = parseCfpDate(cfpDeadline);
    
    // Determine if future
    const now = new Date();
    const isFuture = (cfpDateParsed && new Date(cfpDateParsed) >= now) || 
                     (endDate && new Date(endDate) >= now) ||
                     (category && category.includes('2026'));
    
    afaConfs.push({
      title, country, eventType, cfpDeadline: cfpDateParsed, host,
      location, url: moreInfo || link, isFuture, regDeadline
    });
  }
  
  // 1. Update existing AFA entries with metadata
  let updated = 0;
  for (const entry of data) {
    if (entry.source !== 'AFA Trumba Calendar') continue;
    
    // Find matching RSS item
    const match = afaConfs.find(a => isSimilar(a.title, entry.name));
    if (match) {
      if (match.country && !entry.country) entry.country = match.country;
      if (match.location && (entry.location === 'TBD' || !entry.location)) entry.location = match.location;
      if (match.cfpDeadline && !entry.deadline) entry.deadline = match.cfpDeadline;
      if (match.url && !entry.url) entry.url = match.url;
      updated++;
    }
  }
  console.log(`Updated ${updated} existing AFA entries with metadata`);
  
  // 2. Add NEW AFA conferences not in database
  let added = 0;
  const existingNames = data.map(c => normalize(c.name));
  
  for (const afc of afaConfs) {
    if (!afc.isFuture) continue;
    if (!afc.title || afc.title.length < 5) continue;
    // Skip PhD programs and other non-conference items
    if (afc.eventType === 'Other') continue;
    
    const norm = normalize(afc.title);
    const exists = existingNames.some(en => isSimilar(afc.title, data[existingNames.indexOf(en)]?.name || ''));
    if (exists) continue;
    
    maxId++;
    const startDate = afc.cfpDeadline || ''; // We don't have exact start dates from RSS easily
    
    data.push({
      id: maxId,
      name: afc.title,
      dates: '',
      startDate: '',
      location: afc.location || 'TBD',
      country: afc.country || '',
      disc: ['fin'],
      sid: `afa-${maxId}`,
      ssrnLink: '',
      deadline: afc.cfpDeadline || '',
      url: afc.url || '',
      tier: '',
      source: 'AFA Trumba Calendar'
    });
    existingNames.push(norm);
    added++;
    console.log(`  ADD: ${afc.title} (${afc.country || '?'}, deadline: ${afc.cfpDeadline || 'none'})`);
  }
  console.log(`Added ${added} new AFA conferences`);
  
  // 3. Deduplicate AAA entries
  // Find pairs of AAA duplicates
  const aaaDupes = [
    ['AAA ATA Midyear Meeting 2026', '2026 American Taxation Association Midyear Meeting'],
    ['AAA Leadership Conference 2026', '2026 Leadership in Accounting Education Section Midyear Meeting'],
    ['AAA Forensic Accounting Section Research Conference 2026', '2026 Forensic Accounting Section Research Conference'],
    ['AAA GNP Midyear Meeting 2026', '2026 Government and Nonprofit (GNP) Section Midyear Meeting'],
    ['AAA AIS/SET Bootcamp 2026', '2026 AIS Bootcamp'],
    ['AAA Spark: Igniting Research Innovation 2026', '2026 Spark Meeting'],
    ['AAA ABO Research Conference 2026', '2026 Accounting Behavior and Organizations Research Conference'],
    ['AAA Global Connect 2026 (Annual Meeting)', '2026 AAA Global Connect (formerly Annual Meeting)'],
    ['AAA Global Connect 2027 (Annual Meeting)', '2027 AAA Global Connect'],
    ['AAA Global Connect 2028 (Annual Meeting)', '2028 AAA Global Connect'],
    ['AAA FARS Midyear Meeting 2027', '2027 Financial Accounting and Reporting Section Midyear Meeting'],
    ['AAA MAS Midyear Meeting 2027', '2027 Management Accounting Section Midyear Meeting'],
    ['AAA JIAR Conference 2026', 'Audit Educators Bootcamp'], // NOT a dupe, skip
  ];
  
  let removed = 0;
  for (const [keep, remove] of aaaDupes) {
    const keepIdx = data.findIndex(c => c.name === keep);
    const removeIdx = data.findIndex(c => c.name === remove);
    if (keepIdx >= 0 && removeIdx >= 0) {
      // Merge any better data from remove into keep
      const k = data[keepIdx];
      const r = data[removeIdx];
      if (r.deadline && !k.deadline) k.deadline = r.deadline;
      if (r.location && k.location === 'TBD') k.location = r.location;
      if (r.url && !k.url) k.url = r.url;
      // Remove the duplicate
      data.splice(removeIdx, 1);
      removed++;
      console.log(`  DEDUP: removed "${remove}", kept "${keep}"`);
    }
  }
  
  // Also check for AAA Mid-Career Faculty Consortium (no dupe partner)
  // And "Accounting Horizons Conference" (no dupe)
  
  console.log(`Removed ${removed} duplicates`);
  
  // 4. Fix dates format for AFA entries
  for (const entry of data) {
    // Fix dates that look like "2026-02-02" to human readable
    if (entry.dates && /^\d{4}-\d{2}-\d{2}$/.test(entry.dates)) {
      const d = new Date(entry.dates + 'T12:00:00');
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      entry.dates = `${months[d.getMonth()]} ${d.getDate()}`;
      if (!entry.startDate) entry.startDate = entry.dates;
    }
    
    // Ensure all required fields
    entry.id = entry.id || ++maxId;
    entry.name = entry.name || '';
    entry.dates = entry.dates || '';
    entry.startDate = entry.startDate || '';
    entry.location = entry.location || 'TBD';
    entry.country = entry.country || '';
    entry.disc = entry.disc || ['fin'];
    entry.sid = entry.sid || `ext-${entry.id}`;
    entry.ssrnLink = entry.ssrnLink || '';
    entry.deadline = entry.deadline || '';
    entry.url = entry.url || '';
    entry.tier = entry.tier || '';
  }
  
  // Reassign sequential IDs
  data.forEach((c, i) => c.id = i + 1);
  
  fs.writeFileSync('conferences.json', JSON.stringify(data, null, 2));
  console.log(`\nFinal total: ${data.length} conferences`);
  console.log(`Summary: ${updated} updated, ${added} added, ${removed} duplicates removed`);
})();
