const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const { getLeads, getStats, getLogs, saveLead, addLog } = require('./db');
const { analyzePitch } = require('./services/intelligence');
const { executeWaterfall } = require('./services/waterfall');

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
    const searchRoles = [];
    if (analysis.explicitRole) searchRoles.push(analysis.explicitRole);
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
