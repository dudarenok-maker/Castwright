# Getting a Gemini API key

Castwright can use Google's **Gemini** models to analyse your book — finding who speaks and tagging each line — and, optionally, to voice it. Google gives every account a free tier that's more than enough to get started; you just need an API key. It takes about a minute.

> **In a hurry?** Go straight to **<https://aistudio.google.com/apikey>**, sign in, create a key, copy it, and paste it into Castwright. The steps below walk through exactly that.

## Step by step

1. Open the **Google AI Studio → API keys** page linked above and **sign in** with any Google account. (First visit? Accept the terms when prompted.)
2. Click **Create API key**. If you're asked to pick a Google Cloud project, the default one it offers is fine.
3. Your key appears — a long string starting with `AIza…`. Click **Copy**.
4. Back in Castwright, go to **Account → Server configuration → Gemini API key**, paste the key into the field, and click **Save key**. (The same field appears in the setup wizard's Analysis step, and a **"Get a Gemini API key"** link beside it brings you back to this page.)

That's it — pick any Gemini model under **Defaults for new books → Analysis model** and Castwright will use your key.

## Good to know

- **The free tier is fine for analysis.** You don't need billing enabled to start. Google publishes the current free-tier limits on the same site.
- **Your key stays on your machine.** Castwright stores it in your per-user settings file (`~/.castwright/user-settings.json`, plaintext, gitignored) — the same trust model as `server/.env`. It's never sent anywhere but Google.
- **Analysis fails immediately with "Gemini … returned an empty response"?** That's Google's recitation filter blocking a copyrighted-book chapter, not a bad key. Switch the analysis model to `gemma-4-31b-it`, or go fully local with Ollama. See [Installing Castwright](Installing-Castwright) and [Analysis & the Analyzer](Analysis-and-the-Analyzer) for the details.
- **Prefer not to use the cloud at all?** A local **Ollama** model is the free, private alternative — no key required. See [Analysis & the Analyzer](Analysis-and-the-Analyzer).
