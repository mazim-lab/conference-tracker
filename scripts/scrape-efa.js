const https = require('https');
const cheerio = require('cheerio');
const fs = require('fs');

const URL = 'https://european-finance.org/r/news';

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

// Helper to format date
function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '';
    return date.toISOString().split('T')[0];
}

async function run() {
  try {
    const html = await fetchHTML(URL);
    const $ = cheerio.load(html);
    
    const conferences = [];
    let currentConf = null;

    // Improve scraper to find more items, not just H3s
    // Many items are just paragraphs with a strong link at the start or similar.
    // We will iterate over all children of the main content area
    
    // Fallback selectors
    const content = $('div.content, div#content, body').first();
    
    // Select all potential elements that could be headers or content
    // We iterate over children to maintain order
    content.children().each((i, el) => {
        const $el = $(el);
        const tagName = el.tagName.toLowerCase();
        
        let isHeader = false;
        let title = '';
        let url = '';
        
        // Case 1: Header tag
        if (['h2', 'h3', 'h4'].includes(tagName)) {
            isHeader = true;
            title = $el.text().trim();
            url = $el.find('a').attr('href') || '';
        } 
        // Case 2: Paragraph with strong link at start
        else if (tagName === 'p') {
            const strongLink = $el.find('strong > a, b > a, a > strong, a > b').first();
            if (strongLink.length > 0) {
                // Check if it looks like a title (not "Click here")
                const linkText = strongLink.text().trim();
                // Heuristic: titles are usually longer than 5 chars and don't look like generic links
                if (linkText.length > 5 && !linkText.toLowerCase().includes('click here')) {
                     isHeader = true;
                     title = linkText;
                     url = strongLink.attr('href');
                }
            } else {
                 // Case 3: Paragraph starting with a link that is the whole line
                 const link = $el.find('a').first();
                 if (link.length > 0 && $el.text().trim() === link.text().trim()) {
                     // Potential title if it looks like one
                     if (link.text().length > 10) {
                         isHeader = true;
                         title = link.text().trim();
                         url = link.attr('href');
                     }
                 }
            }
        }
        
        if (isHeader) {
            // Push previous if exists
            if (currentConf) {
                conferences.push(currentConf);
            }
            
            currentConf = {
                name: title,
                url: url || "",
                descText: '',
                source: "EFA",
                disc: ["fin"]
            };
        } else if (currentConf) {
            // Append text to current description
            currentConf.descText += $el.text() + "\n";
        }
    });
    
    // Push last one
    if (currentConf) conferences.push(currentConf);
    
    // Now post-process the collected text to extract details
    const finalConfs = conferences.map(conf => {
        const text = conf.descText;
        
        // Regex strategies for fields
        const locationMatch = text.match(/(?:Location|Venue):\s*(.*?)(?:\n|$|<)/i);
        const dateMatch = text.match(/(?:Date|Dates):\s*(.*?)(?:\n|$|<)/i);
        const deadlineMatch = text.match(/(?:Submission Deadline|Deadline):\s*(.*?)(?:\n|$|<)/i);
        
        // Refine URL if missing or relative
        if (conf.url && !conf.url.startsWith('http')) {
             if (conf.url.startsWith('/')) {
                 conf.url = 'https://european-finance.org' + conf.url;
             }
        }
        
        // Fallback: search for URL in text if main URL is empty
        if (!conf.url) {
            const linkMatch = text.match(/https?:\/\/[^\s]+/);
            if (linkMatch) conf.url = linkMatch[0];
        }
        
        return {
            name: conf.name,
            dates: dateMatch ? dateMatch[1].trim() : "",
            startDate: "", 
            location: locationMatch ? locationMatch[1].trim() : "TBD",
            country: "", 
            disc: ["fin"],
            deadline: deadlineMatch ? formatDate(deadlineMatch[1].trim()) : "",
            url: conf.url,
            source: "EFA"
        };
    }).filter(c => c.name && c.name.length > 5 && !c.name.includes("Finance Journals")); // Filter noise
    
    console.log(JSON.stringify(finalConfs, null, 2));
    
  } catch (err) {
    console.error("Error scraping EFA:", err);
  }
}

run();
