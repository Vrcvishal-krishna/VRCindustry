const config = require('../config');

/**
 * Analyzes pitch transcript to extract brand and determine best personas
 * @param {string} text 
 * @returns {Promise<{brand: string, proposal: string, personName: string|null, explicitRole: string|null, recommendedRoles: string[]}>}
 */
async function analyzePitch(text) {
  if (!config.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const systemPrompt = `You are an elite B2B sales development and brand partnerships intelligence agent.
Your task is to analyze a voice note transcript or note from a founder/executive who wants to collaborate with a brand.

Analyze the user's text and extract:
1. "brand": The target company or brand name mentioned.
2. "proposal": A concise summary of their pitch/collaboration idea (1 sentence).
3. "person_name": Full name of a specific person if explicitly named, or null.
4. "explicit_role": The specific designation if explicitly mentioned, or null.
5. "recommended_roles": If no explicit role was specified, identify the top 3-4 most relevant executive job titles/designations at that target brand who handle this exact type of collaboration or pitch. (e.g., ["Head of Brand Partnerships", "Brand Manager", "Chief Marketing Officer", "Director of Business Development"]). If the company is early-stage or startup, include ["Founder", "Co-Founder", "CEO"].
6. "requires_phone": boolean (set to true ONLY IF user explicitly requests phone number, mobile number, cell, or calling them, e.g., "get me their phone number", "find their mobile number", "need their contact number". Set to false if they only ask to connect, pitch, find contact, or email).

Output strictly valid JSON matching this schema:
{
  "brand": "string",
  "proposal": "string",
  "person_name": "string or null",
  "explicit_role": "string or null",
  "recommended_roles": ["string"],
  "requires_phone": false
}`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Voice note transcript: "${text}"` }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq LLM failed (${response.status}): ${err}`);
  }

  const data = await response.json();
  const rawContent = data.choices[0].message.content;
  
  try {
    const parsed = JSON.parse(rawContent);
    return {
      brand: parsed.brand || '',
      proposal: parsed.proposal || text,
      personName: parsed.person_name || null,
      explicitRole: parsed.explicit_role || null,
      recommendedRoles: Array.isArray(parsed.recommended_roles) && parsed.recommended_roles.length > 0 
        ? parsed.recommended_roles 
        : ['Head of Partnerships', 'Brand Manager', 'Marketing Director', 'Founder'],
      requiresPhone: Boolean(parsed.requires_phone)
    };
  } catch (err) {
    console.error('Failed to parse LLM JSON:', rawContent);
    throw new Error('LLM did not return valid JSON');
  }
}

module.exports = {
  analyzePitch
};
