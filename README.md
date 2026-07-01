# Browser Agent - Free AI Chrome Extension

A Manifest V3 Chrome extension that opens a persistent side-panel AI assistant. It can read the current page, answer questions, inspect forms, and control the page with approved actions such as click, type, scroll, submit, and navigate.

## Features

1. **Side-panel chat** - stays open while you browse.
2. **Free models first** - OpenCode, Pollinations, KeylessAI, ApiAirforce, Ollama, and LM Studio.
3. **Bring-your-own API key** - Anthropic Claude API, OpenAI API, Gemini, OpenRouter, and custom OpenAI-compatible endpoints.
4. **Page control tools** - reads visible text, maps interactive elements, clicks, types, scrolls, submits, and navigates.
5. **Approval flow** - default mode asks before browser actions. Low-risk auto mode is optional.
6. **Debug context** - optional console-log capture through Chrome debugger permission.
7. **Legacy study/quiz tools preserved** - the older auto-answer and study helpers remain available internally for page analysis.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `chrome-extension` folder.
5. Pin **Browser Agent** from the extensions menu.
6. Click the toolbar icon to open the side panel.

## Use

1. Open any normal webpage. Chrome internal pages cannot be controlled.
2. Open the Browser Agent side panel.
3. Choose a provider in **Settings**. The default free provider requires no key.
4. Ask a question, for example: `Summarize this page` or `Find the contact form and fill my name as Vikas`.
5. Review the proposed plan/actions.
6. Click **Approve and run** to let the extension control the page.

## Provider Notes

| Provider | API Key | Notes |
|---|---|---|
| OpenCode AI | Not required | Default no-key option. |
| Pollinations AI | Not required | Public service, can be rate-limited. |
| KeylessAI | Not required | OpenAI-compatible no-key endpoint. |
| ApiAirforce | Not required | Free models endpoint. |
| Ollama Local | Not required | Runs locally at `http://localhost:11434/api/chat`. |
| LM Studio Local | Not required | Runs locally at `http://localhost:1234/v1/chat/completions`. |
| Anthropic Claude API | Required | Uses official Anthropic API keys, not Claude Pro web sessions. |
| OpenAI API | Required | Uses official OpenAI API keys, not ChatGPT Plus web sessions. |
| Google Gemini | Required | Free/paid Gemini API keys supported. |
| OpenRouter | Required | Supports free and paid OpenRouter models. |
| Custom API | Optional | Any OpenAI-compatible endpoint. |

## Safety

The extension can control webpages, so it uses **Ask before acting** by default. High-risk actions should always be reviewed carefully, including purchases, account creation, deletion, password/security changes, downloads, and submitting personal data.

Normal web subscriptions such as Claude Pro or ChatGPT Plus are not API access and are not used directly. Use official API keys or the free/local providers instead.

## Validate

```bash
npm test
```

Run the full browser smoke test manually with:

```bash
npm run test:extension
```
