const fs = require('fs');
const path = require('path');
const config = require('../config');

// File paths
const VERIFIED_CSV = path.join(__dirname, '../data/investors_verified.csv');
const VERIFIED_JSON = path.join(__dirname, '../data/investors_verified.json');
const PROFILES_CSV = path.join(__dirname, '../data/angel_investors_profiles.csv');
const PROFILES_JSON = path.join(__dirname, '../data/angel_investors_profiles.json');
const LEADS_JSON = path.join(__dirname, '../data/leads.json');
const RENDER_SYNC_URL = 'https://vrcindustry.onrender.com/api/leads/sync';

function getSlug(url) {
  if (!url) return '';
  const match = url.match(/\/in\/([^/?#]+)/i);
  return match ? match[1].toLowerCase().trim() : url.toLowerCase().trim();
}

function loadState() {
  const verifiedSlugs = new Set();
  const seenEmails = new Set();
  const queuedSlugs = new Set();
  let verifiedList = [];

  if (fs.existsSync(VERIFIED_JSON)) {
    try {
      verifiedList = JSON.parse(fs.readFileSync(VERIFIED_JSON, 'utf8'));
      for (const item of verifiedList) {
        if (item.linkedinUrl) {
          verifiedSlugs.add(getSlug(item.linkedinUrl));
          queuedSlugs.add(getSlug(item.linkedinUrl));
        }
        if (item.email) seenEmails.add(item.email.toLowerCase().trim());
      }
    } catch (e) {
      verifiedList = [];
    }
  }

  // Ensure CSV headers exist
  if (!fs.existsSync(VERIFIED_CSV) || fs.readFileSync(VERIFIED_CSV, 'utf8').trim() === '') {
    const headers = [
      'ID',
      'Name',
      'Job Title',
      'Brand / Company',
      'Verified Email',
      'Phone',
      'City',
      'LinkedIn Profile',
      'Email Status',
      'Source',
      'Timestamp'
    ];
    fs.writeFileSync(VERIFIED_CSV, headers.join(',') + '\n', 'utf8');
  }

  return { verifiedSlugs, queuedSlugs, seenEmails, verifiedList };
}

function saveVerified(lead, verifiedList) {
  verifiedList.push(lead);
  fs.writeFileSync(VERIFIED_JSON, JSON.stringify(verifiedList, null, 2), 'utf8');

  const row = [
    `"${lead.id}"`,
    `"${(lead.name || '').replace(/"/g, '""')}"`,
    `"${(lead.title || '').replace(/"/g, '""')}"`,
    `"${(lead.brand || '').replace(/"/g, '""')}"`,
    `"${(lead.email || '').replace(/"/g, '""')}"`,
    `"${(lead.phone || 'Not Available').replace(/"/g, '""')}"`,
    `"${(lead.city || '').replace(/"/g, '""')}"`,
    `"${(lead.linkedinUrl || '').replace(/"/g, '""')}"`,
    `"verified"`,
    `"Apify Verified"`,
    `"${lead.timestamp}"`
  ];
  fs.appendFileSync(VERIFIED_CSV, row.join(',') + '\n', 'utf8');

  // Sync to local dashboard leads.json
  try {
    let dashboardLeads = [];
    if (fs.existsSync(LEADS_JSON)) {
      dashboardLeads = JSON.parse(fs.readFileSync(LEADS_JSON, 'utf8'));
    }
    // Remove if existed without email
    dashboardLeads = dashboardLeads.filter(l => getSlug(l.linkedinUrl) !== getSlug(lead.linkedinUrl));
    dashboardLeads.unshift(lead);
    fs.writeFileSync(LEADS_JSON, JSON.stringify(dashboardLeads, null, 2), 'utf8');
  } catch (err) {}

  // Sync to Render live web dashboard
  try {
    fetch(RENDER_SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead)
    }).catch(() => {});
  } catch (e) {}
}

async function scrapeGoogle(query, maxPages = 1) {
  if (!config.APIFY_API_TOKEN) throw new Error('Missing APIFY_API_TOKEN');

  const res = await fetch(`https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=${config.APIFY_API_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      queries: query,
      maxPagesPerQuery: maxPages,
      resultsPerPage: 20
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google scrape error ${res.status}: ${errText}`);
  }

  return await res.json();
}

async function lookupEmails(urls) {
  if (!config.APIFY_API_TOKEN) throw new Error('Missing APIFY_API_TOKEN');

  const res = await fetch(`https://api.apify.com/v2/acts/snipercoder~bulk-linkedin-email-finder/run-sync-get-dataset-items?token=${config.APIFY_API_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      linkedin_url_or_ids: urls
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Email lookup error ${res.status}: ${errText}`);
  }

  return await res.json();
}

