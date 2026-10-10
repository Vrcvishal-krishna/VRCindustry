const config = require('./config');
const { transcribeAudio } = require('./services/speech');
const { analyzePitch } = require('./services/intelligence');
const { executeWaterfall } = require('./services/waterfall');
const { writeHumanizedEmail } = require('./services/emailWriter');
const { sendApprovedEmail } = require('./services/emailSender');
const { saveLead, addLog, getEmails, saveEmail, updateEmailStatus, deleteEmail } = require('./db');

let isPolling = false;
let lastUpdateId = 0;

// In-memory conversation state per Telegram chatId
// Map<chatId, { lastLead, pendingDraft, awaitingPitch }>
const chatSessions = new Map();

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendMessage(chatId, text, parseMode = null, replyMarkup = null) {
  try {
    const payload = {
      chat_id: chatId,
      text: text
    };
    if (parseMode) payload.parse_mode = parseMode;
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error(`[Telegram] Failed to send message to ${chatId}:`, err.message);
  }
}

async function answerCallbackQuery(callbackQueryId, text = '') {
  try {
    await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text })
    });
  } catch (err) {
    console.error('[Telegram] Failed to answer callback query:', err.message);
  }
}

async function editMessageText(chatId, messageId, text, parseMode = null, replyMarkup = null) {
  try {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: text
    };
    if (parseMode) payload.parse_mode = parseMode;
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn('[Telegram] editMessageText non-ok response:', data);
    }
    return data;
  } catch (err) {
    console.error('[Telegram] Failed to edit message text:', err.message);
  }
}

