const config = require('../config');

/**
 * Uses Groq LLM to write a humanized, authentic B2B outreach email based on the user's spoken pitch.
 * Strips away robotic clichés and creates a natural, executive-level message with an approval-ready structure.
 * 
 * @param {Object} params
 * @param {Object} params.lead - The prospect details (name, title, brand, email)
 * @param {string} params.userPitch - The spoken idea or pitch transcribed from the user
 * @param {string} [params.senderCompany='Time Charge'] - The sender's company
 * @returns {Promise<{subject: string, body: string}>}
 */
async function writeHumanizedEmail({ lead, userPitch, senderCompany = 'Time Charge' }) {
  if (!config.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const recipientName = lead.name || 'there';
  const recipientFirstName = recipientName.split(' ')[0];
  const recipientTitle = lead.title || 'Leader';
  const recipientBrand = lead.brand || lead.company || 'your team';

  const systemPrompt = `You are a world-class executive communication advisor and founder copywriter.
A founder/business leader just recorded a raw voice note explaining what they want to propose to a specific decision maker.
Your task is to transform this raw spoken pitch into a humanized, warm, respectful, and razor-sharp B2B outreach email.

RECIPIENT CONTEXT:
- Name: ${recipientName} (First Name: ${recipientFirstName})
- Job Title: ${recipientTitle}
- Company: ${recipientBrand}

SENDER CONTEXT:
- Company: ${senderCompany} (commercial EV charging partner, zero upfront capex, charging hubs for fleets & retail commercial spaces)

STRICT HUMANIZATION & WRITING RULES:
1. WRITE LIKE A REAL HUMAN: Sound like a thoughtful, direct founder or operator writing an email from their personal phone or laptop.
2. BAN ALL CORPORATE CLICHÉS & AI PHRASING:
   - NEVER use: "I hope this email finds you well", "In today's fast-paced world", "I am reaching out to explore synergies", "delve into", "spearheading", "game-changer".
3. BREVITY & PUNCH:
   - 3 to 4 short paragraphs or succinct bullet points max.
   - Clear value proposition based on the user's spoken pitch.
   - Low-friction Call-to-Action (e.g., "Open to a brief 10-minute chat this Thursday?", "Would you be against exploring this?").
4. SUBJECT LINE:
   - Short (3 to 6 words), conversational, lowercase or titlecase, zero spam words (e.g., "${recipientBrand.toLowerCase()} + ${senderCompany.toLowerCase()} ev hubs?").

OUTPUT JSON SCHEMA:
{
  "subject": "string",
  "body": "string"
}`;

  const userPrompt = `Spoken pitch from user:
"${userPitch}"

Draft the humanized email now. Output strictly JSON.`;

  try {
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
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      console.warn(`[EmailWriter] gpt-oss-120b returned ${response.status}, retrying with llama-3.3-70b-versatile...`);
      const fallbackRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3,
          response_format: { type: 'json_object' }
        })
      });

      if (!fallbackRes.ok) {
        throw new Error(`Email generation failed: ${await fallbackRes.text()}`);
      }

      const fbData = await fallbackRes.json();
      return JSON.parse(fbData.choices[0].message.content);
    }

    const data = await response.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (err) {
    console.error('[EmailWriter] Error generating email:', err.message);
    throw err;
  }
}

module.exports = { writeHumanizedEmail };