function extractUrlsFromGoogle(dataset, fallbackCity = 'Bengaluru') {
  const candidates = [];
  const seenInRun = new Set();

  for (const page of dataset) {
    for (const org of page.organicResults || []) {
      const url = org.url || '';
      const rawTitle = org.title || '';
      const snippet = org.description || '';

      if (!url.includes('linkedin.com/in/')) continue;
      const cleanUrl = url.split('?')[0].replace(/\/$/, '').trim();
      const slug = getSlug(cleanUrl);

      if (!slug || seenInRun.has(slug)) continue;
      seenInRun.add(slug);

      const fullText = `${rawTitle} ${snippet}`.toLowerCase();
      if (!fullText.includes('angel investor') && !fullText.includes('angel')) continue;

      let city = fallbackCity;
      if (fullText.includes('mumbai') || fullText.includes('bombay')) city = 'Mumbai';
      else if (fullText.includes('pune')) city = 'Pune';
      else if (fullText.includes('bengaluru') || fullText.includes('bangalore')) city = 'Bengaluru';

      candidates.push({
        url: cleanUrl,
        slug: slug,
        city: city
      });
    }
  }

  return candidates;
}

// Generate extensive search queries targeting Bengaluru, Mumbai, Pune
function generateQueries() {
  const cities = ['Bengaluru', 'Bangalore', 'Mumbai', 'Pune'];
  
  const verticals = [
    'Fintech', 'SaaS', 'AI', 'Healthtech', 'D2C', 'EV', 'Deeptech', 'Logistics',
    'Consumer', 'B2B', 'Edtech', 'Agritech', 'Enterprise', 'CleanTech', 'Web3',
    'Gaming', 'Proptech', 'Insurtech', 'Mobility', 'E-commerce', 'Crypto', 'Supply Chain'
  ];

  const roles = [
    'Founder', 'Co-Founder', 'CEO', 'CTO', 'Managing Director', 'Partner',
    'Serial Entrepreneur', 'Ex-Founder', 'Active Angel Investor', 'Early Stage',
    'Seed Investor', 'Syndicate Lead', 'Angel Network', 'Board Member', 'Advisor'
  ];

  const networks = [
    'LetsVenture', 'Mumbai Angels', 'Indian Angel Network', 'We Founder Circle',
    'Inflection Point Ventures', 'Lead Angels', 'Ah! Ventures', 'Venture Catalysts',
    'Titan Capital', 'Dexter Angels', 'Faad', 'JITO', 'TiE Angels', 'TiE', 'Keiretsu'
  ];

  const schools = ['IIT', 'IIM', 'BITS', 'Stanford', 'Harvard', 'ISB'];

  const queries = [];

  // 1. Direct role + city queries
  for (const c of cities) {
    for (const r of roles) {
      queries.push({ q: `site:linkedin.com/in/ "${r}" "Angel Investor" "${c}"`, city: c });
    }
  }

  // 2. Network + city queries
  for (const c of cities) {
    for (const n of networks) {
      queries.push({ q: `site:linkedin.com/in/ "Angel Investor" "${n}" "${c}"`, city: c });
    }
  }

  // 3. Vertical + city queries
  for (const c of cities) {
    for (const v of verticals) {
      queries.push({ q: `site:linkedin.com/in/ "Angel Investor" "${v}" "${c}"`, city: c });
    }
  }

  // 4. Alumni + angel queries
  for (const c of cities) {
    for (const s of schools) {
      queries.push({ q: `site:linkedin.com/in/ "Angel Investor" "${s}" "${c}"`, city: c });
    }
  }

  // 5. inurl:in.linkedin.com queries
  for (const c of cities) {
    queries.push({ q: `site:in.linkedin.com/in/ "Angel Investor" "${c}"`, city: c });
    queries.push({ q: `site:in.linkedin.com/in/ "Active Angel Investor" "${c}"`, city: c });
    queries.push({ q: `site:in.linkedin.com/in/ "Angel Investor" "Portfolio" "${c}"`, city: c });
    queries.push({ q: `site:in.linkedin.com/in/ "Angel Investor" "Startups" "${c}"`, city: c });
  }

  return queries;
}

