const fs = require('fs');

// Read existing conferences and scraped data
const conferences = JSON.parse(fs.readFileSync('conferences.json', 'utf8'));
const scrapedData = JSON.parse(fs.readFileSync('aaa_scraped_raw.json', 'utf8'));

console.log('📊 Starting AAA data update process...');
console.log(`Found ${conferences.length} total conferences in database`);

// Find existing AAA conferences
const aaaConferences = conferences.filter(conf => 
    conf.name.includes('AAA') || 
    conf.name.includes('American Accounting Association') ||
    conf.url?.includes('aaahq.org')
);

console.log(`Found ${aaaConferences.length} existing AAA conferences`);

// Manual data enhancement based on known AAA meeting information
const manualEnhancements = {
    'https://aaahq.org/Meetings/2026/AAA-Global-Connect': {
        dates: 'Aug 1-5',
        startDate: '2026-08-01',
        location: 'Nashville, TN',
        country: 'USA',
        deadline: '',
        fullName: 'AAA Global Connect 2026 (Annual Meeting)'
    },
    'https://aaahq.org/Meetings/2026/ATA-Midyear-Meeting': {
        dates: 'Feb 19-21',
        startDate: '2026-02-19',
        location: 'Nashville, TN',
        country: 'USA',
        deadline: '',
        fullName: 'AAA ATA Midyear Meeting 2026'
    },
    'https://aaahq.org/Meetings/2026/AIS-Bootcamp': {
        dates: 'May 20-21',
        startDate: '2026-05-20',
        location: 'Atlanta, GA',
        country: 'USA',
        deadline: '',
        fullName: 'AAA AIS/SET Bootcamp 2026'
    },
    'https://aaahq.org/Meetings/2026/ABO-Research-Conference': {
        dates: 'Oct 15-17',
        startDate: '2026-10-15',
        location: 'Atlanta, GA',
        country: 'USA',
        deadline: '',
        fullName: 'AAA ABO Research Conference 2026'
    },
    'https://aaahq.org/Meetings/2027/MAS-Midyear-Meeting': {
        dates: 'Jan 7-9',
        startDate: '2027-01-07',
        location: 'Atlanta, GA',
        country: 'USA',
        deadline: '',
        fullName: 'AAA MAS Midyear Meeting 2027'
    },
    'https://aaahq.org/Meetings/2027/FARS-Midyear-Meeting': {
        dates: 'Jan 21-23',
        startDate: '2027-01-21',
        location: 'Atlanta, GA',
        country: 'USA',
        deadline: '',
        fullName: 'AAA FARS Midyear Meeting 2027'
    },
    'https://aaahq.org/Meetings/2027/AAA-Global-Connect': {
        dates: 'Aug 2-4',
        startDate: '2027-08-02',
        location: 'Atlanta, GA',
        country: 'USA',
        deadline: '',
        fullName: 'AAA Global Connect 2027 (Annual Meeting)'
    },
    'https://aaahq.org/Meetings/2028/AAA-Global-Connect': {
        dates: 'Aug 4-9',
        startDate: '2028-08-04',
        location: 'Atlanta, GA',
        country: 'USA',
        deadline: '',
        fullName: 'AAA Global Connect 2028 (Annual Meeting)'
    }
};

