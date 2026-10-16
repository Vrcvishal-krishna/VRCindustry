const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const config = require('../config');

// Target file paths
const OUTPUT_CSV = path.join(__dirname, '../data/investors_verified.csv');
const OUTPUT_JSON = path.join(__dirname, '../data/investors_verified.json');
const LEADS_JSON = path.join(__dirname, '../data/leads.json');
const RENDER_SYNC_URL = 'https://vrcindustry.onrender.com/api/leads/sync';

// Ensure data folder exists
if (!fs.existsSync(path.dirname(OUTPUT_CSV))) {
  fs.mkdirSync(path.dirname(OUTPUT_CSV), { recursive: true });
}

/**
 * Checks whether domain has active MX records
 */
async function checkDomainMx(domain) {
  if (!domain) return false;
  try {
    const cleanDomain = domain.toLowerCase().replace(/^www\./, '').trim();
    const mx = await dns.resolveMx(cleanDomain);
    return Boolean(mx && mx.length > 0);
  } catch (err) {
    return false;
  }
}

/**
 * Loads existing verified leads to prevent duplicate work
 */
function loadExistingLeads() {
  const seenUrls = new Set();
  const seenEmails = new Set();
  let existingList = [];

  if (fs.existsSync(OUTPUT_JSON)) {
    try {
      existingList = JSON.parse(fs.readFileSync(OUTPUT_JSON, 'utf8'));
      for (const item of existingList) {
        if (item.linkedinUrl) seenUrls.add(item.linkedinUrl.toLowerCase().trim());
        if (item.email) seenEmails.add(item.email.toLowerCase().trim());
      }
    } catch (e) {
      existingList = [];
    }
  }

  // Initialize CSV with header if not exists
  if (!fs.existsSync(OUTPUT_CSV)) {
    const headers = [
      'ID',
      'Name',
      'Title',
      'Company',
      'City',
      'Verified Email',
      'Email Status',
      'Phone',
      'LinkedIn URL',
      'Source',
      'Extracted At'
    ];
    fs.writeFileSync(OUTPUT_CSV, headers.join(',') + '\n', 'utf8');
  }

  return { seenUrls, seenEmails, existingList };
}

/**
 * Appends a verified investor lead to CSV, JSON, and syncs live to Render dashboard
 */
async function saveVerifiedLead(lead, existingList) {
  existingList.push(lead);
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(existingList, null, 2), 'utf8');

  const row = [
    `"${lead.id || ''}"`,
    `"${(lead.name || '').replace(/"/g, '""')}"`,
    `"${(lead.title || '').replace(/"/g, '""')}"`,
    `"${(lead.company || '').replace(/"/g, '""')}"`,
    `"${(lead.city || '').replace(/"/g, '""')}"`,
    `"${(lead.email || '').replace(/"/g, '""')}"`,
    `"${lead.emailStatus || 'verified'}"`,
    `"${(lead.phone || '').replace(/"/g, '""')}"`,
    `"${(lead.linkedinUrl || '').replace(/"/g, '""')}"`,
    `"${lead.source || 'Apollo Verified'}"`,
    `"${lead.timestamp || new Date().toISOString()}"`
  ];
  fs.appendFileSync(OUTPUT_CSV, row.join(',') + '\n', 'utf8');

  // 1. Sync into local dashboard leads file
  try {
    let dashboardLeads = [];
    if (fs.existsSync(LEADS_JSON)) {
      dashboardLeads = JSON.parse(fs.readFileSync(LEADS_JSON, 'utf8'));
    }
    dashboardLeads.unshift({
      id: lead.id,
      brand: lead.company || 'Angel Investment',
      proposal: 'Targeted Investor Outreach',
      name: lead.name,
      title: lead.title,
      linkedinUrl: lead.linkedinUrl,
      email: lead.email,
      emailStatus: 'verified',
      phone: lead.phone,
      city: lead.city,
      source: 'Apollo Verified',
      timestamp: lead.timestamp
    });
    fs.writeFileSync(LEADS_JSON, JSON.stringify(dashboardLeads, null, 2), 'utf8');
  } catch (err) {
    // Non-blocking
  }

  // 2. Sync to live Render dashboard via HTTP POST
  try {
    await fetch(RENDER_SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: lead.id,
        brand: lead.company || 'Angel Investment',
        proposal: 'Targeted Investor Outreach',
        name: lead.name,
        title: lead.title,
        linkedinUrl: lead.linkedinUrl,
        email: lead.email,
        emailStatus: 'verified',
        phone: lead.phone,
        city: lead.city,
        source: 'Apollo Verified',
        timestamp: lead.timestamp
      })
    });
  } catch (syncErr) {
    // Silent fail if network unreachable
  }
}

