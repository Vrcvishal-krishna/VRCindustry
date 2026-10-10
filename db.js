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

const EMAILS_FILE = path.join(DATA_DIR, 'emails.json');

function getEmails() {
  return readJSON(EMAILS_FILE, []);
}

function saveEmail(emailData) {
  const emails = getEmails();
  const entry = {
    id: `email_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    timestamp: new Date().toISOString(),
    status: emailData.status || 'draft', // draft | approved | sent | failed
    ...emailData
  };
  emails.unshift(entry);
  writeJSON(EMAILS_FILE, emails);
  return entry;
}

function updateEmailStatus(id, status, details = {}) {
  const emails = getEmails();
  const email = emails.find(e => e.id === id);
  if (email) {
    email.status = status;
    email.updatedAt = new Date().toISOString();
    Object.assign(email, details);
    writeJSON(EMAILS_FILE, emails);
  }
  return email;
}

function deleteEmail(id) {
  let emails = getEmails();
  const initialLength = emails.length;
  emails = emails.filter(e => e.id !== id);
  writeJSON(EMAILS_FILE, emails);
  return emails.length < initialLength;
}

function deleteLead(id) {
  let leads = getLeads();
  const initialLength = leads.length;
  leads = leads.filter(l => l.id !== id);
  writeJSON(LEADS_FILE, leads);
  return leads.length < initialLength;
}

function getStats() {
  const leads = getLeads();
  const logs = getLogs();
  const emails = getEmails();
  
  const sources = {};
  leads.forEach(l => {
    const src = l.source || 'Other';
    sources[src] = (sources[src] || 0) + 1;
  });

  return {
    totalLeads: leads.length,
    verifiedEmails: leads.filter(l => l.email && l.emailStatus === 'verified').length,
    totalQueries: logs.filter(l => l.type === 'query_received').length,
    totalEmailsDrafted: emails.length,
    totalEmailsSent: emails.filter(e => e.status === 'sent' || e.status === 'approved').length,
    sources
  };
}

module.exports = {
  getLeads,
  saveLead,
  deleteLead,
  getLogs,
  addLog,
  getStats,
  getEmails,
  saveEmail,
  updateEmailStatus,
  deleteEmail
};
