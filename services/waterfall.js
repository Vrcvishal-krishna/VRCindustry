const config = require('../config');
const { addLog } = require('../db');

/**
 * Searches LinkedIn profiles via Apify Google Search Results Scraper
 * With strict brand presence verification to eliminate false matches.
 */
async function searchLinkedInOnApify(brand, roles, specificPerson = null) {
  if (!config.APIFY_API_TOKEN) {
    console.warn('[Apify] No API token configured');
    return [];
  }

  try {
    let query;
    if (specificPerson) {
      query = `site:linkedin.com/in/ "${specificPerson}" "${brand}"`;
    } else {
      const topRoles = roles.slice(0, 2).map(r => `"${r}"`).join(' OR ');
      query = `site:linkedin.com/in/ "${brand}" ${topRoles ? `(${topRoles})` : ''}`.trim();
    }

    addLog('apify_search_started', `Searching Apify for: ${query}`);

    const res = await fetch(`https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=${config.APIFY_API_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: query,
        maxPagesPerQuery: 1,
        resultsPerPage: 6
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[Apify] Search error (${res.status}):`, err);
      return [];
    }

    const items = await res.json();
    const candidates = [];
    const brandLower = brand.toLowerCase();
    const brandWords = brandLower.split(/\s+/).filter(w => w.length > 2);

    for (const dataset of items) {
      for (const org of dataset.organicResults || []) {
        const url = org.url || '';
        const titleText = org.title || '';
        const snippetText = org.description || '';
        const fullContext = (titleText + ' ' + snippetText).toLowerCase();

        if (!url.includes('linkedin.com/in/')) continue;

        // STRICT BRAND VALIDATION
        const matchesBrand = brandWords.some(w => fullContext.includes(w)) || fullContext.includes(brandLower);
        if (!matchesBrand) {
          console.log(`[Apify] Skipping unrelated profile: "${titleText}" (brand "${brand}" not found)`);
          continue;
        }

        const cleanTitle = titleText.replace(/\s*\|\s*LinkedIn.*$/i, '').replace(/\s*-\s*LinkedIn.*$/i, '').trim();
        const parts = cleanTitle.split(/\s*[-–—|]\s*/);
        
        let rawName = parts[0] ? parts[0].trim() : 'Unknown';
        rawName = rawName.replace(/^(Dr\.|Mr\.|Ms\.|Mrs\.)\s+/i, '');

        const nameTokens = rawName.split(/\s+/);
        const firstName = nameTokens[0] || '';
        const lastName = nameTokens.slice(1).join(' ') || '';

        const roleTitle = parts.slice(1).join(' - ').trim() || snippetText.substring(0, 100);

        candidates.push({
          name: rawName,
          firstName,
          lastName,
          title: roleTitle,
          linkedinUrl: url.split('?')[0],
          snippet: snippetText
        });
      }
    }

    addLog('apify_search_completed', `Found ${candidates.length} verified candidate(s) on Apify for ${brand}`, { candidates });
    return candidates;
  } catch (err) {
    console.error('[Apify] Error during search:', err.message);
    return [];
  }
}

/**
 * Scrapes direct verified email from LinkedIn profile URL using Apify
 * 100% Apify-based — Zero Apollo Credits!
 */
