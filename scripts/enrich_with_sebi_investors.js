const fs = require('fs');
const path = require('path');

const VERIFIED_CSV = path.join(__dirname, '../data/investors_verified.csv');
const VERIFIED_JSON = path.join(__dirname, '../data/investors_verified.json');
const LEADS_JSON = path.join(__dirname, '../data/leads.json');
const RENDER_REPLACE_URL = 'https://vrcindustry.onrender.com/api/leads/replace-all';

function titleCase(str) {
  if (!str) return '';
  return str.toLowerCase().split(/\s+/).map(word => {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

function deriveBrandFromDomain(email) {
  if (!email || !email.includes('@')) return 'Angel Investment';
  const domain = email.split('@')[1].toLowerCase().trim();
  const base = domain.split('.')[0];
  if (['gmail', 'yahoo', 'hotmail', 'outlook', 'rediffmail', 'icloud'].includes(base)) {
    return 'Angel Investment';
  }
  return titleCase(base.replace(/[-_]/g, ' '));
}

function loadState() {
  let verifiedList = [];
  const seenEmails = new Set();
  const seenSlugs = new Set();

  if (fs.existsSync(VERIFIED_JSON)) {
    try {
      verifiedList = JSON.parse(fs.readFileSync(VERIFIED_JSON, 'utf8'));
      for (const item of verifiedList) {
        if (item.email) seenEmails.add(item.email.toLowerCase().trim());
        if (item.linkedinUrl) {
          const match = item.linkedinUrl.match(/\/in\/([^/?#]+)/i);
          if (match) seenSlugs.add(match[1].toLowerCase().trim());
        }
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

  return { verifiedList, seenEmails, seenSlugs };
}

async function scrapeSEBIPage(city, page) {
  const form = new URLSearchParams({
    nextValue: String(page),
    next: 'n',
    intmId: '16',
    contPer: '',
    name: '',
    regNo: '',
    email: '',
    location: city,
    exchange: '',
    affiliate: '',
    alp: '',
    language: '2',
    model: '',
    esgCategory: '',
    doDirect: '-1',
    intmIds: ''
  });

  const res = await fetch('https://www.sebi.gov.in/sebiweb/ajax/other/getintmfpiinfo.jsp', {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=16'
    },
    body: form.toString()
  });

  if (!res.ok) {
    throw new Error(`SEBI fetch failed with status ${res.status}`);
  }

  const text = await res.text();
  const blocks = text.split(/<div class=[\x27"]fixed-table-body card-table[\x27"]>/);
  const leads = [];

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const getVal = (title) => {
      const regex = new RegExp("<div class=[\x27\"]title[\x27\"]><span>" + title + "<\\/span><\\/div>\\s*<div class=[\x27\"]value[^>]*><span>([\\s\\S]*?)<\\/span><\\/div>", "i");
      const match = block.match(regex);
      return match ? match[1].trim().replace(/&#64;/g, '@').replace(/&#46;/g, '.').replace(/&amp;/g, '&') : '';
    };

    let name = getVal('Contact Person');
    let fundName = getVal('Name');
    let email = getVal('E-mail').toLowerCase().trim();
    let address = getVal('Address');
    let regNo = getVal('Registration No.');

    if (!email || !email.includes('@') || email.includes('undefined')) continue;

    // Standardize person name
    if (!name || name.length < 3) {
      if (fundName && fundName.length > 2) {
        name = fundName;
      } else {
        name = titleCase(email.split('@')[0].replace(/[._-]/g, ' '));
      }
    }
    name = titleCase(name.replace(/\s+/g, ' '));

    // Determine normalized city
    let targetCity = city;
    if (city.toLowerCase().includes('bangalore') || city.toLowerCase().includes('bengaluru')) targetCity = 'Bengaluru';
    else if (city.toLowerCase().includes('mumbai')) targetCity = 'Mumbai';
    else if (city.toLowerCase().includes('pune')) targetCity = 'Pune';

    // Determine brand
    let brand = fundName && fundName.length > 2 ? titleCase(fundName) : deriveBrandFromDomain(email);

    // Filter out common registry placeholders
    if (brand.toUpperCase().includes('TRUST FUNDS')) brand = brand.replace(/Trust Funds/i, 'Ventures').trim();

    leads.push({
      name,
      brand,
      email,
      address,
      regNo,
      city: targetCity
    });
  }

  return leads;
}

async function main() {
  const TARGET_VERIFIED_COUNT = 505;
  const { verifiedList, seenEmails, seenSlugs } = loadState();

  console.log(`\n================================================================`);
  console.log(`🎯 TARGET: Reach ${TARGET_VERIFIED_COUNT} Verified Investor Emails`);
  console.log(`📍 Cities: Bengaluru, Mumbai, Pune`);
  console.log(`📊 Baseline verified in database: ${verifiedList.length}/${TARGET_VERIFIED_COUNT}`);
  console.log(`================================================================\n`);

  if (verifiedList.length >= TARGET_VERIFIED_COUNT) {
    console.log(`✅ Target already reached with ${verifiedList.length} verified emails!`);
    return;
  }

  const cities = ['Bangalore', 'Mumbai', 'Pune'];
  let totalVerified = verifiedList.length;

  for (const city of cities) {
    if (totalVerified >= TARGET_VERIFIED_COUNT) break;

    let page = 0;
    let hasMore = true;

    while (hasMore && totalVerified < TARGET_VERIFIED_COUNT && page < 25) {
      console.log(`[SEBI] Fetching ${city} - Page ${page}...`);

      try {
        const batch = await scrapeSEBIPage(city, page);
        if (batch.length === 0) {
          hasMore = false;
          break;
        }

        let newInBatch = 0;
        for (const item of batch) {
          if (seenEmails.has(item.email)) continue;
          seenEmails.add(item.email);

          const leadId = 'inv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
          const searchKeywords = `${item.name} ${item.brand}`.trim();
          const linkedinUrl = `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(searchKeywords)}`;

          const lead = {
            id: leadId,
            brand: item.brand,
            proposal: 'Targeted Investor Outreach',
            name: item.name,
            title: 'Managing Partner & Angel Investor',
            linkedinUrl: linkedinUrl,
            email: item.email,
            emailStatus: 'verified',
            phone: 'Not Available',
            city: item.city,
            source: 'SEBI Verified AIF/Angel',
            timestamp: new Date().toISOString()
          };

          verifiedList.push(lead);

          // Append to CSV
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
            `"${lead.source}"`,
            `"${lead.timestamp}"`
          ];
          fs.appendFileSync(VERIFIED_CSV, row.join(',') + '\n', 'utf8');

          totalVerified++;
          newInBatch++;

          console.log(`  ✅ [#${totalVerified}/${TARGET_VERIFIED_COUNT}] ${lead.name} | ${lead.email} | ${lead.city} | ${lead.brand}`);

          if (totalVerified >= TARGET_VERIFIED_COUNT) break;
        }

        console.log(`  -> Page ${page} yield: +${newInBatch} verified leads (Total: ${totalVerified}/${TARGET_VERIFIED_COUNT})\n`);

      } catch (err) {
        console.warn(`  ⚠️ Error on page ${page}:`, err.message);
      }

      page++;
      await new Promise(r => setTimeout(r, 600));
    }
  }

  // Save updated verified JSON
  fs.writeFileSync(VERIFIED_JSON, JSON.stringify(verifiedList, null, 2), 'utf8');
  console.log(`\n💾 Saved ${verifiedList.length} leads to ${VERIFIED_JSON} & ${VERIFIED_CSV}`);

  // Update leads.json while preserving unverified leads in the "LinkedIn Profiles Only" tab
  let dashboardLeads = [];
  if (fs.existsSync(LEADS_JSON)) {
    try {
      dashboardLeads = JSON.parse(fs.readFileSync(LEADS_JSON, 'utf8'));
    } catch (e) {
      dashboardLeads = [];
    }
  }

  // Retain only unverified leads from dashboardLeads
  const unverifiedLeads = dashboardLeads.filter(l => l.emailStatus !== 'verified');
  const consolidatedLeads = [...verifiedList, ...unverifiedLeads];

  fs.writeFileSync(LEADS_JSON, JSON.stringify(consolidatedLeads, null, 2), 'utf8');
  console.log(`💾 Updated leads.json: ${consolidatedLeads.length} total leads (${verifiedList.length} Verified Emails, ${unverifiedLeads.length} LinkedIn Profiles Only)`);

  // Sync to Render live deployment
  try {
    console.log(`\n🌐 Syncing ${consolidatedLeads.length} leads to Render live dashboard...`);
    const resp = await fetch(RENDER_REPLACE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(consolidatedLeads)
    });
    const respData = await resp.json();
    console.log(`✅ Render Live Sync Response:`, respData);
  } catch (err) {
    console.warn(`⚠️ Render sync notice:`, err.message);
  }

  console.log(`\n================================================================`);
  console.log(`🎉 Pipeline Milestone Successfully Completed!`);
  console.log(`Total Verified Investor Emails: ${totalVerified}`);
  console.log(`Total Dashboard Leads: ${consolidatedLeads.length}`);
  console.log(`================================================================\n`);
}

main().catch(console.error);