/**
 * Queries Apify Google Search Results Scraper for a SINGLE query
 * Fast execution (5-8s) - Never exceeds Apify 300s timeout!
 */
async function scrapeSingleQuery(query, maxPages = 2, resultsPerPage = 20) {
  if (!config.APIFY_API_TOKEN) {
    throw new Error('APIFY_API_TOKEN is not configured');
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
    const errText = await res.text();
    throw new Error(`Apify scraping error (${res.status}): ${errText}`);
  }

  return await res.json();
}

/**
 * Matches a LinkedIn profile against Apollo to discover strictly verified emails
 */
async function matchProfileWithApollo(candidate) {
  if (!config.APOLLO_API_KEY) {
    return null;
  }

  try {
    const matchPayload = {
      linkedin_url: candidate.linkedinUrl,
      name: candidate.name
    };

    const res = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': config.APOLLO_API_KEY
      },
      body: JSON.stringify(matchPayload)
    });

    if (!res.ok) return null;

    const data = await res.json();
    const p = data.person;
    if (!p) return null;

    const emailStatus = (p.email_status || '').toLowerCase();
    
    // STRICT REQUIREMENT: Only strictly verified emails!
    if (emailStatus !== 'verified' || !p.email) {
      return null;
    }

    // Secondary MX verification
    const domain = p.email.split('@')[1];
    const hasMx = await checkDomainMx(domain);
    if (!hasMx) {
      return null;
    }

    const phone = p.sanitized_phone || (p.phone_numbers && p.phone_numbers[0]?.sanitized_number) || 'Not Available';
    const city = p.city || candidate.city || 'Bengaluru / Mumbai / Pune';
    const company = p.organization?.name || candidate.company || 'Angel Investment';
    const title = p.title || candidate.title || 'Angel Investor';

    return {
      id: 'inv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      name: p.name || candidate.name,
      title: title,
      company: company,
      city: city,
      email: p.email.toLowerCase().trim(),
      emailStatus: 'verified',
      phone: phone,
      linkedinUrl: p.linkedin_url || candidate.linkedinUrl,
      source: 'Apollo Verified',
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    return null;
  }
}

/**
 * Parses raw Google organic search results into candidate objects
 */
function parseCandidatesFromDataset(datasetItems) {
  const candidates = [];
  const seenInBatch = new Set();

  for (const page of datasetItems) {
    for (const org of page.organicResults || []) {
      const url = org.url || '';
      const title = org.title || '';
      const snippet = org.description || '';

      if (!url.includes('linkedin.com/in/')) continue;
      
      const cleanUrl = url.split('?')[0].toLowerCase().trim();
      if (seenInBatch.has(cleanUrl)) continue;
      seenInBatch.add(cleanUrl);

      // Parse name: extract clean name before dash, pipe, or colon
      let namePart = title.split(/[-–|:·]/)[0].trim();
      namePart = namePart.replace(/\b(Dr\.|Mr\.|Mrs\.|Ms\.)\s+/gi, '').trim();

      // Clean city
      let city = 'Bengaluru';
      const text = `${title} ${snippet}`.toLowerCase();
      if (text.includes('mumbai') || text.includes('bombay')) {
        city = 'Mumbai';
      } else if (text.includes('pune')) {
        city = 'Pune';
      } else if (text.includes('bengaluru') || text.includes('bangalore')) {
        city = 'Bengaluru';
      }

      candidates.push({
        name: namePart,
        title: 'Angel Investor',
        linkedinUrl: cleanUrl,
        city: city,
        snippet: snippet
      });
    }
  }

  return candidates;
}

/**
 * Main Bulk Extraction Routine
 */
