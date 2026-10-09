const config = require('../config');
const { addLog } = require('../db');

/**
 * Searches LinkedIn profiles via Apify Google Search Results Scraper
 * Strict brand presence and headline verification.
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
      // Include up to 4 roles to maximize finding founders / decision makers
      const rolesToSearch = Array.isArray(roles) && roles.length > 0 ? roles : ['Founder', 'Co-Founder', 'Head of Partnerships'];
      const topRoles = rolesToSearch.slice(0, 4).map(r => `"${r}"`).join(' OR ');
      query = `site:linkedin.com/in/ "${brand}" (${topRoles})`.trim();
    }

    addLog('apify_search_started', `Searching Apify for: ${query}`);

    const res = await fetch(`https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=${config.APIFY_API_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: query,
        maxPagesPerQuery: 1,
        resultsPerPage: 8
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
    const brandRegex = new RegExp(`(^|[^a-zA-Z0-9])${brandLower}([^a-zA-Z0-9]|$)`, 'i');

    for (const dataset of items) {
      for (const org of dataset.organicResults || []) {
        const url = org.url || '';
        const titleText = org.title || '';
        const snippetText = org.description || '';
        const fullContext = (titleText + ' ' + snippetText);

        if (!url.includes('linkedin.com/in/')) continue;

        // STRICT BRAND VALIDATION:
        // Must contain brand name as an exact word boundary (prevents false matches like "rápido" in French/Spanish)
        const matchesBrandWord = brandRegex.test(fullContext);
        if (!matchesBrandWord) {
          console.log(`[Apify] Skipping unrelated profile: "${titleText}" (brand word "${brand}" not found)`);
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

    addLog('apify_search_completed', `Found ${candidates.length} candidate(s) on Apify for ${brand}`, { candidates });
    return candidates;
  } catch (err) {
    console.error('[Apify] Error during search:', err.message);
    return [];
  }
}

/**
 * Scrapes direct verified email from LinkedIn profile URL using Apify
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
    const emailDomain = (p.email.split('@')[1] || '').toLowerCase();
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

    addLog('apollo_lead_found', `Verified contact found on Apollo: ${p.email}`);

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
 * Validates whether an extracted email and company strictly belong to target brand
 */