async function searchEmailOnApify(linkedinUrl) {
  if (!config.APIFY_API_TOKEN || !linkedinUrl) return null;

  try {
    addLog('apify_email_search_started', `Querying Apify Email Scraper for: ${linkedinUrl}`);

    const res = await fetch(`https://api.apify.com/v2/acts/vulnv~linkedin-email-finder/run-sync-get-dataset-items?token=${config.APIFY_API_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: [linkedinUrl]
      })
    });

    if (!res.ok) {
      console.warn(`[Apify Email] Returned status ${res.status}`);
      return null;
    }

    const items = await res.json();
    const result = (items || [])[0];

    if (result && result.found && result.email) {
      addLog('apify_email_found', `Verified email found on Apify: ${result.email} (Apollo credits saved!)`);
      return {
        email: result.email,
        name: result.name || '',
        company: result.company || '',
        domain: result.domain || ''
      };
    }
    return null;
  } catch (err) {
    console.error('[Apify Email] Error:', err.message);
    return null;
  }
}

/**
 * Searches and enriches contact using Apollo.io
 * ONLY called when user explicitly asks for a phone number!
 * Strictly validates verified email + company match.
 */
async function searchApollo(brand, candidate, orgDomain, orgCity, orgPhone) {
  if (!config.APPOLLO_API_KEY && !config.APOLLO_API_KEY) return null;
  const apiKey = config.APOLLO_API_KEY || config.APPOLLO_API_KEY;

  try {
    const brandLower = brand.toLowerCase();
    const matchPayload = {
      organization_name: brand,
      domain: orgDomain || undefined
    };

    if (candidate) {
      if (candidate.linkedinUrl) matchPayload.linkedin_url = candidate.linkedinUrl;
      if (candidate.firstName) matchPayload.first_name = candidate.firstName;
      if (candidate.lastName) matchPayload.last_name = candidate.lastName;
    }

    const matchRes = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': apiKey
      },
      body: JSON.stringify(matchPayload)
    });

    if (!matchRes.ok) return null;

    const matchData = await matchRes.json();
    const p = matchData.person;
    if (!p) return null;

    const emailStatus = (p.email_status || '').toLowerCase();
    if (emailStatus !== 'verified' || !p.email) {
      return null;
    }

    // Strict Company Match check
    const personOrg = (p.organization?.name || '').toLowerCase();
    const emailDomain = p.email.split('@')[1] || '';
    const cleanOrgDomain = (orgDomain || '').toLowerCase();

    const companyMatches = 
      personOrg.includes(brandLower) || 
      brandLower.includes(personOrg) ||
      (cleanOrgDomain && emailDomain.includes(cleanOrgDomain)) ||
      (cleanOrgDomain && cleanOrgDomain.includes(emailDomain));

    if (!companyMatches) {
      console.warn(`[Apollo] Rejecting mismatch: ${p.name} works at "${p.organization?.name}", expected "${brand}"`);
      return null;
    }

    addLog('apollo_lead_found', `Verified contact with phone found on Apollo: ${p.email}`);

    const phone = p.sanitized_phone || (p.phone_numbers && p.phone_numbers[0]?.sanitized_number) || orgPhone || 'Not Available';
    const city = p.city || orgCity || 'Not Available';

    return {
      name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || candidate?.name || 'Contact',
      linkedinUrl: p.linkedin_url || candidate?.linkedinUrl || 'Not Available',
      email: p.email,
      emailStatus: 'verified',
      phone: phone,
      city: city,
      title: p.title || candidate?.title || 'Decision Maker',
      source: 'Apollo'
    };
  } catch (err) {
    console.error('[Apollo] Error in search:', err.message);
    return null;
  }
}

/**
 * Extracts city from candidate snippet
 */
function extractCityFromSnippet(snippet) {
  if (!snippet) return 'Not Available';

  const geoMatch = snippet.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),\s*(?:[A-Z][a-z]+,\s*)?(?:India|United States|USA|United Kingdom|UK|Australia|Germany|Singapore|Canada|France|UAE)/);
  if (geoMatch) return geoMatch[1].trim();

  const locMatch = snippet.match(/Location:\s*([A-Za-z\s]+?)(?:·|\s+500|\s*$)/i);
  if (locMatch) return locMatch[1].trim();

  const commonCities = [
    'Bengaluru', 'Bangalore', 'Mumbai', 'Pune', 'Delhi', 'New Delhi', 'Gurugram', 'Gurgaon',
    'Noida', 'Hyderabad', 'Chennai', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Chandigarh',
    'New York', 'San Francisco', 'Chicago', 'London', 'Berlin', 'Sydney', 'Melbourne', 'Dubai'
  ];
  for (const c of commonCities) {
    if (new RegExp(`\\b${c}\\b`, 'i').test(snippet)) {
      return c;
    }
  }

  return 'Not Available';
}

/**
 * Executes Smart Intent-Driven Prospecting:
 * - If requiresPhone === true: Routes to Apollo (retrieves direct phone + verified email)
 * - If requiresPhone === false: Routes to Apify ONLY (retrieves verified email with ZERO Apollo credits!)
 */
async function executeWaterfall(brand, allRoles, specificPerson = null, options = { requiresPhone: false }) {
  const requiresPhone = Boolean(options && options.requiresPhone);

  addLog('waterfall_started', `Starting prospecting for "${brand}" [Phone Requested: ${requiresPhone}]`, { 
    allRoles, 
    specificPerson, 
    requiresPhone 
  });

  // 1. Apify Search to find relevant LinkedIn profiles
  const candidates = await searchLinkedInOnApify(brand, allRoles, specificPerson);

  if (!candidates || candidates.length === 0) {
    addLog('apify_no_candidates', `No matching LinkedIn profiles found for ${brand}`);
    return { lead: null, stage: 'Apify' };
  }

  // CASE A: User explicitly requested Phone Number ➔ Route to Apollo
  if (requiresPhone) {
    console.log(`[Smart Router] 📞 User requested PHONE number. Routing to Apollo to fetch phone + email...`);
    
    // Look up company domain and phone via Apollo org search (free metadata)
    let orgDomain = '';
    let orgCity = '';
    let orgPhone = '';

    try {
      const orgRes = await fetch('https://api.apollo.io/v1/organizations/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': config.APOLLO_API_KEY
        },
        body: JSON.stringify({ q_organization_name: brand, per_page: 1 })
      });

      if (orgRes.ok) {
        const orgData = await orgRes.json();
        const org = (orgData.organizations || [])[0];
        if (org) {
          orgDomain = org.primary_domain || '';
          orgCity = org.city || '';
          orgPhone = org.phone || '';
        }
      }
    } catch (e) {
      console.warn('[Apollo Org] Warning:', e.message);
    }

    // Match candidate on Apollo
    for (const candidate of candidates) {
      const apolloResult = await searchApollo(brand, candidate, orgDomain, orgCity, orgPhone);
      if (apolloResult && apolloResult.emailStatus === 'verified') {
        return { lead: apolloResult, stage: 'Apollo (Phone Requested)' };
      }
    }

    // Direct org match fallback on Apollo
    const apolloDirect = await searchApollo(brand, null, orgDomain, orgCity, orgPhone);
    if (apolloDirect && apolloDirect.emailStatus === 'verified') {
      return { lead: apolloDirect, stage: 'Apollo (Phone Requested)' };
    }

    return { lead: null, stage: 'Apollo' };
  }

  // CASE B: User did NOT ask for Phone Number ➔ 100% Apify (Zero Apollo Credits!)
  console.log(`[Smart Router] 📧 Phone not requested. Routing to Apify ONLY (Saving Apollo credits!)...`);

  for (const candidate of candidates) {
    const emailData = await searchEmailOnApify(candidate.linkedinUrl);

    if (emailData && emailData.email) {
      const city = extractCityFromSnippet(candidate.snippet);

      console.log(`[Smart Router] SUCCESS via Apify! Email: ${emailData.email} (0 Apollo credits used)`);

      return {
        lead: {
          name: emailData.name || candidate.name,
          linkedinUrl: candidate.linkedinUrl,
          email: emailData.email,
          emailStatus: 'verified',
          phone: 'Not Requested',
          city: city,
          title: candidate.title,
          source: 'Apify'
        },
        stage: 'Apify'
      };
    }
  }

  addLog('apify_no_email_found', `No verified email found on Apify for ${brand}`);
  return { lead: null, stage: 'Apify' };
}

module.exports = {
  executeWaterfall,
  searchLinkedInOnApify,
  searchEmailOnApify,
  searchApollo
};
