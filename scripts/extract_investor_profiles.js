const fs = require('fs');
const path = require('path');
const config = require('../config');

// Target file paths
const OUTPUT_CSV = path.join(__dirname, '../data/angel_investors_profiles.csv');
const OUTPUT_JSON = path.join(__dirname, '../data/angel_investors_profiles.json');
const LEADS_JSON = path.join(__dirname, '../data/leads.json');
const RENDER_SYNC_URL = 'https://vrcindustry.onrender.com/api/leads/sync';

// Ensure data folder exists
if (!fs.existsSync(path.dirname(OUTPUT_CSV))) {
  fs.mkdirSync(path.dirname(OUTPUT_CSV), { recursive: true });
}

/**
 * Loads existing leads to prevent duplicates
 */
function loadExisting() {
  const seenUrls = new Set();
  const seenNames = new Set();
  let list = [];

  if (fs.existsSync(OUTPUT_JSON)) {
    try {
      list = JSON.parse(fs.readFileSync(OUTPUT_JSON, 'utf8'));
      for (const item of list) {
        if (item.linkedinUrl) seenUrls.add(item.linkedinUrl.toLowerCase().trim());
        if (item.name) seenNames.add(item.name.toLowerCase().trim());
      }
    } catch (e) {
      list = [];
    }
  }

  // Initialize CSV with headers if not present
  if (!fs.existsSync(OUTPUT_CSV) || fs.readFileSync(OUTPUT_CSV, 'utf8').trim() === '') {
    const headers = [
      'ID',
      'Name',
      'Headline / Title',
      'Company / Network',
      'City',
      'LinkedIn Profile URL',
      'Public Email',
      'Source',
      'Extracted At'
    ];
    fs.writeFileSync(OUTPUT_CSV, headers.join(',') + '\n', 'utf8');
  }

  return { seenUrls, seenNames, list };
}

/**
 * Appends candidate to CSV, JSON, and local dashboard database
 */
function saveCandidate(candidate, list) {
  list.push(candidate);
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(list, null, 2), 'utf8');

  const row = [
    `"${candidate.id}"`,
    `"${(candidate.name || '').replace(/"/g, '""')}"`,
    `"${(candidate.title || '').replace(/"/g, '""')}"`,
    `"${(candidate.company || '').replace(/"/g, '""')}"`,
    `"${(candidate.city || '').replace(/"/g, '""')}"`,
    `"${(candidate.linkedinUrl || '').replace(/"/g, '""')}"`,
    `"${(candidate.email || 'N/A').replace(/"/g, '""')}"`,
    `"${candidate.source || 'LinkedIn Scraper'}"`,
    `"${candidate.timestamp}"`
  ];
  fs.appendFileSync(OUTPUT_CSV, row.join(',') + '\n', 'utf8');

  // Sync to dashboard database
  try {
    let dashboardLeads = [];
    if (fs.existsSync(LEADS_JSON)) {
      dashboardLeads = JSON.parse(fs.readFileSync(LEADS_JSON, 'utf8'));
    }
    dashboardLeads.push({
      id: candidate.id,
      brand: candidate.company || 'Angel Investment',
      proposal: 'Targeted Investor Outreach',
      name: candidate.name,
      title: candidate.title,
      linkedinUrl: candidate.linkedinUrl,
      email: candidate.email || '',
      emailStatus: candidate.email ? 'verified' : 'linkedin_profile',
      phone: 'Not Available',
      city: candidate.city,
      source: 'LinkedIn Direct',
      timestamp: candidate.timestamp
    });
    fs.writeFileSync(LEADS_JSON, JSON.stringify(dashboardLeads, null, 2), 'utf8');
  } catch (err) {}

  try {
    fetch(RENDER_SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: candidate.id,
        brand: candidate.company || 'Angel Investment',
        proposal: 'Targeted Investor Outreach',
        name: candidate.name,
        title: candidate.title,
        linkedinUrl: candidate.linkedinUrl,
        email: candidate.email || '',
        emailStatus: candidate.email ? 'verified' : 'linkedin_profile',
        phone: 'Not Available',
        city: candidate.city,
        source: 'LinkedIn Direct',
        timestamp: candidate.timestamp
      })
    }).catch(() => {});
  } catch (e) {}
}

/**
 * Scrapes a single Google LinkedIn query via Apify (takes 5-8 seconds)
 */
async function scrapeSingleQuery(query, maxPages = 1, resultsPerPage = 20) {
  if (!config.APIFY_API_TOKEN) {
    throw new Error('APIFY_API_TOKEN is missing');
  }

  const res = await fetch(`https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=${config.APIFY_API_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      queries: query,
      maxPagesPerQuery: maxPages,
      resultsPerPage: resultsPerPage
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Apify scraping error (${res.status}): ${txt}`);
  }

  return await res.json();
}