async function main() {
  const targetVerified = parseInt(process.env.TARGET_EMAILS, 10) || 500;

  console.log(`\n================================================================`);
  console.log(`🎯 AUTONOMOUS TARGET PIPELINE: Reach ${targetVerified} Verified Investor Emails`);
  console.log(`📍 Cities: Bengaluru, Mumbai, Pune`);
  console.log(`⚡ Strategy: Harvest LinkedIn URLs -> Instant Apify Corporate Email Resolution`);
  console.log(`================================================================\n`);

  const { verifiedSlugs, queuedSlugs, seenEmails, verifiedList } = loadState();
  let verifiedCount = verifiedList.length;

  console.log(`[Baseline] Currently verified in database: ${verifiedCount}/${targetVerified} (${((verifiedCount / targetVerified) * 100).toFixed(1)}%)\n`);

  if (verifiedCount >= targetVerified) {
    console.log(`Target already reached (${verifiedCount} >= ${targetVerified})!`);
    return;
  }

  const queries = generateQueries();
  console.log(`[Planner] Generated ${queries.length} high-yield search clusters.\n`);

  let pendingEnrichmentQueue = [];
  const BATCH_ENRICH_SIZE = 20;

  async function flushEnrichmentQueue() {
    if (pendingEnrichmentQueue.length === 0) return;
    const batch = [...pendingEnrichmentQueue];
    pendingEnrichmentQueue = [];

    const urls = batch.map(b => b.url);
    const cityBySlug = new Map(batch.map(b => [b.slug, b.city]));

    console.log(`\n  ⚡ [Email Engine] Resolving direct business emails for ${urls.length} profiles...`);

    try {
      const results = await lookupEmails(urls);
      let batchFound = 0;

      for (const res of results) {
        const email = res['04_Email'];
        const linkedinUrl = res['06_Linkedin_url'] || res['17_Query_linkedin'];
        const name = res['01_Name'];

        if (!email || !email.includes('@') || email.includes('undefined')) continue;

        const emailKey = email.toLowerCase().trim();
        const fullUrl = linkedinUrl ? (linkedinUrl.startsWith('http') ? linkedinUrl : 'https://linkedin.com/in/' + linkedinUrl) : '';
        const slug = getSlug(fullUrl);

        if (seenEmails.has(emailKey) || (slug && verifiedSlugs.has(slug))) continue;
        seenEmails.add(emailKey);
        if (slug) verifiedSlugs.add(slug);

        const leadCity = cityBySlug.get(slug) || res['14_City'] || 'Bengaluru';

        const verifiedLead = {
          id: 'inv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          brand: res['16_Company_name'] || 'Angel Investment',
          proposal: 'Targeted Investor Outreach',
          name: name,
          title: res['11_Headline'] || res['07_Title'] || 'Angel Investor',
          linkedinUrl: fullUrl,
          email: email,
          emailStatus: 'verified',
          phone: res['05_Phone_number'] || 'Not Available',
          city: leadCity,
          source: 'Apify Verified',
          timestamp: new Date().toISOString()
        };

        saveVerified(verifiedLead, verifiedList);
        verifiedCount++;
        batchFound++;

        console.log(`    ✅ [#${verifiedCount}/${targetVerified}] ${verifiedLead.name} | ${verifiedLead.email} | ${verifiedLead.phone} | ${verifiedLead.city} | ${verifiedLead.brand}`);

        if (verifiedCount >= targetVerified) break;
      }

      console.log(`  -> Batch yield: +${batchFound} verified emails (Total Progress: ${verifiedCount}/${targetVerified} = ${((verifiedCount / targetVerified) * 100).toFixed(1)}%)\n`);

    } catch (err) {
      console.warn(`  ⚠️ Email lookup batch notice:`, err.message);
    }
  }

  for (let idx = 0; idx < queries.length; idx++) {
    if (verifiedCount >= targetVerified) break;

    const { q, city } = queries[idx];
    console.log(`[Search ${idx + 1}/${queries.length}] ${q}`);

    try {
      const dataset = await scrapeGoogle(q, 1);
      const candidates = extractUrlsFromGoogle(dataset, city);

      let newCandidates = 0;
      for (const cand of candidates) {
        if (queuedSlugs.has(cand.slug) || verifiedSlugs.has(cand.slug)) continue;
        queuedSlugs.add(cand.slug);
        pendingEnrichmentQueue.push(cand);
        newCandidates++;
      }

      console.log(` -> Found ${candidates.length} profiles (${newCandidates} fresh) | Queue: ${pendingEnrichmentQueue.length}/${BATCH_ENRICH_SIZE}`);

      // When queue reaches batch size, resolve emails immediately
      if (pendingEnrichmentQueue.length >= BATCH_ENRICH_SIZE) {
        await flushEnrichmentQueue();
      }

      // Small delay between searches
      await new Promise(r => setTimeout(r, 1200));

    } catch (err) {
      console.warn(`[Search ${idx + 1} Error]:`, err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Flush remaining in queue
  if (pendingEnrichmentQueue.length > 0 && verifiedCount < targetVerified) {
    await flushEnrichmentQueue();
  }

  console.log(`\n================================================================`);
  console.log(`🎉 Pipeline Execution Finished!`);
  console.log(`Final Verified Contacts With Real Emails: ${verifiedCount}`);
  console.log(`📁 CSV: ${VERIFIED_CSV}`);
  console.log(`🌐 Live Dashboard: ${RENDER_SYNC_URL}`);
  console.log(`================================================================\n`);
}

main().catch(console.error);
