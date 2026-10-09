# Autonomous Collab Prospecting Agent

An autonomous AI prospecting agent that listens to your voice notes on Telegram, evaluates the target brand and best point of contact, searches across Apify, Smartlead, and Apollo with a waterfall fallback, and only returns **100% verified emails (strictly zero catch-all)**.

## How It Works

```
Voice Note (Telegram) ➔ Groq Whisper (Speech-to-Text) ➔ Groq GPT-OSS-120B (Persona Intelligence)
                                                                 │
┌────────────────────────────────────────────────────────────────┴─────────────────────────┐
│ WATERFALL PIPELINE                                                                      │
│ 1. Apify: Searches Google for matching LinkedIn Profile                                 │
│ 2. Smartlead SmartProspect: Searches company domain (Checks bounce_status == 'Verified') │
│ 3. Apollo.io: Matches candidate & enriches (Checks email_status == 'verified')          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
        [Verified Email Found]                    [Not Found]
                    │                                     │
    Sends formatted Telegram card:              Sends Telegram message:
    Name, LinkedIn, Email, Phone, City          "Sorry, no contact details found."
    + Saved to Web Dashboard & DB
```

## Dashboard

Open in your browser:
```
http://localhost:3000
```

- **Live table** of all scraped contacts with direct LinkedIn links and verified emails
- **Export to CSV** button
- **Test Pitch simulator** in the browser
- **Live Activity Feed** logging every step of the waterfall

## Project Files

- `config.js` / `.env`: API credentials and configuration
- `bot.js`: Telegram bot listener & voice downloader
- `services/speech.js`: Groq Whisper audio transcriber
- `services/intelligence.js`: Groq LLM brand extraction & persona evaluator
- `services/waterfall.js`: Apify ➔ Smartlead ➔ Apollo waterfall engine
- `server.js`: Express web dashboard & REST API
- `public/index.html`: Responsive dashboard UI
- `data/leads.json`: Persisted leads database