/**
 * Parses organic search results into structured investor profile objects
 */
function parseCandidates(dataset, fallbackCity = 'Bengaluru') {
  const list = [];
  const seenInRun = new Set();

  for (const page of dataset) {
    for (const org of page.organicResults || []) {
      const url = org.url || '';
      const rawTitle = org.title || '';
      const snippet = org.description || '';

      if (!url.includes('linkedin.com/in/')) continue;
      
      const cleanUrl = url.split('?')[0].replace(/\/$/, '').trim();
      if (seenInRun.has(cleanUrl.toLowerCase())) continue;
      seenInRun.add(cleanUrl.toLowerCase());

      const fullText = `${rawTitle} ${snippet}`.toLowerCase();

      // Ensure profile mentions angel investor
      if (!fullText.includes('angel investor') && !fullText.includes('angel')) {
        continue;
      }

      // Parse clean Name & Headline
      // Format is usually: "Name - Headline - Company | LinkedIn" or "Name | Headline"
      const parts = rawTitle.split(/[-–|:·]/);
      let name = parts[0].trim().replace(/\b(Dr\.|Mr\.|Mrs\.|Ms\.)\s+/gi, '').trim();
      let headline = parts.slice(1).join(' - ').replace(/\s*\|\s*LinkedIn\s*$/i, '').trim() || 'Angel Investor';

      // Detect city
      let city = fallbackCity;
      if (fullText.includes('mumbai') || fullText.includes('bombay')) {
        city = 'Mumbai';
      } else if (fullText.includes('pune')) {
        city = 'Pune';
      } else if (fullText.includes('bengaluru') || fullText.includes('bangalore')) {
        city = 'Bengaluru';
      }

      // Check for public email in snippet
      let publicEmail = null;
      const emailMatch = snippet.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (emailMatch && !emailMatch[1].endsWith('.png') && !emailMatch[1].endsWith('.jpg')) {
        publicEmail = emailMatch[1].toLowerCase();
      }

      // Detect company / angel network
      let company = 'Angel Investor / Private';
      if (/letsventure/i.test(fullText)) company = 'LetsVenture';
      else if (/mumbai angels/i.test(fullText)) company = 'Mumbai Angels';
      else if (/indian angel network/i.test(fullText)) company = 'Indian Angel Network';
      else if (/we founder circle/i.test(fullText)) company = 'We Founder Circle';
      else if (/titan capital/i.test(fullText)) company = 'Titan Capital';
      else if (/inflection point/i.test(fullText)) company = 'Inflection Point Ventures';
      else if (/dexter angels/i.test(fullText)) company = 'Dexter Angels';
      else if (/lead angels/i.test(fullText)) company = 'Lead Angels';
      else if (/ah! ventures/i.test(fullText)) company = 'ah! Ventures';
      else if (/venture catalysts/i.test(fullText)) company = 'Venture Catalysts';
      else {
        const atMatch = headline.match(/\bat\s+([^,–\-·|]+)/i);
        if (atMatch) {
          company = atMatch[1].trim();
        }
      }

      list.push({
        id: 'inv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        name: name,
        title: headline,
        company: company,
        city: city,
        linkedinUrl: cleanUrl,
        email: publicEmail,
        source: 'LinkedIn Search',
        timestamp: new Date().toISOString()
      });
    }
  }

  return list;
}

/**
 * Main routine: pulls across search queries until target count is reached
 */
