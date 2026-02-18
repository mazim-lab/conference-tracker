#!/usr/bin/env node
/**
 * merge-conferences.js
 * Merges scraped conference data into conferences.json
 * Usage: node merge-conferences.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONF_PATH = path.join(__dirname, '..', 'conferences.json');

// Normalize name for comparison
function normName(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Simple string similarity (Jaccard on words)
function similarity(a, b) {
  const wordsA = new Set(normName(a).split(' ').filter(w => w.length > 2));
  const wordsB = new Set(normName(b).split(' ').filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  return intersection / Math.max(wordsA.size, wordsB.size);
}

// Find best match in existing conferences
function findMatch(newConf, existing) {
  let bestMatch = null;
  let bestScore = 0;
  
  for (const conf of existing) {
    // URL match is strongest signal
    if (newConf.url && conf.url && newConf.url.split('?')[0] === conf.url.split('?')[0]) {
      return { conf, score: 1.0 };
    }
    
    // Name similarity
    const score = similarity(newConf.name, conf.name);
    
    // Boost if same year
    if (newConf.startDate && conf.startDate && 
        newConf.startDate.substring(0, 4) === conf.startDate.substring(0, 4)) {
      if (score > 0.5 && score + 0.1 > bestScore) {
        bestScore = score + 0.1;
        bestMatch = conf;
      }
    }
    
    if (score > bestScore && score >= 0.6) {
      bestScore = score;
      bestMatch = conf;
    }
  }
  
  return bestMatch ? { conf: bestMatch, score: bestScore } : null;
}

// Merge new data into existing entry (fill blanks, don't overwrite good data)
function mergeEntry(existing, newData) {
  const updated = { ...existing };
  let changed = false;
  
  const fields = ['dates', 'startDate', 'location', 'country', 'deadline', 'url', 'ssrnLink'];
  for (const field of fields) {
    const existingVal = existing[field];
    const newVal = newData[field];
    
    // Fill blank fields
    if ((!existingVal || existingVal === '' || existingVal === 'TBD' || existingVal === 'USA') && 
        newVal && newVal !== '' && newVal !== 'TBD') {
      updated[field] = newVal;
      changed = true;
    }
  }
  
  // Fix disc if wrong (e.g., "fin" should be "acct" for AAA)
  if (newData.source === 'aaa' && JSON.stringify(existing.disc) !== '["acct"]') {
    updated.disc = ["acct"];
    changed = true;
  }
  
  // Fill name if existing is less specific
  if (newData.name.length > existing.name.length && similarity(newData.name, existing.name) > 0.5) {
    // Keep existing name unless new is clearly more complete
  }
  
  return { updated, changed };
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  
  // Load existing conferences
  const existing = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
  console.error(`Loaded ${existing.length} existing conferences`);
  
  // Load scraped data from each source
  const sources = ['aaa', 'afa', 'eaa', 'efa'];
  const scraped = {};
  
  for (const source of sources) {
    const filePath = path.join(__dirname, '..', `scraped-${source}.json`);
    if (fs.existsSync(filePath)) {
      scraped[source] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      console.error(`Loaded ${scraped[source].length} scraped ${source.toUpperCase()} conferences`);
    } else {
      console.error(`No scraped data for ${source.toUpperCase()} (${filePath})`);
      scraped[source] = [];
    }
  }
  
  let updated = 0, added = 0, unchanged = 0;
  let maxId = Math.max(...existing.map(c => c.id || 0));
  const usedSids = new Set(existing.map(c => c.sid).filter(Boolean));
  
  // Process each scraped conference
  for (const [source, confs] of Object.entries(scraped)) {
    for (const newConf of confs) {
      const match = findMatch(newConf, existing);
      
      if (match && match.score >= 0.6) {
        // Update existing entry
        const { updated: mergedEntry, changed } = mergeEntry(match.conf, newConf);
        if (changed) {
          Object.assign(match.conf, mergedEntry);
          updated++;
          console.error(`  UPDATED: ${match.conf.name} (score: ${match.score.toFixed(2)})`);
        } else {
          unchanged++;
        }
      } else {
        // Add new entry
        maxId++;
        newConf.id = maxId;
        
        // Ensure unique sid
        if (!newConf.sid || usedSids.has(newConf.sid)) {
          newConf.sid = `${source}-${crypto.createHash('md5').update(newConf.name + newConf.url).digest('hex').substring(0, 8)}`;
        }
        usedSids.add(newConf.sid);
        
        // Ensure all required fields
        newConf.ssrnLink = newConf.ssrnLink || '';
        newConf.tier = newConf.tier || '2';
        newConf.disc = newConf.disc || ['acct'];
        
        existing.push(newConf);
        added++;
        console.error(`  ADDED: ${newConf.name} (${source})`);
      }
    }
  }
  
  // Verify no duplicate sids
  const sidCounts = {};
  for (const c of existing) {
    if (c.sid) {
      sidCounts[c.sid] = (sidCounts[c.sid] || 0) + 1;
    }
  }
  const dupes = Object.entries(sidCounts).filter(([, count]) => count > 1);
  if (dupes.length > 0) {
    console.error(`\n⚠️  Duplicate sids found:`);
    for (const [sid, count] of dupes) {
      console.error(`  ${sid}: ${count} entries`);
      // Fix by appending index
      let idx = 0;
      for (const c of existing) {
        if (c.sid === sid) {
          if (idx > 0) c.sid = `${sid}-${idx}`;
          idx++;
        }
      }
    }
  }
  
  console.error(`\n=== Summary ===`);
  console.error(`Updated: ${updated}`);
  console.error(`Added: ${added}`);
  console.error(`Unchanged: ${unchanged}`);
  console.error(`Total: ${existing.length}`);
  
  if (dryRun) {
    console.error('\n(Dry run — not writing)');
  } else {
    fs.writeFileSync(CONF_PATH, JSON.stringify(existing, null, 2));
    console.error(`\nWritten to ${CONF_PATH}`);
  }
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
