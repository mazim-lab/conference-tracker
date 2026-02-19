#!/usr/bin/env node
/**
 * Pass 3: AI-powered enrichment for conferences that Pass 2 couldn't resolve.
 * 
 * Uses OpenClaw's browser automation to visit conference pages behind Cloudflare,
 * then extracts dates via LLM analysis of page content.
 * 
 * Usage: node scripts/enrich-ai.js
 * 
 * This script outputs a JSON file of suggested fixes that can be reviewed
 * and applied. It does NOT modify conferences.json directly.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONF_PATH = path.join(__dirname, '..', 'conferences.json');
const SUGGESTIONS_PATH = path.join(__dirname, '..', 'enrich-suggestions.json');
const OPENCLAW = process.env.OPENCLAW_BIN || '/Users/shafbot/.openclaw/bin/openclaw';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const data = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
  
  // Find conferences still missing startDate after Pass 2
  const needsDate = data.filter(c => !c.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(c.startDate));
  
  console.log(`=== AI Enrichment (Pass 3) ===`);
  console.log(`${needsDate.length} conferences need dates\n`);
  
  if (needsDate.length === 0) {
    console.log('Nothing to do!');
    return;
  }

  // Build the task for the AI agent
  const confList = needsDate.map((c, i) => {
    const parts = [`${i+1}. "${c.name}"`];
    if (c.url) parts.push(`URL: ${c.url}`);
    if (c.ssrnLink) parts.push(`SSRN: ${c.ssrnLink}`);
    if (c.deadline && c.deadline !== 'TBD') parts.push(`Deadline: ${c.deadline}`);
    if (c.dates) parts.push(`Dates text: ${c.dates}`);
    if (c.location) parts.push(`Location: ${c.location}`);
    return parts.join(' | ');
  }).join('\n');

  const task = `You are a research assistant. Your job is to find the EXACT conference dates for these academic conferences.

For each conference below, do the following:
1. If a URL is provided, use the browser to visit it and extract the conference dates
2. If no URL or the URL doesn't work, search the web for the conference name + year
3. If you find the dates, extract: startDate (YYYY-MM-DD), dates (human readable like "Mar 19-20"), location, country
4. If this is clearly NOT a conference (it's a journal call, research project, prize, etc.), mark it as "remove"
5. If you genuinely cannot find dates after searching, mark as "unknown"

IMPORTANT:
- Use web_search and web_fetch tools to find information
- For Cloudflare-blocked sites (like SSRN), use web_search instead
- Be precise with dates — don't guess
- Output ONLY a JSON array of results, one per conference, in this format:
[
  {"index": 1, "action": "fix", "startDate": "2026-03-19", "dates": "Mar 19-20", "location": "City", "country": "Country", "url": "https://..."},
  {"index": 2, "action": "remove", "reason": "Not a conference - journal call for papers"},
  {"index": 3, "action": "unknown", "reason": "No dates found after searching"}
]

Here are the conferences:

${confList}

Output ONLY the JSON array. No other text.`;

  console.log('Spawning AI agent for date extraction...\n');
  
  // Write task to temp file to avoid shell escaping issues
  const taskFile = path.join(__dirname, '..', '.enrich-task.tmp');
  fs.writeFileSync(taskFile, task);
  
  try {
    const result = execSync(
      `${OPENCLAW} agent --agent guppy --message "$(cat '${taskFile}')" --timeout 300 --json`,
      {
        cwd: path.join(__dirname, '..'),
        timeout: 360000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      }
    );
    
    // Parse the agent response
    let response;
    try {
      response = JSON.parse(result);
    } catch {
      // Try to extract JSON from the response text
      response = { reply: result };
    }
    
    const replyText = response.reply || response.text || result;
    
    // Extract JSON array from reply
    const jsonMatch = replyText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log('Could not parse AI response as JSON.');
      console.log('Raw response:', replyText.slice(0, 500));
      fs.writeFileSync(SUGGESTIONS_PATH, JSON.stringify({ error: 'parse_failed', raw: replyText }, null, 2));
      return;
    }
    
    const suggestions = JSON.parse(jsonMatch[0]);
    
    // Apply suggestions
    let fixed = 0, removed = 0, unknown = 0;
    
    for (const s of suggestions) {
      const conf = needsDate[s.index - 1];
      if (!conf) continue;
      
      if (s.action === 'fix' && s.startDate) {
        conf.startDate = s.startDate;
        if (s.dates) conf.dates = s.dates;
        if (s.location && conf.location === 'TBD') conf.location = s.location;
        if (s.country && !conf.country) conf.country = s.country;
        if (s.url && !conf.url) conf.url = s.url;
        console.log(`  ✓ Fixed: ${conf.name.slice(0, 50)} → ${s.startDate}`);
        fixed++;
      } else if (s.action === 'remove') {
        conf._remove = true;
        console.log(`  ✗ Remove: ${conf.name.slice(0, 50)} (${s.reason})`);
        removed++;
      } else {
        console.log(`  ? Unknown: ${conf.name.slice(0, 50)} (${s.reason || 'no info'})`);
        unknown++;
      }
    }
    
    // Remove marked conferences
    const filtered = data.filter(c => !c._remove);
    filtered.forEach(c => delete c._remove);
    
    fs.writeFileSync(CONF_PATH, JSON.stringify(filtered, null, 2));
    
    // Save suggestions for audit
    fs.writeFileSync(SUGGESTIONS_PATH, JSON.stringify(suggestions, null, 2));
    
    console.log(`\n=== Pass 3 Results ===`);
    console.log(`Fixed: ${fixed}`);
    console.log(`Removed: ${removed}`);
    console.log(`Unknown: ${unknown}`);
    console.log(`Total conferences: ${filtered.length}`);
    console.log(`Suggestions saved to: ${SUGGESTIONS_PATH}`);
    
  } catch (err) {
    console.log(`AI agent error: ${err.message.slice(0, 300)}`);
    if (err.stdout) console.log('stdout:', err.stdout.slice(0, 500));
    if (err.stderr) console.log('stderr:', err.stderr.slice(0, 500));
  } finally {
    // Cleanup
    try { fs.unlinkSync(taskFile); } catch {}
  }
}

main().catch(console.error);
