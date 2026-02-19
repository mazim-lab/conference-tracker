#!/usr/bin/env node
/**
 * run-all-scrapers.js
 * Runs all conference scrapers, saves output, then merges into conferences.json
 * Usage: node run-all-scrapers.js [--dry-run]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPTS_DIR = __dirname;
const PROJECT_DIR = path.join(__dirname, '..');

const scrapers = [
  { name: 'AAA', script: 'scrape-aaa.js', output: 'scraped-aaa.json', timeout: 120000 },
  { name: 'AFA', script: 'scrape-afa.js', output: 'scraped-afa.json', timeout: 60000 },
  { name: 'EAA', script: 'scrape-eaa.js', output: 'scraped-eaa.json', timeout: 60000 },
  { name: 'EFA', script: 'scrape-efa.js', output: 'scraped-efa.json', timeout: 60000 },
];

const dryRun = process.argv.includes('--dry-run');

async function run() {
  console.log('=== Conference Scraper Pipeline ===\n');
  
  const results = {};
  
  for (const scraper of scrapers) {
    const scriptPath = path.join(SCRIPTS_DIR, scraper.script);
    const outputPath = path.join(PROJECT_DIR, scraper.output);
    
    if (!fs.existsSync(scriptPath)) {
      console.log(`⚠️  ${scraper.name}: Script not found (${scraper.script}), skipping`);
      continue;
    }
    
    console.log(`🔍 Running ${scraper.name} scraper...`);
    
    try {
      const stdout = execSync(`node "${scriptPath}"`, {
        cwd: PROJECT_DIR,
        timeout: scraper.timeout,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8'
      });
      
      // Validate JSON
      const data = JSON.parse(stdout);
      
      // Filter out junk entries
      const filtered = data.filter(c => {
        if (!c.name || c.name.length < 5) return false;
        if (c.name.startsWith('http')) return false;
        if (c.location && c.location.length > 100) return false;
        return true;
      });
      
      fs.writeFileSync(outputPath, JSON.stringify(filtered, null, 2));
      results[scraper.name] = filtered.length;
      console.log(`   ✅ ${filtered.length} conferences (${data.length - filtered.length} filtered out)\n`);
      
    } catch (err) {
      console.log(`   ❌ Error: ${err.message.substring(0, 200)}\n`);
      results[scraper.name] = 0;
    }
  }
  
  // Run merge
  console.log('📦 Merging into conferences.json...');
  const mergeArgs = dryRun ? '--dry-run' : '';
  try {
    const mergeOutput = execSync(`node "${path.join(SCRIPTS_DIR, 'merge-conferences.js')}" ${mergeArgs}`, {
      cwd: PROJECT_DIR,
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
    console.log(mergeOutput);
  } catch (err) {
    // merge-conferences.js outputs to stderr
    if (err.stderr) console.log(err.stderr);
    if (err.status !== 0) console.log(`   ❌ Merge error: ${err.message.substring(0, 200)}`);
  }
  
  // Run filter (removes junk, normalizes dates)
  console.log('🧹 Filtering non-conference items...');
  try {
    const filterOutput = execSync(`node "${path.join(SCRIPTS_DIR, 'filter-conferences.js')}"`, {
      cwd: PROJECT_DIR,
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
    console.log(filterOutput);
  } catch (err) {
    if (err.stdout) console.log(err.stdout);
    if (err.status !== 0) console.log(`   ❌ Filter error: ${err.message.substring(0, 200)}`);
  }

  // Run enrichment (fills missing dates via web search)
  console.log('🔎 Enriching missing dates (Pass 2)...');
  try {
    const enrichOutput = execSync(`node "${path.join(SCRIPTS_DIR, 'enrich-conferences.js')}"`, {
      cwd: PROJECT_DIR,
      timeout: 300000,  // 5 min — rate-limited web searches
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env }
    });
    console.log(enrichOutput);
  } catch (err) {
    if (err.stdout) console.log(err.stdout);
    if (err.status !== 0) console.log(`   ❌ Enrichment error: ${err.message.substring(0, 200)}`);
  }

  // Run AI enrichment (Pass 3 — for whatever Pass 2 couldn't find)
  console.log('🤖 AI enrichment for remaining gaps (Pass 3)...');
  try {
    const aiOutput = execSync(`node "${path.join(SCRIPTS_DIR, 'enrich-ai.js')}"`, {
      cwd: PROJECT_DIR,
      timeout: 400000,  // 6.5 min — AI agent may take a while
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env }
    });
    console.log(aiOutput);
  } catch (err) {
    if (err.stdout) console.log(err.stdout);
    if (err.status !== 0) console.log(`   ⚠️ AI enrichment error (non-fatal): ${err.message.substring(0, 200)}`);
  }

  console.log('\n=== Pipeline Complete ===');
  console.log('Results:');
  for (const [name, count] of Object.entries(results)) {
    console.log(`  ${name}: ${count} conferences`);
  }
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
