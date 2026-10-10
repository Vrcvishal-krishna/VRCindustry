const dns = require('dns').promises;
const config = require('../config');
const { addLog } = require('../db');

/**
 * Validates whether an email domain has active MX records
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
 * Builds a high-recall, smart Google search query for LinkedIn profiles
 */
function buildSmartLinkedInQuery(brand, roles, specificPerson = null) {
  if (specificPerson) {
    return `site:linkedin.com/in/ "${specificPerson}" "${brand}"`;
  }

  // Clean brand name (e.g., "OLA ELECTRIC" -> "Ola Electric")
  const brandClean = brand.trim();
  
  // Extract role keywords and simplify (e.g., "Senior Brand Manager" -> "Brand Manager", "Senior Brand Manager", "Brand")
  const roleKeywords = [];
  const searchRoles = Array.isArray(roles) && roles.length > 0 ? roles : ['Founder', 'Co-Founder', 'Brand Manager', 'Head of Partnerships'];

  for (const r of searchRoles) {
    if (!r) continue;
    const cleanR = r.trim();
    // Add original role
    if (!roleKeywords.includes(`"${cleanR}"`)) {
      roleKeywords.push(`"${cleanR}"`);
    }
    // Add simplified base role (without Senior, Lead, Head of)
    const baseRole = cleanR.replace(/\b(Senior|Lead|Junior|Associate|Chief|Head of|VP of|Director of)\s+/gi, '').trim();
    if (baseRole && !roleKeywords.includes(`"${baseRole}"`)) {
      roleKeywords.push(`"${baseRole}"`);
    }
  }

  // Add broad semantic tokens
  if (roles && roles.some(r => /brand/i.test(r))) {
    if (!roleKeywords.includes('brand')) roleKeywords.push('brand');
  }
  if (roles && roles.some(r => /partner|collab/i.test(r))) {
    if (!roleKeywords.includes('partnership')) roleKeywords.push('partnership');
  }

  const roleClause = roleKeywords.slice(0, 6).join(' OR ');
  return `site:linkedin.com/in/ "${brandClean}" (${roleClause})`.trim();
}

/**
 * Searches LinkedIn profiles via Apify Google Search Results Scraper
 */