async function main() {
  const targetCount = parseInt(process.env.TARGET_COUNT, 10) || 500;
  console.log(`\n======================================================`);
  console.log(`🚀 Starting Bulk Investor Extraction: Target = ${targetCount} Verified Emails`);
  console.log(`🎯 Targeting: Angel Investors, Founder-Angels, Family Offices`);
  console.log(`📍 Cities: Bengaluru, Mumbai, Pune`);
  console.log(`🛡️ Strict Zero Catch-All & 100% MX Verified Guarantee`);
  console.log(`======================================================\n`);

  const { seenUrls, seenEmails, existingList } = loadExistingLeads();
  console.log(`[Cache] Found ${existingList.length} already verified leads on disk.`);

  // Comprehensive queries across Bengaluru, Mumbai, Pune
  const allQueries = [
    // 1. Pure-Play Angel Investors
    'site:linkedin.com/in/ "Angel Investor" "Bengaluru"',
    'site:linkedin.com/in/ "Angel Investor" "Bangalore"',
    'site:linkedin.com/in/ "Angel Investor" "Mumbai"',
    'site:linkedin.com/in/ "Angel Investor" "Pune"',

    // 2. Founder & Angel Investors
    'site:linkedin.com/in/ "Founder" "Angel Investor" "Bengaluru"',
    'site:linkedin.com/in/ "Founder" "Angel Investor" "Mumbai"',
    'site:linkedin.com/in/ "Founder" "Angel Investor" "Pune"',
    'site:linkedin.com/in/ "Co-Founder" "Angel Investor" "Bengaluru"',
    'site:linkedin.com/in/ "Co-Founder" "Angel Investor" "Mumbai"',
    'site:linkedin.com/in/ "Co-Founder" "Angel Investor" "Pune"',

    // 3. Family Offices & Principals
    'site:linkedin.com/in/ "Family Office" "Bengaluru"',
    'site:linkedin.com/in/ "Family Office" "Mumbai"',
    'site:linkedin.com/in/ "Family Office" "Pune"',
    'site:linkedin.com/in/ "Single Family Office" "Mumbai"',
    'site:linkedin.com/in/ "Single Family Office" "Bengaluru"',
    'site:linkedin.com/in/ "Multi Family Office" "Mumbai"',
    'site:linkedin.com/in/ "Multi Family Office" "Bengaluru"',

    // 4. Angel Networks & Micro-VC Syndicates
    'site:linkedin.com/in/ "LetsVenture" ("Bengaluru" OR "Mumbai")',
    'site:linkedin.com/in/ "Mumbai Angels" ("Mumbai" OR "Pune")',
    'site:linkedin.com/in/ "Indian Angel Network" ("Bengaluru" OR "Mumbai")',
    'site:linkedin.com/in/ "We Founder Circle" ("Bengaluru" OR "Mumbai")',
    'site:linkedin.com/in/ "Titan Capital" ("Bengaluru" OR "Mumbai")',
    'site:linkedin.com/in/ "Inflection Point Ventures" ("Bengaluru" OR "Mumbai")',
    'site:linkedin.com/in/ "Dexter Angels" ("Bengaluru" OR "Mumbai" OR "Pune")',
    'site:linkedin.com/in/ "Venture Catalysts" ("Mumbai" OR "Pune" OR "Bengaluru")',

    // 5. Early Stage & Seed Investors
    'site:linkedin.com/in/ "Early Stage Investor" "Bengaluru"',
    'site:linkedin.com/in/ "Early Stage Investor" "Mumbai"',
    'site:linkedin.com/in/ "Early Stage Investor" "Pune"',
    'site:linkedin.com/in/ "Seed Investor" "Bengaluru"',
    'site:linkedin.com/in/ "Seed Investor" "Mumbai"',
    'site:linkedin.com/in/ "Seed Investor" "Pune"',
    'site:linkedin.com/in/ "Venture Partner" "Bengaluru"',
    'site:linkedin.com/in/ "Venture Partner" "Mumbai"',
    'site:linkedin.com/in/ "Venture Partner" "Pune"',

    // 6. Venture Partners & General Partners
    'site:linkedin.com/in/ "General Partner" "Ventures" "Bengaluru"',
    'site:linkedin.com/in/ "General Partner" "Ventures" "Mumbai"',
    'site:linkedin.com/in/ "Managing Partner" "Ventures" "Bengaluru"',
    'site:linkedin.com/in/ "Managing Partner" "Ventures" "Mumbai"',
    'site:linkedin.com/in/ "Managing Partner" "Ventures" "Pune"',

    // 7. Investment Directors & Principals
    'site:linkedin.com/in/ "Investment Director" "Ventures" "Bengaluru"',
    'site:linkedin.com/in/ "Investment Director" "Ventures" "Mumbai"',
    'site:linkedin.com/in/ "Investment Director" "Ventures" "Pune"',
    'site:linkedin.com/in/ "Principal" "Ventures" "Bengaluru"',
    'site:linkedin.com/in/ "Principal" "Ventures" "Mumbai"',
    'site:linkedin.com/in/ "Vice President" "Ventures" "Bengaluru"',
    'site:linkedin.com/in/ "Vice President" "Ventures" "Mumbai"',

    // 8. Syndicate Leads & Angel Backers
    'site:linkedin.com/in/ "Syndicate Lead" "Angel" "Bengaluru"',
    'site:linkedin.com/in/ "Syndicate Lead" "Angel" "Mumbai"',
    'site:linkedin.com/in/ "Angel Syndicate" "Bengaluru"',
    'site:linkedin.com/in/ "Angel Syndicate" "Mumbai"',
    'site:linkedin.com/in/ "Angel Syndicate" "Pune"',
    'site:linkedin.com/in/ "Angel Investor" "Portfolio" "Bengaluru"',
    'site:linkedin.com/in/ "Angel Investor" "Portfolio" "Mumbai"',
    'site:linkedin.com/in/ "Angel Investor" "Portfolio" "Pune"',

    // 9. Tech Founders actively Angel Investing
    'site:linkedin.com/in/ "Tech Founder" "Angel Investor" "Bengaluru"',
    'site:linkedin.com/in/ "Tech Founder" "Angel Investor" "Mumbai"',
    'site:linkedin.com/in/ "Serial Entrepreneur" "Angel Investor" "Bengaluru"',
    'site:linkedin.com/in/ "Serial Entrepreneur" "Angel Investor" "Mumbai"',
    'site:linkedin.com/in/ "Serial Entrepreneur" "Angel Investor" "Pune"',
    'site:linkedin.com/in/ "Ex-Founder" "Angel Investor" "Bengaluru"',
    'site:linkedin.com/in/ "Ex-Founder" "Angel Investor" "Mumbai"',

    // 10. Private Equity & Family Office Heads
    'site:linkedin.com/in/ "Chief Investment Officer" "Family Office" "Mumbai"',
    'site:linkedin.com/in/ "Chief Investment Officer" "Family Office" "Bengaluru"',
    'site:linkedin.com/in/ "Head of Investments" "Family Office" "Mumbai"',
    'site:linkedin.com/in/ "Head of Investments" "Family Office" "Bengaluru"',
    'site:linkedin.com/in/ "Director of Investments" "Family Office" "Mumbai"',
    'site:linkedin.com/in/ "Managing Director" "Family Office" "Mumbai"',
    'site:linkedin.com/in/ "Managing Director" "Family Office" "Bengaluru"'
  ];

  let verifiedCount = existingList.length;

  for (let qIdx = 0; qIdx < allQueries.length; qIdx++) {
    if (verifiedCount >= targetCount) break;

    const query = allQueries[qIdx];
    console.log(`\n[Query ${qIdx + 1}/${allQueries.length}] Running: ${query}`);

    try {
      const dataset = await scrapeSingleQuery(query, 2, 20);
      const candidates = parseCandidatesFromDataset(dataset);
      console.log(` -> Found ${candidates.length} profiles from this query.`);

      for (let i = 0; i < candidates.length; i++) {
        if (verifiedCount >= targetCount) break;

        const cand = candidates[i];
        if (seenUrls.has(cand.linkedinUrl)) {
          continue;
        }
        seenUrls.add(cand.linkedinUrl);

        process.stdout.write(`   [${verifiedCount + 1}/${targetCount}] Matching: ${cand.name} (${cand.city})... `);
        
        const matched = await matchProfileWithApollo(cand);
        if (matched && matched.email && !seenEmails.has(matched.email)) {
          seenEmails.add(matched.email);
          await saveVerifiedLead(matched, existingList);
          verifiedCount++;
          console.log(`✓ VERIFIED: ${matched.email} [${matched.company}]`);
        } else {
          console.log(`✗ No verified email`);
        }

        // Polite 200ms throttle to Apollo API
        await new Promise(r => setTimeout(r, 200));
      }

    } catch (err) {
      console.warn(`[Query ${qIdx + 1}] Notice:`, err.message);
    }
  }

  console.log(`\n======================================================`);
  console.log(`🎉 Extraction Complete!`);
  console.log(`Total Verified Leads: ${verifiedCount}`);
  console.log(`📁 CSV Saved to: ${OUTPUT_CSV}`);
  console.log(`📁 JSON Saved to: ${OUTPUT_JSON}`);
  console.log(`======================================================\n`);
}

main().catch(console.error);
