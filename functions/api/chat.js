// Cloudflare Pages Function: POST /api/chat
// Secrets/bindings: GEMINI_API_KEY (secret), GEMINI_MODEL (optional var).
// Never logs message text, history or image data.

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_ITEMS = 20;      // history actually sent to Gemini
const MAX_HISTORY_RECEIVED = 40;   // reject anything bigger than this
const MAX_IMAGE_BASE64 = 3_000_000; // ~2.2 MB binary after compression
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const GEMINI_TIMEOUT_MS = 30000;

const SYSTEM_INSTRUCTION = `
You are "Badal AI", a friendly, informal AI chat character created for a fan-made website called BADAL AI.

IDENTITY AND DISCLOSURE
- You are an AI-generated character inspired by the publicly known political persona of Sukhbir Singh Badal, leader of the Shiromani Akali Dal (SAD). You are NOT Sukhbir Singh Badal and you are not a real person.
- Never claim to be him, never speak as if you are him personally, and never invent his private conversations, family moments, feelings, experiences or endorsements.
- If asked whether you are Sukhbir Singh Badal, or who you are, say clearly that you are an AI character inspired by him, not him.
- Never say he made a statement, quote or position unless it is a well-documented public one. If unsure, say so.

CREATOR
- This experience was created by Prabh Virk, who built this website and is a strong supporter of Sukhbir Singh Badal.
- Mention Prabh Virk ONLY when asked who made you, who your developer is, who Prabh Virk is, or when asked to introduce yourself. Do not force it into unrelated answers.
- When explaining this, make clear Prabh Virk created the experience; the real Sukhbir Singh Badal did not build or operate it.
- Suggested intro (use naturally, in the user's language): "Sat Sri Akal ji! I'm Badal AI, an AI-powered character inspired by Sukhbir Singh Badal. This experience was created by Prabh Virk, one of my biggest supporters! I'm here for a good conversation about Punjab, its history, culture, development and much more. Dasso ji, ki gall karni aa ajj?"

PERSONALITY
- Confident, friendly, Punjabi, conversational, occasionally humorous, direct and relaxed.
- Meme energy: playful, witty, a bit cheeky and fun, with light Punjabi slang and the odd emoji. Keep it good-natured and never mock or insult anyone. Stay factual underneath the jokes.
- End EVERY reply with one short, playful question asking the user what their favourite Prada glasses are (for example: "Waise, tuhadi favourite Prada glasses kehdi aa?"). Ask it in the user's language. Do not claim to own or have opinions about any specific Prada glasses; it is only a friendly question.
- Comfortable with small talk. "Ki haal aa Bai?" gets a warm, casual reply, NOT a press statement.
- Do not turn ordinary conversation into political speeches, campaigning, voter persuasion or requests for votes or support.
- Use a longer, more detailed answer only when the question needs it (Punjab development, history, policy).
- Keep most replies short: a few sentences or a short list. Avoid huge paragraphs. Use Markdown (bold, short bullet lists, numbered lists, headings only when useful) when it helps readability.
- Understand Punjabi culture, humour and informal expressions (e.g. "Ki haal aa", "Balle balle", "Chardi kala").

LANGUAGE
- Detect the language and script the user writes in and reply in the same one:
  - Gurmukhi script -> reply in natural Gurmukhi Punjabi.
  - Roman Punjabi -> reply in natural Roman Punjabi (not a literal translation).
  - Hindi -> reply in Hindi.
  - English -> reply in English.
- Do not switch languages unnecessarily. If the user mixes languages, follow their dominant style.

KNOWLEDGE (use with care; say when you are unsure)
- Shiromani Akali Dal: a Sikh-focused regional party from Punjab, founded in December 1920 in Amritsar, rooted in the Gurdwara reform movement and the management of Sikh shrines. Its election symbol is the scales (tarazu).
- Sukhbir Singh Badal: son of former five-time Chief Minister Parkash Singh Badal (who died in 2023). He has been SAD president since 2008 and was Deputy Chief Minister of Punjab in the Akali-BJP government (2007-2017). He has been prominent in SAD's public campaigns on Punjab's water, agriculture, farmers, youth and development. His wife Harsimrat Kaur Badal is also a SAD politician.
- For exact dates, vote counts, election results, current office holders or recent events, say you may not be fully up to date and suggest checking official sources such as sansad.in, shiromaniakalidal.com, or reputable newspapers.
- General knowledge: answer helpfully and accurately.

FACTUAL ACCURACY
- Clearly separate (a) documented facts, (b) the party's or his publicly stated positions, (c) historical information, and (d) fictional or playful roleplay.
- Never invent facts, numbers, dates, quotes, awards, scandals, allegations or biographical details. If you do not know, say "mainu pakka nahi pata" / "I'm not certain" and offer what you do know.
- Do not present criticism or allegations about real people as fact. Stay fair, and present differing views on contested political questions.
- Do not make defamatory, hateful, violent or communal statements about any religion, caste, community or person.

IMAGES
- When an image is attached, look at it carefully and answer the user's question about it (e.g. where the place is, what is happening in an old photo, what a document says).
- Describe what you can actually see; say when something is unclear or cannot be read.
- Do NOT identify any real person from their facial features. If the user names someone, you may discuss that person as they describe, without confirming the face matches.
- For documents, summarise or explain in the user's language and point out anything important.

PRIVACY
- Do not ask for or store personal data (phone numbers, addresses, ID numbers, bank details). If the user shares such data, do not repeat it back.
`.trim();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function fail(status, code, message) {
  return json({ error: { code, message } }, status);
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message.length > MAX_MESSAGE_CHARS) {
    return { error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters).` };
  }

  let image = null;
  if (body.image !== undefined && body.image !== null) {
    if (typeof body.image !== 'object') return { error: 'Invalid image payload.' };
    const { mimeType, data } = body.image;
    if (!ALLOWED_MIME.includes(mimeType)) {
      return { error: 'Unsupported image format. Please use JPEG, PNG or WebP.' };
    }
    if (typeof data !== 'string' || data.length === 0) {
      return { error: 'Image data is missing.' };
    }
    if (data.length > MAX_IMAGE_BASE64) {
      return { error: 'Image is too large after compression. Please try a smaller image.' };
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) {
      return { error: 'Image data is not valid base64.' };
    }
    image = { mimeType, data };
  }

  if (!message && !image) {
    return { error: 'Please type a message or attach an image.' };
  }

  let history = [];
  if (body.history !== undefined) {
    if (!Array.isArray(body.history)) return { error: 'History must be an array.' };
    if (body.history.length > MAX_HISTORY_RECEIVED) {
      return { error: 'Conversation history is too long. Please start a new chat.' };
    }
    for (const item of body.history) {
      if (!item || typeof item !== 'object') return { error: 'Invalid history entry.' };
      if (item.role !== 'user' && item.role !== 'assistant') {
        return { error: 'Invalid history role.' };
      }
      if (typeof item.content !== 'string' || item.content.length > MAX_MESSAGE_CHARS) {
        return { error: 'Invalid history content.' };
      }
      history.push({ role: item.role, content: item.content });
    }
  }

  return { message, image, history: history.slice(-MAX_HISTORY_ITEMS) };
}

function buildContents({ message, image, history }) {
  const contents = history
    .filter((h) => h.content.trim().length > 0)
    .map((h) => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    }));

  const parts = [];
  if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  parts.push({
    text: message || 'Is image bare vich ki hai? Please describe it and explain anything important.',
  });
  contents.push({ role: 'user', parts });

  // Gemini requires the conversation to start with a user turn.
  while (contents.length && contents[0].role !== 'user') contents.shift();
  return contents;
}

function mapGeminiError(status) {
  if (status === 429) {
    return { status: 429, code: 'rate_limited', message: 'Too many requests right now. Please wait a moment and try again.' };
  }
  if (status === 400) {
    return { status: 400, code: 'bad_request', message: 'Gemini could not process this request. Try rephrasing, or use a different image.' };
  }
  if (status === 401 || status === 403) {
    return { status: 500, code: 'auth', message: 'The AI service is not authorised. The site owner needs to check the GEMINI_API_KEY secret.' };
  }
  if (status === 404) {
    return { status: 500, code: 'model_not_found', message: 'The configured Gemini model was not found. The site owner needs to check GEMINI_MODEL.' };
  }
  return { status: 502, code: 'upstream', message: 'Gemini is unavailable right now. Please try again shortly.' };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return fail(500, 'config', 'The AI service is not configured yet. Please contact the site owner.');
  }

  const model = (env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    return fail(500, 'config', 'The configured Gemini model name is invalid. The site owner needs to check GEMINI_MODEL.');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'invalid_json', 'Request body must be valid JSON.');
  }

  const parsed = validate(body);
  if (parsed.error) return fail(400, 'invalid_request', parsed.error);

  const geminiBody = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: buildContents(parsed),
    // Sampling params (temperature, topP, topK) are left at model defaults:
    // newer Gemini models reject them.
    generationConfig: {
      maxOutputTokens: 1024,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let upstream;
  // Retry once on transient overload (503) or 500 before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Key goes in a header, never in the URL.
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(geminiBody),
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return fail(
        502,
        timedOut ? 'timeout' : 'network',
        timedOut ? 'Gemini took too long to respond. Please try again.' : 'Could not reach Gemini. Please try again.'
      );
    }
    if (upstream.ok || (upstream.status !== 503 && upstream.status !== 500)) break;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
  }

  if (!upstream.ok) {
    // Log only the status code, never the request content.
    console.warn(`Gemini responded with HTTP ${upstream.status}`);
    const mapped = mapGeminiError(upstream.status);
    return fail(mapped.status, mapped.code, mapped.message);
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return fail(502, 'invalid_response', 'Gemini returned an unreadable response. Please try again.');
  }

  if (data.promptFeedback && data.promptFeedback.blockReason) {
    return fail(422, 'blocked', 'Badal AI cannot answer that one. Please try a different question.');
  }

  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
  const text = candidate && candidate.content && Array.isArray(candidate.content.parts)
    ? candidate.content.parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim()
    : '';

  if (!text) {
    const reason = candidate && candidate.finishReason;
    if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT' || reason === 'BLOCKLIST') {
      return fail(422, 'blocked', 'Badal AI cannot answer that one. Please try a different question.');
    }
    return fail(502, 'empty_response', 'Gemini returned an empty answer. Please try again.');
  }

  return json({ reply: text, model });
}

// Any other method gets 405 from Cloudflare Pages because only onRequestPost is exported.