async function main() {
  const targetCount = parseInt(process.env.TARGET_COUNT, 10) || 500;
  console.log(`\n================================================================`);
  console.log(`🚀 Starting Bulk Investor Extraction: Target = ${targetCount} Profiles`);
  console.log(`🎯 Targeting: "Angel Investor" in LinkedIn Title`);
  console.log(`📍 Cities: Bengaluru, Mumbai, Pune`);
  console.log(`💰 Cost: 100% Free (Zero Apollo Credits Needed)`);
  console.log(`================================================================\n`);

  const { seenUrls, seenNames, list } = loadExisting();
  console.log(`[Cache] Found ${list.length} already extracted profiles.`);

  // Comprehensive query matrix strictly focused on Angel Investors in the 3 target cities
  const queryConfigs = [
    // --- BENGALURU / BANGALORE ---
    { q: 'site:linkedin.com/in/ "Angel Investor" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Bangalore"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "India" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:in.linkedin.com/in/ "Angel Investor" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:in.linkedin.com/in/ "Angel Investor" "Bangalore"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Active Angel Investor" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Founder" "Angel Investor" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Founder" "Angel Investor" "Bangalore"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Co-Founder" "Angel Investor" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "CEO" "Angel Investor" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Serial Entrepreneur" "Angel Investor" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "LetsVenture" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Indian Angel Network" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "We Founder Circle" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Titan Capital" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Inflection Point Ventures" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Dexter Angels" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Fintech" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "SaaS" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "AI" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "D2C" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Deeptech" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "B2B" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Portfolio" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Tech Angel Investor" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Early Stage Angel Investor" "Bengaluru"', city: 'Bengaluru' },

    // --- MUMBAI ---
    { q: 'site:linkedin.com/in/ "Angel Investor" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Bombay"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "India" "Mumbai"', city: 'Mumbai' },
    { q: 'site:in.linkedin.com/in/ "Angel Investor" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Active Angel Investor" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Founder" "Angel Investor" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Co-Founder" "Angel Investor" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "CEO" "Angel Investor" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Managing Director" "Angel Investor" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Serial Entrepreneur" "Angel Investor" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Mumbai Angels"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "LetsVenture" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Indian Angel Network" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "We Founder Circle" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Venture Catalysts" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Lead Angels" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Ah! Ventures" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Fintech" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "D2C" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Consumer" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "SaaS" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Portfolio" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Tech Angel Investor" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Early Stage Angel Investor" "Mumbai"', city: 'Mumbai' },

    // --- PUNE ---
    { q: 'site:linkedin.com/in/ "Angel Investor" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "India" "Pune"', city: 'Pune' },
    { q: 'site:in.linkedin.com/in/ "Angel Investor" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Active Angel Investor" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Founder" "Angel Investor" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Co-Founder" "Angel Investor" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "CEO" "Angel Investor" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Serial Entrepreneur" "Angel Investor" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Mumbai Angels" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "LetsVenture" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Indian Angel Network" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "We Founder Circle" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Venture Catalysts" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "SaaS" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "EV" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Tech" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Portfolio" "Pune"', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Early Stage Angel Investor" "Pune"', city: 'Pune' },

    // --- CROSS-REGIONAL HIGH YIELD QUERIES ---
    { q: 'site:linkedin.com/in/ "Angel Investor" ("Bengaluru" OR "Bangalore")', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" ("Mumbai" OR "Bombay")', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" ("Pune" OR "Maharashtra")', city: 'Pune' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Syndicate Lead" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Syndicate Lead" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Angel Network" "Bengaluru"', city: 'Bengaluru' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Angel Network" "Mumbai"', city: 'Mumbai' },
    { q: 'site:linkedin.com/in/ "Angel Investor" "Angel Network" "Pune"', city: 'Pune' }
  ];

  let count = list.length;

  for (let idx = 0; idx < queryConfigs.length; idx++) {
    if (count >= targetCount) break;

    const { q, city } = queryConfigs[idx];
    console.log(`[Query ${idx + 1}/${queryConfigs.length}] Scraping: ${q}`);

    try {
      const dataset = await scrapeSingleQuery(q, 1, 20);
      const candidates = parseCandidates(dataset, city);
      console.log(` -> Retrieved ${candidates.length} profiles from this query.`);

      let addedInBatch = 0;
      for (const cand of candidates) {
        if (count >= targetCount) break;

        const urlKey = cand.linkedinUrl.toLowerCase().trim();
        const nameKey = cand.name.toLowerCase().trim();

        if (seenUrls.has(urlKey) || seenNames.has(nameKey) || cand.name.length < 2) {
          continue;
        }

        seenUrls.add(urlKey);
        seenNames.add(nameKey);
        saveCandidate(cand, list);
        count++;
        addedInBatch++;

        console.log(`   [#${count}/${targetCount}] ✓ ${cand.name} | ${cand.title.slice(0, 35)} | ${cand.city} | ${cand.linkedinUrl}`);
      }

      console.log(` -> Saved +${addedInBatch} new profiles (Total: ${count}/${targetCount})\n`);

      // Gentle pause to avoid rate limiting
      await new Promise(r => setTimeout(r, 1500));

    } catch (err) {
      console.warn(`[Query ${idx + 1}] Notice:`, err.message);
      // Wait a moment on error
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log(`\n================================================================`);
  console.log(`🎉 Extraction Completed!`);
  console.log(`Total Extracted Profiles: ${count}`);
  console.log(`📁 CSV Spreadsheet Saved to: ${OUTPUT_CSV}`);
  console.log(`📁 JSON Dataset Saved to: ${OUTPUT_JSON}`);
  console.log(`================================================================\n`);
}

module.exports = { scrapeSingleQuery, parseCandidates, loadExisting, saveCandidate };

if (require.main === module) {
  main().catch(console.error);
}