async function downloadTelegramFile(fileId) {
  const fileRes = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json();
  if (!fileData.ok) {
    throw new Error(`Failed to get file info: ${fileData.description}`);
  }

  const filePath = fileData.result.file_path;
  const downloadRes = await fetch(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!downloadRes.ok) {
    throw new Error(`Failed to download audio file: ${downloadRes.status}`);
  }

  const arrayBuffer = await downloadRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Determines whether the message is a pitch/outreach for the current active contact or a new company search.
 */
async function classifyIntent(text, activeLead) {
  if (!activeLead) return { isPitchForCurrentLead: false };

  try {
    const prompt = `You are an intent router for a B2B prospecting bot.
Current contact in context:
- Name: ${activeLead.name}
- Company: ${activeLead.brand}
- Email: ${activeLead.email}

User's incoming message:
"${text}"

Determine if this message is:
1. "PITCH_FOR_CURRENT_LEAD": User is giving ideas, pitch points, or instructions to draft/send an email to the CURRENT contact (e.g. "I want to email him about...", "Tell them we want to install EV chargers...", "Pitch 50% revenue share", "Here is what to say...").
2. "NEW_SEARCH": User is asking to look up or find another company, founder, or brand (e.g. "Find me founder of Swiggy", "Look up Zomato", "What's the email of ...").

Output strictly JSON:
{
  "intent": "PITCH_FOR_CURRENT_LEAD" or "NEW_SEARCH"
}`;

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      })
    });

    if (res.ok) {
      const data = await res.json();
      const parsed = JSON.parse(data.choices[0].message.content);
      return { isPitchForCurrentLead: parsed.intent === 'PITCH_FOR_CURRENT_LEAD' };
    }
  } catch (err) {
    console.warn('[Intent] Classification fallback check:', err.message);
  }

  // Heuristic fallback if LLM call fails
  const lower = text.toLowerCase();
  const searchKeywords = ['find', 'search', 'founder of', 'who is', 'give me', 'look up'];
  const isExplicitSearch = searchKeywords.some(k => lower.includes(k));
  return { isPitchForCurrentLead: !isExplicitSearch };
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
      await sendMessage(chatId, `📝 <b>Transcribed:</b> <i>"${escapeHtml(rawText)}"</i>`, 'HTML');
    } catch (err) {
      console.error('[Speech] Error transcribing:', err.message);
      await sendMessage(chatId, `⚠️ Could not process voice note: ${err.message}`);
      return;
    }
  } else if (msg.text) {
    if (msg.text.startsWith('/start')) {
      const sender = config.SMTP_USER || 'vishal@vrcindustry.com';
      await sendMessage(chatId, 
        `👋 <b>Welcome to Time Charge Autonomous Prospecting & Email Outreach!</b>\n\n` +
        `Send me a <b>voice note</b> anytime you spot a brand:\n` +
        `<i>"I saw Brand X and have an idea to collaborate on EV charging..."</i>\n\n` +
        `🚀 <b>Autonomous Two-Step Flow:</b>\n` +
        `1. <b>Discover Contact:</b> AI verifies direct email (100% verified, 0% catch-all).\n` +
        `2. <b>Voice-to-Email:</b> Speak what to say ➔ AI writes humanized email ➔ Review & Send from <code>${escapeHtml(sender)}</code>!`,
        'HTML'
      );
      return;
    }
    rawText = msg.text;
    addLog('query_received', `Text received from ${fromUser}: "${rawText}"`, { chatId });
  } else {
    return;
  }

  if (!rawText.trim()) {
    await sendMessage(chatId, '⚠️ Voice note was silent or could not be transcribed. Please try again!');
    return;
  }

  const session = chatSessions.get(chatId) || {};

  // Check if this input is an email pitch for the last discovered contact
  if (session.lastLead && session.awaitingPitch) {
    const { isPitchForCurrentLead } = await classifyIntent(rawText, session.lastLead);
    
    if (isPitchForCurrentLead) {
      await sendMessage(chatId, `✍️ <b>Drafting humanized email for ${escapeHtml(session.lastLead.name)}...</b>`, 'HTML');

      try {
        const draftContent = await writeHumanizedEmail({
          lead: session.lastLead,
          userPitch: rawText,
          senderCompany: 'Time Charge'
        });

        const savedDraft = saveEmail({
          leadId: session.lastLead.id,
          leadName: session.lastLead.name,
          to: session.lastLead.email,
          brand: session.lastLead.brand,
          pitchTranscript: rawText,
          subject: draftContent.subject,
          body: draftContent.body,
          status: 'draft'
        });

        session.pendingDraft = savedDraft;
        chatSessions.set(chatId, session);

        addLog('email_drafted', `Drafted email for ${session.lastLead.name} (${session.lastLead.email})`, {
          draftId: savedDraft.id,
          subject: draftContent.subject
        });

        const senderEmail = config.SMTP_USER || 'vishal@vrcindustry.com';
        const previewMsg = 
          `✉️ <b>AI Humanized Email Draft:</b>\n\n` +
          `<b>From:</b> <code>${escapeHtml(senderEmail)}</code> (Hostinger)\n` +
          `<b>To:</b> <code>${escapeHtml(session.lastLead.email)}</code>\n` +
          `<b>Subject:</b> ${escapeHtml(draftContent.subject)}\n\n` +
          `${escapeHtml(draftContent.body)}\n\n` +
          `─────────────────────────\n` +
          `<b>Shall I send this email to ${escapeHtml(session.lastLead.name)}?</b>`;

        const keyboard = {
          inline_keyboard: [
            [
              { text: '✅ Approve & Send', callback_data: `approve_draft_${savedDraft.id}` },
              { text: '❌ Discard', callback_data: `discard_draft_${savedDraft.id}` }
            ]
          ]
        };

        await sendMessage(chatId, previewMsg, 'HTML', keyboard);
        return;
      } catch (err) {
        console.error('[EmailWriter] Error drafting email:', err);
        await sendMessage(chatId, `⚠️ Could not draft email: ${err.message}`);
        return;
      }
    }
  }

  // Otherwise, treat as new prospect search
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
    ? `🔍 <b>Phone requested</b> ➔ Routing to Apollo for direct phone & verified email...`
    : `🔍 <b>Email requested</b> ➔ Routing to Apify (Zero Apollo Credits used)...`;

  await sendMessage(chatId, 
    `🎯 <b>Brand Identified:</b> ${escapeHtml(analysis.brand)}\n` +
    `👤 <b>Target Role:</b> ${escapeHtml(personaLabel)}\n` +
    `${routingMsg}`, 
    'HTML'
  );

  try {
    const { lead, stage } = await executeWaterfall(analysis.brand, searchRoles, analysis.personName, {
      requiresPhone: analysis.requiresPhone
    });

    if (lead && lead.email && lead.emailStatus === 'verified') {
      const savedLead = saveLead({
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

      // Save lead context for subsequent voice pitch email drafting
      chatSessions.set(chatId, {
        lastLead: savedLead,
        awaitingPitch: true,
        pendingDraft: null
      });

      // 1. Send clean contact card
      const responseCard = 
        `Name: ${lead.name}\n` +
        `Title: ${lead.title || 'Decision Maker'}\n` +
        `Company: ${analysis.brand}\n` +
        `Linkedin URL: ${lead.linkedinUrl}\n` +
        `Email: ${lead.email}\n` +
        `Phone number: ${lead.phone}\n` +
        `City: ${lead.city}`;

      await sendMessage(chatId, responseCard);

      // 2. Offer one-click voice-to-email drafting
      const pitchPrompt = 
        `🎙️ <b>Want to reach out to ${escapeHtml(lead.name)}?</b>\n` +
        `Reply with a <b>voice note</b> (or text) explaining your pitch or collaboration idea!\n` +
        `AI will craft a humanized, zero-cliché B2B email and get your approval before sending from <code>${escapeHtml(config.SMTP_USER || 'vishal@vrcindustry.com')}</code>.`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: `🎙️ Draft Email for ${lead.name.split(' ')[0]}`, callback_data: `prompt_pitch_${savedLead.id}` }
          ]
        ]
      };

      await sendMessage(chatId, pitchPrompt, 'HTML', keyboard);
    } else {
      await sendMessage(chatId, 'Sorry, no contact details found.');
    }
  } catch (err) {
    console.error('[Waterfall] Execution error:', err);
    await sendMessage(chatId, 'Sorry, no contact details found.');
  }
}