// Helper function to find matching conference by name similarity
function findMatchingConference(scrapedEntry, conferences) {
    const scrapedName = scrapedEntry.fullName?.toLowerCase() || scrapedEntry.title?.toLowerCase() || '';
    
    for (const conf of conferences) {
        const confName = conf.name.toLowerCase();
        
        // Direct URL match
        if (conf.url === scrapedEntry.url) {
            return conf;
        }
        
        // Name similarity matching
        if (scrapedName.includes('global connect') && confName.includes('global connect')) {
            const scrapedYear = scrapedEntry.url?.match(/\/(\d{4})\//)?.[1];
            if (scrapedYear && confName.includes(scrapedYear)) {
                return conf;
            }
        }
        
        if (scrapedName.includes('ata') && confName.includes('ata')) {
            return conf;
        }
        
        if (scrapedName.includes('ais') && confName.includes('ais')) {
            return conf;
        }
        
        if (scrapedName.includes('abo') && confName.includes('abo')) {
            return conf;
        }
        
        if (scrapedName.includes('mas') && confName.includes('mas')) {
            return conf;
        }
        
        if (scrapedName.includes('fars') && confName.includes('fars')) {
            return conf;
        }
    }
    
    return null;
}

// Process scraped data and update existing conferences
let updatesCount = 0;
let newConferencesCount = 0;
const maxId = Math.max(...conferences.map(c => c.id));
let nextId = maxId + 1;

// Get existing sids to avoid duplicates
const existingSids = new Set(conferences.map(c => c.sid));

for (const scrapedEntry of scrapedData) {
    // Skip login page and invalid entries
    if (scrapedEntry.url.includes('Sign-In') || !scrapedEntry.url.includes('/Meetings/')) {
        continue;
    }
    
    console.log(`\n🔍 Processing: ${scrapedEntry.title || scrapedEntry.fullName}`);
    console.log(`    URL: ${scrapedEntry.url}`);
    
    // Get manual enhancements if available
    const enhancement = manualEnhancements[scrapedEntry.url] || {};
    
    // Find matching existing conference
    const existingConf = findMatchingConference(scrapedEntry, aaaConferences);
    
    if (existingConf) {
        console.log(`    ✅ Found existing conference: ${existingConf.name}`);
        
        // Update existing conference
        const updates = [];
        
        // Update name if we have a better one
        if (enhancement.fullName && enhancement.fullName !== existingConf.name) {
            existingConf.name = enhancement.fullName;
            updates.push('name');
        }
        
        // Update dates
        if (enhancement.dates && enhancement.dates !== existingConf.dates) {
            existingConf.dates = enhancement.dates;
            updates.push('dates');
        }
        
        // Update startDate
        if (enhancement.startDate && (!existingConf.startDate || existingConf.startDate === '')) {
            existingConf.startDate = enhancement.startDate;
            updates.push('startDate');
        }
        
        // Update location
        if (enhancement.location && (existingConf.location === 'USA' || existingConf.location === '' || !existingConf.location)) {
            existingConf.location = enhancement.location;
            updates.push('location');
        }
        
        // Update country
        if (enhancement.country && (!existingConf.country || existingConf.country === '')) {
            existingConf.country = enhancement.country;
            updates.push('country');
        }
        
        // Fix discipline - AAA conferences should be "acct", not "fin"
        if (existingConf.disc.includes('fin') && !existingConf.disc.includes('acct')) {
            existingConf.disc = ['acct'];
            updates.push('disc');
        }
        
        // Update URL if missing
        if (!existingConf.url && scrapedEntry.url) {
            existingConf.url = scrapedEntry.url;
            updates.push('url');
        }
        
        if (updates.length > 0) {
            console.log(`    📝 Updated: ${updates.join(', ')}`);
            updatesCount++;
        } else {
            console.log(`    ✓ No updates needed`);
        }
        
    } else {
        // Create new conference entry
        console.log(`    🆕 Creating new conference entry`);
        
        // Generate unique sid
        let sid;
        do {
            sid = (Math.floor(Math.random() * 90000) + 10000).toString();
        } while (existingSids.has(sid));
        existingSids.add(sid);
        
        const newConf = {
            id: nextId++,
            name: enhancement.fullName || scrapedEntry.fullName || scrapedEntry.title,
            dates: enhancement.dates || extractDatesFromText(scrapedEntry.dates) || '',
            startDate: enhancement.startDate || parseScrapedDate(scrapedEntry.dates) || '',
            location: enhancement.location || 'USA',
            country: enhancement.country || 'USA',
            disc: ['acct'],
            sid: sid,
            ssrnLink: '',
            deadline: enhancement.deadline || '',
            url: scrapedEntry.url,
            tier: ''
        };
        
        conferences.push(newConf);
        newConferencesCount++;
        
        console.log(`    ✅ Created new conference: ${newConf.name}`);
        console.log(`    📋 ID: ${newConf.id}, SID: ${newConf.sid}`);
    }
}

// Helper functions
function extractDatesFromText(text) {
    if (!text) return '';
    
    // Clean up the scraped dates
    if (text.includes('august 1-5, 2026')) return 'Aug 1-5';
    if (text.includes('may 20-21, 2026')) return 'May 20-21';
    if (text.includes('october 15–17, 2026')) return 'Oct 15-17';
    if (text.includes('january 7-9, 2027')) return 'Jan 7-9';
    if (text.includes('january 21-23, 2027')) return 'Jan 21-23';
    if (text.includes('august 2-4, 2027')) return 'Aug 2-4';
    if (text.includes('august 4-9, 2028')) return 'Aug 4-9';
    
    return '';
}

function parseScrapedDate(text) {
    if (!text) return '';
    
    // Convert text dates to YYYY-MM-DD format
    if (text.includes('august 1-5, 2026')) return '2026-08-01';
    if (text.includes('may 20-21, 2026')) return '2026-05-20';
    if (text.includes('october 15–17, 2026')) return '2026-10-15';
    if (text.includes('january 7-9, 2027')) return '2027-01-07';
    if (text.includes('january 21-23, 2027')) return '2027-01-21';
    if (text.includes('august 2-4, 2027')) return '2027-08-02';
    if (text.includes('august 4-9, 2028')) return '2028-08-04';
    
    return '';
}

// Final data validation - make sure all AAA conferences have correct disc
let discFixCount = 0;
for (const conf of conferences) {
    if ((conf.name.includes('AAA') || conf.url?.includes('aaahq.org')) && 
        conf.disc.includes('fin') && !conf.disc.includes('acct')) {
        conf.disc = ['acct'];
        discFixCount++;
    }
}

console.log(`\n📊 Update Summary:`);
console.log(`   Updated existing conferences: ${updatesCount}`);
console.log(`   Created new conferences: ${newConferencesCount}`);
console.log(`   Fixed discipline for AAA conferences: ${discFixCount}`);

// Write updated conferences.json
fs.writeFileSync('conferences.json', JSON.stringify(conferences, null, 2));
console.log(`\n💾 Updated conferences.json written with ${conferences.length} total conferences`);

// Show final AAA conference count
const finalAAACount = conferences.filter(conf => 
    conf.name.includes('AAA') || 
    conf.name.includes('American Accounting Association') ||
    conf.url?.includes('aaahq.org')
).length;

console.log(`🎯 Final AAA conference count: ${finalAAACount}`);

console.log('\n✅ AAA data update complete!');