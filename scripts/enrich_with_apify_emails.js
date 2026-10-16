const fs = require('fs');
const path = require('path');
const config = require('../config');

const PROFILES_JSON = path.join(__dirname, '../data/angel_investors_profiles.json');
const VERIFIED_CSV = path.join(__dirname, '../data/investors_verified.csv');
const VERIFIED_JSON = path.join(__dirname, '../data/investors_verified.json');
const LEADS_JSON = path.join(__dirname, '../data/leads.json');
const RENDER_SYNC_URL = 'https://vrcindustry.onrender.com/api/leads/sync';

// Ensure data folder exists
if (!fs.existsSync(path.dirname(VERIFIED_CSV))) {
  fs.mkdirSync(path.dirname(VERIFIED_CSV), { recursive: true });
}

function getSlug(url) {
  if (!url) return '';
  const match = url.match(/\/in\/([^/?#]+)/i);
  return match ? match[1].toLowerCase().trim() : url.toLowerCase().trim();
}

function loadVerified() {
  const seenUrls = new Set();
  const seenSlugs = new Set();
  const seenEmails = new Set();
  let list = [];

  if (fs.existsSync(VERIFIED_JSON)) {
    try {
      list = JSON.parse(fs.readFileSync(VERIFIED_JSON, 'utf8'));
      for (const item of list) {
        if (item.linkedinUrl) {
          seenUrls.add(item.linkedinUrl.toLowerCase().trim());
          seenSlugs.add(getSlug(item.linkedinUrl));
        }
        if (item.email) seenEmails.add(item.email.toLowerCase().trim());
      }
    } catch (e) {
      list = [];
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

  return { seenUrls, seenSlugs, seenEmails, list };
}

function saveVerifiedLead(lead, list) {
  list.push(lead);
  fs.writeFileSync(VERIFIED_JSON, JSON.stringify(list, null, 2), 'utf8');

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

  // Update leads.json for local UI
  try {
    let dashboardLeads = [];
    if (fs.existsSync(LEADS_JSON)) {
      dashboardLeads = JSON.parse(fs.readFileSync(LEADS_JSON, 'utf8'));
    }
    // Remove old entry with matching linkedinUrl if it had no email
    dashboardLeads = dashboardLeads.filter(l => 
      !(l.linkedinUrl && l.linkedinUrl.toLowerCase().trim() === lead.linkedinUrl.toLowerCase().trim())
    );
    dashboardLeads.unshift(lead);
    fs.writeFileSync(LEADS_JSON, JSON.stringify(dashboardLeads, null, 2), 'utf8');
  } catch (err) {}

  // Sync to Render live dashboard
  try {
    fetch(RENDER_SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead)
    }).catch(() => {});
  } catch (e) {}
}

/**
 * Calls snipercoder/bulk-linkedin-email-finder on Apify
 */
async function lookupEmailsBatch(linkedinUrls) {
  if (!config.APIFY_API_TOKEN) {
    throw new Error('APIFY_API_TOKEN is missing');
  }

  const res = await fetch(`https://api.apify.com/v2/acts/snipercoder~bulk-linkedin-email-finder/run-sync-get-dataset-items?token=${config.APIFY_API_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      linkedin_url_or_ids: linkedinUrls
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Apify email lookup error (${res.status}): ${txt}`);
  }

  return await res.json();
}

async function main() {
  console.log(`\n================================================================`);
  console.log(`⚡ Apify Verified Email Enrichment for Angel Investors`);
  console.log(`💰 Cost: $0.001 per email (Utilizing your Apify free credits)`);
  console.log(`================================================================\n`);

  if (!fs.existsSync(PROFILES_JSON)) {
    console.error('No profiles file found at:', PROFILES_JSON);
    return;
  }

  const profiles = JSON.parse(fs.readFileSync(PROFILES_JSON, 'utf8'));
  console.log(`[Source] Loaded ${profiles.length} LinkedIn profiles.`);

  const { seenUrls, seenSlugs, seenEmails, list } = loadVerified();
  console.log(`[Cache] Already have ${list.length} verified emails in database.`);

  // Filter to profiles that need email enrichment
  const toEnrich = profiles.filter(p => {
    if (!p.linkedinUrl) return false;
    const urlKey = p.linkedinUrl.toLowerCase().trim();
    const slug = getSlug(p.linkedinUrl);
    return !seenUrls.has(urlKey) && !seenSlugs.has(slug);
  });

  console.log(`[Queue] ${toEnrich.length} profiles queued for verified email enrichment.\n`);

  const BATCH_SIZE = 15;
  let totalFound = list.length;

  for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
    const batch = toEnrich.slice(i, i + BATCH_SIZE);
    const urls = batch.map(b => b.linkedinUrl);

    console.log(`[Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toEnrich.length / BATCH_SIZE)}] Looking up emails for ${urls.length} profiles...`);

    try {
      const results = await lookupEmailsBatch(urls);
      console.log(` -> Received ${results.length} result entries from Apify.`);

      for (const res of results) {
        const email = res['04_Email'];
        const linkedinUrl = res['06_Linkedin_url'] || res['17_Query_linkedin'];
        const name = res['01_Name'];

        if (!email || !email.includes('@') || email.includes('undefined')) {
          continue;
        }

        const emailKey = email.toLowerCase().trim();
        const urlKey = linkedinUrl ? linkedinUrl.toLowerCase().trim() : '';

        if (seenEmails.has(emailKey)) continue;
        seenEmails.add(emailKey);
        if (urlKey) seenUrls.add(urlKey);

        const verifiedLead = {
          id: 'inv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          brand: res['16_Company_name'] || 'Angel Investment',
          proposal: 'Targeted Investor Outreach',
          name: name,
          title: res['11_Headline'] || res['07_Title'] || 'Angel Investor',
          linkedinUrl: linkedinUrl ? (linkedinUrl.startsWith('http') ? linkedinUrl : 'https://linkedin.com/in/' + linkedinUrl) : '',
          email: email,
          emailStatus: 'verified',
          phone: res['05_Phone_number'] || 'Not Available',
          city: res['14_City'] || 'Bengaluru',
          source: 'Apify Verified',
          timestamp: new Date().toISOString()
        };

        saveVerifiedLead(verifiedLead, list);
        totalFound++;

        console.log(`   [#${totalFound}] ✓ ${verifiedLead.name} | ${verifiedLead.email} | ${verifiedLead.phone} | ${verifiedLead.city} | ${verifiedLead.brand}`);
      }

      console.log(` -> Running total verified emails: ${totalFound}\n`);
      // Brief pause between batches
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.warn(`[Batch Warning]`, err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n================================================================`);
  console.log(`🎉 Email Enrichment Complete!`);
  console.log(`Total Verified Leads with Deliverable Emails: ${totalFound}`);
  console.log(`📁 CSV: ${VERIFIED_CSV}`);
  console.log(`📁 JSON: ${VERIFIED_JSON}`);
  console.log(`🌐 Live on Render Dashboard: ${RENDER_SYNC_URL}`);
  console.log(`================================================================\n`);
}

main().catch(console.error);