async function handleCallbackQuery(cq) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const data = cq.data || '';

  if (data.startsWith('prompt_pitch_')) {
    await answerCallbackQuery(cq.id, 'Ready for your pitch!');
    const session = chatSessions.get(chatId);
    const leadName = (session && session.lastLead) ? session.lastLead.name : 'this contact';
    await sendMessage(chatId, `🎙️ <b>Go ahead!</b> Send a voice note or type what you want to propose to ${escapeHtml(leadName)}.`, 'HTML');
    return;
  }

  if (data.startsWith('approve_draft_')) {
    const draftId = data.replace('approve_draft_', '');
    const emails = getEmails();
    let draft = emails.find(e => e.id === draftId);

    // Fallback to in-memory session if file was re-read
    const session = chatSessions.get(chatId);
    if (!draft && session && session.pendingDraft && session.pendingDraft.id === draftId) {
      draft = session.pendingDraft;
    }

    if (!draft) {
      await answerCallbackQuery(cq.id, 'Draft not found or expired.');
      await editMessageText(chatId, messageId, '⚠️ <b>Draft not found or expired.</b> Please send your pitch again to generate a fresh draft.', 'HTML');
      return;
    }

    await answerCallbackQuery(cq.id, 'Sending email via Hostinger...');

    try {
      const result = await sendApprovedEmail({
        to: draft.to,
        subject: draft.subject,
        text: draft.body
      });

      const newStatus = result.sent ? 'sent' : 'approved';
      updateEmailStatus(draftId, newStatus, {
        sentAt: new Date().toISOString(),
        simulated: result.simulated,
        messageId: result.messageId || null
      });

      addLog('email_sent', `Email to ${draft.to} approved (${result.sent ? 'Dispatched' : 'Logged'})`, {
        draftId,
        simulated: result.simulated
      });

      const senderEmail = config.SMTP_USER || 'vishal@vrcindustry.com';
      const confirmText = result.sent
        ? `🚀 <b>Email Sent Successfully!</b>\n\n<b>From:</b> <code>${escapeHtml(senderEmail)}</code> (Hostinger)\n<b>To:</b> <code>${escapeHtml(draft.to)}</code>\n\n<b>Subject:</b> ${escapeHtml(draft.subject)}`
        : `✅ <b>Email Approved & Saved!</b>\n\n<b>Linked Sender:</b> <code>${escapeHtml(senderEmail)}</code> (Hostinger)\n<b>Recipient:</b> <code>${escapeHtml(draft.to)}</code>\n<b>Subject:</b> ${escapeHtml(draft.subject)}\n\n⚠️ <i>Note: To dispatch live emails automatically, please configure your Hostinger email password (<code>SMTP_PASS</code>) in Render Environment Variables or in Dashboard Settings.</i>`;

      await editMessageText(chatId, messageId, confirmText, 'HTML');
    } catch (err) {
      console.error('[Bot] Error dispatching email:', err);
      updateEmailStatus(draftId, 'failed', { error: err.message });
      await editMessageText(chatId, messageId, `⚠️ <b>Could not send email:</b>\n${escapeHtml(err.message)}`, 'HTML');
    }
    return;
  }

  if (data.startsWith('discard_draft_')) {
    const draftId = data.replace('discard_draft_', '');
    deleteEmail(draftId);
    await answerCallbackQuery(cq.id, 'Draft discarded and removed.');
    await editMessageText(chatId, messageId, '❌ <b>Email draft discarded and deleted.</b>', 'HTML');
    return;
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
            handleMessage(update.message).catch(err => {
              console.error('[Bot] Message processing error:', err);
            });
          } else if (update.callback_query) {
            handleCallbackQuery(update.callback_query).catch(err => {
              console.error('[Bot] Callback processing error:', err);
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
  handleMessage,
  handleCallbackQuery
};