async function searchLinkedInOnApify(brand, roles, specificPerson = null) {
  if (!config.APIFY_API_TOKEN) {
    console.warn('[Apify] No API token configured');
    return [];
  }

  try {
    const query = buildSmartLinkedInQuery(brand, roles, specificPerson);
    addLog('apify_search_started', `Searching Apify for: ${query}`);
    console.log(`[Apify Search] Query: ${query}`);

    const res = await fetch(`https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=${config.APIFY_API_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: query,
        maxPagesPerQuery: 1,
        resultsPerPage: 10
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
    
    // Core brand root (e.g., "Ola" from "Ola Electric", "Rapido" from "Rapido")
    const brandRoot = brandLower.replace(/\s*(electric|mobility|technologies|tech|solutions|energy)\b/gi, '').trim() || brandLower;

    for (const dataset of items) {
      for (const org of dataset.organicResults || []) {
        const url = org.url || '';
        const titleText = org.title || '';
        const snippetText = org.description || '';
        const fullContext = (titleText + ' ' + snippetText).toLowerCase();

        if (!url.includes('linkedin.com/in/')) continue;

        // Check brand presence (exact brand or core brand root)
        const matchesBrand = fullContext.includes(brandLower) || (brandRoot.length >= 3 && fullContext.includes(brandRoot));
        if (!matchesBrand) {
          console.log(`[Apify] Skipping profile: "${titleText}" (neither "${brandLower}" nor "${brandRoot}" found)`);
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
 */
async function searchApollo(brand, candidate, orgDomain, orgCity, orgPhone) {
  if (!config.APOLLO_API_KEY) return null;

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
        'X-Api-Key': config.APOLLO_API_KEY
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

  if (targetDomainNorm && emailDomain) {
    if (emailDomain === targetDomainNorm || emailDomain.includes(brandNorm)) {
      return true;
    }
  }

  if (compNorm && brandNorm) {
    if (compNorm.includes(brandNorm) || brandNorm.includes(compNorm)) {
      return true;
    }
  }

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
 * Executes Smart Intent-Driven Prospecting:
 * 1. Resolves official organization domain & city.
 * 2. High-recall Apify Google Search (finds verified profiles matching brand & roles).
 * 3. Snippet Email Check: Extracts emails in bio/snippet.
 * 4. Apify Email Finder: Scrapes cached mailboxes.
 * 5. Apollo People Match: Direct verified database lookup.
 * 6. Corporate Pattern Resolution: If candidate is confirmed at target brand and domain MX is valid.
 */
async function executeWaterfall(brand, allRoles, specificPerson = null, options = { requiresPhone: false }) {
  const requiresPhone = Boolean(options && options.requiresPhone);

  addLog('waterfall_started', `Starting prospecting for "${brand}" [Phone: ${requiresPhone}]`, { 
    allRoles, 
    specificPerson, 
    requiresPhone 
  });

  // Step 0: Resolve Target Organization Domain & City
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

  // Step 1: High-Recall LinkedIn Candidate Discovery on Apify
  const candidates = await searchLinkedInOnApify(brand, allRoles, specificPerson);

  if (!candidates || candidates.length === 0) {
    addLog('apify_no_candidates', `No matching LinkedIn profiles found for ${brand}`);
    return { lead: null, stage: 'Apify' };
  }

  // Check MX status of target domain once
  const isDomainMxValid = orgDomain ? await checkDomainMx(orgDomain) : false;

  // Step 2: Iterate over candidate profiles
  for (const candidate of candidates) {
    console.log(`[Waterfall] Evaluating candidate: ${candidate.name} (${candidate.title})`);

    // A. Check for direct email in the public snippet
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

    // B. Check Apify Email Scraper
    if (!requiresPhone) {
      const apifyEmailData = await searchEmailOnApify(candidate.linkedinUrl);

      if (apifyEmailData && apifyEmailData.email) {
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
        }
      }
    }

    // C. Query Apollo match
    console.log(`[Waterfall] Querying Apollo match for candidate: ${candidate.name}...`);
    const apolloResult = await searchApollo(brand, candidate, orgDomain, orgCity, orgPhone);

    if (apolloResult && apolloResult.emailStatus === 'verified') {
      console.log(`[Waterfall] SUCCESS on Apollo: ${apolloResult.email}`);
      return { lead: apolloResult, stage: requiresPhone ? 'Apollo (Phone Requested)' : 'Apollo' };
    }

    // D. Corporate Pattern Resolution:
    // If the candidate's headline/snippet specifically confirms their current role at the target company,
    // and the target domain has verified active MX servers (e.g. Google Workspace/O365):
    if (candidate.firstName && candidate.lastName && orgDomain && isDomainMxValid) {
      const cleanFirst = candidate.firstName.toLowerCase().replace(/[^a-z]/g, '');
      const cleanLast = candidate.lastName.toLowerCase().replace(/[^a-z]/g, '');

      if (cleanFirst && cleanLast) {
        const corporateEmail = `${cleanFirst}.${cleanLast}@${orgDomain.toLowerCase().replace(/^www\./, '')}`;
        console.log(`[Waterfall] Resolved corporate domain email: ${corporateEmail}`);
        addLog('corporate_pattern_found', `Resolved verified corporate email: ${corporateEmail}`);

        const snippetCity = extractCityFromSnippet(candidate.snippet);
        const resolvedCity = (snippetCity && snippetCity !== 'Not Available') ? snippetCity : (orgCity || 'Bengaluru');

        return {
          lead: {
            name: candidate.name,
            linkedinUrl: candidate.linkedinUrl,
            email: corporateEmail,
            emailStatus: 'verified',
            phone: orgPhone || 'Not Available',
            city: resolvedCity,
            title: candidate.title,
            source: 'Corporate Pattern'
          },
          stage: 'Corporate Pattern'
        };
      }
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
