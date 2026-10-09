const { startServer } = require('./server');
const { startPolling } = require('./bot');
const config = require('./config');

async function main() {
  console.log('====================================================');
  console.log('🚀 AI COLLAB PROSPECTING AGENT (TELEGRAM + WATERFALL)');
  console.log('====================================================');
  console.log(`• Telegram Bot: @Aasha_mehtabot`);
  console.log(`• Audio Transcription: Groq Whisper-large-v3-turbo`);
  console.log(`• AI Intelligence: Groq OpenAI GPT-OSS-120B`);
  console.log(`• Scrapers: Apify (Google Search Scraper)`);
  console.log(`• Waterfall: Apify ➡️ Smartlead ➡️ Apollo.io`);
  console.log(`• Verification: Strictly Verified Emails (0% Catch-All)`);
  console.log('====================================================');

  // Start Web Dashboard
  await startServer(config.PORT);

  // Start Telegram Long Polling Bot
  startPolling();
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
