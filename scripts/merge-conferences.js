const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFERENCES_FILE = path.join(__dirname, '../conferences.json');
const SCRIPTS_DIR = path.join(__dirname, '../scripts');

// Simple Levenshtein distance for fuzzy matching
function levenshtein(a, b) {
  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          Math.min(
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1 // deletion
          )
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

function isSimilar(title1, title2) {
    if (!title1 || !title2) return false;
    const s1 = title1.toLowerCase().replace(/[^a-z0-9]/g, '');
    const s2 = title2.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    if (s1 === s2) return true;
    if (s1.includes(s2) || s2.includes(s1)) return true;
    
    const dist = levenshtein(s1, s2);
    const maxLen = Math.max(s1.length, s2.length);
    // Allow 20% difference
    return dist < maxLen * 0.2;
}

function runScraper(scriptName) {
    try {
        console.log(`Running ${scriptName}...`);
        const output = execSync(`node "${path.join(SCRIPTS_DIR, scriptName)}"`, { encoding: 'utf8' });
        // The scrapers print logs to stdout as well, but the JSON is likely at the end or we need to separate it.
        // My scrapers print logs then the JSON. I should probably adjust them to output ONLY JSON or write to a file.
        // Or I can parse the last line? Or try to find the JSON array in the output.
        
        // Robust way: find the first '[' and last ']'
        const start = output.indexOf('[');
        const end = output.lastIndexOf(']');
        if (start === -1 || end === -1) {
            console.error(`No JSON found in output of ${scriptName}`);
            return [];
        }
        const jsonStr = output.substring(start, end + 1);
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error(`Failed to run ${scriptName}:`, e.message);
        return [];
    }
}

function merge() {
    console.log("Reading existing conferences...");
    let existing = [];
    try {
        existing = JSON.parse(fs.readFileSync(CONFERENCES_FILE, 'utf8'));
    } catch (e) {
        console.error("Could not read existing conferences.json", e);
        existing = [];
    }

    const afa = runScraper('scrape-afa.js');
    const efa = runScraper('scrape-efa.js');
    const eaa = runScraper('scrape-eaa.js');

    const newConferences = [...afa, ...efa, ...eaa];
    console.log(`Collected ${newConferences.length} potential new conferences.`);

    let addedCount = 0;
    let maxId = existing.reduce((max, c) => Math.max(max, c.id || 0), 0);

    for (const conf of newConferences) {
        // Check for duplicates
        const exists = existing.find(e => {
            // Check exact URL match if URL exists
            if (conf.url && e.url === conf.url) return true;
            // Check title similarity
            if (isSimilar(e.name, conf.name)) return true;
            return false;
        });

        if (!exists) {
            maxId++;
            // Normalize fields
            const newEntry = {
                id: maxId,
                name: conf.name,
                dates: conf.dates || "",
                startDate: conf.startDate || "",
                location: conf.location || "TBD",
                country: conf.country || "", // Scrapers might not set this well
                disc: conf.disc || ["fin"],
                sid: "", // Source ID?
                ssrnLink: "",
                deadline: conf.deadline || "",
                url: conf.url || "",
                tier: "",
                source: conf.source // Track where it came from
            };
            
            existing.push(newEntry);
            addedCount++;
            console.log(`Adding: ${conf.name}`);
        } else {
            // Optional: update existing entry with better data?
            // For now, skip to preserve manual edits.
        }
    }

    console.log(`Merged ${addedCount} new conferences.`);
    console.log(`Total conferences: ${existing.length}`);

    fs.writeFileSync(CONFERENCES_FILE, JSON.stringify(existing, null, 2));
    console.log("Updated conferences.json");
}

merge();
