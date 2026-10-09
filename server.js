const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const { getLeads, getStats, getLogs, saveLead, addLog, getEmails, saveEmail, updateEmailStatus } = require('./db');
const { analyzePitch } = require('./services/intelligence');
const { executeWaterfall } = require('./services/waterfall');
const { writeHumanizedEmail } = require('./services/emailWriter');
const { sendApprovedEmail } = require('./services/emailSender');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint for Render & uptime monitors
app.get('/health', (req, res) => res.status(200).json({ status: 'healthy', uptime: process.uptime() }));

// API: Get Leads
app.get('/api/leads', (req, res) => {
  res.json(getLeads());
});

// API: Get Stats
app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

// API: Get Activity Logs
app.get('/api/logs', (req, res) => {
  res.json(getLogs());
});

// API: Get Drafted & Sent Emails
app.get('/api/emails', (req, res) => {
  res.json(getEmails());
});

// API: Draft an email using Groq LLM
app.post('/api/emails/draft', async (req, res) => {
  const { lead, pitchText } = req.body;
  if (!lead || !lead.email || !pitchText) {
    return res.status(400).json({ error: 'Lead details and pitchText are required' });
  }

  try {
    const draftContent = await writeHumanizedEmail({
      lead,
      userPitch: pitchText,
      senderCompany: 'Time Charge'
    });

    const savedDraft = saveEmail({
      leadId: lead.id,
      leadName: lead.name,
      to: lead.email,
      brand: lead.brand,
      pitchTranscript: pitchText,
      subject: draftContent.subject,
      body: draftContent.body,
      status: 'draft'
    });

    addLog('email_drafted', `Web UI drafted email for ${lead.name} (${lead.email})`, {
      draftId: savedDraft.id,
      subject: draftContent.subject
    });

    res.json({ success: true, draft: savedDraft });
  } catch (err) {
    console.error('Error drafting email:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Approve & Send an email
app.post('/api/emails/send', async (req, res) => {
  const { draftId, to, subject, body } = req.body;
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'to, subject, and body are required' });
  }

  try {
    const result = await sendApprovedEmail({ to, subject, text: body });
    const newStatus = result.sent ? 'sent' : 'approved';

    if (draftId) {
      updateEmailStatus(draftId, newStatus, {
        subject,
        body,
        sentAt: new Date().toISOString(),
        simulated: result.simulated,
        messageId: result.messageId || null
      });
    } else {
      saveEmail({
        to,
        subject,
        body,
        status: newStatus,
        sentAt: new Date().toISOString(),
        simulated: result.simulated
      });
    }

    addLog('email_sent', `Web UI approved email to ${to} (${result.sent ? 'Dispatched' : 'Logged'})`, {
      simulated: result.simulated
    });

    res.json({ success: true, result });
  } catch (err) {
    console.error('Error sending email:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Export to CSV
app.get('/api/export', (req, res) => {
  const leads = getLeads();
  const headers = ['ID', 'Brand', 'Name', 'Title', 'Verified Email', 'Email Status', 'Phone', 'City', 'LinkedIn', 'Source', 'Timestamp'];
  
  const rows = leads.map(l => [
    `"${l.id || ''}"`,
    `"${(l.brand || '').replace(/"/g, '""')}"`,
    `"${(l.name || '').replace(/"/g, '""')}"`,
    `"${(l.title || '').replace(/"/g, '""')}"`,
    `"${(l.email || '').replace(/"/g, '""')}"`,
    `"${l.emailStatus || 'verified'}"`,
    `"${(l.phone || '').replace(/"/g, '""')}"`,
    `"${(l.city || '').replace(/"/g, '""')}"`,
    `"${(l.linkedinUrl || '').replace(/"/g, '""')}"`,
    `"${l.source || ''}"`,
    `"${l.timestamp || ''}"`
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="verified_leads_${Date.now()}.csv"`);
  res.send(csv);
});

// API: Test Pitch Simulation from Dashboard
app.post('/api/test-pitch', async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Text pitch is required' });
  }

  addLog('query_received', `Dashboard web test pitch: "${text}"`);

  try {
    const analysis = await analyzePitch(text);
    console.log('[Dashboard Test Analysis]', analysis);

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

    const { lead, stage } = await executeWaterfall(analysis.brand, searchRoles, analysis.personName, {
      requiresPhone: analysis.requiresPhone
    });

    if (lead && lead.email && lead.emailStatus === 'verified') {
      const saved = saveLead({
        brand: analysis.brand,
        proposal: analysis.proposal,
        audioTranscript: text,
        name: lead.name,
        title: lead.title,
        linkedinUrl: lead.linkedinUrl,
        email: lead.email,
        emailStatus: lead.emailStatus,
        phone: lead.phone,
        city: lead.city,
        source: stage
      });
      return res.json({ lead: saved, analysis });
    } else {
      return res.json({ lead: null, analysis, message: 'Sorry, no contact details found.' });
    }
  } catch (err) {
    console.error('Error in test pitch:', err);
    res.status(500).json({ error: err.message });
  }
});

function startServer(port = config.PORT) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`[Dashboard] Web dashboard live at: http://localhost:${port}`);
      resolve(server);
    });
  });
}

module.exports = {
  app,
  startServer
};
