const { chromium } = require('playwright');
const fs = require('fs');

async function scrapeAAAMeetings() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    console.log('🚀 Starting AAA meetings scraper...');
    
    const allMeetings = [];
    
    // URLs to scrape
    const urls = [
        'https://aaahq.org/Meetings/AAA-Meetings',
        'https://aaahq.org/Meetings/Section-Meetings'
    ];
    
    for (const url of urls) {
        console.log(`\n📄 Scraping ${url}...`);
        
        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
            
            // Wait for content to be loaded by JavaScript
            await page.waitForTimeout(3000);
            
            // Extract meeting links
            const meetingLinks = await page.evaluate(() => {
                const links = [];
                // Look for links that contain meeting URLs
                const anchorTags = document.querySelectorAll('a[href*="/Meetings/"]');
                
                anchorTags.forEach(link => {
                    const href = link.href;
                    const text = link.textContent?.trim();
                    
                    // Filter for AAA-related meetings and exclude main pages
                    if (href && text && 
                        (href.includes('/Meetings/20') || href.includes('/Meetings/AAA')) &&
                        !href.endsWith('/AAA-Meetings') &&
                        !href.endsWith('/Section-Meetings') &&
                        (text.includes('AAA') || text.includes('American Accounting') || 
                         href.includes('AAA') || href.includes('ATA') || href.includes('FARS') || 
                         href.includes('MAS') || href.includes('AIS') || href.includes('ABO'))) {
                        
                        links.push({
                            url: href,
                            title: text,
                            source: document.location.href
                        });
                    }
                });
                
                return links;
            });
            
            console.log(`Found ${meetingLinks.length} potential meeting links from ${url}`);
            
            // Add to our collection, avoiding duplicates
            meetingLinks.forEach(link => {
                if (!allMeetings.find(m => m.url === link.url)) {
                    allMeetings.push(link);
                }
            });
            
        } catch (error) {
            console.error(`❌ Error scraping ${url}:`, error.message);
        }
    }
    
    console.log(`\n📋 Found ${allMeetings.length} unique meeting links total`);
    
    // Now scrape individual meeting pages
    const detailedMeetings = [];
    
    for (let i = 0; i < allMeetings.length; i++) {
        const meeting = allMeetings[i];
        console.log(`\n🔍 Scraping meeting ${i+1}/${allMeetings.length}: ${meeting.title}`);
        console.log(`    URL: ${meeting.url}`);
        
        try {
            await page.goto(meeting.url, { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(2000);
            
            const details = await page.evaluate(() => {
                const data = {
                    fullName: '',
                    dates: '',
                    location: '',
                    country: '',
                    deadline: '',
                    registrationDeadline: '',
                    cfpLinks: []
                };
                
                // Extract title - try multiple selectors
                const titleSelectors = ['h1', '.page-title', '.meeting-title', '.conference-title'];
                for (const selector of titleSelectors) {
                    const titleEl = document.querySelector(selector);
                    if (titleEl && titleEl.textContent.trim()) {
                        data.fullName = titleEl.textContent.trim();
                        break;
                    }
                }
                
                // If no title found, use page title
                if (!data.fullName && document.title) {
                    data.fullName = document.title.replace(' | AAA', '').trim();
                }
                
                // Look for dates in various formats
                const textContent = document.body.textContent.toLowerCase();
                const datePatterns = [
                    /(\w+\s+\d{1,2}[-–]\d{1,2},?\s+\d{4})/gi,
                    /(\w+\s+\d{1,2}[-–]\d{1,2})/gi,
                    /(\d{1,2}\/\d{1,2}\/\d{4}\s*[-–]\s*\d{1,2}\/\d{1,2}\/\d{4})/gi
                ];
                
                for (const pattern of datePatterns) {
                    const matches = textContent.match(pattern);
                    if (matches) {
                        data.dates = matches[0];
                        break;
                    }
                }
                
                // Look for location info
                const locationKeywords = ['location:', 'venue:', 'where:', 'city:', 'hosted'];
                for (const keyword of locationKeywords) {
                    const regex = new RegExp(keyword + '\\s*([^\\n]+)', 'i');
                    const match = textContent.match(regex);
                    if (match) {
                        data.location = match[1].trim();
                        break;
                    }
                }
                
                // Look for deadlines
                const deadlineKeywords = ['deadline:', 'due:', 'submit by:', 'submission deadline:'];
                for (const keyword of deadlineKeywords) {
                    const regex = new RegExp(keyword + '\\s*([^\\n]+)', 'i');
                    const match = textContent.match(regex);
                    if (match) {
                        data.deadline = match[1].trim();
                        break;
                    }
                }
                
                // Look for registration deadline
                const regDeadlineKeywords = ['registration deadline:', 'register by:'];
                for (const keyword of regDeadlineKeywords) {
                    const regex = new RegExp(keyword + '\\s*([^\\n]+)', 'i');
                    const match = textContent.match(regex);
                    if (match) {
                        data.registrationDeadline = match[1].trim();
                        break;
                    }
                }
                
                // Look for CFP links
                const cfpLinks = document.querySelectorAll('a[href*="cfp"], a[href*="call"], a[href*="papers"]');
                cfpLinks.forEach(link => {
                    if (link.href && !data.cfpLinks.includes(link.href)) {
                        data.cfpLinks.push(link.href);
                    }
                });
                
                return data;
            });
            
            const meetingData = {
                ...meeting,
                ...details,
                scrapedAt: new Date().toISOString()
            };
            
            detailedMeetings.push(meetingData);
            
            console.log(`    ✅ Name: ${details.fullName}`);
            console.log(`    📅 Dates: ${details.dates}`);
            console.log(`    📍 Location: ${details.location}`);
            console.log(`    ⏰ Deadline: ${details.deadline}`);
            
        } catch (error) {
            console.error(`    ❌ Error scraping ${meeting.url}:`, error.message);
            // Still add the basic info even if detailed scraping failed
            detailedMeetings.push({
                ...meeting,
                fullName: meeting.title,
                scrapedAt: new Date().toISOString(),
                error: error.message
            });
        }
    }
    
    await browser.close();
    
    console.log(`\n✅ Scraping complete! Found ${detailedMeetings.length} meetings`);
    
    // Save raw scraped data for inspection
    fs.writeFileSync('aaa_scraped_raw.json', JSON.stringify(detailedMeetings, null, 2));
    console.log('💾 Raw scraped data saved to aaa_scraped_raw.json');
    
    return detailedMeetings;
}

// Helper function to parse dates into YYYY-MM-DD format
function parseDate(dateStr) {
    if (!dateStr) return '';
    
    // Try to extract year, month, day from various formats
    const currentYear = new Date().getFullYear();
    const nextYear = currentYear + 1;
    
    // Look for year in the string
    const yearMatch = dateStr.match(/\b(20\d{2})\b/);
    const year = yearMatch ? parseInt(yearMatch[1]) : nextYear; // default to next year
    
    // Common date patterns
    const monthNames = {
        'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04', 'may': '05', 'jun': '06',
        'jul': '07', 'aug': '08', 'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12',
        'january': '01', 'february': '02', 'march': '03', 'april': '04', 'may': '05', 'june': '06',
        'july': '07', 'august': '08', 'september': '09', 'october': '10', 'november': '11', 'december': '12'
    };
    
    for (const [monthName, monthNum] of Object.entries(monthNames)) {
        if (dateStr.toLowerCase().includes(monthName)) {
            const dayMatch = dateStr.match(/\b(\d{1,2})(?:[-–]|\s|$)/);
            if (dayMatch) {
                const day = dayMatch[1].padStart(2, '0');
                return `${year}-${monthNum}-${day}`;
            }
        }
    }
    
    return '';
}

// Helper function to clean and standardize location
function cleanLocation(location) {
    if (!location) return '';
    
    // Remove extra whitespace and clean up
    let cleaned = location.trim();
    
    // If it's just "USA" or generic, return as-is for now
    if (cleaned.toLowerCase() === 'usa' || cleaned.toLowerCase() === 'united states') {
        return 'USA';
    }
    
    return cleaned;
}

// Helper function to determine country from location
function getCountryFromLocation(location) {
    if (!location) return '';
    
    const loc = location.toLowerCase();
    
    if (loc.includes('canada') || loc.includes(', ca') || loc.includes('alberta') || 
        loc.includes('ontario') || loc.includes('quebec') || loc.includes('banff')) {
        return 'Canada';
    }
    
    if (loc.includes('usa') || loc.includes('united states') || 
        loc.includes(', usa') || loc.includes(', us') ||
        loc.includes('atlanta') || loc.includes('nashville') || loc.includes('chicago') ||
        loc.includes(' ga') || loc.includes(' tn') || loc.includes(' il') || 
        loc.includes(' ny') || loc.includes(' ca') || loc.includes(' tx') ||
        loc.includes(', georgia') || loc.includes(', tennessee') || loc.includes(', illinois')) {
        return 'USA';
    }
    
    return 'USA'; // Default assumption for AAA meetings
}

if (require.main === module) {
    scrapeAAAMeetings().catch(console.error);
}

module.exports = { scrapeAAAMeetings, parseDate, cleanLocation, getCountryFromLocation };