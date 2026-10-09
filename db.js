const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(file, defaultValue = []) {
  try {
    if (!fs.existsSync(file)) return defaultValue;
    const content = fs.readFileSync(file, 'utf-8');
    return JSON.parse(content) || defaultValue;
  } catch (err) {
    console.error(`Error reading ${file}:`, err.message);
    return defaultValue;
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`Error writing ${file}:`, err.message);
  }
}

function getLeads() {
  return readJSON(LEADS_FILE, []);
}

function saveLead(lead) {
  const leads = getLeads();
  const newLead = {
    id: `lead_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...lead
  };
  leads.unshift(newLead);
  writeJSON(LEADS_FILE, leads);
  return newLead;
}

function getLogs() {
  return readJSON(LOGS_FILE, []);
}

function addLog(type, message, details = {}) {
  const logs = getLogs();
  const entry = {
    id: `log_${Date.now()}`,
    timestamp: new Date().toISOString(),
    type,
    message,
    details
  };
  logs.unshift(entry);
  if (logs.length > 500) logs.pop();
  writeJSON(LOGS_FILE, logs);
  return entry;
}

function getStats() {
  const leads = getLeads();
  const logs = getLogs();
  
  const sources = {};
  leads.forEach(l => {
    const src = l.source || 'Other';
    sources[src] = (sources[src] || 0) + 1;
  });

  return {
    totalLeads: leads.length,
    verifiedEmails: leads.filter(l => l.email && l.emailStatus === 'verified').length,
    totalQueries: logs.filter(l => l.type === 'query_received').length,
    sources
  };
}

module.exports = {
  getLeads,
  saveLead,
  getLogs,
  addLog,
  getStats
};