function isCompanyMatch(targetBrand, targetDomain, candidateCompany, candidateEmail) {
  const brandNorm = (targetBrand || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const compNorm = (candidateCompany || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const emailDomain = (candidateEmail ? candidateEmail.split('@')[1] : '').toLowerCase();
  const targetDomainNorm = (targetDomain || '').toLowerCase().replace(/^www\./, '');

  // 1. Check email domain match (e.g. @rapido.bike, @atherenergy.com)
  if (targetDomainNorm && emailDomain) {
    if (emailDomain === targetDomainNorm || emailDomain.includes(brandNorm)) {
      return true;
    }
  }

  // 2. Check company name match
  if (compNorm && brandNorm) {
    if (compNorm.includes(brandNorm) || brandNorm.includes(compNorm)) {
      return true;
    }
  }

  // 3. Fallback: if email domain contains brand name
  if (emailDomain && brandNorm && emailDomain.includes(brandNorm)) {
    return true;
  }

  return false;
}

/**
 * Checks for direct email mentioned in the public snippet
 */
function extractEmailFromSnippet(snippet, targetBrand, targetDomain) {
  if (!snippet) return null;
  const matches = snippet.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g);
  if (!matches) return null;

  for (const email of matches) {
    if (isCompanyMatch(targetBrand, targetDomain, '', email)) {
      return email;
    }
  }
  return null;
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
 * Executes Smart Intent-Driven Prospecting with Strict Company Verification:
 * 1. Resolves official organization domain (e.g. rapido.bike).
 * 2. Apify Google Search (finds verified profiles matching brand & roles).
 * 3. Apify Email Finder: Strictly verifies company match (blocks ExclusiveWallz/Banks Avocats).
 * 4. Snippet Email Check: Extracts emails in bio/snippet (e.g. aravind@rapido.bike).
 * 5. Apollo Fallback: Verified company matching for genuine company leads.
 */
async function executeWaterfall(brand, allRoles, specificPerson = null, options = { requiresPhone: false }) {
  const requiresPhone = Boolean(options && options.requiresPhone);

  addLog('waterfall_started', `Starting prospecting for "${brand}" [Phone: ${requiresPhone}]`, { 
    allRoles, 
    specificPerson, 
    requiresPhone 
  });

  // Step 0: Resolve Target Organization Domain & City (Free org metadata)
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
        console.log(`[Org Resolver] ${brand} ➔ Domain: ${orgDomain}, City: ${orgCity}`);
      }
    }
  } catch (e) {
    console.warn('[Org Resolver] Warning:', e.message);
  }

  // Step 1: Apify Google Search Scraper
  const candidates = await searchLinkedInOnApify(brand, allRoles, specificPerson);

  if (!candidates || candidates.length === 0) {
    addLog('apify_no_candidates', `No matching LinkedIn profiles found for ${brand}`);
    return { lead: null, stage: 'Apify' };
  }

  // Iterate over candidates
  for (const candidate of candidates) {
    console.log(`[Waterfall] Evaluating candidate: ${candidate.name} (${candidate.title})`);

    // A. Check for direct email in the public snippet (e.g., aravind@rapido.bike)
    const snippetEmail = extractEmailFromSnippet(candidate.snippet, brand, orgDomain);
    if (snippetEmail) {
      console.log(`[Waterfall] Found verified email directly in snippet: ${snippetEmail}`);
      addLog('snippet_email_found', `Verified email found in profile: ${snippetEmail}`);
      return {
        lead: {
          name: candidate.name,
          linkedinUrl: candidate.linkedinUrl,
          email: snippetEmail,
          emailStatus: 'verified',
          phone: requiresPhone ? (orgPhone || 'Not Available') : 'Not Requested',
          city: extractCityFromSnippet(candidate.snippet) || orgCity || 'Not Available',
          title: candidate.title,
          source: 'Apify'
        },
        stage: 'Apify'
      };
    }

    // B. Check Apify Email Scraper (Only if phone NOT specifically required)
    if (!requiresPhone) {
      const apifyEmailData = await searchEmailOnApify(candidate.linkedinUrl);

      if (apifyEmailData && apifyEmailData.email) {
        // STRICT COMPANY VALIDATION ON APIFY RESULT:
        const isMatch = isCompanyMatch(brand, orgDomain, apifyEmailData.company, apifyEmailData.email);

        if (isMatch) {
          console.log(`[Waterfall] Apify Email Verified for ${brand}: ${apifyEmailData.email}`);
          addLog('apify_email_found', `Verified email on Apify: ${apifyEmailData.email}`);
          return {
            lead: {
              name: apifyEmailData.name || candidate.name,
              linkedinUrl: candidate.linkedinUrl,
              email: apifyEmailData.email,
              emailStatus: 'verified',
              phone: 'Not Requested',
              city: extractCityFromSnippet(candidate.snippet) || orgCity || 'Not Available',
              title: candidate.title,
              source: 'Apify'
            },
            stage: 'Apify'
          };
        } else {
          console.warn(`[Waterfall] DISCARDED Apify email mismatch: ${apifyEmailData.email} (${apifyEmailData.company}) does not match ${brand}`);
          addLog('apify_email_mismatch_discarded', `Discarded unrelated email: ${apifyEmailData.email} (${apifyEmailData.company})`);
        }
      }
    }

    // C. Fallback to Apollo (for genuine verified company match or when phone is requested)
    console.log(`[Waterfall] Querying Apollo match for candidate: ${candidate.name}...`);
    const apolloResult = await searchApollo(brand, candidate, orgDomain, orgCity, orgPhone);

    if (apolloResult && apolloResult.emailStatus === 'verified') {
      console.log(`[Waterfall] SUCCESS on Apollo: ${apolloResult.email}`);
      return { lead: apolloResult, stage: requiresPhone ? 'Apollo (Phone Requested)' : 'Apollo' };
    }
  }

  // Final direct org match fallback on Apollo
  const apolloDirect = await searchApollo(brand, null, orgDomain, orgCity, orgPhone);
  if (apolloDirect && apolloDirect.emailStatus === 'verified') {
    return { lead: apolloDirect, stage: 'Apollo' };
  }

  addLog('waterfall_exhausted', `No verified contact details found for ${brand}`);
  return { lead: null, stage: 'Exhausted' };
}

module.exports = {
  executeWaterfall,
  searchLinkedInOnApify,
  searchEmailOnApify,
  searchApollo
};
