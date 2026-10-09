const config = require('./config');
const { transcribeAudio } = require('./services/speech');
const { analyzePitch } = require('./services/intelligence');
const { executeWaterfall } = require('./services/waterfall');
const { saveLead, addLog } = require('./db');

let isPolling = false;
let lastUpdateId = 0;

async function sendMessage(chatId, text, parseMode = null) {
  try {
    const payload = {
      chat_id: chatId,
      text: text
    };
    if (parseMode) payload.parse_mode = parseMode;

    await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error(`[Telegram] Failed to send message to ${chatId}:`, err.message);
  }
}

async function downloadTelegramFile(fileId) {
  // 1. Get file path
  const fileRes = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json();
  if (!fileData.ok) {
    throw new Error(`Failed to get file info: ${fileData.description}`);
  }

  const filePath = fileData.result.file_path;
  // 2. Download file content
  const downloadRes = await fetch(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!downloadRes.ok) {
    throw new Error(`Failed to download audio file: ${downloadRes.status}`);
  }

  const arrayBuffer = await downloadRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const fromUser = msg.from ? `${msg.from.first_name || ''} (@${msg.from.username || 'unknown'})` : 'User';

  let rawText = '';
  let isVoice = false;

  if (msg.voice) {
    isVoice = true;
    addLog('query_received', `Voice note received from ${fromUser}`, { chatId, duration: msg.voice.duration });
    await sendMessage(chatId, '🎧 Listening to your voice note...');

    try {
      const audioBuffer = await downloadTelegramFile(msg.voice.file_id);
      rawText = await transcribeAudio(audioBuffer, 'voice.oga');
      console.log(`[Transcription] Result: "${rawText}"`);
      await sendMessage(chatId, `📝 *Transcribed:* "${rawText}"`, 'Markdown');
    } catch (err) {
      console.error('[Speech] Error transcribing:', err.message);
      await sendMessage(chatId, `⚠️ Could not process voice note: ${err.message}`);
      return;
    }
  } else if (msg.text) {
    // Check if start command
    if (msg.text.startsWith('/start')) {
      await sendMessage(chatId, 
        `👋 *Welcome to the Autonomous Collab Prospecting Bot!*\n\n` +
        `Send me a *voice note* anytime you spot a brand (or type your pitch):\n` +
        `_"I saw Brand X and have an idea to collaborate on marketing..."_\n\n` +
        `🚀 *What happens next:*\n` +
        `1. AI extracts the brand & identifies the ideal decision-maker\n` +
        `2. Apify finds their LinkedIn profile\n` +
        `3. Waterfall search (Smartlead -> Apollo) verifies their direct contact\n` +
        `4. Strictly *100% verified emails only* (zero catch-all)\n` +
        `5. Sends back Name, LinkedIn, Email, Phone & City, saved to your dashboard!`,
        'Markdown'
      );
      return;
    }
    rawText = msg.text;
    addLog('query_received', `Text pitch received from ${fromUser}: "${rawText}"`, { chatId });
  } else {
    // Other media type
    return;
  }

  if (!rawText.trim()) {
    await sendMessage(chatId, '⚠️ Voice note was silent or could not be transcribed. Please try again!');
    return;
  }

  // 1. Analyze pitch with Groq LLM
  await sendMessage(chatId, '🧠 Evaluating brand & identifying best point of contact...');
  let analysis;
  try {
    analysis = await analyzePitch(rawText);
    console.log('[Analysis]', analysis);
  } catch (err) {
    console.error('[Intelligence] Analysis failed:', err.message);
    await sendMessage(chatId, `⚠️ Could not analyze pitch: ${err.message}`);
    return;
  }

  if (!analysis.brand) {
    await sendMessage(chatId, '⚠️ Could not identify the brand name from your message. Please mention the brand name clearly!');
    return;
  }

  // Prioritize all explicit roles first if specified, then recommended roles
  const searchRoles = [];
  if (Array.isArray(analysis.explicitRoles) && analysis.explicitRoles.length > 0) {
    for (const r of analysis.explicitRoles) {
      if (!searchRoles.includes(r)) searchRoles.push(r);
    }
  } else if (analysis.explicitRole) {
    searchRoles.push(analysis.explicitRole);
  }

  if (Array.isArray(analysis.recommendedRoles)) {
    for (const r of analysis.recommendedRoles) {
      if (!searchRoles.includes(r)) searchRoles.push(r);
    }
  }

  const personaLabel = searchRoles.slice(0, 2).join(' / ') || 'Partnerships Lead';
  const routingMsg = analysis.requiresPhone 
    ? `🔍 *Phone requested* ➔ Routing to Apollo for direct phone & verified email...`
    : `🔍 *Email requested* ➔ Routing to Apify (Zero Apollo Credits used)...`;

  await sendMessage(chatId, 
    `🎯 *Brand Identified:* ${analysis.brand}\n` +
    `👤 *Target Role:* ${personaLabel}\n` +
    `${routingMsg}`, 
    'Markdown'
  );

  // 2. Run Smart Pipeline
  try {
    const { lead, stage } = await executeWaterfall(analysis.brand, searchRoles, analysis.personName, {
      requiresPhone: analysis.requiresPhone
    });

    if (lead && lead.email && lead.emailStatus === 'verified') {
      // Save to local database
      saveLead({
        brand: analysis.brand,
        proposal: analysis.proposal,
        audioTranscript: rawText,
        name: lead.name,
        title: lead.title,
        linkedinUrl: lead.linkedinUrl,
        email: lead.email,
        emailStatus: lead.emailStatus,
        phone: lead.phone,
        city: lead.city,
        source: stage
      });

      // Send formatted result strictly as specified by user
      const responseCard = 
        `Name: ${lead.name}\n` +
        `Linkedin URL: ${lead.linkedinUrl}\n` +
        `Email: ${lead.email}\n` +
        `Phone number: ${lead.phone}\n` +
        `City: ${lead.city}`;

      await sendMessage(chatId, responseCard);
    } else {
      // If not found anywhere, strictly reply with user-specified string
      await sendMessage(chatId, 'Sorry, no contact details found.');
    }
  } catch (err) {
    console.error('[Waterfall] Execution error:', err);
    await sendMessage(chatId, 'Sorry, no contact details found.');
  }
}

async function startPolling() {
  if (isPolling) return;
  isPolling = true;
  console.log('[Telegram] Bot polling service started...');

  while (isPolling) {
    try {
      const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`;
      const res = await fetch(url);
      
      if (!res.ok) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      const data = await res.json();
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          lastUpdateId = update.update_id;
          if (update.message) {
            // Handle message asynchronously so polling isn't blocked
            handleMessage(update.message).catch(err => {
              console.error('[Bot] Message processing error:', err);
            });
          }
        }
      }
    } catch (err) {
      console.warn('[Telegram] Polling connection hiccup:', err.message);
      await new Promise(r => setTimeout(r, 4000));
    }
  }
}

function stopPolling() {
  isPolling = false;
}

module.exports = {
  startPolling,
  stopPolling,
  handleMessage
};
