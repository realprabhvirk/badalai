# BADAL AI

**Punjab Di Gall, Badal AI De Naal.**

BADAL AI is a single-page chat website with a Cloudflare Pages Function backend that calls Google's Gemini API. It is a fan-made, AI-generated character inspired by Sukhbir Singh Badal and the Shiromani Akali Dal. It is **not** Sukhbir Singh Badal. The experience was created by Prabh Virk.

## Project structure

```
badal-ai/
├── index.html
├── styles.css
├── app.js
├── README.md
├── _headers
├── assets/
│   ├── sukhbir-badal-hero.webp
│   └── akali-logo.png
└── functions/
    └── api/
        └── chat.js
```

Plain HTML, CSS and JavaScript. No build step.

## Local development

Use Wrangler, which serves both the static files and `functions/`:

```bash
npm install
npx wrangler pages dev . --binding GEMINI_API_KEY=your-key-here --binding GEMINI_MODEL=gemini-2.5-flash
```

Do not use `python -m http.server`. It does not run `functions/`, so `/api/chat` will fail.

## Gemini secret setup

1. Create an API key in Google AI Studio.
2. Store it as a Pages secret. Do not put it in any file in this repo:

```bash
npx wrangler pages secret put GEMINI_API_KEY --project-name badal-ai
```

3. Optional: choose the model. Default is `gemini-2.5-flash`. Set it as an environment variable in the Pages project settings (Settings → Environment variables), or with:

```bash
npx wrangler pages secret put GEMINI_MODEL --project-name badal-ai
```

## Deployment (Wrangler)

Dragging the folder into the Cloudflare dashboard does **not** deploy `functions/`. Use Wrangler or Git integration.

```bash
npm install -D wrangler
npx wrangler login
npx wrangler pages project create badal-ai
npx wrangler pages secret put GEMINI_API_KEY --project-name badal-ai
npx wrangler pages deploy . --project-name badal-ai
```

Redeploy with the last command after changes.

Git integration also works: connect the repo, leave the build command empty, and set the output directory to `/`. Add `GEMINI_API_KEY` under Settings → Environment variables (encrypted).

## Assets

- `assets/sukhbir-badal-hero.webp`: background photograph. Replace it with a higher-resolution supplied image (ideally 1600px+ wide, landscape) for best results.
- `assets/akali-logo.png`: the supplied emblem. Use only the official, permitted logo.

## Privacy

- No accounts, no database, no analytics.
- Conversations are held in browser memory only. Refreshing or closing the tab clears them.
- Nothing is saved to localStorage or IndexedDB.
- The backend does not log message text, history or image data. It only logs HTTP status codes from Gemini.
- Messages and images are sent to Google's Gemini API to generate replies.

## Error behaviour

- Missing key, invalid model, bad input, oversized or unsupported images, rate limits, Gemini failures and network errors all show a readable message.
- If `/api/chat` returns 404 or 405, the UI says the backend deployment is missing. The frontend never falls back to calling Gemini directly.
