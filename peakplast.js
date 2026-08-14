/**
 * پلاستیک دسته‌دار — ربات تلگرامی مدیریت مشتریان و سفارش‌ها
 * تک‌فایل Cloudflare Worker: بات تلگرام (webhook) + پنل ادمین وب + API
 *
 * Bindings required (set in Dashboard → Worker → Settings):
 *   D1 database binding:  DB
 *   Secret var:            BOT_TOKEN        (Telegram bot token from @BotFather)
 *   Secret var:            WEBHOOK_SECRET   (any random string you choose)
 *   Secret var:            ZARINPAL_MERCHANT_ID  (from your Zarinpal dashboard —
 *                            optional; without it, invoices fall back to the
 *                            static "لینک پرداخت" link set in the admin panel)
 *   Secret var:            GEMINI_API_KEYS  (from Google AI Studio — for voice
 *                            ordering; comma-separated if you have multiple keys,
 *                            e.g. "key1,key2". Rotated automatically on quota
 *                            errors. Without it, voice ordering is unavailable
 *                            but the rest of the bot works fine.)
 *
 * One-time setup after deploying:
 *   1. Set the two secrets above in Settings → Variables and Secrets.
 *   2. Register the webhook (replace values):
 *        curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
 *          -d "url=https://<your-worker>.workers.dev/webhook" \
 *          -d "secret_token=<WEBHOOK_SECRET>"
 *   3. Visit https://<your-worker>.workers.dev/admin to set the admin password
 *      (first visit only — no env secret needed for this).
 *   4. Optional: add a Cron Trigger (Dashboard → Worker → Settings →
 *      Triggers → Cron Triggers, e.g. every 15 minutes) so stuck-'pending'
 *      Zarinpal payments get silently reconciled even if a customer never
 *      made it back to the /payment/verify redirect. Skip this if you're
 *      not using ZARINPAL_MERCHANT_ID.
 *
 * Schema is created automatically on first request (CREATE TABLE IF NOT EXISTS),
 * no separate SQL step needed.
 */

// ---------------------------------------------------------------------------
// Constants — extracted to src/constants.js (modularization step 1, see
// PLAN.md). Imported here for backward compatibility during the incremental
// split; call sites throughout this file are unchanged.
// ---------------------------------------------------------------------------

import {
  BUSINESS_TYPES,
  SIZES,
  PRESET_WEIGHTS,
  PAGE_SIZE,
  SESSION_TTL_MS,
  TG_STATE_TTL_MS,
  GEMINI_MODELS,
  ADMIN_LOGIN_MAX_ATTEMPTS,
  ADMIN_LOGIN_BASE_LOCKOUT_MS,
  ADMIN_LOGIN_MAX_LOCKOUT_MS,
  ADDRESS_SIMILARITY_THRESHOLD,
  CHAT_LOCK_TTL_MS,
  CHAT_LOCK_POLL_MS,
  CHAT_LOCK_MAX_WAIT_MS,
  VOICE_FLOOD_WINDOW_MS,
  VOICE_FLOOD_MAX,
  ZARINPAL_REQUEST_URL,
  ZARINPAL_VERIFY_URL,
  ZARINPAL_STARTPAY_URL,
} from './src/constants.js';

// ---------------------------------------------------------------------------
// Voice ordering (Gemini) — transcription + structured extraction, tested
// separately via test-voice-order.js before being wired in here. Requires
// secret var GEMINI_API_KEYS (from Google AI Studio) — comma-separated if
// you have more than one, e.g. "key1,key2,key3". A single GEMINI_API_KEY
// still works too. Keys are tried in order and automatically rotated past
// on quota/rate-limit errors (429 / RESOURCE_EXHAUSTED).
// ---------------------------------------------------------------------------

// GEMINI_MODELS — see src/constants.js for the model list and the 404-
// fallback rationale (moved there in modularization step 1).

// Reads one or more Gemini API keys from secrets so a quota-exhausted key
// automatically falls over to the next one. GEMINI_API_KEYS is a
// comma-separated list (preferred); GEMINI_API_KEY (single key) is still
// supported for backward compatibility with existing deployments.
function getGeminiApiKeys(env) {
  const raw = env.GEMINI_API_KEYS || env.GEMINI_API_KEY || '';
  return String(raw)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

// area is the runtime-editable 'delivery_areas' setting, not a hardcoded
// constant, so — same reasoning as buildAdminRegVoiceSchema — this has to
// be rebuilt per-request with whatever's currently configured. The area
// property is omitted entirely when no areas are set up yet, rather than
// shipping an enum of [].
function buildVoiceOrderSchema(areas) {
  const schema = {
    type: 'object',
    properties: {
      transcript: { type: 'string' },
      understood: { type: 'boolean' },
      items: {
        type: 'array',
        nullable: true,
        items: {
          type: 'object',
          properties: {
            size: { type: 'integer' },
            weight_kg: { type: 'number' },
          },
          required: ['size', 'weight_kg'],
        },
      },
      size: { type: 'integer', nullable: true },
      weight_kg: { type: 'number', nullable: true },
      address: { type: 'string', nullable: true },
      clarification_needed: { type: 'string', nullable: true },
    },
    required: ['transcript', 'understood', 'items', 'size', 'weight_kg', 'address', 'clarification_needed'],
  };
  if (areas.length) {
    schema.properties.area = { type: 'string', nullable: true, enum: [...areas, null] };
    schema.required.push('area');
  }
  return schema;
}

function buildVoiceOrderSystemPrompt(areas) {
  const areaInstruction = areas.length
    ? `9. منطقه تحویل: اگر مشتری منطقه/محله تحویل را گفت، آن را دقیقاً با یکی از این مقادیر مطابقت دهید و
   در area بگذارید: ${areas.map((a) => `"${a}"`).join('، ')}. این یک فیلد جدا از address است — اگر با
   هیچ‌کدام از این موارد مطابقت نداشت یا نامشخص بود، حدس نزنید — null بگذارید.\n`
    : '';
  return `
شما دستیار پردازش سفارش برای یک فروشگاه پلاستیک دسته‌دار هستید. مشتری معمولاً سفارش را طی چند پیام صوتی
جداگانه کامل می‌کند (نه لزوماً در یک پیام)، و ممکن است بیش از یک سایز در همان سفارش بخواهد (مثلاً سایز ۳
ده کیلو و سایز ۵ هفت کیلو).
وظیفه شما برای هر پیام صوتی، مستقل از پیام‌های قبلی:
1. ترنسکریپت دقیق و کامل صدا را در فیلد transcript بنویسید (حتی اگر لهجه یا نویز داشته باشد).
2. اگر این پیام یک یا چند جفتِ کامل «سایز + وزن» را با هم مشخص کرده (مثلاً «سایز ۳ ده کیلو و سایز ۵ هفت
   کیلو»، یا حتی فقط یک جفت کامل مثل «سایز ۳ ده کیلو»)، همه‌ی این جفت‌ها را در آرایه items برگردانید و
   فیلدهای size/weight_kg را null بگذارید.
3. اگر پیام فقط بخشی از یک قلم را دارد (فقط سایز بدون وزن، یا فقط وزن بدون سایز)، آن مقدار را در فیلدهای
   size/weight_kg مجزا برگردانید (نه در items) و items را null بگذارید — این یعنی جزئی از یک قلم در حال
   تکمیل است، نه یک قلم مستقل و کامل.
4. اگر آدرسی گفته شده، آن را هم در address استخراج کنید.
5. اگر پیام فقط سایز/وزن/آدرس را شامل شود، بقیه فیلدها را null بگذارید — این طبیعی است، حدس نزنید.
6. اگر مشتری مقدار سایزی که قبلاً گفته را تصحیح یا با تاکید تکرار می‌کند (مثلاً «سایز ۳ گفتم که»، «نه ۵
   کیلو برای سایز ۳»)، مقدار جدید را همان‌طور که در بند ۲ یا ۳ گفته شد برگردانید — این مقدار قبلیِ همان
   سایز را جایگزین می‌کند، نه یک قلم اضافه.
7. اگر چیزی مبهم یا نامرتبط است، حدس نزنید — understood را false بگذارید و در clarification_needed
   یک سوال کوتاه و مودبانه به فارسی بنویسید.
8. هرگز مقداری را که مشتری در همین پیام نگفته حدس نزنید یا پیش‌فرض نگذارید.
${areaInstruction}فقط طبق schema داده‌شده پاسخ دهید.
`.trim();
}

// Builds a short "here's what we already know" note to prepend to the user
// turn when a customer is mid-way through a multi-voice-message order. This
// is what lets Gemini tell a bare "سایز ۳" apart as a correction to a prior
// value instead of an unrelated fragment — passed fresh on every request
// since the API itself is stateless (there's no session to carry this).
function describeKnownSoFar(known) {
  const hasItems = known && known.items && known.items.length;
  if (!known || (!hasItems && known.size == null && known.weight_kg == null && !known.address && !known.area)) return '';
  const itemsDesc = hasItems
    ? known.items.map((it) => `سایز ${it.size}=${it.weight_kg} کیلوگرم`).join('، ')
    : 'هیچ';
  return (
    `اقلامِ تاییدشده‌ی این سفارش تاکنون: ${itemsDesc}. ` +
    `علاوه بر این، بخشِ در حال تکمیل (هنوز کامل نشده): سایز=${known.size != null ? known.size : 'نامشخص'}، ` +
    `وزن=${known.weight_kg != null ? known.weight_kg + ' کیلوگرم' : 'نامشخص'}، ` +
    `آدرس=${known.address ? known.address : 'نامشخص'}، منطقه=${known.area ? known.area : 'نامشخص'}. ` +
    `این پیام صوتی جدید را طبق دستورالعمل پردازش کن؛ اگر سایز جدیدی (که در اقلام تاییدشده نیست) با وزنش گفت ` +
    `آن را در items برگردان؛ اگر مقدار سایز/وزنِ در حال تکمیل را تصحیح یا تکمیل کرد، در فیلدهای size/weight_kg ` +
    `مجزا برگردان؛ اگر مقدار یکی از سایزهای تاییدشده را تصحیح کرد، آن را هم به‌صورت یک جفت در items برگردان.`
  );
}

// Downloads a Telegram voice note by file_id and sends it to Gemini for
// transcription + structured extraction. Throws on network/API failure —
// callers must catch and show the customer a generic retry message rather
// than letting a raw error leak through.
//
// `knownSoFar` (optional) is { size, weight_kg, address } representing
// whatever this order already has from earlier voice messages in the same
// chain — it's injected into the prompt as plain text so Gemini can tell a
// correction ("سایز ۳ گفتم که") apart from a fresh, unrelated fragment. Note
// this is just prompt content, not a stored session: the API call itself
// stays fully stateless, which is exactly what makes multi-key rotation
// below safe — there's nothing tied to a particular key that could be lost.
// ---------------------------------------------------------------------------
// arrayBufferToBase64 — the actual cause of the "پردازش پیام صوتی با خطا
// مواجه شد" instant-failure reports (2026-07-11 and again 2026-07-12,
// confirmed via Workers Logs: "RangeError: Maximum call stack size exceeded"
// thrown synchronously, no network delay). The previous one-liner —
// btoa(String.fromCharCode(...new Uint8Array(buffer))) — spreads every
// single byte of the audio file as an individual function argument.  JS
// engines cap how many arguments a function call can take (commonly ~65,536)
// regardless of available memory, so any voice note whose audio buffer
// exceeds that (a completely normal size for more than a few seconds of
// speech — the failing message here was 260,432 bytes) blows the call stack
// before any Telegram/Gemini network call even happens. Converting in fixed-
// size chunks avoids ever spreading more args than the engine allows.
// ---------------------------------------------------------------------------
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Shared by transcribeVoiceOrder and transcribeAdminRegVoice. Tries each
// model in GEMINI_MODELS in order; within each model, tries each API key in
// order (existing quota-rotation behavior). Falls through to the next MODEL
// on a 404/NOT_FOUND (model retired or unavailable) as well as on quota
// errors — previously a 404 threw immediately with no fallback at all,
// which is exactly what took voice ordering down when Google retired
// gemini-2.5-flash early. A genuinely bad request (400) still throws right
// away, since that would fail identically on every model/key.
async function callGeminiWithFallback(env, requestBody) {
  const apiKeys = getGeminiApiKeys(env);
  if (!apiKeys.length) throw new Error('هیچ GEMINI_API_KEY/GEMINI_API_KEYS تنظیم نشده است');

  let lastError;
  for (const model of GEMINI_MODELS) {
    for (const key of apiKeys) {
      let geminiRes;
      try {
        geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBody }
        );
      } catch (e) {
        lastError = e;
        continue; // network hiccup on this key's request — try the next key
      }

      if (geminiRes.ok) {
        const geminiJson = await geminiRes.json();
        const textPart = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textPart) throw new Error('پاسخ Gemini بدون متن بود');
        return JSON.parse(textPart);
      }

      const bodyText = await geminiRes.text();
      lastError = new Error(`Gemini API error ${geminiRes.status} (model ${model}): ${bodyText}`);

      const isQuotaError = geminiRes.status === 429 || /RESOURCE_EXHAUSTED/i.test(bodyText);
      const isModelUnavailable = geminiRes.status === 404 || /NOT_FOUND/i.test(bodyText);
      if (isQuotaError) continue; // try the next key on the same model
      if (isModelUnavailable) break; // stop trying keys on this model, move to the next model
      throw lastError; // genuinely bad request — retrying won't help
    }
    // loop continues to the next model in GEMINI_MODELS
  }

  throw lastError || new Error('همه‌ی مدل‌ها و Gemini API keyها با خطا مواجه شدند');
}

async function transcribeVoiceOrder(env, fileId, knownSoFar) {
  const fileInfoRes = await tgApi(env, 'getFile', { file_id: fileId });
  const fileInfo = await fileInfoRes.json();
  const filePath = fileInfo?.result?.file_path;
  if (!filePath) throw new Error('تلگرام مسیر فایل صوتی را برنگرداند');

  const audioRes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`);
  if (!audioRes.ok) throw new Error('دانلود فایل صوتی از تلگرام ناموفق بود');
  const audioBuffer = await audioRes.arrayBuffer();
  const audioBase64 = arrayBufferToBase64(audioBuffer);

  const areas = await getDeliveryAreas(env);
  const contextNote = describeKnownSoFar(knownSoFar);
  const promptText = contextNote
    ? `${contextNote}`
    : 'این پیام صوتی مشتری را طبق دستورالعمل پردازش کن.';

  const requestBody = JSON.stringify({
    system_instruction: { parts: [{ text: buildVoiceOrderSystemPrompt(areas) }] },
    contents: [
      {
        role: 'user',
        parts: [
          { text: promptText },
          { inline_data: { mime_type: 'audio/ogg', data: audioBase64 } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: buildVoiceOrderSchema(areas),
    },
  });

  return callGeminiWithFallback(env, requestBody);
}

// Guardrail: never trust the model's own field values at face value for a
// single voice message — re-check size/weight against real business
// constraints and null out anything bogus, so a garbage value from one
// utterance can never silently corrupt the order state accumulated from
// earlier utterances. Unlike the old validateVoiceExtraction, this does NOT
// require size+weight to both be present in one message — a message is now
// allowed to carry just a fragment (only size, only weight, only a
// correction, etc.), since completeness is judged against the *merged*
// order state (see voiceOrderIsComplete), not any single utterance.
function sanitizeVoiceExtraction(data, knownAreas = []) {
  const problems = [];

  let size = data.size;
  if (size !== null && size !== undefined) {
    if (!SIZES.includes(size)) {
      problems.push(`size=${size} خارج از سایزهای مجاز است`);
      size = null;
    }
  } else {
    size = null;
  }

  let weight_kg = data.weight_kg;
  if (weight_kg !== null && weight_kg !== undefined) {
    if (typeof weight_kg !== 'number' || !(weight_kg > 0) || weight_kg > 1000) {
      problems.push(`weight_kg=${weight_kg} مقدار منطقی نیست`);
      weight_kg = null;
    }
  } else {
    weight_kg = null;
  }

  const address = typeof data.address === 'string' && data.address.trim() ? data.address.trim() : null;

  // area: same exact-match-against-known-list rule as everywhere else
  // (sanitizeAdminRegExtraction, business_type) — an empty knownAreas
  // (feature not configured) means this always comes back null.
  let area = null;
  if (typeof data.area === 'string' && data.area.trim()) {
    const trimmed = data.area.trim();
    if (knownAreas.includes(trimmed)) {
      area = trimmed;
    } else {
      problems.push(`area="${trimmed}" با هیچ‌کدام از مناطق تعریف‌شده مطابقت ندارد`);
    }
  }

  const transcript = typeof data.transcript === 'string' ? data.transcript.trim() : '';
  if (!transcript) problems.push('transcript خالی است');

  // Same guardrail as size/weight_kg above, applied per-pair: a garbage
  // size or weight anywhere in the items array is dropped rather than
  // corrupting the whole message's extraction.
  const items = [];
  if (Array.isArray(data.items)) {
    for (const raw of data.items) {
      const s = raw && raw.size;
      const w = raw && raw.weight_kg;
      if (!SIZES.includes(s)) {
        problems.push(`size=${s} در items خارج از سایزهای مجاز است`);
        continue;
      }
      if (typeof w !== 'number' || !(w > 0) || w > 1000) {
        problems.push(`weight_kg=${w} در items مقدار منطقی نیست`);
        continue;
      }
      items.push({ size: s, weight_kg: w });
    }
  }

  return {
    size,
    weight_kg,
    items,
    address,
    area,
    transcript,
    clarification_needed: data.clarification_needed || null,
    problems,
  };
}

// Merges one confirmed {size, weight_kg} pair into an items[] list —
// replacing the weight if that size is already present (treated as a
// correction, per the agreed "replace on repeat" default) rather than
// stacking a second row for the same size.
function mergeItemIntoList(items, item) {
  const idx = items.findIndex((it) => it.size === item.size);
  if (idx === -1) return [...items, item];
  const copy = [...items];
  copy[idx] = item;
  return copy;
}

// A multi-item order accumulates confirmed {size, weight_kg} pairs in
// state.items[]. state.pending_size/pending_weight represent ONLY the one
// item currently in progress (a lone size or lone weight not yet paired) —
// the instant both halves of a pending pair are known, they're folded into
// items[] and pending_size/pending_weight are cleared. This mirrors the
// button-driven flow (see wkg:confirm below), where the same fold happens
// on every "✅ تایید و ثبت" tap.
function foldPendingItem(state) {
  if (state.pending_size != null && state.pending_weight > 0) {
    return {
      ...state,
      items: mergeItemIntoList(state.items || [], { size: state.pending_size, weight_kg: state.pending_weight }),
      pending_size: null,
      pending_weight: null,
      pending_history: [],
    };
  }
  return state;
}

// Merges one sanitized voice-message extraction into the order's
// accumulated state. Any complete pairs in clean.items are folded straight
// into state.items[] (replacing on a repeated size, per mergeItemIntoList).
// A non-null clean.size/weight_kg always overwrites the previous pending
// value — this is what makes a correction like "سایز ۳ گفتم که" work — and
// once that pending pair is itself complete, it's folded into items[] too.
function mergeVoicePending(state, clean) {
  let items = state.items || [];
  for (const it of clean.items || []) {
    items = mergeItemIntoList(items, it);
  }

  const merged = {
    ...state,
    items,
    pending_size: clean.size != null ? clean.size : (state.pending_size ?? null),
    pending_weight: clean.weight_kg != null ? clean.weight_kg : (state.pending_weight ?? null),
    address: clean.address != null ? clean.address : (state.address ?? null),
    area: clean.area != null ? clean.area : (state.area ?? null),
  };

  return foldPendingItem(merged);
}

function voiceOrderIsComplete(state) {
  return (
    (state.items || []).length > 0 &&
    (Boolean(state.address) || state.address_id != null)
  );
}

// ---------------------------------------------------------------------------
// Admin voice-driven registration (implemented 2026-07-11, per the plan
// discussed the same day) — lets an admin fill the hub-and-spoke
// registration screen (name/phone/address/items) via voice instead of
// typing every field, while the hub screen itself stays the only place
// values are reviewed or corrected (no separate per-field confirm step —
// re-rendering the hub after each voice message IS the confirmation UI).
//
// DECISION (2026-07-11): this is a ONE-SHOT FILL, never a voice-driven
// correction. If a name/phone/address extraction is vague, low-confidence,
// or likely misheard, it is left null rather than guessed, and the field
// stays whatever it already was (blank, or previously set) for the admin
// to fill in or fix by tapping it on the hub screen. Concretely: merge
// logic below only ever writes a hub field when it is CURRENTLY EMPTY —
// an already-set first_name/phone_number/address is never overwritten by
// a later voice message, by design.
//
// Routing: gated to state.hub_mode && state.origin === 'admin_add' &&
// state.step === 'hub' in the voice message handler — the same privacy
// boundary already drawn around the admin-only address-search/duplicate-
// catch features, so self-registering customers never get this path, and
// a voice message sent while some OTHER hub sub-step is open (name/phone/
// address/business_type/size_select/etc.) still gets the ordinary "finish
// this step first" treatment rather than being silently reinterpreted.
// ---------------------------------------------------------------------------

// business_type's enum is a hardcoded constant (BUSINESS_TYPES), but the
// area list is the runtime-editable 'delivery_areas' setting — so unlike
// the schema above, this one has to be rebuilt per-request with whatever
// areas are currently configured. An empty areas list (feature not set up
// yet) omits the area property entirely rather than shipping an enum of [].
function buildAdminRegVoiceSchema(areas) {
  const schema = {
    type: 'object',
    properties: {
      transcript: { type: 'string' },
      understood: { type: 'boolean' },
      first_name: { type: 'string', nullable: true },
      last_name: { type: 'string', nullable: true },
      phone_number: { type: 'string', nullable: true },
      shop_name: { type: 'string', nullable: true },
      business_type: { type: 'string', nullable: true, enum: [...BUSINESS_TYPES, null] },
      items: {
        type: 'array',
        nullable: true,
        items: {
          type: 'object',
          properties: {
            size: { type: 'integer' },
            weight_kg: { type: 'number' },
          },
          required: ['size', 'weight_kg'],
        },
      },
      size: { type: 'integer', nullable: true },
      weight_kg: { type: 'number', nullable: true },
      address: { type: 'string', nullable: true },
      clarification_needed: { type: 'string', nullable: true },
    },
    required: [
      'transcript',
      'understood',
      'first_name',
      'last_name',
      'phone_number',
      'shop_name',
      'business_type',
      'items',
      'size',
      'weight_kg',
      'address',
      'clarification_needed',
    ],
  };
  if (areas.length) {
    schema.properties.area = { type: 'string', nullable: true, enum: [...areas, null] };
    schema.required.push('area');
  }
  return schema;
}

function buildAdminRegVoiceSystemPrompt(areas) {
  const areaInstruction = areas.length
    ? `9. منطقه تحویل: اگر ادمین منطقه/محله تحویل را گفت، آن را دقیقاً با یکی از این مقادیر مطابقت دهید و در
   area بگذارید: ${areas.map((a) => `"${a}"`).join('، ')}. این یک فیلد جدا از address است — اگر با هیچ‌کدام
   از این موارد مطابقت نداشت یا نامشخص بود، حدس نزنید — null بگذارید.\n`
    : '';
  return `
شما دستیار ثبت‌نام صوتی برای ادمین یک فروشگاه پلاستیک دسته‌دار هستید. ادمین با صدای خودش مشخصات یک
مشتری جدید (نام، شماره تماس، صنف/نوع کسب‌وکار، آدرس) و اقلام سفارش (سایز و وزن) را اعلام می‌کند —
احتمالاً طی چند پیام صوتی جداگانه، نه لزوماً در یک پیام.
وظیفه شما برای هر پیام صوتی، مستقل از پیام‌های قبلی:
1. ترنسکریپت دقیق و کامل صدا را در فیلد transcript بنویسید.
2. نام: first_name و last_name کاملاً مستقل از هم هستند — هرکدام را جداگانه فقط اگر با اطمینان بالا و
   واضح شنیده شد پر کنید، حتی اگر دیگری شنیده نشد. مثلاً «خانوم ابراهیمی» یعنی فقط نام‌خانوادگی گفته شده
   (last_name="ابراهیمی")؛ در این حالت first_name را null بگذارید ولی last_name را حتماً پر کنید — کل نام
   را null نگذارید فقط به این دلیل که نام کوچک گفته نشده. اگر یک فیلد نامفهوم، نویزدار یا مبهم بود، فقط
   همان فیلد را null بگذارید — حدس نزنید. ادمین می‌تواند بعداً از صفحه ثبت‌نام با دست تایپ کند.
3. شماره تماس: فقط اگر تمام ارقام آن با اطمینان کامل شنیده شد، آن را در phone_number بگذارید (فقط ارقام،
   بدون فاصله یا خط‌تیره)؛ یک رقم اشتباه در شماره تماس مشکل‌ساز است، پس در صورت کوچک‌ترین تردید null
   بگذارید.
4. صنف/نوع کسب‌وکار: اگر ادمین نوع کسب‌وکار مشتری را گفت، آن را دقیقاً با یکی از این مقادیر مطابقت
   دهید و در business_type بگذارید: "سوپرمارکت"، "میوه و تره‌بار"، "آرایشی بهداشتی"، "عمده‌فروشی"،
   "سایر". مثلاً «سوپرمارکت» یا «سوپر مارکت» یعنی business_type="سوپرمارکت". این یک فیلد کاملاً جدا از
   address است — نوع مغازه را هرگز داخل متن address قرار ندهید، حتی اگر در همان جمله با آدرس گفته شده
   باشد. اگر با هیچ‌کدام از این ۵ مورد مطابقت نداشت یا نامشخص بود، سایر را انتخاب نکنید — null بگذارید و
   بگذارید ادمین از دکمه‌ها انتخاب کند.
4b. نام مغازه: اگر ادمین اسم خاص مغازه را هم گفت (مثلاً «سوپرمارکت فجر» یا «آرایشی گلستان»)، آن اسم خاص
   («فجر»، «گلستان») را در shop_name بگذارید — این جدا از business_type است و آن را جایگزین نمی‌کند؛ هر
   دو را با هم پر کنید. shop_name را با نام یا نام‌خانوادگی مشتری (first_name/last_name) اشتباه نگیرید —
   shop_name اسمِ مغازه است، نه اسمِ شخص. اگر فقط نوع کسب‌وکار گفته شد بدون اسم خاص (مثلاً فقط «سوپرمارکت»)،
   shop_name را null بگذارید.
5. آدرس: فقط خودِ آدرس (خیابان/محله/پلاک/نشانی جغرافیایی) را در address بگذارید؛ نام یا نوع مغازه را
   شامل نشود (طبق بند ۴ و ۴b). فقط اگر با اطمینان مناسب گفته شد، آن را در address بگذارید؛ در غیر این
   صورت null بگذارید.
6. اقلام سفارش: دقیقاً طبق همان قوانین سفارش صوتی مشتری عمل کنید — جفت‌های کامل «سایز+وزن» را در items
   برگردانید، و یک قطعه ناقص (فقط سایز یا فقط وزن) را در فیلدهای size/weight_kg مجزا برگردانید (نه در
   items).
7. اگر چیزی مبهم است، همان فیلد را null بگذارید — حدس نزدن مهم‌تر از پر کردن همه فیلدهاست. لازم نیست
   understood را false کنید مگر کل پیام نامفهوم باشد.
8. هرگز مقداری را که ادمین در همین پیام نگفته حدس نزنید یا پیش‌فرض نگذارید.
${areaInstruction}فقط طبق schema داده‌شده پاسخ دهید.
`.trim();
}

// Same "here's what we already know" pattern as describeKnownSoFar (for
// customer voice orders), adapted for the hub's wider set of fields —
// lets Gemini avoid re-asking for something already confirmed while still
// only filling in fields the admin actually spoke this turn.
function describeKnownSoFarAdminReg(state) {
  const hasItems = state.items && state.items.length;
  const nameKnown = state.first_name
    ? [state.first_name, state.last_name].filter(Boolean).join(' ')
    : null;
  if (
    !hasItems &&
    state.pending_size == null &&
    state.pending_weight == null &&
    !state.address &&
    !nameKnown &&
    !state.phone_number &&
    !state.shop_name &&
    !state.business_type
  ) {
    return '';
  }
  const itemsDesc = hasItems
    ? state.items.map((it) => `سایز ${it.size}=${it.weight_kg} کیلوگرم`).join('، ')
    : 'هیچ';
  return (
    `اطلاعات تاییدشده‌ی این ثبت‌نام تاکنون: نام=${nameKnown || 'نامشخص'}، تلفن=${state.phone_number || 'نامشخص'}، ` +
    `نام مغازه=${state.shop_name || 'نامشخص'}، صنف=${state.business_type || 'نامشخص'}، آدرس=${state.address || 'نامشخص'}، اقلام سفارش=${itemsDesc}. ` +
    `بخشِ در حال تکمیل (هنوز کامل نشده): سایز=${state.pending_size != null ? state.pending_size : 'نامشخص'}، ` +
    `وزن=${state.pending_weight != null ? state.pending_weight + ' کیلوگرم' : 'نامشخص'}. ` +
    `این پیام صوتی جدید را طبق دستورالعمل پردازش کن — فقط فیلدهایی که هنوز نامشخص است یا این پیام صریحاً ` +
    `دوباره گفته را پر کن؛ چیزی را که این پیام نگفته حدس نزن یا از اطلاعات بالا کپی نکن.`
  );
}

// Downloads + transcribes exactly like transcribeVoiceOrder above, but with
// the admin-registration schema/prompt. Kept as a separate self-contained
// function (rather than a shared parameterized helper) to avoid any risk of
// touching the already-reviewed customer voice-order path.
async function transcribeAdminRegVoice(env, fileId, knownSoFarState) {
  const fileInfoRes = await tgApi(env, 'getFile', { file_id: fileId });
  const fileInfo = await fileInfoRes.json();
  const filePath = fileInfo?.result?.file_path;
  if (!filePath) throw new Error('تلگرام مسیر فایل صوتی را برنگرداند');

  const audioRes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`);
  if (!audioRes.ok) throw new Error('دانلود فایل صوتی از تلگرام ناموفق بود');
  const audioBuffer = await audioRes.arrayBuffer();
  const audioBase64 = arrayBufferToBase64(audioBuffer);

  const areas = await getDeliveryAreas(env);
  const contextNote = describeKnownSoFarAdminReg(knownSoFarState);
  const promptText = contextNote
    ? contextNote
    : 'این پیام صوتی ادمین را طبق دستورالعمل پردازش کن.';

  const requestBody = JSON.stringify({
    system_instruction: { parts: [{ text: buildAdminRegVoiceSystemPrompt(areas) }] },
    contents: [
      {
        role: 'user',
        parts: [
          { text: promptText },
          { inline_data: { mime_type: 'audio/ogg', data: audioBase64 } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: buildAdminRegVoiceSchema(areas),
    },
  });

  return callGeminiWithFallback(env, requestBody);
}

// Same guardrail philosophy as sanitizeVoiceExtraction, extended with
// name/phone validation. Per the one-shot-fill decision above, anything
// that doesn't clear a conservative bar is dropped to null here rather than
// passed through — this is the actual enforcement point for "leave vague/
// misheard fields for the admin to fill via the hub".
function sanitizeAdminRegExtraction(data, knownAreas = []) {
  const problems = [];

  let size = data.size;
  if (size !== null && size !== undefined) {
    if (!SIZES.includes(size)) {
      problems.push(`size=${size} خارج از سایزهای مجاز است`);
      size = null;
    }
  } else {
    size = null;
  }

  let weight_kg = data.weight_kg;
  if (weight_kg !== null && weight_kg !== undefined) {
    if (typeof weight_kg !== 'number' || !(weight_kg > 0) || weight_kg > 1000) {
      problems.push(`weight_kg=${weight_kg} مقدار منطقی نیست`);
      weight_kg = null;
    }
  } else {
    weight_kg = null;
  }

  const items = [];
  if (Array.isArray(data.items)) {
    for (const raw of data.items) {
      const s = raw && raw.size;
      const w = raw && raw.weight_kg;
      if (!SIZES.includes(s)) {
        problems.push(`size=${s} در items خارج از سایزهای مجاز است`);
        continue;
      }
      if (typeof w !== 'number' || !(w > 0) || w > 1000) {
        problems.push(`weight_kg=${w} در items مقدار منطقی نیست`);
        continue;
      }
      items.push({ size: s, weight_kg: w });
    }
  }

  const address = typeof data.address === 'string' && data.address.trim() ? data.address.trim() : null;

  // business_type must be an exact match against the fixed list used
  // everywhere else in the app (hub buttons, admin panel filter, etc.) — if
  // Gemini returns anything else (typo, synonym it wasn't supposed to
  // invent, etc.) drop it to null rather than writing an inconsistent value
  // into customers.business_type.
  let business_type = null;
  if (typeof data.business_type === 'string' && data.business_type.trim()) {
    const trimmed = data.business_type.trim();
    if (BUSINESS_TYPES.includes(trimmed)) {
      business_type = trimmed;
    } else {
      problems.push(`business_type="${trimmed}" با هیچ‌کدام از صنف‌های مجاز مطابقت ندارد`);
    }
  }

  // area: same exact-match-against-known-list rule as business_type, except
  // the list is the runtime 'delivery_areas' setting (knownAreas) rather
  // than a hardcoded constant — an empty knownAreas (feature not configured
  // yet) means area is always dropped to null here, never guessed.
  let area = null;
  if (typeof data.area === 'string' && data.area.trim()) {
    const trimmed = data.area.trim();
    if (knownAreas.includes(trimmed)) {
      area = trimmed;
    } else {
      problems.push(`area="${trimmed}" با هیچ‌کدام از مناطق تعریف‌شده مطابقت ندارد`);
    }
  }

  // Conservative phone check: strip everything but digits and require a
  // plausible complete-number length. There is no phone validator anywhere
  // else in the codebase (typed entry is trusted as free text as-is) — this
  // one exists purely to gate what the noisier voice channel is allowed to
  // auto-fill; anything outside this range is dropped to null rather than
  // guessed at or truncated.
  let phone_number = null;
  if (typeof data.phone_number === 'string') {
    const digitsOnly = data.phone_number.replace(/[^\d]/g, '');
    if (digitsOnly.length >= 10 && digitsOnly.length <= 13) {
      phone_number = digitsOnly;
    } else if (digitsOnly) {
      problems.push(`phone_number="${data.phone_number}" طول معتبر ندارد`);
    }
  }

  const first_name = typeof data.first_name === 'string' && data.first_name.trim() ? data.first_name.trim() : null;
  const last_name = typeof data.last_name === 'string' && data.last_name.trim() ? data.last_name.trim() : null;

  // shop_name: free text like first_name/last_name (no fixed list to match
  // against, unlike business_type) — the store's own name, e.g. "فجر" in
  // "سوپرمارکت فجر". Kept fully separate from business_type so a specific
  // shop name no longer gets silently folded into just its category.
  const shop_name = typeof data.shop_name === 'string' && data.shop_name.trim() ? data.shop_name.trim() : null;

  const transcript = typeof data.transcript === 'string' ? data.transcript.trim() : '';
  if (!transcript) problems.push('transcript خالی است');

  return {
    size,
    weight_kg,
    items,
    address,
    phone_number,
    first_name,
    last_name,
    shop_name,
    business_type,
    area,
    transcript,
    clarification_needed: data.clarification_needed || null,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Schema (auto-init, idempotent)
// ---------------------------------------------------------------------------

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT DEFAULT '',
      address TEXT NOT NULL,
      business_type TEXT NOT NULL,
      telegram_chat_id TEXT,
      debt_amount REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      order_date TEXT NOT NULL DEFAULT (datetime('now')),
      payment_status TEXT NOT NULL DEFAULT 'unpaid'
    )`,
    `CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      size INTEGER NOT NULL,
      weight_kg REAL NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS admin_auth (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identifier TEXT NOT NULL UNIQUE,
      identifier_type TEXT NOT NULL CHECK (identifier_type IN ('id', 'username')),
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT
    )`,
    // Multi-address support: a customer can have several delivery addresses.
    // customers.address is kept as the "first registered address" for quick
    // display/filtering in the admin panel; per-order addressing is tracked
    // here and via orders.address_id (added below via migration).
    `CREATE TABLE IF NOT EXISTS addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      address TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // Simple key/value settings editable from the admin panel (e.g. payment_link)
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
    // Per-size unit prices (Toman per kg), editable from the admin panel.
    // Used to snapshot order_items.unit_price at order time.
    `CREATE TABLE IF NOT EXISTS size_prices (
      size INTEGER PRIMARY KEY,
      price_per_kg REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // Zarinpal payment sessions — one per invoice sent to a customer.
    // status: 'pending' (requested, not yet paid), 'paid', 'failed'.
    `CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      authority TEXT NOT NULL UNIQUE,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      ref_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      verified_at TEXT
    )`,
    // Card-to-card receipt photos submitted by customers, one row per photo.
    // Lets admins/staff double check "did the customer actually send a
    // receipt" even after the forwarded message scrolls out of view.
    `CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      file_id TEXT NOT NULL,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_customers_address ON customers(address)`,
    `CREATE INDEX IF NOT EXISTS idx_customers_telegram_chat_id ON customers(telegram_chat_id)`,
    `CREATE INDEX IF NOT EXISTS idx_customers_business_type ON customers(business_type)`,
    `CREATE INDEX IF NOT EXISTS idx_customers_payment_status ON customers(payment_status)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_addresses_customer ON addresses(customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_authority ON payments(authority)`,
    `CREATE INDEX IF NOT EXISTS idx_receipts_order ON receipts(order_id)`,
  ];
  await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));

  // Migration: orders.address_id (SQLite has no "ADD COLUMN IF NOT EXISTS",
  // so this is attempted once and any "duplicate column" error is ignored).
  try {
    await env.DB.prepare(
      `ALTER TABLE orders ADD COLUMN address_id INTEGER REFERENCES addresses(id)`
    ).run();
  } catch (e) {
    // column already exists from a previous deploy — safe to ignore;
    // anything else (bad SQL, missing table, D1 hiccup) should surface
    // rather than being silently swallowed.
    if (!/duplicate column/i.test(String(e?.message || e))) throw e;
  }

  // Migration: order_items.unit_price — snapshot of the per-kg price at the
  // moment the order was placed, so invoices stay accurate even if prices
  // in size_prices change afterwards.
  try {
    await env.DB.prepare(
      `ALTER TABLE order_items ADD COLUMN unit_price REAL NOT NULL DEFAULT 0`
    ).run();
  } catch (e) {
    // column already exists from a previous deploy — safe to ignore;
    // anything else (bad SQL, missing table, D1 hiccup) should surface
    // rather than being silently swallowed.
    if (!/duplicate column/i.test(String(e?.message || e))) throw e;
  }

  // Migration: orders.payment_method — how the customer chose to pay
  // ('gateway' / 'card' / 'cod'). Null for older orders and for
  // admin-created orders, which don't go through the selection screen.
  try {
    await env.DB.prepare(
      `ALTER TABLE orders ADD COLUMN payment_method TEXT`
    ).run();
  } catch (e) {
    // column already exists from a previous deploy — safe to ignore;
    // anything else (bad SQL, missing table, D1 hiccup) should surface
    // rather than being silently swallowed.
    if (!/duplicate column/i.test(String(e?.message || e))) throw e;
  }

  // Migration: admins.telegram_user_id — the numeric chat id backfilled the
  // first time a username-registered admin interacts with the bot. Telegram
  // only lets us proactively message a numeric chat id, never a bare
  // @username, so this is what makes notifications actually reach
  // username-registered admins.
  try {
    await env.DB.prepare(
      `ALTER TABLE admins ADD COLUMN telegram_user_id TEXT`
    ).run();
  } catch (e) {
    // column already exists from a previous deploy — safe to ignore;
    // anything else (bad SQL, missing table, D1 hiccup) should surface
    // rather than being silently swallowed.
    if (!/duplicate column/i.test(String(e?.message || e))) throw e;
  }

  // Migration: customers.phone_number — collected during registration,
  // editable afterwards from the admin panel.
  try {
    await env.DB.prepare(
      `ALTER TABLE customers ADD COLUMN phone_number TEXT`
    ).run();
  } catch (e) {
    // column already exists from a previous deploy — safe to ignore;
    // anything else (bad SQL, missing table, D1 hiccup) should surface
    // rather than being silently swallowed.
    if (!/duplicate column/i.test(String(e?.message || e))) throw e;
  }

  // Migration: admin_auth brute-force lockout tracking. /admin is a public
  // URL and PBKDF2 alone doesn't stop unlimited password guesses — these
  // columns back an escalating lockout applied in handleAdminSetupOrLogin.
  try {
    await env.DB.prepare(
      `ALTER TABLE admin_auth ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0`
    ).run();
  } catch (e) {
    // column already exists from a previous deploy — safe to ignore;
    // anything else (bad SQL, missing table, D1 hiccup) should surface
    // rather than being silently swallowed.
    if (!/duplicate column/i.test(String(e?.message || e))) throw e;
  }
  try {
    await env.DB.prepare(
      `ALTER TABLE admin_auth ADD COLUMN locked_until TEXT`
    ).run();
  } catch (e) {
    // column already exists from a previous deploy — safe to ignore;
    // anything else (bad SQL, missing table, D1 hiccup) should surface
    // rather than being silently swallowed.
    if (!/duplicate column/i.test(String(e?.message || e))) throw e;
  }

  // Migration: addresses.area — delivery zone/neighborhood, separate from
  // the free-text address itself, for dispatch grouping and admin panel
  // filtering (agreed 2026-07-12: a fixed, admin-editable list rather than
  // a mapping/geocoding API — see the 'delivery_areas' setting and
  // getDeliveryAreas below).
  try {
    await env.DB.prepare(`ALTER TABLE addresses ADD COLUMN area TEXT`).run();
  } catch (e) {
    if (!/duplicate column/i.test(String(e?.message || e))) throw e;
  }
  try {
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_addresses_area ON addresses(area)`).run();
  } catch (e) {
    if (!/duplicate column/i.test(String(e?.message || e))) throw e;
  }

  // Migration: customers.shop_name — the shop/store's own name (e.g. "فجر"
  // in "سوپرمارکت فجر"), separate from business_type (a fixed 5-value
  // category) and from first_name/last_name (the contact PERSON's name).
  // Added 2026-07-12 after admin voice registration was found to have
  // nowhere to put this: the extraction prompt folded a specific shop name
  // into just its category and silently dropped the name itself, since no
  // field existed to hold it (see buildAdminRegVoiceSystemPrompt).
  try {
    await env.DB.prepare(`ALTER TABLE customers ADD COLUMN shop_name TEXT`).run();
  } catch (e) {
    if (!/duplicate column/i.test(String(e?.message || e))) throw e;
  }

  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Admin login brute-force lockout
//
// PBKDF2 (100k iterations) + timing-safe compare is solid crypto, but
// neither one slows down an automated password-guessing script hitting the
// public /admin URL directly. This adds an escalating lockout: after
// ADMIN_LOGIN_MAX_ATTEMPTS consecutive failures, further attempts are
// rejected outright for a period that doubles with each additional failure
// past the threshold (capped), until a correct password resets the counter.
// ---------------------------------------------------------------------------
const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
const ADMIN_LOGIN_BASE_LOCKOUT_MS = 60 * 1000; // 1 minute base, doubles per extra failure
const ADMIN_LOGIN_MAX_LOCKOUT_MS = 30 * 60 * 1000; // cap at 30 minutes

function adminLockRemainingMs(authRow) {
  try {
    if (!authRow || !authRow.locked_until) return 0;
    const remaining = new Date(authRow.locked_until).getTime() - Date.now();
    return remaining > 0 ? remaining : 0;
  } catch (e) {
    // Never let a malformed/unexpected locked_until value break the whole
    // admin page — treat it as "not locked" and let the password check
    // (which is the actual security boundary) decide.
    console.error('adminLockRemainingMs failed:', e && e.stack ? e.stack : e);
    return 0;
  }
}

async function recordAdminLoginFailure(env, authRow) {
  try {
    const attempts = (authRow.failed_attempts || 0) + 1;
    let lockedUntil = null;
    if (attempts >= ADMIN_LOGIN_MAX_ATTEMPTS) {
      const lockoutMs = Math.min(
        ADMIN_LOGIN_BASE_LOCKOUT_MS * Math.pow(2, attempts - ADMIN_LOGIN_MAX_ATTEMPTS),
        ADMIN_LOGIN_MAX_LOCKOUT_MS
      );
      lockedUntil = new Date(Date.now() + lockoutMs).toISOString();
    }
    await env.DB.prepare(`UPDATE admin_auth SET failed_attempts = ?, locked_until = ? WHERE id = ?`)
      .bind(attempts, lockedUntil, authRow.id)
      .run();
  } catch (e) {
    // Failing to record a failed attempt should never crash the login
    // response itself — the user already got "wrong password" either way.
    console.error('recordAdminLoginFailure failed:', e && e.stack ? e.stack : e);
  }
}

async function resetAdminLoginFailures(env, authRow) {
  try {
    await env.DB.prepare(`UPDATE admin_auth SET failed_attempts = 0, locked_until = NULL WHERE id = ?`)
      .bind(authRow.id)
      .run();
  } catch (e) {
    console.error('resetAdminLoginFailures failed:', e && e.stack ? e.stack : e);
  }
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

// Module-scope in-memory cache for settings — best-effort only. Cloudflare
// Workers isolates are commonly reused across requests for a while, so this
// avoids re-querying D1 for the same handful of settings (business_name,
// payment_link, card_number, etc.) on every single request that needs them.
// A fresh/recycled isolate just starts with an empty cache and falls back to
// D1, so correctness never depends on this surviving. setSetting() keeps it
// consistent so an admin edit takes effect immediately, at least within the
// isolate that served the edit.
const _settingsCache = new Map();

// Batched settings lookup — fetches every key not already cached in a single
// D1 query instead of one round trip per key, then returns a { key: value }
// map. Missing keys resolve to null, same as the old getSetting() behavior.
async function getSettings(env, keys) {
  const result = {};
  const missing = [];
  for (const key of keys) {
    if (_settingsCache.has(key)) {
      result[key] = _settingsCache.get(key);
    } else {
      missing.push(key);
    }
  }
  if (missing.length) {
    const placeholders = missing.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
      .bind(...missing)
      .all();
    const found = new Map((rows.results || []).map((r) => [r.key, r.value]));
    for (const key of missing) {
      const value = found.has(key) ? found.get(key) : null;
      _settingsCache.set(key, value);
      result[key] = value;
    }
  }
  return result;
}

async function getSetting(env, key) {
  const map = await getSettings(env, [key]);
  return map[key];
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(key, value)
    .run();
  _settingsCache.set(key, value);
}

// Delivery areas/zones: unlike BUSINESS_TYPES (a fixed list baked into the
// code), the set of neighborhoods a given shop delivers to is business-
// specific and needs to be editable without a redeploy — so it's stored as
// a comma-separated 'delivery_areas' setting instead. Empty/whitespace
// entries are dropped. Returns [] (not an error) if never configured, and
// every caller (hub keyboard, voice-extraction prompt, admin filter) treats
// an empty list as "area feature not set up yet" rather than failing.
async function getDeliveryAreas(env) {
  const raw = await getSetting(env, 'delivery_areas');
  if (!raw) return [];
  return raw
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Size price helpers
// ---------------------------------------------------------------------------

async function getSizePrices(env) {
  const rows = await env.DB.prepare(`SELECT size, price_per_kg FROM size_prices`).all();
  const map = {};
  for (const s of SIZES) map[s] = 0;
  for (const row of rows.results || []) map[row.size] = row.price_per_kg;
  return map;
}

async function setSizePrice(env, size, pricePerKg) {
  await env.DB.prepare(
    `INSERT INTO size_prices (size, price_per_kg, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(size) DO UPDATE SET price_per_kg = excluded.price_per_kg, updated_at = excluded.updated_at`
  )
    .bind(size, pricePerKg)
    .run();
}

// ---------------------------------------------------------------------------
// Zarinpal payment gateway
// ---------------------------------------------------------------------------

const ZARINPAL_REQUEST_URL = 'https://payment.zarinpal.com/pg/v4/payment/request.json';
const ZARINPAL_VERIFY_URL = 'https://payment.zarinpal.com/pg/v4/payment/verify.json';
const ZARINPAL_STARTPAY_URL = 'https://payment.zarinpal.com/pg/StartPay/';

// Creates a Zarinpal payment session for an order and returns a clickable
// pay URL, or null if it couldn't be created (missing merchant id, amount
// too small, network/API error). Never throws — callers should treat a
// null return as "fall back to no payment link".
async function createZarinpalPaymentLink(env, { orderId, amount, description, callbackUrl }) {
  if (!env.ZARINPAL_MERCHANT_ID) return null;
  const roundedAmount = Math.round(amount);
  if (roundedAmount < 100) return null; // Zarinpal's minimum is 100 Toman

  let data;
  try {
    const res = await fetch(ZARINPAL_REQUEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        merchant_id: env.ZARINPAL_MERCHANT_ID,
        amount: roundedAmount,
        currency: 'IRT', // Toman
        callback_url: callbackUrl,
        description,
      }),
    });
    data = await res.json();
  } catch (e) {
    return null;
  }

  const authority = data && data.data && data.data.authority;
  const code = data && data.data && data.data.code;
  if (code !== 100 || !authority) return null;

  await env.DB.prepare(
    `INSERT INTO payments (order_id, authority, amount, status) VALUES (?, ?, ?, 'pending')`
  )
    .bind(orderId, authority, roundedAmount)
    .run();

  return ZARINPAL_STARTPAY_URL + authority;
}

// Verifies a Zarinpal transaction after the user returns from the gateway.
// Returns { ok: true, refId } on a confirmed payment, or { ok: false, reason }.
async function verifyZarinpalPayment(env, { authority, amount }) {
  let data;
  try {
    const res = await fetch(ZARINPAL_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        merchant_id: env.ZARINPAL_MERCHANT_ID,
        amount: Math.round(amount),
        authority,
      }),
    });
    data = await res.json();
  } catch (e) {
    return { ok: false, reason: 'network' };
  }
  const code = data && data.data && data.data.code;
  // 100 = freshly verified, 101 = already verified previously — both are a success.
  if (code === 100 || code === 101) {
    return { ok: true, refId: data.data.ref_id };
  }
  return { ok: false, reason: (data && data.errors && data.errors.message) || 'rejected' };
}

// ---------------------------------------------------------------------------
// Crypto helpers (PBKDF2 via Web Crypto API — no external deps)
// ---------------------------------------------------------------------------

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function pbkdf2Hash(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBuf(saltHex), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bufToHex(bits);
}

function randomHex(numBytes) {
  const bytes = new Uint8Array(numBytes);
  crypto.getRandomValues(bytes);
  return bufToHex(bytes);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Session helpers (shared table: admin logins + Telegram conversation state)
// ---------------------------------------------------------------------------

async function createAdminSession(env) {
  const token = randomHex(32);
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token, kind, data, expires_at) VALUES (?, 'admin', NULL, ?)`
  )
    .bind(token, expires)
    .run();
  return token;
}

async function getAdminSession(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT * FROM sessions WHERE token = ? AND kind = 'admin'`
  )
    .bind(token)
    .first();
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
    return null;
  }
  return row;
}

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}

async function getTgState(env, chatId) {
  const token = `tg_${chatId}`;
  const row = await env.DB.prepare(`SELECT * FROM sessions WHERE token = ? AND kind = 'tg_state'`)
    .bind(token)
    .first();
  if (!row) return { step: 'idle' };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
    return { step: 'idle' };
  }
  try {
    return JSON.parse(row.data) || { step: 'idle' };
  } catch {
    return { step: 'idle' };
  }
}

async function setTgState(env, chatId, state) {
  const token = `tg_${chatId}`;
  const expires = new Date(Date.now() + TG_STATE_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token, kind, data, expires_at) VALUES (?, 'tg_state', ?, ?)
     ON CONFLICT(token) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
  )
    .bind(token, JSON.stringify(state), expires)
    .run();
}

async function clearTgState(env, chatId) {
  await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(`tg_${chatId}`).run();
}

// ---------------------------------------------------------------------------
// Per-chat lock — fixes the "voice order gets stuck after cancel" bug.
//
// Telegram can deliver a second update for the same chat (e.g. a follow-up
// voice note, or a cancel tap) while the first update's webhook invocation
// is still mid-flight — most commonly while awaiting the ~2-3s Gemini
// transcription call. Two concurrent invocations then both read the same
// tg_state row, both compute a new state, and both write it back via
// INSERT...ON CONFLICT DO UPDATE — last write wins and silently clobbers
// whichever finished first. Each invocation also tries to editMessageText
// its own wizard message, and by the time the loser's edit fires, Telegram
// has already moved that message on (edited by the other invocation), so
// the edit comes back 400 and the customer sees nothing update — "stuck".
//
// Fix: serialize processing per chat_id with a short-lived lock row (reusing
// the sessions table — kind='chat_lock' — so no new binding is needed). A
// second update for the same chat waits briefly for the first to finish
// instead of racing it. Uses SQLite's UPSERT ... WHERE clause so acquiring
// is a single atomic statement: the row is only taken over if it doesn't
// exist yet OR its previous holder's lock has already expired (in case a
// prior invocation crashed without releasing).
const CHAT_LOCK_TTL_MS = 20000; // generous vs. the ~3s Gemini call this guards against
const CHAT_LOCK_POLL_MS = 350;
const CHAT_LOCK_MAX_WAIT_MS = 8000; // give up and let the user know rather than hang the request

async function acquireChatLock(env, chatId) {
  const token = `chat_lock_${chatId}`;
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + CHAT_LOCK_TTL_MS).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO sessions (token, kind, data, expires_at) VALUES (?, 'chat_lock', '1', ?)
     ON CONFLICT(token) DO UPDATE SET data = '1', expires_at = excluded.expires_at
     WHERE sessions.expires_at IS NULL OR sessions.expires_at < ?`
  )
    .bind(token, expiresIso, nowIso)
    .run();
  // D1's run() reports affected rows via meta.changes; the WHERE clause above
  // means changes stays 0 if a live lock is already held by someone else.
  return Boolean(result?.meta?.changes);
}

async function releaseChatLock(env, chatId) {
  await env.DB.prepare(`DELETE FROM sessions WHERE token = ? AND kind = 'chat_lock'`)
    .bind(`chat_lock_${chatId}`)
    .run();
}

// Runs `fn` while holding the per-chat lock, waiting (polling) up to
// CHAT_LOCK_MAX_WAIT_MS if another update for the same chat is still being
// processed. Returns true if the lock was acquired and fn ran; false if we
// gave up waiting (caller should tell the user to retry rather than
// processing anyway and re-introducing the race).
async function withChatLock(env, chatId, fn) {
  const deadline = Date.now() + CHAT_LOCK_MAX_WAIT_MS;
  let acquired = await acquireChatLock(env, chatId);
  while (!acquired && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CHAT_LOCK_POLL_MS));
    acquired = await acquireChatLock(env, chatId);
  }
  if (!acquired) return false;
  try {
    await fn();
  } finally {
    await releaseChatLock(env, chatId);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Voice-message flood limit
//
// Each incoming voice note costs a real Gemini API call (quota + money) plus
// a D1 write, and nothing previously capped how many a single chat could
// send. The per-chat lock above only serializes concurrent processing — it
// doesn't limit rate. This adds a simple rolling-window counter, reusing the
// sessions table (kind='voice_flood') the same way the chat lock reuses it,
// so no new binding is needed. Since a voice message is always handled while
// already holding that chat's lock (see handleWebhook), there's no race
// between the read and the write here — a plain read-then-write is safe.
// ---------------------------------------------------------------------------
const VOICE_FLOOD_WINDOW_MS = 60 * 1000; // rolling window
const VOICE_FLOOD_MAX = 5; // max voice messages per chat per window

// Returns { allowed: true } if this voice message may proceed, or
// { allowed: false, retryAfterSec } if the chat has hit the cap and should
// be told to slow down instead of being processed.
async function checkVoiceFloodLimit(env, chatId) {
  const token = `voice_flood_${chatId}`;
  const now = Date.now();
  const row = await env.DB.prepare(`SELECT data FROM sessions WHERE token = ? AND kind = 'voice_flood'`)
    .bind(token)
    .first();

  let count = 1;
  let windowStart = now;
  if (row && row.data) {
    try {
      const parsed = JSON.parse(row.data);
      if (parsed && typeof parsed.windowStart === 'number' && now - parsed.windowStart < VOICE_FLOOD_WINDOW_MS) {
        windowStart = parsed.windowStart;
        count = (parsed.count || 0) + 1;
      }
    } catch (e) {
      // malformed row — treat as a fresh window rather than failing closed
    }
  }

  if (count > VOICE_FLOOD_MAX) {
    const retryAfterSec = Math.max(1, Math.ceil((windowStart + VOICE_FLOOD_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSec };
  }

  const expiresIso = new Date(windowStart + VOICE_FLOOD_WINDOW_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token, kind, data, expires_at) VALUES (?, 'voice_flood', ?, ?)
     ON CONFLICT(token) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
  )
    .bind(token, JSON.stringify({ count, windowStart }), expiresIso)
    .run();

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------

// Escapes text for safe embedding in a parse_mode:'HTML' Telegram message.
// Any free-text/DB-supplied value (customer name, address, phone, transcript,
// payment link, etc.) that gets interpolated into message text MUST go
// through this first — an unescaped '&', '<', or '>' makes Telegram reject
// the whole sendMessage/editMessageText call with a 400 "can't parse
// entities" error. That rejection used to be completely invisible (see the
// tgApi fix below), which is exactly how the 2026-07-12 "voice fails
// silently" bug happened: a matched address containing a raw character broke
// the HTML parse and nothing ever appeared in the chat.
function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function tgApi(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Telegram returning a non-2xx (e.g. 400 "can't parse entities", bad
  // chat_id, message-not-modified, etc.) used to vanish completely — fetch()
  // itself doesn't throw on HTTP error statuses, so nothing ever surfaced.
  // Log it here (visible via wrangler tail / dashboard Logs) so a rejected
  // call is at least diagnosable instead of silent. Cloned so callers can
  // still read the original response body (e.g. .json()) untouched.
  if (!res.ok) {
    let errBody = '';
    try {
      errBody = await res.clone().text();
    } catch (e) {
      errBody = '(could not read response body)';
    }
    console.error(`Telegram API ${method} failed with status ${res.status}:`, errBody);
  }
  return res;
}

function sendMessage(env, chatId, text, replyMarkup) {
  return tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
    parse_mode: 'HTML',
  });
}

async function editMessageText(env, chatId, messageId, text, replyMarkup) {
  const res = await tgApi(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: replyMarkup,
    parse_mode: 'HTML',
  });
  // Telegram rejects the edit (400) when the target message was already
  // changed/replaced — most commonly by a racing update for the same chat
  // that we now serialize against via the chat lock, but this can still
  // happen for other reasons (message deleted, etc.). Rather than let the
  // customer see nothing update, fall back to a fresh message with the same
  // prompt/keyboard. Note: this doesn't update wizard_msg_id in tg_state —
  // callers that need the new message id should read it off the returned
  // response.
  //
  // Exception: "message is not modified" means the content we tried to set
  // is already exactly what's showing — there's nothing wrong, so falling
  // back would just spam a duplicate message with identical content. Treat
  // that specific case as a no-op success instead.
  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.clone().text();
    } catch (e) {
      // ignore — fall through and treat as a real failure below
    }
    if (/message is not modified/i.test(bodyText)) {
      return res;
    }
    return sendMessage(env, chatId, text, replyMarkup);
  }
  return res;
}

// Deletes a message the customer sent us — used to clean up the free-text
// replies typed during a wizard step (name/phone/address/...) right after
// we've read them, so the chat just shows the single prompt message being
// edited in place instead of a growing back-and-forth. Telegram allows bots
// to delete a user's incoming messages in a private chat (up to 48h old);
// this can still fail for edge cases (message already gone, chat isn't
// actually private, etc.) so failures are swallowed — losing the "vanish"
// effect once in a while is harmless, unlike breaking the wizard over it.
async function deleteCustomerMessage(env, chatId, messageId) {
  if (!messageId) return;
  try {
    await tgApi(env, 'deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch (e) {
    // ignore — not critical if this fails
  }
}

function answerCallbackQuery(env, id, text, showAlert) {
  return tgApi(env, 'answerCallbackQuery', { callback_query_id: id, text, show_alert: Boolean(showAlert) });
}

// Sends a new message that starts (or restarts) a "wizard" step chain, and
// returns its message_id so it can be stored in tg_state and reused with
// editMessageText for every subsequent step, instead of sending a fresh
// message each time. Telegram can only edit inline keyboards/text, not
// persistent reply keyboards, so this is only used for the first message of
// a flow — after that, every step must use inline keyboards to stay editable.
async function sendWizardMessage(env, chatId, text, replyMarkup) {
  const res = await sendMessage(env, chatId, text, replyMarkup);
  try {
    const data = await res.json();
    return data && data.result ? data.result.message_id : null;
  } catch {
    return null;
  }
}

// --- Keyboards ---

const adminMenuKeyboard = {
  keyboard: [['➕ مشتری جدید'], ['📋 لیست مشتریان'], ['🗺 مناطق تحویل']],
  resize_keyboard: true,
};

const customerMenuKeyboard = {
  keyboard: [['➕ ثبت سفارش جدید'], ['🧾 سفارش های من'], ['✏️ ویرایش اطلاعات من']],
  resize_keyboard: true,
};

async function mainMenuKeyboardFor(env, from) {
  return (await isAdminSender(env, from)) ? adminMenuKeyboard : customerMenuKeyboard;
}

// Appended to every inline keyboard shown during the order flow so a
// literal "❌ لغو" button is always visible — reachable with a tap
// regardless of which step the customer is on.
const CANCEL_INLINE_ROW = [{ text: '❌ لغو', callback_data: 'order_cancel' }];

// Shown on every free-text step (name, phone, address, ...) as an inline
// button attached to that step's own wizard message — same order_cancel
// callback used by CANCEL_INLINE_ROW elsewhere. Using an inline button
// (instead of a persistent reply keyboard, or matching typed words like
// "لغو") means cancelling is always tied to a deliberate tap on the current
// step's own message, so a customer whose actual name/address/etc. happens
// to be one of those words is never misread as wanting to cancel.
const cancelOnlyKeyboard = { inline_keyboard: [CANCEL_INLINE_ROW] };

// Shown after a customer types a value for a wizard step (name/phone/
// address) instead of auto-advancing — lets them confirm what was typed or
// re-type it before it's committed. `field` is 'name' | 'phone' | 'address'
// and is threaded through the wconfirm:<field>:yes / wconfirm:<field>:edit
// callback_data handled in handleCallbackQuery.
function confirmEditKeyboard(field) {
  return {
    inline_keyboard: [
      [
        { text: '✅ تایید', callback_data: `wconfirm:${field}:yes` },
        { text: '✏️ ویرایش مجدد', callback_data: `wconfirm:${field}:edit` },
      ],
      CANCEL_INLINE_ROW,
    ],
  };
}

// Entry point for "✏️ ویرایش اطلاعات من". Name/phone (plan C) and address
// management (plan D) are both wired up via editinfo:/addrmgr: handling in
// handleCallbackQuery below.
function editInfoMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✏️ تغییر نام', callback_data: 'editinfo:name' },
        { text: '✏️ تغییر تلفن', callback_data: 'editinfo:phone' },
      ],
      [{ text: '📍 مدیریت آدرس‌ها', callback_data: 'editinfo:addresses' }],
      [{ text: 'بستن', callback_data: 'editinfo:close' }],
    ],
  };
}

function editInfoMenuText(customer, addrCount) {
  return (
    `نام: ${escapeHtml([customer.first_name, customer.last_name].filter(Boolean).join(' '))}\n` +
    `تلفن: ${escapeHtml(customer.phone_number)}\n` +
    `آدرس‌ها (${addrCount})`
  );
}

// Plan D — address management list. Addresses INSERT as fresh rows rather
// than being mutated in place (past orders FK-reference addresses.id via
// orders.address_id, so an in-place edit would silently rewrite historical
// order addresses too). "Editing" here is therefore add-new + delete-old,
// not an in-place text change; delete is blocked if any order still
// references the row (checked in the addrmgr: handlers below).
function addressManageListText(addresses) {
  if (!addresses.length) {
    return '📍 مدیریت آدرس‌ها\n\nهنوز آدرسی ثبت نشده است.';
  }
  return '📍 مدیریت آدرس‌ها\n\nبرای حذف یک آدرس روی آن بزنید:';
}

function addressManageKeyboard(addresses) {
  const rows = addresses.map((a) => [
    {
      text: `🗑 ${a.address.length > 30 ? `${a.address.slice(0, 30)}…` : a.address}`,
      callback_data: `addrmgr:ask_delete:${a.id}`,
    },
  ]);
  rows.push([{ text: '➕ آدرس جدید', callback_data: 'addrmgr:new' }]);
  rows.push([{ text: '🔙 بازگشت', callback_data: 'editinfo:back' }]);
  return { inline_keyboard: rows };
}

function businessTypeInlineKeyboard() {
  return {
    inline_keyboard: [...BUSINESS_TYPES.map((t, i) => [{ text: t, callback_data: `btype:${i}` }]), CANCEL_INLINE_ROW],
  };
}

// Same index-into-list pattern as businessTypeInlineKeyboard, but the list
// itself comes from the admin-editable 'delivery_areas' setting rather than
// a hardcoded constant (see getDeliveryAreas) — so it's rebuilt from the
// current setting value on every call rather than baked in once.
function areaInlineKeyboard(areas) {
  return {
    inline_keyboard: [...areas.map((a, i) => [{ text: a, callback_data: `area:${i}` }]), CANCEL_INLINE_ROW],
  };
}

// Admin-facing "🗺 مناطق تحویل" screen: lists whatever's currently in the
// 'delivery_areas' setting (see getDeliveryAreas) and offers a button to add
// one more, right from the bot — previously this list was only viewable/
// editable from the web admin panel's settings page. Read-only display here
// (no per-area delete/rename button) since that already exists in the web
// panel and duplicating full CRUD in two places invites them to drift.
function deliveryAreasText(areas) {
  if (!areas.length) {
    return '🗺 مناطق تحویل\n\nهنوز هیچ منطقه‌ای ثبت نشده است.';
  }
  const lines = areas.map((a, i) => `${i + 1}. ${a}`);
  return `🗺 مناطق تحویل (${areas.length} مورد)\n\n${lines.join('\n')}`;
}

function deliveryAreasKeyboard() {
  return { inline_keyboard: [[{ text: '➕ افزودن منطقه جدید', callback_data: 'areas:add' }]] };
}

function addressInlineKeyboard(addresses) {
  const rows = addresses.map((a) => [{ text: a.address, callback_data: `addr:${a.id}` }]);
  rows.push([{ text: '➕ آدرس جدید', callback_data: 'addr:new' }]);
  rows.push(CANCEL_INLINE_ROW);
  return { inline_keyboard: rows };
}

function sizeInlineKeyboard() {
  return {
    inline_keyboard: [
      SIZES.map((s) => ({ text: `سایز ${s}`, callback_data: `size:${s}` })),
      CANCEL_INLINE_ROW,
    ],
  };
}

// Formats a kg amount without trailing zeros (e.g. 6 not 6.00, 2.5 stays 2.5).
function fmtKg(n) {
  return Number(n.toFixed(2)).toString();
}

function weightSelectPrompt(size, weight) {
  return `سایز ${size} — مقدار فعلی: ${fmtKg(weight)} کیلوگرم\nبرای افزودن روی دکمه‌ها بزنید یا مقدار دلخواه وارد کنید:`;
}

// hasHistory controls whether the undo button is shown (nothing to undo on
// a fresh selection screen).
function weightSelectionKeyboard(hasHistory) {
  const rows = [PRESET_WEIGHTS.map((w) => ({ text: `➕ ${w} کیلوگرم`, callback_data: `wkg:add:${w}` }))];
  const controlRow = [{ text: '✏️ مقدار دلخواه', callback_data: 'wkg:custom' }];
  if (hasHistory) controlRow.push({ text: '↩️ حذف آخرین', callback_data: 'wkg:undo' });
  rows.push(controlRow);
  rows.push([{ text: '✅ تایید و ثبت', callback_data: 'wkg:confirm' }]);
  rows.push(CANCEL_INLINE_ROW);
  return { inline_keyboard: rows };
}

// hubMode changes only the label on the second button: during hub-and-spoke
// registration (see below) this screen doesn't actually place the order yet
// — it just returns to the hub so other fields can still be filled in —
// so the button must not claim to "finish and place the order".
function afterSizeInlineKeyboardFor(hubMode) {
  return {
    inline_keyboard: [
      [{ text: '➕ افزودن سایز دیگر', callback_data: 'add_size' }],
      [
        {
          text: hubMode ? '🔙 بازگشت به صفحه ثبت‌نام' : '✅ پایان و ثبت سفارش',
          callback_data: 'finish_order',
        },
      ],
      CANCEL_INLINE_ROW,
    ],
  };
}
// Kept for any existing call sites that haven't been updated to pass hubMode
// explicitly — behaves exactly as before (non-hub wording).
const afterSizeInlineKeyboard = afterSizeInlineKeyboardFor(false);

// Shown once at least one voice-order item is confirmed and nothing is
// mid-flight: lets the customer either add another size (loops back into
// the same size/weight prompts, still under step 'voice_order') or move on
// by picking/typing an address — same address rows as addressInlineKeyboard,
// just with the "add another size" row prepended.
function voiceItemHybridKeyboard(addrList) {
  const rows = [[{ text: '➕ افزودن سایز دیگر', callback_data: 'voiceitem:addmore' }]];
  for (const a of addrList) rows.push([{ text: a.address, callback_data: `addr:${a.id}` }]);
  rows.push([{ text: '➕ آدرس جدید', callback_data: 'addr:new' }]);
  rows.push(CANCEL_INLINE_ROW);
  return { inline_keyboard: rows };
}

const paymentStatusInlineKeyboard = (orderId) => ({
  inline_keyboard: [
    [
      { text: '✅ پرداخت شده', callback_data: `pay:paid:${orderId}` },
      { text: '❌ پرداخت نشده', callback_data: `pay:unpaid:${orderId}` },
    ],
  ],
});

// Shown to regular (non-admin) customers right after they finish an order,
// so we know which follow-up to run: gateway link, card-to-card receipt
// upload, or nothing (cash on delivery). No cancel row here — the order
// itself is already placed at this point, so "cancelling" would mean
// abandoning payment selection, not the order; unpaid orders can still be
// handled from the admin panel.
const paymentMethodInlineKeyboard = (orderId) => ({
  inline_keyboard: [
    [{ text: '💳 پرداخت آنلاین (درگاه)', callback_data: `pm:gateway:${orderId}` }],
    [{ text: '🏦 کارت به کارت', callback_data: `pm:card:${orderId}` }],
    [{ text: '🚚 پرداخت در محل', callback_data: `pm:cod:${orderId}` }],
  ],
});

function paginationKeyboard(page, hasNext, extraRows = []) {
  const navRow = [];
  if (page > 0) navRow.push({ text: '⬅️ قبلی', callback_data: `page:${page - 1}` });
  if (hasNext) navRow.push({ text: 'بعدی ➡️', callback_data: `page:${page + 1}` });
  const rows = [...extraRows];
  if (navRow.length) rows.push(navRow);
  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

async function findCustomerByChatId(env, chatId) {
  return env.DB.prepare(`SELECT * FROM customers WHERE telegram_chat_id = ?`)
    .bind(String(chatId))
    .first();
}

// ---------------------------------------------------------------------------
// Admin gating (Telegram side) — checked against the `admins` table, which is
// managed from the /admin web panel. An entry can be either the numeric
// Telegram user id, or a @username (case-insensitive, stored without the @).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Address dedup — customers (especially via voice) end up saying/typing the
// same address with tiny formatting differences (commas, extra spaces), and
// each successful order used to insert it as a brand-new address row every
// time. This normalizes for comparison (commas/whitespace only — not a fuzzy
// match) and reuses an existing row for this customer when one already
// matches, instead of piling up near-duplicates in the address selector.
// ---------------------------------------------------------------------------

function normalizeAddressForDedup(address) {
  return String(address || '')
    .replace(/[،,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function getCustomerAddresses(env, customerId) {
  const rows = await env.DB.prepare(`SELECT * FROM addresses WHERE customer_id = ? ORDER BY id DESC`)
    .bind(customerId)
    .all();
  return rows.results || [];
}

async function findOrCreateAddress(env, customerId, addressText, area = null) {
  const normalized = normalizeAddressForDedup(addressText);
  if (normalized) {
    const rows = await env.DB.prepare(`SELECT * FROM addresses WHERE customer_id = ?`)
      .bind(customerId)
      .all();
    const existing = (rows.results || []).find(
      (a) => normalizeAddressForDedup(a.address) === normalized
    );
    if (existing) {
      // Fill-only-if-empty, same rule as the hub's name/phone fields — never
      // overwrites an area the address already has, but backfills one if
      // this call happens to know an area and the existing row doesn't.
      if (area && !existing.area) {
        await env.DB.prepare(`UPDATE addresses SET area = ? WHERE id = ?`).bind(area, existing.id).run();
      }
      return existing.id;
    }
  }
  const res = await env.DB.prepare(`INSERT INTO addresses (customer_id, address, area) VALUES (?, ?, ?)`)
    .bind(customerId, addressText, area || null)
    .run();
  return res.meta.last_row_id;
}

// ---------------------------------------------------------------------------
// Hub-and-spoke registration wizard (agreed 2026-07-11) — replaces the old
// linear name→phone→address→business_type→size_select→... chain for BOTH
// self-registration and admin "➕ مشتری جدید" with a single hub screen that
// lists each field as a button. Tapping a field edits the same message into
// that field's sub-flow (reusing the existing free-text/confirm and
// size_select/weight_select/add_size/finish_order machinery verbatim); on
// completion we return to the hub instead of chaining to the next field.
// Only "✅ ثبت نهایی" actually calls createOrderAndRoute.
//
// state.hub_mode: true marks a tg_state as belonging to this wizard — every
// place that needs to behave differently for hub vs. the old flows (which
// still exist for "existing customer places another order") checks this
// flag rather than the step name, since several steps (name/phone/address/
// business_type/size_select/weight_select/size_or_finish) are shared
// between hub and non-hub contexts.
// ---------------------------------------------------------------------------

function hubMissingFields(state) {
  const missing = [];
  // A name is "present" if EITHER component is set — matches hubKeyboard's
  // own nameVal display just below, which already shows a last-name-only
  // value (e.g. "ابراهیمی" from "خانوم ابراهیمی") as a complete-looking
  // name. Requiring first_name specifically here disagreed with that
  // display: the hub would show the name as filled, then block submission
  // saying it was missing. See resolveNameForStorage for how this gets
  // normalized into the NOT NULL first_name column at insert time.
  if (!state.first_name && !state.last_name) missing.push('نام');
  if (!state.phone_number) missing.push('تلفن');
  if (!state.address) missing.push('آدرس');
  if (!(state.items || []).length) missing.push('حداقل یک قلم سفارش');
  return missing;
}

// customers.first_name is NOT NULL, but the hub allows submitting with only
// last_name set (see hubMissingFields above) — e.g. a customer known only
// as "خانوم ابراهیمی" with no given name ever spoken. In that case the one
// known name component is what should end up in first_name (the always-
// populated, always-displayed field), not silently lost or forced through
// an empty NOT NULL column. When first_name IS set, both fields pass
// through unchanged.
function resolveNameForStorage(state) {
  if (!state.first_name && state.last_name) {
    return { first_name: state.last_name, last_name: '' };
  }
  return { first_name: state.first_name, last_name: state.last_name || '' };
}

function hubKeyboard(state) {
  const nameVal = [state.first_name, state.last_name].filter(Boolean).join(' ') || 'تنظیم نشده';
  const phoneVal = state.phone_number || 'تنظیم نشده';
  const addressRaw = state.address || '';
  const addressVal = addressRaw
    ? addressRaw.length > 24
      ? `${addressRaw.slice(0, 24)}…`
      : addressRaw
    : 'تنظیم نشده';
  const businessVal = state.business_type || 'تنظیم نشده (اختیاری)';
  const shopNameVal = state.shop_name || 'تنظیم نشده (اختیاری)';
  const areaVal = state.area || 'تنظیم نشده (اختیاری)';
  const itemCount = (state.items || []).length;
  return {
    inline_keyboard: [
      [{ text: `👤 نام: ${nameVal}`, callback_data: 'hub:name' }],
      [{ text: `📞 تلفن: ${phoneVal}`, callback_data: 'hub:phone' }],
      [{ text: `📍 آدرس: ${addressVal}`, callback_data: 'hub:address' }],
      [{ text: `🗺 منطقه: ${areaVal}`, callback_data: 'hub:area' }],
      [{ text: `🏷 صنف: ${businessVal}`, callback_data: 'hub:business_type' }],
      [{ text: `🏪 نام مغازه: ${shopNameVal}`, callback_data: 'hub:shop_name' }],
      [{ text: `📦 اقلام سفارش: ${itemCount} قلم`, callback_data: 'hub:items' }],
      [{ text: '✅ ثبت نهایی', callback_data: 'hub:submit' }],
      CANCEL_INLINE_ROW,
    ],
  };
}

function hubText() {
  return '📝 ثبت‌نام مشتری جدید\n\nبرای تکمیل یا ویرایش هر بخش روی دکمه مربوطه بزنید. در پایان روی «✅ ثبت نهایی» بزنید.';
}

// Sends (first time) or edits (every time after) the hub message. Returns
// the message_id so callers can persist it as wizard_msg_id.
async function renderHub(env, chatId, state) {
  if (state.wizard_msg_id) {
    await editMessageText(env, chatId, state.wizard_msg_id, hubText(), hubKeyboard(state));
    return state.wizard_msg_id;
  }
  return sendWizardMessage(env, chatId, hubText(), hubKeyboard(state));
}

// Admin-only address search-as-you-type entry point, offered alongside
// free-text entry when origin === 'admin_add'. Self-registration stays
// free-text-only (privacy boundary — must not let a random Telegram user
// browse other customers' addresses), so this keyboard is never shown there.
function hubAddressEntryKeyboard() {
  return {
    inline_keyboard: [[{ text: '🔍 جستجوی آدرس', callback_data: 'addrsearch:start' }], CANCEL_INLINE_ROW],
  };
}

// Default similarity threshold for the automatic duplicate-catch confirm
// (see findSimilarAddresses below). Proposed 2026-07-11, not yet explicitly
// confirmed by the user — reasonable default, revisit if it misfires.
const ADDRESS_SIMILARITY_THRESHOLD = 0.6;

// Admin-only helper: scores every saved address against addressText by
// Jaccard token overlap (|intersection|/|union| of normalized word sets),
// reusing normalizeAddressForDedup so "خ" vs "خیابان"/comma/whitespace
// differences don't block a match the way plain substring LIKE would.
// No external library — computed in JS over all rows fetched once, since
// the addresses table isn't expected to be large enough to need SQL-side
// fuzzy matching. Used for both search-as-you-type (threshold 0, small
// limit) and the automatic duplicate catch (threshold ~0.6, limit 1).
async function findSimilarAddresses(env, addressText, { threshold = 0, limit = 5 } = {}) {
  const normalizedQuery = normalizeAddressForDedup(addressText);
  const queryTokens = new Set(normalizedQuery.split(' ').filter(Boolean));
  if (!queryTokens.size) return [];

  const rows = await env.DB.prepare(`SELECT * FROM addresses`).all();
  const scored = [];
  for (const row of rows.results || []) {
    const rowTokens = new Set(normalizeAddressForDedup(row.address).split(' ').filter(Boolean));
    if (!rowTokens.size) continue;
    let intersection = 0;
    for (const t of queryTokens) if (rowTokens.has(t)) intersection++;
    const union = new Set([...queryTokens, ...rowTokens]).size;
    const score = union > 0 ? intersection / union : 0;
    if (score >= threshold) scored.push({ ...row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function normalizeUsername(u) {
  return String(u || '').replace(/^@/, '').toLowerCase();
}

async function isAdminSender(env, from) {
  if (!from) return false;
  const id = String(from.id);
  const username = normalizeUsername(from.username);
  const row = await env.DB.prepare(
    `SELECT 1 FROM admins WHERE
       (identifier_type = 'id' AND identifier = ?)
       OR (identifier_type = 'username' AND ? != '' AND LOWER(identifier) = ?)
     LIMIT 1`
  )
    .bind(id, username, username)
    .first();
  return !!row;
}

// Telegram will only let us proactively message a numeric chat id — never a
// bare @username — so a username-registered admin can't receive any
// notifyAdminsOfNewOrder-style message until we know their numeric id. This
// backfills it the first time that admin sends any message or tap to the
// bot (matched by id or username, same as isAdminSender). Safe/cheap to
// call on every update: it's a no-op once telegram_user_id is already set.
async function recordAdminChatId(env, from) {
  if (!from) return;
  const id = String(from.id);
  const username = normalizeUsername(from.username);
  await env.DB.prepare(
    `UPDATE admins SET telegram_user_id = ?
     WHERE telegram_user_id IS NULL
       AND ((identifier_type = 'id' AND identifier = ?)
         OR (identifier_type = 'username' AND ? != '' AND LOWER(identifier) = ?))`
  )
    .bind(id, id, username, username)
    .run();
}

// Resolves the admins table into a list of chat ids we can actually send a
// proactive message to: the numeric identifier directly for id-based
// admins, or the backfilled telegram_user_id for username-based ones.
// Username-based admins who haven't interacted with the bot yet (so we
// have no telegram_user_id for them) are silently skipped — there is no
// way to message them until they do.
async function getNotifiableAdminChatIds(env) {
  const rows = await env.DB.prepare(
    `SELECT identifier, identifier_type, telegram_user_id FROM admins`
  ).all();
  const out = [];
  for (const a of rows.results || []) {
    const chatId = a.telegram_user_id || (a.identifier_type === 'id' ? a.identifier : null);
    if (chatId) out.push(chatId);
  }
  return out;
}

// Recomputes a customer's aggregate payment_status from ALL of their orders,
// instead of blindly copying whichever single order was just touched. A
// customer is only 'paid' once every one of their orders is 'paid'; if any
// order is still unpaid/pending/anything-else, the customer as a whole is
// 'unpaid'. Call this after any change to an individual order's
// payment_status (manual admin toggle, Zarinpal auto-verify, etc.) instead
// of writing the order's status straight onto the customer row — otherwise
// a customer with multiple orders flips paid/unpaid based purely on
// whichever order was last touched, which also breaks the admin panel's
// payment_status customer filter.
// Sums the snapshotted unit_price × weight_kg for every item on an order —
// the authoritative order total for debt/paid tracking. Uses the snapshot
// (not the live size_prices table) so a later price change never
// retroactively alters an already-issued invoice's contribution to a
// customer's debt/paid totals.
async function computeOrderTotal(env, orderId) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(weight_kg * unit_price), 0) AS total FROM order_items WHERE order_id = ?`
  )
    .bind(orderId)
    .first();
  return row ? row.total : 0;
}

// Central place for changing an order's payment_status. Previously every
// call site (manual admin toggle, Zarinpal webhook) wrote orders.payment_status
// directly, which meant customers.debt_amount/paid_amount stayed at their
// schema default of 0 forever — the columns existed but nothing ever wrote
// to them. Routing every transition through here keeps those two columns
// accurate. Idempotent: a "change" to the status the order is already at is
// a no-op, so retries/races (webhook + cron reconciliation both landing on
// the same payment, for instance) can't double-count.
async function setOrderPaymentStatus(env, orderId, newStatus) {
  const order = await env.DB.prepare(`SELECT customer_id, payment_status FROM orders WHERE id = ?`)
    .bind(orderId)
    .first();
  if (!order) return null;
  if (order.payment_status === newStatus) return order.customer_id;

  const total = await computeOrderTotal(env, orderId);
  const wasPaid = order.payment_status === 'paid';
  const nowPaid = newStatus === 'paid';
  if (!wasPaid && nowPaid) {
    await env.DB.prepare(
      `UPDATE customers SET paid_amount = paid_amount + ?, debt_amount = MAX(0, debt_amount - ?) WHERE id = ?`
    )
      .bind(total, total, order.customer_id)
      .run();
  } else if (wasPaid && !nowPaid) {
    await env.DB.prepare(
      `UPDATE customers SET debt_amount = debt_amount + ?, paid_amount = MAX(0, paid_amount - ?) WHERE id = ?`
    )
      .bind(total, total, order.customer_id)
      .run();
  }

  await env.DB.prepare(`UPDATE orders SET payment_status = ? WHERE id = ?`).bind(newStatus, orderId).run();
  return order.customer_id;
}

async function recomputeCustomerPaymentStatus(env, customerId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN payment_status != 'paid' THEN 1 ELSE 0 END) AS unpaid_count
     FROM orders WHERE customer_id = ?`
  )
    .bind(customerId)
    .first();
  // A customer with NO orders at all must stay 'unpaid' (their actual
  // starting default) — without the total>0 check, unpaid_count would be 0
  // for "no orders" the same as for "all orders paid", incorrectly marking
  // a brand-new customer as 'paid' if this were ever called before any
  // order existed for them.
  const newStatus = row && row.total > 0 && (row.unpaid_count || 0) === 0 ? 'paid' : 'unpaid';
  await env.DB.prepare(`UPDATE customers SET payment_status = ? WHERE id = ?`)
    .bind(newStatus, customerId)
    .run();
  return newStatus;
}

async function customerSummaryLine(env, customer) {
  const totals = await env.DB.prepare(
    `SELECT COALESCE(SUM(oi.weight_kg), 0) AS total_kg, COUNT(DISTINCT o.id) AS order_count
     FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.customer_id = ?`
  )
    .bind(customer.id)
    .first();
  const statusEmoji = customer.payment_status === 'paid' ? '✅' : '❌';
  const phonePart = customer.phone_number ? ` — 📞 ${escapeHtml(customer.phone_number)}` : '';
  const shopPart = customer.shop_name ? ` (${escapeHtml(customer.shop_name)})` : '';
  return `${statusEmoji} ${escapeHtml(customer.first_name)} ${escapeHtml(customer.last_name)}${shopPart} — ${escapeHtml(
    customer.address
  )}${phonePart} — ${(totals.total_kg || 0).toFixed(1)} کیلوگرم (${totals.order_count} سفارش)`;
}

// ---------------------------------------------------------------------------
// Telegram webhook handling
// ---------------------------------------------------------------------------

async function handleWebhook(request, env) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  await ensureSchema(env);

  // Diagnostic safety net (added 2026-07-11) — previously an uncaught
  // exception anywhere in handleMessage/handleCallbackQuery propagated all
  // the way up with NOTHING sent back to the chat and no visibility beyond
  // Cloudflare's own crash log: the user just saw silence. This wraps both
  // dispatches so (a) the error is logged via console.error (visible in
  // `wrangler tail` / the dashboard's Logs tab), and (b) the chat gets a
  // generic failure message instead of nothing, so at minimum it's clear
  // *something* went wrong rather than looking like the bot ignored them.
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? null;

  const dispatch = async () => {
    if (update.message) {
      await handleMessage(env, update.message);
    } else if (update.callback_query) {
      await handleCallbackQuery(env, update.callback_query, new URL(request.url).origin);
    }
  };

  try {
    if (chatId) {
      // Serialize per chat: a second update for the same chat (e.g. a
      // follow-up voice note arriving while the first is still awaiting
      // Gemini, or a cancel tap racing a still-processing message) waits
      // for the first to finish instead of running concurrently and
      // clobbering tg_state — see withChatLock for the full rationale.
      const gotLock = await withChatLock(env, chatId, dispatch);
      if (!gotLock) {
        // Another update for this chat was still processing after our
        // whole wait budget — extremely unlikely (would mean something
        // upstream is truly hung), but tell the user rather than silently
        // dropping the update or processing it unsafely.
        try {
          await sendMessage(
            env,
            chatId,
            'پیام قبلی شما هنوز در حال پردازش است. لطفاً چند لحظه صبر کنید و دوباره امتحان کنید.'
          );
        } catch (sendErr) {
          // swallow — see below
        }
      }
    } else {
      // No chat id we can key a lock on (shouldn't normally happen) —
      // fall back to the old unsynchronized behavior rather than dropping
      // the update.
      await dispatch();
    }
  } catch (e) {
    console.error('Unhandled error in webhook update:', e && e.stack ? e.stack : e);
    if (chatId) {
      try {
        await sendMessage(
          env,
          chatId,
          'متاسفانه خطایی رخ داد. لطفاً دوباره امتحان کنید یا با /start از نو شروع کنید.'
        );
      } catch (sendErr) {
        // If even the error notice fails to send (e.g. bad token, blocked
        // bot), there's nothing further we can do here — swallow it so the
        // webhook still returns 'ok' below rather than throwing again.
      }
    }
  }

  return new Response('ok');
}

// Shared by both hub-voice paths: an admin filling the "➕ مشتری جدید" hub
// (origin: 'admin_add') and a customer self-registering via their very
// first voice message (origin unset — see the unregistered-voice bootstrap
// in handleMessage). Downloads + transcribes the voice note against
// whatever the hub already knows, sanitizes it, and merges anything usable
// into the hub state (fill-only-if-empty, same one-shot-fill philosophy as
// the rest of admin voice registration), then re-renders the hub.
//
// The automatic "did you mean this saved address?" duplicate-match is kept
// admin-only (state.origin === 'admin_add'): it fuzzy-matches against EVERY
// customer's saved addresses, which is fine for an admin but would leak
// another customer's address to a stranger self-registering by voice. For
// self-registration the spoken address is accepted as-is instead.
async function handleHubVoiceMessage(env, chatId, state, voiceFileId) {
  let extraction;
  try {
    extraction = await transcribeAdminRegVoice(env, voiceFileId, state);
  } catch (e) {
    console.error('transcribeAdminRegVoice failed:', e && e.stack ? e.stack : e);
    await sendMessage(
      env,
      chatId,
      'پردازش پیام صوتی با خطا مواجه شد. لطفاً دوباره امتحان کنید یا اطلاعات را با دکمه‌های صفحه ثبت‌نام وارد کنید.'
    );
    return;
  }

  const areas = await getDeliveryAreas(env);
  const clean = sanitizeAdminRegExtraction(extraction, areas);
  if (!clean.transcript) {
    await sendMessage(env, chatId, 'متوجه پیام صوتی نشدم. لطفاً دوباره واضح بگویید یا از دکمه‌ها استفاده کنید.');
    return;
  }
  // Gemini flagged something ambiguous (e.g. an unclear name/size) —
  // surface that instead of silently dropping it, so the sender knows to
  // double-check the field rather than assuming it was heard correctly.
  if (clean.clarification_needed) {
    await sendMessage(env, chatId, `❓ ${clean.clarification_needed}`);
  }

  // Items: same accumulation machinery as the customer multi-item voice
  // flow (mergeItemIntoList + foldPendingItem) — a size is a fixed
  // 1-of-5 value, much less prone to mishearing than a name or phone
  // number, so folding it as usual is fine here.
  let itemsMerged = state.items || [];
  for (const it of clean.items || []) itemsMerged = mergeItemIntoList(itemsMerged, it);
  let newState = {
    ...state,
    items: itemsMerged,
    pending_size: clean.size != null ? clean.size : (state.pending_size ?? null),
    pending_weight: clean.weight_kg != null ? clean.weight_kg : (state.pending_weight ?? null),
  };
  newState = foldPendingItem(newState);

  // Name/phone: fill-only-if-empty. Never overwrites an already-set hub
  // field — this is what makes it a one-shot fill rather than a
  // voice-driven correction, per the 2026-07-11 decision. first_name and
  // last_name are independent — accept whichever one(s) came back, each
  // still fill-only-if-currently-empty (e.g. "خانوم ابراهیمی" fills only
  // last_name).
  if (!newState.first_name && clean.first_name) {
    newState.first_name = clean.first_name;
  }
  if (!newState.last_name && clean.last_name) {
    newState.last_name = clean.last_name;
  }
  if (!newState.phone_number && clean.phone_number) {
    newState.phone_number = clean.phone_number;
  }
  // shop_name: same fill-only-if-empty rule — the store's own name (e.g.
  // "فجر" in "سوپرمارکت فجر"), separate from business_type.
  if (!newState.shop_name && clean.shop_name) {
    newState.shop_name = clean.shop_name;
  }
  // business_type: same fill-only-if-empty rule.
  if (!newState.business_type && clean.business_type) {
    newState.business_type = clean.business_type;
  }
  // area: same fill-only-if-empty rule, validated against the current
  // delivery_areas setting inside sanitizeAdminRegExtraction above.
  if (!newState.area && clean.area) {
    newState.area = clean.area;
  }

  // Address: fill-only-if-empty. For admin_add only, this also runs through
  // the same admin-only duplicate/similarity catch as typed entry before
  // being accepted outright — reuses the existing address_dup_confirm step
  // and addrdup:accept/reject callbacks verbatim, so accepting or rejecting
  // the match returns to the hub with everything else (items/name/phone
  // merged above) intact. Self-registration skips the cross-customer match
  // entirely (see function comment above) and just accepts the address.
  if (!newState.address && clean.address) {
    if (state.origin === 'admin_add') {
      const matches = await findSimilarAddresses(env, clean.address, {
        threshold: ADDRESS_SIMILARITY_THRESHOLD,
        limit: 1,
      });
      if (matches.length) {
        const candidate = matches[0];
        const dupState = {
          ...newState,
          step: 'address_dup_confirm',
          dup_candidate_id: candidate.id,
          dup_candidate_text: candidate.address,
          pending_address: clean.address,
        };
        await setTgState(env, chatId, dupState);
        await editMessageText(
          env,
          chatId,
          state.wizard_msg_id,
          `آیا منظور شما این آدرس است؟\n${escapeHtml(candidate.address)}`,
          {
            inline_keyboard: [
              [
                { text: '✅ بله همین است', callback_data: 'addrdup:accept' },
                { text: '❌ خیر، جدید است', callback_data: 'addrdup:reject' },
              ],
              CANCEL_INLINE_ROW,
            ],
          }
        );
        return;
      }
    }
    newState.address = clean.address;
  }

  const wizardMsgId = await renderHub(env, chatId, newState);
  await setTgState(env, chatId, { ...newState, wizard_msg_id: wizardMsgId });
}

async function handleMessage(env, message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  await recordAdminChatId(env, message.from);

  if (text === '/start') {
    await clearTgState(env, chatId);
    await sendMessage(
      env,
      chatId,
      'به ربات مدیریت مشتریان پلاستیک دسته‌دار خوش آمدید.',
      await mainMenuKeyboardFor(env, message.from)
    );
    return;
  }

  const state = await getTgState(env, chatId);

  if (message.photo && message.photo.length && state.step === 'awaiting_receipt') {
    const orderId = state.order_id;
    const largest = message.photo[message.photo.length - 1];
    await env.DB.prepare(`INSERT INTO receipts (order_id, file_id) VALUES (?, ?)`)
      .bind(orderId, largest.file_id)
      .run();

    await sendMessage(env, chatId, 'فیش واریزی شما دریافت شد و برای بررسی برای ادمین ارسال شد. سپاسگزاریم.', await mainMenuKeyboardFor(env, message.from));

    const adminChatIds = await getNotifiableAdminChatIds(env);
    for (const chatId of adminChatIds) {
      try {
        await tgApi(env, 'sendPhoto', {
          chat_id: chatId,
          photo: largest.file_id,
          caption: `🧾 فیش واریزی کارت‌به‌کارت — سفارش شماره ${String(orderId).padStart(6, '0')}`,
          reply_markup: paymentStatusInlineKeyboard(orderId),
        });
      } catch (e) {
        // e.g. admin blocked the bot — skip silently
      }
    }

    await clearTgState(env, chatId);
    return;
  }

  // Free-text reply to the "➕ افزودن منطقه جدید" prompt (see areas:add in
  // handleCallbackQuery). Only reachable via that admin-only button, but
  // re-checked here anyway — same defensive pattern as every other admin
  // step — in case the bot token/session ends up in the wrong hands mid-flow.
  if (state.step === 'awaiting_new_area') {
    if (!(await isAdminSender(env, message.from))) {
      await clearTgState(env, chatId);
      return;
    }
    const newArea = text.trim();
    if (!newArea) {
      await sendMessage(env, chatId, 'نام منطقه نمی‌تواند خالی باشد. دوباره ارسال کنید یا لغو کنید:', cancelOnlyKeyboard);
      return;
    }
    const areas = await getDeliveryAreas(env);
    if (areas.some((a) => a === newArea)) {
      await sendMessage(env, chatId, `منطقه‌ی «${newArea}» از قبل در لیست موجود است.`, cancelOnlyKeyboard);
      return;
    }
    const updated = [...areas, newArea];
    // Stored the same way the web admin panel writes it (see
    // handleApiSettingsSet) — a single comma-separated 'delivery_areas'
    // setting — so either surface can add/edit and the other stays in sync.
    await setSetting(env, 'delivery_areas', updated.join(', '));
    await clearTgState(env, chatId);
    await sendMessage(env, chatId, `✅ منطقه‌ی «${newArea}» اضافه شد.`, await mainMenuKeyboardFor(env, message.from));
    await sendMessage(env, chatId, deliveryAreasText(updated), deliveryAreasKeyboard());
    return;
  }

  if (message.voice && message.voice.file_id) {
    const floodCheck = await checkVoiceFloodLimit(env, chatId);
    if (!floodCheck.allowed) {
      await sendMessage(
        env,
        chatId,
        `تعداد پیام‌های صوتی شما در این بازه زیاد بوده. لطفاً حدود ${floodCheck.retryAfterSec} ثانیه صبر کنید و دوباره امتحان کنید.`
      );
      return;
    }

    const inVoiceOrderFlow = state.step === 'voice_order';
    // Sitting on the hub screen of a new-customer registration — either an
    // admin's "➕ مشتری جدید" (origin: 'admin_add') or a customer
    // self-registering (origin unset — see the unregistered-voice bootstrap
    // below, which starts this same hub for a first-time voice message
    // instead of just blocking it). Voice fills whatever hub fields it
    // confidently can, via the shared handleHubVoiceMessage helper. Any
    // OTHER hub sub-step (name/phone/address/business_type/size_select/etc.
    // already open) is deliberately NOT included here, so it still falls
    // through to the generic "finish this step first" handling below
    // rather than being silently reinterpreted.
    const inRegHub = Boolean(state.hub_mode) && state.step === 'hub';

    // Any other in-progress flow (registration wizard, button-driven order,
    // awaiting a receipt photo, etc.) still has to be finished first — voice
    // ordering only interleaves with itself, and hub voice registration
    // only interleaves with the hub screen itself. Re-show the actual
    // prompt/keyboard for that step (as a fresh message) rather than just
    // saying "use the buttons" and leaving the customer to hunt for a
    // message that may have scrolled out of view — that was the "stuck" bug.
    if (!inVoiceOrderFlow && !inRegHub && state.step && state.step !== 'idle') {
      const resent = await resendCurrentStepPrompt(env, chatId, state);
      await sendMessage(
        env,
        chatId,
        resent
          ? 'لطفاً ابتدا مرحله‌ی فعلی را با دکمه‌ها یا متن تکمیل کنید، سپس دوباره پیام صوتی بفرستید.\n(برای شروع دوباره از صفر، دکمه‌ی «❌ لغو» زیر همین پیام را بزنید.)'
          : 'مرحله‌ی قبلی شما دیگر معتبر نیست. برای شروع دوباره دستور /start را بفرستید.'
      );
      return;
    }

    if (inRegHub) {
      await handleHubVoiceMessage(env, chatId, state, message.voice.file_id);
      return;
    }

    let workingState = state;
    if (!inVoiceOrderFlow) {
      const existing = await findCustomerByChatId(env, chatId);
      if (!existing) {
        // First-ever voice message from someone we don't have a customer
        // record for — previously this just blocked with a "register first"
        // message and stopped, forcing them to switch to the button flow
        // (defeating the point of voice ordering for a brand-new customer).
        // Instead, start the same self-registration hub the "➕ ثبت سفارش
        // جدید" button opens for a first-time customer (origin left unset,
        // same as that button — NOT 'admin_add'), then immediately run this
        // voice message through it, so one voice note can both register
        // them (name/phone/address/business type) and start their order
        // (size/weight) in one go. They still have to tap "✅ ثبت نهایی" on
        // the hub before anything is actually created.
        const initialHubState = { step: 'hub', hub_mode: true, items: [] };
        const hubMsgId = await renderHub(env, chatId, initialHubState);
        const freshHubState = { ...initialHubState, wizard_msg_id: hubMsgId };
        await setTgState(env, chatId, freshHubState);
        await handleHubVoiceMessage(env, chatId, freshHubState, message.voice.file_id);
        return;
      }
      workingState = {
        step: 'voice_order',
        customer_id: existing.id,
        items: [],
        pending_size: null,
        pending_weight: null,
        pending_history: [],
        address: null,
        address_id: null,
        area: null,
        wizard_msg_id: null,
      };
    }

    let extraction;
    try {
      extraction = await transcribeVoiceOrder(env, message.voice.file_id, {
        items: workingState.items,
        size: workingState.pending_size,
        weight_kg: workingState.pending_weight,
        address: workingState.address,
        area: workingState.area,
      });
    } catch (e) {
      console.error('transcribeVoiceOrder failed:', e && e.stack ? e.stack : e);
      await sendMessage(env, chatId, 'پردازش پیام صوتی با خطا مواجه شد. لطفاً دوباره امتحان کنید یا سفارش را با دکمه ثبت کنید.');
      return;
    }

    const areasForSanitize = await getDeliveryAreas(env);
    const clean = sanitizeVoiceExtraction(extraction, areasForSanitize);
    if (!clean.transcript) {
      // Totally unintelligible audio — nothing to merge, ask them to retry.
      // Existing pending state (if any) is untouched, so nothing already
      // captured is lost.
      await sendMessage(env, chatId, 'متوجه پیام صوتی نشدم. لطفاً دوباره واضح بگویید یا از دکمه‌ها استفاده کنید.');
      return;
    }
    // Gemini flagged something ambiguous (e.g. "did you mean size 3?") —
    // surface that to the customer instead of silently dropping it, so they
    // get a chance to correct it before the order is finalized.
    if (clean.clarification_needed) {
      await sendMessage(env, chatId, `❓ ${clean.clarification_needed}`);
    }

    let merged = mergeVoicePending(workingState, clean);

    // If address is the only thing left and the model didn't isolate a
    // structured address, we can only safely fall back to the raw transcript
    // when THIS message was address-only to begin with (no size/weight/items
    // extracted from it) — otherwise the transcript still contains the
    // size/weight phrasing too (e.g. "۲۵ کیلو سایز ۳ سوپر فضلی") and using it
    // as-is would save garbage like that as the customer's address. In that
    // mixed case we don't guess — we just prompt for the address again on
    // its own. (Since a completed pending pair is folded into items[]
    // immediately by mergeVoicePending, checking items.length here — rather
    // than the old pending_size/pending_weight check — is what still lets
    // this fallback fire once at least one item is confirmed.)
    if (
      (merged.items || []).length > 0 &&
      !merged.address &&
      !merged.address_id &&
      !clean.address &&
      clean.size == null &&
      clean.weight_kg == null &&
      !(clean.items && clean.items.length)
    ) {
      merged = { ...merged, address: clean.transcript };
    }

    if (voiceOrderIsComplete(merged)) {
      await finalizeVoiceOrder(env, chatId, merged, message.from);
      return;
    }

    const wizardMsgId = await promptForMissingVoiceOrderField(env, chatId, merged);
    await setTgState(env, chatId, { ...merged, wizard_msg_id: wizardMsgId });
    return;
  }

  // Admin-only button (see adminMenuKeyboard vs customerMenuKeyboard — a
  // non-admin never sees this label). Deliberately does NOT call
  // findCustomerByChatId on the admin's own chat: this button always means
  // "register a brand-new customer", regardless of whether the admin's own
  // Telegram account happens to be linked to some customer row. Tagging the
  // state with origin: 'admin_add' also tells createOrderAndRoute not to
  // stamp the admin's chat id onto the new customer as telegram_chat_id
  // (see there for why that used to cause this exact bug to recur).
  if (text === '➕ مشتری جدید') {
    const initialState = { step: 'hub', origin: 'admin_add', hub_mode: true, items: [] };
    const wizardMsgId = await renderHub(env, chatId, initialState);
    await setTgState(env, chatId, { ...initialState, wizard_msg_id: wizardMsgId });
    return;
  }

  if (text === '➕ ثبت سفارش جدید') {
    const existing = await findCustomerByChatId(env, chatId);
    if (existing) {
      const addrRows = await env.DB.prepare(
        `SELECT * FROM addresses WHERE customer_id = ? ORDER BY id DESC`
      )
        .bind(existing.id)
        .all();
      const addrList = addrRows.results || [];
      if (addrList.length) {
        const wizardMsgId = await sendWizardMessage(
          env,
          chatId,
          `سفارش جدید برای ${escapeHtml(existing.first_name)} ${escapeHtml(existing.last_name)}.\nآدرس این سفارش را انتخاب کنید:`,
          addressInlineKeyboard(addrList)
        );
        await setTgState(env, chatId, {
          step: 'address_select',
          customer_id: existing.id,
          items: [],
          wizard_msg_id: wizardMsgId,
        });
      } else {
        // fallback safety net — should not normally happen for an existing customer
        const wizardMsgId = await sendWizardMessage(env, chatId, 'آدرس این سفارش را وارد کنید:', cancelOnlyKeyboard);
        await setTgState(env, chatId, {
          step: 'address_new_entry',
          customer_id: existing.id,
          items: [],
          wizard_msg_id: wizardMsgId,
        });
      }
    } else {
      const initialState = { step: 'hub', hub_mode: true, items: [] };
      const wizardMsgId = await renderHub(env, chatId, initialState);
      await setTgState(env, chatId, { ...initialState, wizard_msg_id: wizardMsgId });
    }
    return;
  }

  if (text === '📋 لیست مشتریان') {
    if (await isAdminSender(env, message.from)) {
      await sendCustomerListPage(env, chatId, null, 0);
    } else {
      await sendOwnCustomerInfo(env, chatId);
    }
    return;
  }

  // Admin-only button (see adminMenuKeyboard vs customerMenuKeyboard — a
  // non-admin never sees this label, but we still gate on isAdminSender
  // rather than trusting the keyboard alone, same as every other admin
  // button here). Shows the current 'delivery_areas' setting and offers an
  // inline "add one" button rather than duplicating full edit/delete/reorder
  // controls that already live in the web admin panel.
  if (text === '🗺 مناطق تحویل') {
    if (!(await isAdminSender(env, message.from))) return;
    const areas = await getDeliveryAreas(env);
    await sendMessage(env, chatId, deliveryAreasText(areas), deliveryAreasKeyboard());
    return;
  }

  if (text === '🧾 سفارش های من') {
    await sendOwnCustomerInfo(env, chatId);
    return;
  }

  if (text === '✏️ ویرایش اطلاعات من') {
    const existing = await findCustomerByChatId(env, chatId);
    if (!existing) {
      // Same guard pattern as voice ordering — unregistered customers are
      // pointed at registration instead of an edit menu with nothing to edit.
      await sendMessage(
        env,
        chatId,
        'برای ویرایش اطلاعات ابتدا باید یک‌بار به‌عنوان مشتری ثبت‌نام کنید. لطفاً از دکمه زیر استفاده کنید:',
        await mainMenuKeyboardFor(env, message.from)
      );
      return;
    }
    const addresses = await getCustomerAddresses(env, existing.id);
    await sendMessage(env, chatId, editInfoMenuText(existing, addresses.length), editInfoMenuKeyboard());
    return;
  }

  switch (state.step) {
    case 'name': {
      const parts = text.split(/\s+/);
      const first_name = parts[0] || text;
      const last_name = parts.slice(1).join(' ');
      await setTgState(env, chatId, {
        ...state,
        step: 'name_confirm',
        pending_first_name: first_name,
        pending_last_name: last_name,
      });
      await editMessageText(
        env,
        chatId,
        state.wizard_msg_id,
        `نام ثبت شد: ${[first_name, last_name].filter(Boolean).join(' ')}`,
        confirmEditKeyboard('name')
      );
      await deleteCustomerMessage(env, chatId, message.message_id);
      break;
    }
    case 'name_confirm': {
      // Button-driven only — stray typed text here is just discarded.
      await deleteCustomerMessage(env, chatId, message.message_id);
      break;
    }
    case 'phone': {
      const digitsOnly = text.replace(/\D/g, '');
      if (digitsOnly.length < 8) {
        await editMessageText(
          env,
          chatId,
          state.wizard_msg_id,
          'شماره تماس نامعتبر است. لطفاً دوباره وارد کنید (فقط عدد، حداقل ۸ رقم):',
          cancelOnlyKeyboard
        );
        await deleteCustomerMessage(env, chatId, message.message_id);
        return;
      }
      await setTgState(env, chatId, { ...state, step: 'phone_confirm', pending_phone: text.trim() });
      await editMessageText(
        env,
        chatId,
        state.wizard_msg_id,
        `شماره ثبت شد: ${text.trim()}`,
        confirmEditKeyboard('phone')
      );
      await deleteCustomerMessage(env, chatId, message.message_id);
      break;
    }
    case 'phone_confirm': {
      await deleteCustomerMessage(env, chatId, message.message_id);
      break;
    }
    case 'address': {
      await setTgState(env, chatId, { ...state, step: 'address_confirm', pending_address: text });
      await editMessageText(
        env,
        chatId,
        state.wizard_msg_id,
        `آدرس ثبت شد: ${text}`,
        confirmEditKeyboard('address')
      );
      await deleteCustomerMessage(env, chatId, message.message_id);
      break;
    }
    case 'address_confirm': {
      await deleteCustomerMessage(env, chatId, message.message_id);
      break;
    }
    // Free text, committed directly (no confirm sub-step, unlike name/phone/
    // address) — shop_name is optional and, since hub_mode always returns
    // to the hub after an edit, a typo is just one more tap away from being
    // fixed rather than gating progress to the next field the way the old
    // linear flow's confirm step did.
    case 'shop_name': {
      const newState = { ...state, shop_name: text.trim() || null, step: 'hub' };
      await setTgState(env, chatId, newState);
      await renderHub(env, chatId, newState);
      await deleteCustomerMessage(env, chatId, message.message_id);
      break;
    }
    case 'edit_name': {
      const parts = text.split(/\s+/);
      const first_name = parts[0] || text;
      const last_name = parts.slice(1).join(' ');
      await setTgState(env, chatId, {
        ...state,
        step: 'edit_name_confirm',
        pending_first_name: first_name,
        pending_last_name: last_name,
      });
      await editMessageText(
        env,
        chatId,
        state.wizard_msg_id,
        `نام جدید: ${[first_name, last_name].filter(Boolean).join(' ')}`,
        confirmEditKeyboard('edit_name')
      );
      await deleteCustomerMessage(env, chatId, message.message_id);
      break;
    }
    case 'edit_name_confirm': {
      // Button-driven only — stray typed text here is just discarded.
      await deleteCustomerMessage(env, chatId, message.message_id);
      break;
    }
    case 'edit_phone': {
      const digitsOnly = text.replace(/\D/g, '');
      if (digitsOnly.length < 8) {
        await editMessageText(
          env,
          chatId,
          state.wizard_msg_id,
          'شماره تماس نامعتبر است. لطفاً دوباره وارد کنید (فقط عدد، حداقل ۸ رقم):',
          cancelOnlyKeyboard
        );
        await deleteCustomerMessage(env, chatId, message.message_id);
        return;
      }
      await setTgState(env, chatId, { ...state, step: 'edit_phone_confirm', pending_phone: text.trim() });
      await editMessageText(
        env,
        chatId,
        state.wizard_msg_id,
        `شماره جدید: ${text.trim()}`,
        confirmEditKeyboard('edit_phone')
      );
      await deleteCustomerMessage(env, chatId, message.message_id);
      break;
    }
    case 'edit_phone_confirm': {
      await deleteCustomerMessage(env, chatId, message.message_id);
      break;
    }
    case 'addrmgr_new_entry': {
      // No confirm step here (unlike name/phone) — findOrCreateAddress
      // already dedupes near-identical text, and this always inserts a
      // fresh row rather than mutating any existing one, so there's
      // nothing destructive to double-check before committing.
      await findOrCreateAddress(env, state.customer_id, text);
      await clearTgState(env, chatId);
      const addresses = await getCustomerAddresses(env, state.customer_id);
      await editMessageText(
        env,
        chatId,
        state.wizard_msg_id,
        addressManageListText(addresses),
        addressManageKeyboard(addresses)
      );
      await deleteCustomerMessage(env, chatId, message.message_id);
      break;
    }
    // NOTE: business type is now chosen via inline buttons (see 'btype:' in
    // handleCallbackQuery) rather than typed text, so the flow chains
    // instead of posting a new message. There is intentionally no text-based
    // case for it anymore — if the user types instead of tapping a button,
    // they just fall through to the default case below and can still tap
    // the buttons on the still-visible wizard message.
    case 'hub_address_search': {
      // Same server-side privacy boundary as addrsearch:start/addrsearchpick
      // in handleCallbackQuery — reaching this step at all should already
      // require origin === 'admin_add', but re-checking here too means a
      // forged/replayed state transition can't bypass the boundary just by
      // skipping straight to the text-entry step.
      if (state.origin !== 'admin_add' || !(await isAdminSender(env, message.from))) {
        await clearTgState(env, chatId);
        await sendMessage(env, chatId, 'اجازه دسترسی ندارید.', await mainMenuKeyboardFor(env, message.from));
        return;
      }
      const matches = await findSimilarAddresses(env, text, { threshold: 0, limit: 5 });
      await deleteCustomerMessage(env, chatId, message.message_id);
      if (!matches.length) {
        await editMessageText(
          env,
          chatId,
          state.wizard_msg_id,
          'نتیجه‌ای یافت نشد. عبارت دیگری امتحان کنید یا آدرس را مستقیم بنویسید:',
          hubAddressEntryKeyboard()
        );
        return;
      }
      const rows = matches.map((m) => [
        { text: m.address.length > 40 ? `${m.address.slice(0, 40)}…` : m.address, callback_data: `addrsearchpick:${m.id}` },
      ]);
      rows.push([{ text: '✏️ جستجوی دوباره', callback_data: 'addrsearch:start' }]);
      rows.push(CANCEL_INLINE_ROW);
      await setTgState(env, chatId, { ...state, step: 'hub_address_search_results' });
      await editMessageText(env, chatId, state.wizard_msg_id, 'نزدیک‌ترین آدرس‌های یافت‌شده — یکی را انتخاب کنید:', {
        inline_keyboard: rows,
      });
      return;
    }
    case 'address_new_entry': {
      const addressId = await findOrCreateAddress(env, state.customer_id, text);
      await setTgState(env, chatId, { ...state, step: 'size_select', address_id: addressId });
      await editMessageText(env, chatId, state.wizard_msg_id, 'سایز پلاستیک را انتخاب کنید:', sizeInlineKeyboard());
      await deleteCustomerMessage(env, chatId, message.message_id);
      break;
    }
    case 'voice_order': {
      // Customer typed instead of tapping a button or sending voice —
      // interpret the text as whichever field is still missing.
      if (state.pending_size == null) {
        const n = parseInt(text.trim(), 10);
        if (SIZES.includes(n)) {
          const newState = foldPendingItem({ ...state, pending_size: n });
          const wizardMsgId = await promptForMissingVoiceOrderField(env, chatId, newState);
          await setTgState(env, chatId, { ...newState, wizard_msg_id: wizardMsgId });
        } else {
          await editMessageText(env, chatId, state.wizard_msg_id, 'لطفاً سایز را با دکمه انتخاب کنید یا با ویس بگویید:', sizeInlineKeyboard());
        }
        return;
      }
      if (!(state.pending_weight > 0)) {
        const w = parseFloat(text.replace(',', '.'));
        if (!isNaN(w) && w > 0) {
          const newState = foldPendingItem({ ...state, pending_weight: w });
          const wizardMsgId = await promptForMissingVoiceOrderField(env, chatId, newState);
          await setTgState(env, chatId, { ...newState, wizard_msg_id: wizardMsgId });
        } else {
          await editMessageText(
            env,
            chatId,
            state.wizard_msg_id,
            weightSelectPrompt(state.pending_size, state.pending_weight || 0),
            weightSelectionKeyboard((state.pending_history || []).length > 0)
          );
        }
        return;
      }
      // Only the address is left — free text is the address itself.
      await finalizeVoiceOrder(env, chatId, { ...state, address: text.trim() }, message.from);
      break;
    }
    case 'weight_custom_entry': {
      const weight = parseFloat(text.replace(',', '.'));
      if (isNaN(weight) || weight <= 0) {
        await editMessageText(env, chatId, state.wizard_msg_id, 'لطفاً یک عدد معتبر برای مقدار (کیلوگرم) وارد کنید:', cancelOnlyKeyboard);
        await deleteCustomerMessage(env, chatId, message.message_id);
        return;
      }
      const newWeight = (state.pending_weight || 0) + weight;
      const history = [...(state.pending_history || []), weight];
      await deleteCustomerMessage(env, chatId, message.message_id);

      if (state.prev_step === 'voice_order') {
        const newState = foldPendingItem({ ...state, step: 'voice_order', prev_step: undefined, pending_weight: newWeight, pending_history: history });
        if (voiceOrderIsComplete(newState)) {
          await finalizeVoiceOrder(env, chatId, newState, message.from);
        } else {
          const wizardMsgId = await promptForMissingVoiceOrderField(env, chatId, newState);
          await setTgState(env, chatId, { ...newState, wizard_msg_id: wizardMsgId });
        }
        return;
      }

      await setTgState(env, chatId, { ...state, step: 'weight_select', prev_step: undefined, pending_weight: newWeight, pending_history: history });
      await editMessageText(
        env,
        chatId,
        state.wizard_msg_id,
        weightSelectPrompt(state.pending_size, newWeight),
        weightSelectionKeyboard(history.length > 0)
      );
      break;
    }
    case 'awaiting_receipt': {
      await sendMessage(env, chatId, 'لطفاً عکس فیش واریزی را ارسال کنید.');
      break;
    }
    default:
      await sendMessage(env, chatId, 'برای شروع از منوی زیر استفاده کنید:', await mainMenuKeyboardFor(env, message.from));
  }
}

// ---------------------------------------------------------------------------
// Invoice builder
// ---------------------------------------------------------------------------

function formatToman(n) {
  return Math.round(n).toLocaleString('en-US');
}

// items: array of { size, weight_kg, unit_price } (unit_price already snapshotted)
// Returns a formatted invoice string ready to send as a Telegram message.
async function buildInvoiceText(env, { customer, orderId, items, paymentLink }) {
  const { business_name: businessName, business_address: businessAddress, business_phone: businessPhone } =
    await getSettings(env, ['business_name', 'business_address', 'business_phone']);

  // The customer's actual delivery address for THIS order — previously
  // never looked up here, so the invoice only ever showed the store's own
  // address (businessAddress above), never where the order should ship. A
  // customer can have multiple saved addresses (see the addresses table),
  // so this has to come from orders.address_id for the specific order, not
  // just customers.address (which is only the first-ever registered one).
  const orderAddressRow = await env.DB.prepare(
    `SELECT a.address AS address_text FROM orders o
     LEFT JOIN addresses a ON a.id = o.address_id
     WHERE o.id = ?`
  )
    .bind(orderId)
    .first();
  const deliveryAddress = orderAddressRow?.address_text || customer?.address || null;

  const lines = [];
  lines.push('🧾 فاکتور فروش');
  if (businessName) lines.push(escapeHtml(businessName));
  if (businessAddress) lines.push(`آدرس: ${escapeHtml(businessAddress)}`);
  if (businessPhone) lines.push(`تلفن: ${escapeHtml(businessPhone)}`);
  lines.push('———————————————');
  lines.push(`شماره فاکتور: ${String(orderId).padStart(6, '0')}`);
  lines.push(`تاریخ: ${new Date().toLocaleDateString('fa-IR')}`);
  if (customer) {
    lines.push(`مشتری: ${escapeHtml(customer.first_name)} ${escapeHtml(customer.last_name || '')}`.trim());
    if (customer.shop_name) lines.push(`نام مغازه: ${escapeHtml(customer.shop_name)}`);
    if (customer.business_type) lines.push(`صنف: ${escapeHtml(customer.business_type)}`);
    if (deliveryAddress) lines.push(`آدرس تحویل: ${escapeHtml(deliveryAddress)}`);
  }
  lines.push('———————————————');

  let total = 0;
  for (const it of items) {
    const subtotal = it.weight_kg * it.unit_price;
    total += subtotal;
    lines.push(
      `سایز ${it.size}  ×  ${it.weight_kg} کیلوگرم  ×  ${formatToman(it.unit_price)} تومان`
    );
    lines.push(`  = ${formatToman(subtotal)} تومان`);
  }
  lines.push('———————————————');
  lines.push(`مبلغ کل: ${formatToman(total)} تومان`);

  if (paymentLink) {
    // paymentLink is a URL and will very likely contain a raw '&' in its
    // query string (Zarinpal links do) — escaping it is required for the
    // HTML parse to succeed; Telegram's HTML parser correctly decodes
    // '&amp;' back to '&' when displaying, so the visible/auto-linked text
    // is unaffected.
    lines.push('');
    lines.push(`برای پرداخت: ${escapeHtml(paymentLink)}`);
  }

  return { text: lines.join('\n'), total };
}

// Shared by the button-driven "finish_order" callback and the voice-order
// flow below: creates the customer (if new), the order + order_items, and
// routes to either the admin invoice screen or the customer payment-method
// screen. `messageId` is the wizard message to edit in place; `sender` is
// the Telegram `from` object used for the admin/customer routing check.
async function createOrderAndRoute(env, chatId, messageId, state, sender) {
  let customerId = state.customer_id;
  let addressId = state.address_id;
  let orderId;
  let justCreatedCustomer = false;
  let items = state.items || [];

  if (!customerId) {
    // Duplicate-registration guard: an admin may have already registered
    // this person by phone (origin: 'admin_add', telegram_chat_id left
    // NULL — see note below). If they now message the bot themselves and
    // give the same phone number during self-registration, link to that
    // existing record instead of silently creating a second customer row
    // for the same person. Only ever matches an UNLINKED record — an
    // account that's already linked to some other chat is never touched.
    let linkedExisting = null;
    if (state.origin !== 'admin_add' && state.phone_number) {
      linkedExisting = await env.DB.prepare(
        `SELECT * FROM customers WHERE phone_number = ? AND telegram_chat_id IS NULL LIMIT 1`
      )
        .bind(state.phone_number)
        .first();
    }

    if (linkedExisting) {
      customerId = linkedExisting.id;
      await env.DB.prepare(`UPDATE customers SET telegram_chat_id = ? WHERE id = ?`)
        .bind(String(chatId), customerId)
        .run();
      // Reuse/create the address for THIS order under the now-linked
      // customer (dedup via findOrCreateAddress) rather than assuming the
      // admin-entered address is necessarily where this order should ship.
      addressId = await findOrCreateAddress(env, customerId, state.address, state.area || null);
    } else {
      // When an admin registers a brand-new customer (origin: 'admin_add'),
      // `chatId` here is the ADMIN's own chat, not the customer's — the real
      // customer never texted the bot themselves (the admin is entering their
      // details by phone/in person). Stamping the admin's chat id onto this
      // row used to make findCustomerByChatId(adminChatId) match it on the
      // very next "add customer" tap, silently skipping name/phone/address
      // entry from then on. Leaving telegram_chat_id NULL here means this
      // customer simply has no linked Telegram account yet, which is correct;
      // if they later message the bot themselves with the same phone number,
      // the branch above links them instead of duplicating this row.
      const telegramChatIdForNewCustomer = state.origin === 'admin_add' ? null : String(chatId);
      const { first_name: storedFirstName, last_name: storedLastName } = resolveNameForStorage(state);
      const res = await env.DB.prepare(
        `INSERT INTO customers (first_name, last_name, address, business_type, shop_name, telegram_chat_id, phone_number)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          storedFirstName,
          storedLastName,
          state.address,
          // business_type is optional in the hub-and-spoke wizard (agreed
          // 2026-07-11), but the column is NOT NULL — default to '' (same
          // pattern as last_name) rather than migrate the schema.
          state.business_type || '',
          state.shop_name || null,
          telegramChatIdForNewCustomer,
          state.phone_number || null
        )
        .run();
      customerId = res.meta.last_row_id;

      // First address for a brand-new customer also becomes their first row
      // in the addresses table, so it's selectable for future orders too.
      const addrRes = await env.DB.prepare(
        `INSERT INTO addresses (customer_id, address, area) VALUES (?, ?, ?)`
      )
        .bind(customerId, state.address, state.area || null)
        .run();
      addressId = addrRes.meta.last_row_id;
      justCreatedCustomer = true;
    }
  }

  // customer/address were just created above but the order (and its items)
  // aren't a single D1 batch with them — a batch can't consume an
  // auto-generated id from an earlier statement in the same call, so the
  // order has to be inserted as its own round-trip once customerId/addressId
  // are known. If that round-trip (or the items insert right after it)
  // fails partway for a brand-new customer, don't leave an orphaned
  // customer+address with no order behind — compensate by deleting what we
  // just created and let the error propagate so the caller can tell the
  // user to retry.
  try {
    const orderRes = await env.DB.prepare(
      `INSERT INTO orders (customer_id, address_id, payment_status) VALUES (?, ?, 'unpaid')`
    )
      .bind(customerId, addressId)
      .run();
    orderId = orderRes.meta.last_row_id;

    const sizePrices = await getSizePrices(env);
    // Snapshot each item's unit price at order time so later price changes
    // don't retroactively alter already-issued invoices.
    for (const it of items) it.unit_price = sizePrices[it.size] || 0;

    if (items.length) {
      await env.DB.batch(
        items.map((it) =>
          env.DB.prepare(
            `INSERT INTO order_items (order_id, size, weight_kg, unit_price) VALUES (?, ?, ?, ?)`
          ).bind(orderId, it.size, it.weight_kg, it.unit_price)
        )
      );
    }

    // New order starts as unpaid debt. Computed from `items` directly (not
    // a fresh SELECT) since unit_price was just snapshotted onto them above.
    const newOrderTotal = items.reduce((sum, it) => sum + it.weight_kg * it.unit_price, 0);
    if (newOrderTotal > 0) {
      await env.DB.prepare(`UPDATE customers SET debt_amount = debt_amount + ? WHERE id = ?`)
        .bind(newOrderTotal, customerId)
        .run();
    }
  } catch (e) {
    if (justCreatedCustomer) {
      try {
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM orders WHERE id = ?`).bind(orderId ?? -1),
          env.DB.prepare(`DELETE FROM addresses WHERE id = ?`).bind(addressId),
          env.DB.prepare(`DELETE FROM customers WHERE id = ?`).bind(customerId),
        ]);
      } catch (cleanupError) {
        console.error('createOrderAndRoute compensating cleanup failed:', cleanupError);
      }
    }
    throw e;
  }

  const customer = await env.DB.prepare(`SELECT * FROM customers WHERE id = ?`)
    .bind(customerId)
    .first();

  const senderIsAdmin = await isAdminSender(env, sender);

  if (senderIsAdmin) {
    // Admin registered/ordered directly — they can finalize payment status
    // themselves, so there's no need for the payment-method screen.
    await setTgState(env, chatId, { step: 'idle' });
    const staticPaymentLink = await getSetting(env, 'payment_link');
    const { text: invoiceText } = await buildInvoiceText(env, {
      customer,
      orderId,
      items,
      paymentLink: staticPaymentLink,
    });
    await editMessageText(
      env,
      chatId,
      messageId,
      `${invoiceText}\n\nوضعیت پرداخت؟`,
      paymentStatusInlineKeyboard(orderId)
    );
  } else {
    // Regular customer — let them pick how they'll pay first. Each method
    // needs different follow-up (gateway link, card-to-card receipt
    // upload, or nothing for cash on delivery), so we hold order state
    // until they choose instead of building the invoice right away.
    await setTgState(env, chatId, {
      step: 'payment_method_select',
      order_id: orderId,
      customer_id: customerId,
      items,
      wizard_msg_id: messageId,
    });
    await editMessageText(env, chatId, messageId, 'روش پرداخت را انتخاب کنید:', paymentMethodInlineKeyboard(orderId));
  }
}

// Figures out what's still missing from a voice order in progress and sends
// (or edits, if a wizard message already exists) a prompt that pairs the
// question with the *same* inline keyboard the button-driven flow uses —
// e.g. sizeInlineKeyboard() or weightSelectionKeyboard() — so the customer
// can answer either by tapping a button or by sending another voice note.
// Returns the message_id of the prompt so callers can save it as
// wizard_msg_id in tg_state.
async function promptForMissingVoiceOrderField(env, chatId, state) {
  const itemCount = (state.items || []).length;
  const known = [];
  if (itemCount) known.push(`${itemCount} قلم ثبت شده`);
  if (state.pending_size != null) known.push(`سایز ${state.pending_size}`);
  if (state.pending_weight) known.push(`${fmtKg(state.pending_weight)} کیلوگرم`);
  const knownPrefix = known.length ? `متوجه شدم: ${known.join('، ')}.\n` : '';

  let text;
  let keyboard;

  if (state.pending_size == null && !itemCount) {
    // Nothing at all yet — first item, ask for its size.
    text = `${knownPrefix}سایز پلاستیک را انتخاب کنید یا با ویس بگویید:`;
    keyboard = sizeInlineKeyboard();
  } else if (state.pending_size != null && !(state.pending_weight > 0)) {
    // A size is chosen for the item currently in progress but its weight
    // isn't set yet.
    text = `${knownPrefix}${weightSelectPrompt(state.pending_size, state.pending_weight || 0)}\n(یا با ویس هم می‌توانید بگویید)`;
    keyboard = weightSelectionKeyboard((state.pending_history || []).length > 0);
  } else {
    // At least one item is confirmed and nothing is mid-flight (a completed
    // pending pair is always folded into items[] immediately — see
    // foldPendingItem) — offer to add another size or move on to address.
    const addrRows = await env.DB.prepare(`SELECT * FROM addresses WHERE customer_id = ? ORDER BY id DESC`)
      .bind(state.customer_id)
      .all();
    const addrList = addrRows.results || [];
    const itemsSummary = (state.items || [])
      .map((it) => `سایز ${it.size} — ${fmtKg(it.weight_kg)} کیلوگرم`)
      .join('\n');
    text = `${knownPrefix}اقلام تاکنون:\n${itemsSummary}\n\nسایز دیگری اضافه می‌کنید یا آدرس تحویل را مشخص می‌کنید؟ (با متن/ویس هم می‌توانید آدرس بگویید)`;
    keyboard = voiceItemHybridKeyboard(addrList);
  }

  if (state.wizard_msg_id) {
    await editMessageText(env, chatId, state.wizard_msg_id, text, keyboard);
    return state.wizard_msg_id;
  }
  return sendWizardMessage(env, chatId, text, keyboard);
}

// Re-sends (as a brand-new message, so it's visible at the bottom of the
// chat instead of wherever the original wizard message scrolled to) the
// prompt + keyboard for whatever step the customer is currently stuck on.
// This is what lets the voice-message guard below actually get someone
// unstuck instead of just telling them buttons exist somewhere above.
async function resendCurrentStepPrompt(env, chatId, state) {
  switch (state.step) {
    case 'name':
      return sendMessage(env, chatId, 'نام و نام خانوادگی مشتری را وارد کنید:', cancelOnlyKeyboard);
    case 'name_confirm':
      return sendMessage(
        env,
        chatId,
        `نام ثبت شد: ${escapeHtml([state.pending_first_name, state.pending_last_name].filter(Boolean).join(' '))}`,
        confirmEditKeyboard('name')
      );
    case 'phone':
      return sendMessage(env, chatId, 'شماره تماس مشتری را وارد کنید:', cancelOnlyKeyboard);
    case 'phone_confirm':
      return sendMessage(env, chatId, `شماره ثبت شد: ${escapeHtml(state.pending_phone)}`, confirmEditKeyboard('phone'));
    case 'address':
      return sendMessage(env, chatId, 'آدرس مشتری را وارد کنید:', cancelOnlyKeyboard);
    case 'address_confirm':
      return sendMessage(env, chatId, `آدرس ثبت شد: ${escapeHtml(state.pending_address)}`, confirmEditKeyboard('address'));
    case 'edit_name':
      return sendMessage(env, chatId, 'نام و نام خانوادگی جدید را وارد کنید:', cancelOnlyKeyboard);
    case 'edit_name_confirm':
      return sendMessage(
        env,
        chatId,
        `نام جدید: ${escapeHtml([state.pending_first_name, state.pending_last_name].filter(Boolean).join(' '))}`,
        confirmEditKeyboard('edit_name')
      );
    case 'edit_phone':
      return sendMessage(env, chatId, 'شماره تماس جدید را وارد کنید:', cancelOnlyKeyboard);
    case 'edit_phone_confirm':
      return sendMessage(env, chatId, `شماره جدید: ${escapeHtml(state.pending_phone)}`, confirmEditKeyboard('edit_phone'));
    case 'business_type':
      return sendMessage(env, chatId, 'صنف مشتری را انتخاب کنید:', businessTypeInlineKeyboard());
    case 'shop_name':
      return sendMessage(env, chatId, 'نام مغازه را وارد کنید:', cancelOnlyKeyboard);
    case 'area': {
      const areas = await getDeliveryAreas(env);
      if (!areas.length) {
        return sendMessage(env, chatId, 'هنوز لیست مناطق تنظیم نشده است (از پنل ادمین اضافه کنید).', cancelOnlyKeyboard);
      }
      return sendMessage(env, chatId, 'منطقه تحویل مشتری را انتخاب کنید:', areaInlineKeyboard(areas));
    }
    case 'address_new_entry':
      return sendMessage(env, chatId, 'آدرس این سفارش را وارد کنید:', cancelOnlyKeyboard);
    case 'address_select': {
      const addrRows = await env.DB.prepare(
        `SELECT * FROM addresses WHERE customer_id = ? ORDER BY id DESC`
      )
        .bind(state.customer_id)
        .all();
      return sendMessage(env, chatId, 'آدرس این سفارش را انتخاب کنید:', addressInlineKeyboard(addrRows.results || []));
    }
    case 'size_select':
      return sendMessage(env, chatId, 'سایز پلاستیک را انتخاب کنید:', sizeInlineKeyboard());
    case 'weight_select':
      return sendMessage(
        env,
        chatId,
        weightSelectPrompt(state.pending_size, state.pending_weight || 0),
        weightSelectionKeyboard((state.pending_history || []).length > 0)
      );
    case 'weight_custom_entry':
      return sendMessage(env, chatId, 'مقدار وزن دلخواه را به کیلوگرم بنویسید:', cancelOnlyKeyboard);
    case 'size_or_finish':
      return sendMessage(
        env,
        chatId,
        'سایز دیگری اضافه می‌کنید یا سفارش را نهایی می‌کنید؟',
        afterSizeInlineKeyboardFor(state.hub_mode)
      );
    case 'hub':
      return sendMessage(env, chatId, hubText(), hubKeyboard(state));
    case 'hub_address_search':
      return sendMessage(env, chatId, 'عبارت جستجو را وارد کنید:', cancelOnlyKeyboard);
    case 'hub_address_search_results':
      return sendMessage(env, chatId, 'لطفاً یکی از آدرس‌های یافت‌شده را انتخاب کنید یا دوباره جستجو کنید.', {
        inline_keyboard: [[{ text: '🔍 جستجوی دوباره', callback_data: 'addrsearch:start' }], CANCEL_INLINE_ROW],
      });
    case 'address_dup_confirm':
      return sendMessage(env, chatId, `آیا منظور شما این آدرس است؟\n${escapeHtml(state.dup_candidate_text || '')}`, {
        inline_keyboard: [
          [
            { text: '✅ بله همین است', callback_data: 'addrdup:accept' },
            { text: '❌ خیر، جدید است', callback_data: 'addrdup:reject' },
          ],
          CANCEL_INLINE_ROW,
        ],
      });
    case 'payment_method_select':
      if (state.order_id) {
        return sendMessage(env, chatId, 'روش پرداخت را انتخاب کنید:', paymentMethodInlineKeyboard(state.order_id));
      }
      return null;
    case 'awaiting_receipt':
      return sendMessage(env, chatId, 'لطفاً عکس فیش واریزی را ارسال کنید.');
    default:
      return null;
  }
}

// Finalizes a completed voice order (size + weight + address all known,
// however they were gathered across one or more voice messages / button
// taps): inserts the address row if a fresh address was given as text, then
// hands off to the same order-creation/payment-routing logic used by the
// button-driven flow.
async function finalizeVoiceOrder(env, chatId, state, sender) {
  let addressId = state.address_id || null;
  if (!addressId && state.address) {
    addressId = await findOrCreateAddress(env, state.customer_id, state.address, state.area || null);
  }
  // Defensive fold: every call site is expected to have already folded a
  // completed pending pair into items[] before reaching here, but this
  // keeps finalize itself correct even if ever invoked with a dangling one.
  const folded = foldPendingItem(state);
  await createOrderAndRoute(
    env,
    chatId,
    state.wizard_msg_id,
    { ...folded, address_id: addressId },
    sender
  );
}

async function handleCallbackQuery(env, cbq, origin) {
  const chatId = cbq.message.chat.id;
  const messageId = cbq.message.message_id;
  const data = cbq.data || '';
  const state = await getTgState(env, chatId);

  await recordAdminChatId(env, cbq.from);

  // Cancel button shown on every inline keyboard throughout the order flow
  // (see CANCEL_INLINE_ROW / cancelOnlyKeyboard) — reachable with a tap
  // regardless of which step the customer is on, including free-text steps
  // (name/phone/address) that used to rely on a global typed-word catch.
  if (data === 'order_cancel') {
    await answerCallbackQuery(env, cbq.id);

    // "➕ افزودن منطقه جدید" isn't part of the order/registration flow at
    // all, so it gets its own short-circuit here rather than falling into
    // the "سفارش لغو شد" (order cancelled) wording below, which wouldn't
    // make sense for it.
    if (state && state.step === 'awaiting_new_area') {
      await clearTgState(env, chatId);
      await editMessageText(env, chatId, messageId, 'لغو شد.');
      await sendMessage(env, chatId, 'برای ادامه از منو استفاده کنید:', await mainMenuKeyboardFor(env, cbq.from));
      return;
    }

    // Hub-and-spoke registration: cancelling FROM INSIDE a field's sub-flow
    // (name/phone/address/business_type/size_select/weight_select/
    // size_or_finish/address search, etc.) returns to the hub screen with
    // nothing lost, rather than aborting the whole registration — only the
    // hub's own ❌ لغو (state.step === 'hub') does a full abort, handled by
    // falling through to the code below.
    if (state && state.hub_mode && state.step !== 'hub') {
      const hubState = {
        ...state,
        step: 'hub',
        wizard_msg_id: messageId,
        // Discard partial/in-progress values from whichever sub-flow is
        // being cancelled — committed fields (first_name, phone_number,
        // address, business_type, items) are untouched.
        pending_first_name: undefined,
        pending_last_name: undefined,
        pending_phone: undefined,
        pending_address: undefined,
        pending_size: undefined,
        pending_weight: undefined,
        pending_history: undefined,
        dup_candidate_id: undefined,
        dup_candidate_text: undefined,
      };
      await setTgState(env, chatId, hubState);
      await renderHub(env, chatId, hubState);
      return;
    }

    await clearTgState(env, chatId);
    await editMessageText(env, chatId, messageId, 'سفارش لغو شد.');
    await sendMessage(env, chatId, 'برای شروع دوباره از منوی زیر استفاده کنید:', await mainMenuKeyboardFor(env, cbq.from));
    return;
  }

  if (data.startsWith('wconfirm:')) {
    const [, field, action] = data.split(':');
    await answerCallbackQuery(env, cbq.id);

    if (action === 'edit') {
      const rePrompts = {
        name: 'نام و نام خانوادگی مشتری را وارد کنید:',
        phone: 'شماره تماس مشتری را وارد کنید:',
        address: 'آدرس مشتری را وارد کنید:',
        edit_name: 'نام و نام خانوادگی جدید را وارد کنید:',
        edit_phone: 'شماره تماس جدید را وارد کنید:',
      };
      if (!rePrompts[field]) return;
      await setTgState(env, chatId, { ...state, step: field, wizard_msg_id: messageId });
      await editMessageText(env, chatId, messageId, rePrompts[field], cancelOnlyKeyboard);
      return;
    }

    if (action === 'yes') {
      if (field === 'name') {
        const newState = {
          ...state,
          first_name: state.pending_first_name,
          last_name: state.pending_last_name,
          wizard_msg_id: messageId,
        };
        if (state.hub_mode) {
          const hubState = { ...newState, step: 'hub' };
          await setTgState(env, chatId, hubState);
          await renderHub(env, chatId, hubState);
          return;
        }
        await setTgState(env, chatId, { ...newState, step: 'phone' });
        await editMessageText(env, chatId, messageId, 'شماره تماس مشتری را وارد کنید:', cancelOnlyKeyboard);
        return;
      }
      if (field === 'phone') {
        const newState = { ...state, phone_number: state.pending_phone, wizard_msg_id: messageId };
        if (state.hub_mode) {
          const hubState = { ...newState, step: 'hub' };
          await setTgState(env, chatId, hubState);
          await renderHub(env, chatId, hubState);
          return;
        }
        await setTgState(env, chatId, { ...newState, step: 'address' });
        await editMessageText(env, chatId, messageId, 'آدرس مشتری را وارد کنید:', cancelOnlyKeyboard);
        return;
      }
      if (field === 'address') {
        // Admin, hub-mode: silently run the automatic duplicate/similarity
        // check before accepting a brand-new typed address (only when this
        // wasn't already picked via the search-as-you-type flow, which sets
        // state.address directly and never reaches this confirm step for
        // that value). Self-registration skips this — no cross-customer
        // address exposure for a random Telegram user.
        if (state.hub_mode && state.origin === 'admin_add') {
          const matches = await findSimilarAddresses(env, state.pending_address, {
            threshold: ADDRESS_SIMILARITY_THRESHOLD,
            limit: 1,
          });
          if (matches.length) {
            const candidate = matches[0];
            const dupState = {
              ...state,
              step: 'address_dup_confirm',
              dup_candidate_id: candidate.id,
              dup_candidate_text: candidate.address,
              wizard_msg_id: messageId,
            };
            await setTgState(env, chatId, dupState);
            await editMessageText(
              env,
              chatId,
              messageId,
              `آیا منظور شما این آدرس است؟\n${escapeHtml(candidate.address)}`,
              {
                inline_keyboard: [
                  [
                    { text: '✅ بله همین است', callback_data: 'addrdup:accept' },
                    { text: '❌ خیر، جدید است', callback_data: 'addrdup:reject' },
                  ],
                  CANCEL_INLINE_ROW,
                ],
              }
            );
            return;
          }
        }
        const newState = { ...state, address: state.pending_address, wizard_msg_id: messageId };
        if (state.hub_mode) {
          const hubState = { ...newState, step: 'hub' };
          await setTgState(env, chatId, hubState);
          await renderHub(env, chatId, hubState);
          return;
        }
        await setTgState(env, chatId, { ...newState, step: 'business_type' });
        await editMessageText(env, chatId, messageId, 'صنف مشتری را انتخاب کنید:', businessTypeInlineKeyboard());
        return;
      }
      if (field === 'edit_name') {
        await env.DB.prepare(`UPDATE customers SET first_name = ?, last_name = ? WHERE id = ?`)
          .bind(state.pending_first_name, state.pending_last_name, state.customer_id)
          .run();
        await clearTgState(env, chatId);
        await editMessageText(env, chatId, messageId, '✅ نام با موفقیت به‌روزرسانی شد.');
        return;
      }
      if (field === 'edit_phone') {
        await env.DB.prepare(`UPDATE customers SET phone_number = ? WHERE id = ?`)
          .bind(state.pending_phone, state.customer_id)
          .run();
        await clearTgState(env, chatId);
        await editMessageText(env, chatId, messageId, '✅ شماره تماس با موفقیت به‌روزرسانی شد.');
        return;
      }
    }
    return;
  }

  if (data.startsWith('editinfo:')) {
    const action = data.split(':')[1];
    if (action === 'close') {
      await answerCallbackQuery(env, cbq.id);
      await deleteCustomerMessage(env, chatId, messageId);
      return;
    }
    if (action === 'name' || action === 'phone') {
      const existing = await findCustomerByChatId(env, chatId);
      if (!existing) {
        await answerCallbackQuery(env, cbq.id, 'مشتری یافت نشد.');
        return;
      }
      await answerCallbackQuery(env, cbq.id);
      const step = action === 'name' ? 'edit_name' : 'edit_phone';
      const prompt = action === 'name' ? 'نام و نام خانوادگی جدید را وارد کنید:' : 'شماره تماس جدید را وارد کنید:';
      await setTgState(env, chatId, { step, customer_id: existing.id, wizard_msg_id: messageId });
      await editMessageText(env, chatId, messageId, prompt, cancelOnlyKeyboard);
      return;
    }
    if (action === 'addresses') {
      const existing = await findCustomerByChatId(env, chatId);
      if (!existing) {
        await answerCallbackQuery(env, cbq.id, 'مشتری یافت نشد.');
        return;
      }
      await answerCallbackQuery(env, cbq.id);
      const addresses = await getCustomerAddresses(env, existing.id);
      await editMessageText(
        env,
        chatId,
        messageId,
        addressManageListText(addresses),
        addressManageKeyboard(addresses)
      );
      return;
    }
    if (action === 'back') {
      const existing = await findCustomerByChatId(env, chatId);
      if (!existing) {
        await answerCallbackQuery(env, cbq.id, 'مشتری یافت نشد.');
        return;
      }
      await answerCallbackQuery(env, cbq.id);
      const addresses = await getCustomerAddresses(env, existing.id);
      await editMessageText(env, chatId, messageId, editInfoMenuText(existing, addresses.length), editInfoMenuKeyboard());
      return;
    }
    return;
  }

  // Plan D — address management (list / add / delete). Delete is blocked
  // whenever an order still references the address via orders.address_id,
  // since deleting it would orphan that order's address; the guard is
  // re-checked at actual delete time too, not just when offering the
  // confirm button, in case an order came in between the two taps.
  if (data.startsWith('addrmgr:')) {
    const parts = data.split(':');
    const action = parts[1];

    if (action === 'list') {
      const existing = await findCustomerByChatId(env, chatId);
      if (!existing) {
        await answerCallbackQuery(env, cbq.id, 'مشتری یافت نشد.');
        return;
      }
      await answerCallbackQuery(env, cbq.id);
      const addresses = await getCustomerAddresses(env, existing.id);
      await editMessageText(
        env,
        chatId,
        messageId,
        addressManageListText(addresses),
        addressManageKeyboard(addresses)
      );
      return;
    }

    if (action === 'new') {
      const existing = await findCustomerByChatId(env, chatId);
      if (!existing) {
        await answerCallbackQuery(env, cbq.id, 'مشتری یافت نشد.');
        return;
      }
      await answerCallbackQuery(env, cbq.id);
      await setTgState(env, chatId, { step: 'addrmgr_new_entry', customer_id: existing.id, wizard_msg_id: messageId });
      await editMessageText(env, chatId, messageId, 'آدرس جدید را وارد کنید:', cancelOnlyKeyboard);
      return;
    }

    if (action === 'ask_delete') {
      const addressId = parseInt(parts[2], 10);
      if (isNaN(addressId)) {
        await answerCallbackQuery(env, cbq.id, 'شناسه آدرس نامعتبر است.', true);
        return;
      }
      const inUse = await env.DB.prepare(`SELECT COUNT(*) AS c FROM orders WHERE address_id = ?`)
        .bind(addressId)
        .first();
      if (inUse && inUse.c > 0) {
        await answerCallbackQuery(env, cbq.id, 'این آدرس در سفارش‌های قبلی استفاده شده و قابل حذف نیست.', true);
        return;
      }
      await answerCallbackQuery(env, cbq.id);
      await editMessageText(env, chatId, messageId, 'آیا از حذف این آدرس مطمئن هستید؟', {
        inline_keyboard: [
          [
            { text: '✅ بله، حذف شود', callback_data: `addrmgr:del:${addressId}` },
            { text: '↩️ انصراف', callback_data: 'addrmgr:list' },
          ],
        ],
      });
      return;
    }

    if (action === 'del') {
      const addressId = parseInt(parts[2], 10);
      if (isNaN(addressId)) {
        await answerCallbackQuery(env, cbq.id, 'شناسه آدرس نامعتبر است.', true);
        return;
      }
      const existing = await findCustomerByChatId(env, chatId);
      if (!existing) {
        await answerCallbackQuery(env, cbq.id, 'مشتری یافت نشد.');
        return;
      }
      const inUse = await env.DB.prepare(`SELECT COUNT(*) AS c FROM orders WHERE address_id = ?`)
        .bind(addressId)
        .first();
      if (inUse && inUse.c > 0) {
        await answerCallbackQuery(env, cbq.id, 'این آدرس دیگر قابل حذف نیست.', true);
      } else {
        await env.DB.prepare(`DELETE FROM addresses WHERE id = ? AND customer_id = ?`)
          .bind(addressId, existing.id)
          .run();
        await answerCallbackQuery(env, cbq.id, '✅ آدرس حذف شد.');
      }
      const addresses = await getCustomerAddresses(env, existing.id);
      await editMessageText(
        env,
        chatId,
        messageId,
        addressManageListText(addresses),
        addressManageKeyboard(addresses)
      );
      return;
    }

    return;
  }

  if (data.startsWith('hub:')) {
    const action = data.split(':')[1];

    if (action === 'name') {
      await answerCallbackQuery(env, cbq.id);
      await setTgState(env, chatId, { ...state, step: 'name', wizard_msg_id: messageId });
      await editMessageText(env, chatId, messageId, 'نام و نام خانوادگی مشتری را وارد کنید:', cancelOnlyKeyboard);
      return;
    }
    if (action === 'phone') {
      await answerCallbackQuery(env, cbq.id);
      await setTgState(env, chatId, { ...state, step: 'phone', wizard_msg_id: messageId });
      await editMessageText(env, chatId, messageId, 'شماره تماس مشتری را وارد کنید:', cancelOnlyKeyboard);
      return;
    }
    if (action === 'address') {
      await answerCallbackQuery(env, cbq.id);
      await setTgState(env, chatId, { ...state, step: 'address', wizard_msg_id: messageId });
      const keyboard = state.origin === 'admin_add' ? hubAddressEntryKeyboard() : cancelOnlyKeyboard;
      await editMessageText(env, chatId, messageId, 'آدرس مشتری را وارد کنید:', keyboard);
      return;
    }
    if (action === 'business_type') {
      await answerCallbackQuery(env, cbq.id);
      await setTgState(env, chatId, { ...state, step: 'business_type', wizard_msg_id: messageId });
      await editMessageText(env, chatId, messageId, 'صنف مشتری را انتخاب کنید:', businessTypeInlineKeyboard());
      return;
    }
    if (action === 'shop_name') {
      await answerCallbackQuery(env, cbq.id);
      await setTgState(env, chatId, { ...state, step: 'shop_name', wizard_msg_id: messageId });
      await editMessageText(env, chatId, messageId, 'نام مغازه را وارد کنید:', cancelOnlyKeyboard);
      return;
    }
    if (action === 'area') {
      const areas = await getDeliveryAreas(env);
      if (!areas.length) {
        await answerCallbackQuery(env, cbq.id, 'هنوز لیست مناطق در پنل ادمین تنظیم نشده است.', true);
        return;
      }
      await answerCallbackQuery(env, cbq.id);
      await setTgState(env, chatId, { ...state, step: 'area', wizard_msg_id: messageId });
      await editMessageText(env, chatId, messageId, 'منطقه تحویل مشتری را انتخاب کنید:', areaInlineKeyboard(areas));
      return;
    }
    if (action === 'items') {
      await answerCallbackQuery(env, cbq.id);
      await setTgState(env, chatId, { ...state, step: 'size_select', wizard_msg_id: messageId });
      await editMessageText(env, chatId, messageId, 'سایز پلاستیک را انتخاب کنید:', sizeInlineKeyboard());
      return;
    }
    if (action === 'submit') {
      const missing = hubMissingFields(state);
      if (missing.length) {
        await answerCallbackQuery(env, cbq.id, `اطلاعات ناقص است: ${missing.join('، ')}`, true);
        return;
      }
      await answerCallbackQuery(env, cbq.id);
      await createOrderAndRoute(env, chatId, messageId, state, cbq.from);
      return;
    }
    return;
  }

  if (data === 'addrsearch:start') {
    // Server-side enforcement of the admin-only privacy boundary — the
    // button itself is only ever shown when state.origin === 'admin_add',
    // but callback_data is just a string sent back to us and isn't proof of
    // which buttons were actually rendered for this chat. Without this
    // check here too, a self-registering customer could reach the same
    // search-across-all-customers-addresses flow just by sending this
    // literal callback string, which is exactly what must never happen.
    if (state.origin !== 'admin_add' || !(await isAdminSender(env, cbq.from))) {
      await answerCallbackQuery(env, cbq.id, 'اجازه دسترسی ندارید.');
      return;
    }
    await answerCallbackQuery(env, cbq.id);
    await setTgState(env, chatId, { ...state, step: 'hub_address_search', wizard_msg_id: messageId });
    await editMessageText(env, chatId, messageId, 'عبارت جستجو را وارد کنید (مثلاً نام خیابان یا محله):', cancelOnlyKeyboard);
    return;
  }

  if (data.startsWith('addrsearchpick:')) {
    // Same server-side boundary as addrsearch:start above — a forged/replayed
    // callback here would otherwise let anyone read back an arbitrary
    // addresses.id row regardless of whose customer record it belongs to.
    if (state.origin !== 'admin_add' || !(await isAdminSender(env, cbq.from))) {
      await answerCallbackQuery(env, cbq.id, 'اجازه دسترسی ندارید.');
      return;
    }
    const addrId = parseInt(data.split(':')[1], 10);
    await answerCallbackQuery(env, cbq.id);
    const row = await env.DB.prepare(`SELECT * FROM addresses WHERE id = ?`).bind(addrId).first();
    const hubState = { ...state, address: row ? row.address : state.address, step: 'hub', wizard_msg_id: messageId };
    await setTgState(env, chatId, hubState);
    await renderHub(env, chatId, hubState);
    return;
  }

  if (data === 'addrdup:accept') {
    await answerCallbackQuery(env, cbq.id);
    const hubState = {
      ...state,
      address: state.dup_candidate_text,
      step: 'hub',
      wizard_msg_id: messageId,
      dup_candidate_id: undefined,
      dup_candidate_text: undefined,
    };
    await setTgState(env, chatId, hubState);
    await renderHub(env, chatId, hubState);
    return;
  }

  if (data === 'addrdup:reject') {
    await answerCallbackQuery(env, cbq.id);
    const hubState = {
      ...state,
      address: state.pending_address,
      step: 'hub',
      wizard_msg_id: messageId,
      dup_candidate_id: undefined,
      dup_candidate_text: undefined,
    };
    await setTgState(env, chatId, hubState);
    await renderHub(env, chatId, hubState);
    return;
  }

  if (data.startsWith('btype:')) {
    const idx = parseInt(data.split(':')[1], 10);
    const businessType = BUSINESS_TYPES[idx];
    if (!businessType) {
      await answerCallbackQuery(env, cbq.id, 'گزینه نامعتبر است.');
      return;
    }
    await answerCallbackQuery(env, cbq.id);
    if (state.hub_mode) {
      const hubState = { ...state, business_type: businessType, step: 'hub', wizard_msg_id: messageId };
      await setTgState(env, chatId, hubState);
      await renderHub(env, chatId, hubState);
      return;
    }
    await setTgState(env, chatId, {
      ...state,
      step: 'size_select',
      business_type: businessType,
      items: [],
      wizard_msg_id: messageId,
    });
    await editMessageText(env, chatId, messageId, 'سایز پلاستیک را انتخاب کنید:', sizeInlineKeyboard());
    return;
  }

  if (data.startsWith('area:')) {
    const idx = parseInt(data.split(':')[1], 10);
    const areas = await getDeliveryAreas(env);
    const area = areas[idx];
    if (!area) {
      await answerCallbackQuery(env, cbq.id, 'گزینه نامعتبر است.');
      return;
    }
    await answerCallbackQuery(env, cbq.id);
    // Only reachable via 'hub:area' above, so always hub_mode — no
    // linear-flow branch needed the way btype: has one.
    const hubState = { ...state, area, step: 'hub', wizard_msg_id: messageId };
    await setTgState(env, chatId, hubState);
    await renderHub(env, chatId, hubState);
    return;
  }

  if (data.startsWith('size:')) {
    const size = parseInt(data.split(':')[1], 10);
    await answerCallbackQuery(env, cbq.id);

    if (state.step === 'voice_order') {
      // foldPendingItem: if a weight was already captured (e.g. via an
      // earlier voice fragment) before this size tap, this immediately
      // completes that item and folds it into items[].
      const newState = foldPendingItem({ ...state, pending_size: size, wizard_msg_id: messageId });
      if (voiceOrderIsComplete(newState)) {
        await finalizeVoiceOrder(env, chatId, newState, cbq.from);
      } else {
        const wizardMsgId = await promptForMissingVoiceOrderField(env, chatId, newState);
        await setTgState(env, chatId, { ...newState, wizard_msg_id: wizardMsgId });
      }
      return;
    }

    // Preserve any weight already known (e.g. this size tap is completing a
    // voice-initiated order in the button-driven weight_select screen)
    // instead of always resetting it to 0.
    const weight = state.pending_weight || 0;
    const history = state.pending_history || [];
    await setTgState(env, chatId, {
      ...state,
      step: 'weight_select',
      pending_size: size,
      pending_weight: weight,
      pending_history: history,
      wizard_msg_id: messageId,
    });
    await editMessageText(env, chatId, messageId, weightSelectPrompt(size, weight), weightSelectionKeyboard(history.length > 0));
    return;
  }

  if (data.startsWith('wkg:add:')) {
    const amt = parseFloat(data.split(':')[2]);
    const newWeight = (state.pending_weight || 0) + amt;
    const history = [...(state.pending_history || []), amt];
    await setTgState(env, chatId, { ...state, pending_weight: newWeight, pending_history: history, wizard_msg_id: messageId });
    await answerCallbackQuery(env, cbq.id);
    await editMessageText(
      env,
      chatId,
      messageId,
      weightSelectPrompt(state.pending_size, newWeight),
      weightSelectionKeyboard(history.length > 0)
    );
    return;
  }

  if (data === 'wkg:undo') {
    const history = [...(state.pending_history || [])];
    const last = history.pop();
    const newWeight = Math.max(0, (state.pending_weight || 0) - (last || 0));
    await setTgState(env, chatId, { ...state, pending_weight: newWeight, pending_history: history, wizard_msg_id: messageId });
    await answerCallbackQuery(env, cbq.id);
    await editMessageText(
      env,
      chatId,
      messageId,
      weightSelectPrompt(state.pending_size, newWeight),
      weightSelectionKeyboard(history.length > 0)
    );
    return;
  }

  if (data === 'wkg:custom') {
    // prev_step remembers where to route back to once the typed amount
    // comes in (see the weight_custom_entry case in handleMessage) —
    // needed because this step temporarily overwrites state.step, and a
    // voice_order in progress needs to resume as voice_order afterward.
    await setTgState(env, chatId, { ...state, step: 'weight_custom_entry', prev_step: state.step, wizard_msg_id: messageId });
    await answerCallbackQuery(env, cbq.id);
    await editMessageText(
      env,
      chatId,
      messageId,
      `مقدار دلخواه (کیلوگرم) برای سایز ${state.pending_size} را وارد کنید:`
    );
    return;
  }

  if (data === 'wkg:confirm') {
    if (!state.pending_weight || state.pending_weight <= 0) {
      await answerCallbackQuery(env, cbq.id, 'حداقل یک مقدار انتخاب کنید.');
      return;
    }
    await answerCallbackQuery(env, cbq.id);

    if (state.step === 'voice_order') {
      const newState = foldPendingItem({ ...state, wizard_msg_id: messageId });
      if (voiceOrderIsComplete(newState)) {
        await finalizeVoiceOrder(env, chatId, newState, cbq.from);
      } else {
        const wizardMsgId = await promptForMissingVoiceOrderField(env, chatId, newState);
        await setTgState(env, chatId, { ...newState, wizard_msg_id: wizardMsgId });
      }
      return;
    }

    const items = [...(state.items || []), { size: state.pending_size, weight_kg: state.pending_weight }];
    const size = state.pending_size;
    const weight = state.pending_weight;
    await setTgState(env, chatId, {
      ...state,
      step: 'size_or_finish',
      items,
      pending_size: undefined,
      pending_weight: undefined,
      pending_history: undefined,
      wizard_msg_id: messageId,
    });
    await editMessageText(
      env,
      chatId,
      messageId,
      `سایز ${size} — ${fmtKg(weight)} کیلوگرم ثبت شد.`,
      afterSizeInlineKeyboardFor(state.hub_mode)
    );
    return;
  }

  if (data.startsWith('addr:')) {
    const val = data.split(':')[1];
    await answerCallbackQuery(env, cbq.id);

    if (state.step === 'voice_order') {
      if (val === 'new') {
        await editMessageText(env, chatId, messageId, 'آدرس جدید را بنویسید یا با ویس بگویید:');
        await setTgState(env, chatId, { ...state, wizard_msg_id: messageId });
      } else {
        const addressId = parseInt(val, 10);
        await finalizeVoiceOrder(env, chatId, { ...state, address_id: addressId, wizard_msg_id: messageId }, cbq.from);
      }
      return;
    }

    if (val === 'new') {
      await setTgState(env, chatId, { ...state, step: 'address_new_entry', wizard_msg_id: messageId });
      await editMessageText(env, chatId, messageId, 'آدرس جدید را وارد کنید:');
    } else {
      const addressId = parseInt(val, 10);
      await setTgState(env, chatId, { ...state, step: 'size_select', address_id: addressId, wizard_msg_id: messageId });
      await editMessageText(env, chatId, messageId, 'سایز پلاستیک را انتخاب کنید:', sizeInlineKeyboard());
    }
    return;
  }

  if (data === 'voiceitem:addmore') {
    // Loops back into the size prompt while staying on step 'voice_order' —
    // this is what keeps the shared size:/wkg:confirm handlers routing
    // through the voice_order branches above instead of the button-driven
    // size_or_finish flow.
    await answerCallbackQuery(env, cbq.id);
    const newState = { ...state, pending_size: null, pending_weight: null, pending_history: [], wizard_msg_id: messageId };
    await setTgState(env, chatId, newState);
    await editMessageText(env, chatId, messageId, 'سایز پلاستیک را انتخاب کنید:', sizeInlineKeyboard());
    return;
  }

  if (data === 'add_size') {
    await setTgState(env, chatId, { ...state, step: 'size_select', wizard_msg_id: messageId });
    await answerCallbackQuery(env, cbq.id);
    await editMessageText(env, chatId, messageId, 'سایز پلاستیک را انتخاب کنید:', sizeInlineKeyboard());
    return;
  }

  if (data === 'finish_order') {
    await answerCallbackQuery(env, cbq.id);
    if (state.hub_mode) {
      const hubState = { ...state, step: 'hub', wizard_msg_id: messageId };
      await setTgState(env, chatId, hubState);
      await renderHub(env, chatId, hubState);
      return;
    }
    await createOrderAndRoute(env, chatId, messageId, state, cbq.from);
    return;
  }

  if (data.startsWith('pm:')) {
    const [, method, orderIdStr] = data.split(':');
    const orderId = parseInt(orderIdStr, 10);
    if (state.step !== 'payment_method_select' || state.order_id !== orderId) {
      await answerCallbackQuery(env, cbq.id, 'این سفارش دیگر معتبر نیست.');
      return;
    }
    await answerCallbackQuery(env, cbq.id);

    const items = state.items || [];
    const customerId = state.customer_id;
    const customer = await env.DB.prepare(`SELECT * FROM customers WHERE id = ?`)
      .bind(customerId)
      .first();
    await env.DB.prepare(`UPDATE orders SET payment_method = ? WHERE id = ?`).bind(method, orderId).run();

    if (method === 'gateway') {
      const orderTotal = items.reduce((sum, it) => sum + it.weight_kg * it.unit_price, 0);
      const staticPaymentLink = await getSetting(env, 'payment_link');
      let paymentLink = staticPaymentLink;
      if (origin) {
        const gatewayLink = await createZarinpalPaymentLink(env, {
          orderId,
          amount: orderTotal,
          description: `فاکتور شماره ${orderId}`,
          callbackUrl: `${origin}/payment/verify`,
        });
        if (gatewayLink) paymentLink = gatewayLink;
      }
      const { text: invoiceText } = await buildInvoiceText(env, { customer, orderId, items, paymentLink });
      await editMessageText(env, chatId, messageId, invoiceText);
      await sendMessage(env, chatId, 'برای ادامه از منو استفاده کنید:', await mainMenuKeyboardFor(env, cbq.from));
      await setTgState(env, chatId, { step: 'idle' });
      await notifyAdminsOfNewOrder(env, customerId, orderId, items, { method: 'gateway' });
      return;
    }

    if (method === 'card') {
      const { card_number: cardNumber, card_holder_name: cardHolder } = await getSettings(env, [
        'card_number',
        'card_holder_name',
      ]);
      const lines = ['🏦 پرداخت کارت به کارت'];
      if (cardNumber) lines.push(`شماره کارت: ${cardNumber}`);
      if (cardHolder) lines.push(`به نام: ${cardHolder}`);
      lines.push('', 'پس از واریز، لطفاً عکس فیش واریزی را همینجا ارسال کنید.');
      await editMessageText(env, chatId, messageId, lines.join('\n'));
      await setTgState(env, chatId, {
        step: 'awaiting_receipt',
        order_id: orderId,
        customer_id: customerId,
        wizard_msg_id: messageId,
      });
      // Admins are notified right away (not only once the receipt arrives),
      // so they still know an order exists even if the customer goes quiet.
      await notifyAdminsOfNewOrder(env, customerId, orderId, items, { method: 'card', pendingReceipt: true });
      return;
    }

    if (method === 'cod') {
      const { text: invoiceText } = await buildInvoiceText(env, { customer, orderId, items });
      await editMessageText(env, chatId, messageId, `${invoiceText}\n\n🚚 پرداخت در محل هنگام تحویل انجام می‌شود.`);
      await sendMessage(env, chatId, 'برای ادامه از منو استفاده کنید:', await mainMenuKeyboardFor(env, cbq.from));
      await setTgState(env, chatId, { step: 'idle' });
      await notifyAdminsOfNewOrder(env, customerId, orderId, items, { method: 'cod' });
      return;
    }

    await answerCallbackQuery(env, cbq.id, 'گزینه نامعتبر است.');
    return;
  }

  if (data.startsWith('pay:')) {
    if (!(await isAdminSender(env, cbq.from))) {
      await answerCallbackQuery(env, cbq.id, 'اجازه دسترسی ندارید.');
      return;
    }
    const [, status, orderIdStr] = data.split(':');
    const orderId = parseInt(orderIdStr, 10);
    const toggledCustomerId = await setOrderPaymentStatus(env, orderId, status);
    if (toggledCustomerId) {
      // Recompute from ALL of the customer's orders rather than copying this
      // single order's status — a customer with other still-unpaid orders
      // must stay 'unpaid' even though this particular order just got marked paid.
      await recomputeCustomerPaymentStatus(env, toggledCustomerId);
    }
    await answerCallbackQuery(env, cbq.id, 'ثبت شد');
    await editMessageText(
      env,
      chatId,
      messageId,
      `وضعیت پرداخت ثبت شد: ${status === 'paid' ? '✅ پرداخت شده' : '❌ پرداخت نشده'}`
    );
    await sendMessage(env, chatId, 'برای ادامه از منو استفاده کنید:', adminMenuKeyboard);
    return;
  }

  // Triggered by the "➕ افزودن منطقه جدید" button on the "🗺 مناطق تحویل"
  // screen (see deliveryAreasKeyboard). Puts the chat into a plain free-text
  // wait state — actual append-to-setting logic lives in the
  // state.step === 'awaiting_new_area' branch of handleMessage.
  if (data === 'areas:add') {
    if (!(await isAdminSender(env, cbq.from))) {
      await answerCallbackQuery(env, cbq.id, 'اجازه دسترسی ندارید.');
      return;
    }
    await answerCallbackQuery(env, cbq.id);
    await setTgState(env, chatId, { step: 'awaiting_new_area' });
    await sendMessage(env, chatId, 'نام منطقه‌ی جدید را ارسال کنید:', cancelOnlyKeyboard);
    return;
  }

  if (data.startsWith('page:')) {
    const page = parseInt(data.split(':')[1], 10);
    if (!(await isAdminSender(env, cbq.from))) {
      await answerCallbackQuery(env, cbq.id, 'اجازه دسترسی ندارید.');
      return;
    }
    await answerCallbackQuery(env, cbq.id);
    await sendCustomerListPage(env, chatId, messageId, page);
    return;
  }

  await answerCallbackQuery(env, cbq.id);
}

async function notifyAdminsOfNewOrder(env, customerId, orderId, items, opts = {}) {
  const adminChatIds = await getNotifiableAdminChatIds(env);
  if (!adminChatIds.length) return;

  const customer = await env.DB.prepare(`SELECT * FROM customers WHERE id = ?`)
    .bind(customerId)
    .first();
  const { text: invoiceText } = await buildInvoiceText(env, { customer, orderId, items });

  const methodLabels = {
    gateway: '💳 پرداخت آنلاین (درگاه)',
    card: '🏦 کارت به کارت' + (opts.pendingReceipt ? ' — منتظر فیش واریزی' : ''),
    cod: '🚚 پرداخت در محل',
  };
  const methodLine = methodLabels[opts.method];
  const header = methodLine ? `🆕 سفارش جدید از مشتری\n${methodLine}` : '🆕 سفارش جدید از مشتری';
  const text = `${header}\n\n${invoiceText}\n\nوضعیت پرداخت؟`;

  for (const chatId of adminChatIds) {
    try {
      await sendMessage(env, chatId, text, paymentStatusInlineKeyboard(orderId));
    } catch (e) {
      // e.g. admin blocked the bot — skip silently
    }
  }
}

async function sendOwnCustomerInfo(env, chatId) {
  const customer = await findCustomerByChatId(env, chatId);
  if (!customer) {
    await sendMessage(env, chatId, 'هنوز به عنوان مشتری ثبت نشده‌اید. برای ثبت از دکمه «➕ ثبت سفارش جدید» استفاده کنید.');
    return;
  }
  const line = await customerSummaryLine(env, customer);
  const orders = await env.DB.prepare(
    `SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT ${PAGE_SIZE}`
  )
    .bind(customer.id)
    .all();
  const orderList = orders.results || [];
  const orderLines = await Promise.all(
    orderList.map(async (o) => {
      const items = await env.DB.prepare(`SELECT * FROM order_items WHERE order_id = ?`).bind(o.id).all();
      const itemsStr = (items.results || [])
        .map((it) => `سایز ${it.size}: ${it.weight_kg} کیلوگرم`)
        .join(', ');
      const statusEmoji = o.payment_status === 'paid' ? '✅' : '❌';
      return `${statusEmoji} ${o.order_date} — ${itemsStr || 'بدون آیتم'}`;
    })
  );
  const text = `اطلاعات شما:\n${line}\n\nسفارش‌های اخیر:\n${orderLines.join('\n') || 'سفارشی ثبت نشده است.'}`;
  await sendMessage(env, chatId, text, customerMenuKeyboard);
}

async function sendCustomerListPage(env, chatId, messageId, page) {
  const offset = page * PAGE_SIZE;
  const rows = await env.DB.prepare(`SELECT * FROM customers ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(PAGE_SIZE + 1, offset)
    .all();
  const results = rows.results || [];
  const hasNext = results.length > PAGE_SIZE;
  const pageItems = results.slice(0, PAGE_SIZE);

  if (!pageItems.length) {
    const text = 'مشتری‌ای ثبت نشده است.';
    if (messageId) await editMessageText(env, chatId, messageId, text);
    else await sendMessage(env, chatId, text);
    return;
  }

  const lines = await Promise.all(pageItems.map((c) => customerSummaryLine(env, c)));
  const text = `📋 لیست مشتریان (صفحه ${page + 1}):\n\n${lines.join('\n')}`;
  const kb = paginationKeyboard(page, hasNext);

  if (messageId) await editMessageText(env, chatId, messageId, text, kb);
  else await sendMessage(env, chatId, text, kb);
}

// ---------------------------------------------------------------------------
// Admin web panel (/admin)
// ---------------------------------------------------------------------------

function htmlPage(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0f1115">
<title>پنل مدیریت — پلاستیک دسته‌دار</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#0f1115;
    --surface:#171a21;
    --surface-2:#1e222b;
    --border:#262b35;
    --text:#e7e9ec;
    --text-dim:#8b93a1;
    --accent:#14b8a6;
    --accent-ink:#04211d;
    --paid:#22c55e;
    --unpaid:#f43f5e;
  }
  *{ box-sizing:border-box; }
  html,body{ background:var(--bg); }
  body{
    font-family:'Vazirmatn', Tahoma, sans-serif;
    color:var(--text);
    margin:0;
    padding:0 0 3rem;
    font-variant-numeric: tabular-nums;
  }
  .topbar{
    position:sticky; top:0; z-index:10;
    display:flex; align-items:center; justify-content:space-between;
    padding:1rem 1.25rem;
    background:rgba(15,17,21,.9); backdrop-filter:blur(8px);
    border-bottom:1px solid var(--border);
  }
  .topbar h1{ font-size:1.05rem; font-weight:700; margin:0; letter-spacing:-.01em; }
  .topbar a{ color:var(--text-dim); text-decoration:none; font-size:.85rem; }
  .topbar a:hover{ color:var(--text); }
  .wrap{ max-width:760px; margin:0 auto; padding:1.25rem; }
  .card{
    background:var(--surface); border:1px solid var(--border); border-radius:16px;
    padding:1.25rem; margin-bottom:1.25rem;
  }
  .card h2{ font-size:1rem; font-weight:700; margin:0 0 .2rem; }
  .card .hint{ color:var(--text-dim); font-size:.8rem; margin:0 0 1rem; line-height:1.6; }
  label{ display:block; font-size:.78rem; color:var(--text-dim); margin:0 0 .3rem; }
  input, select{
    width:100%; padding:.65rem .8rem; margin:0 0 .8rem; border-radius:10px;
    border:1px solid var(--border); background:var(--surface-2); color:var(--text);
    font-family:inherit; font-size:.9rem;
  }
  input::placeholder{ color:#5b6472; }
  input:focus, select:focus, button:focus-visible{
    outline:2px solid var(--accent); outline-offset:1px; border-color:var(--accent);
  }
  select{ appearance:none; background-image:linear-gradient(45deg, transparent 50%, var(--text-dim) 50%), linear-gradient(135deg, var(--text-dim) 50%, transparent 50%); background-position: calc(100% - 18px) 1.1rem, calc(100% - 13px) 1.1rem; background-size:5px 5px; background-repeat:no-repeat; }
  button{
    background:var(--accent); color:var(--accent-ink); border:none; font-weight:700;
    padding:.7rem 1.1rem; border-radius:10px; cursor:pointer; font-family:inherit; font-size:.88rem;
  }
  button:hover{ filter:brightness(1.08); }
  button.secondary{ background:var(--surface-2); color:var(--text); border:1px solid var(--border); font-weight:500; }
  .field-grid{ display:grid; grid-template-columns:1fr 1fr; gap:0 .7rem; }
  .field-grid .full{ grid-column:1 / -1; }
  .toolbar-btn{ width:100%; margin-top:.2rem; }
  .list{ display:flex; flex-direction:column; gap:.6rem; }
  .row{
    background:var(--surface-2); border:1px solid var(--border); border-radius:12px;
    padding:.85rem .95rem;
  }
  .row-top{ display:flex; align-items:center; justify-content:space-between; gap:.6rem; margin-bottom:.5rem; }
  .row-name{ font-weight:700; font-size:.92rem; }
  .row-meta{ display:grid; grid-template-columns:1fr; gap:.3rem; font-size:.82rem; color:var(--text-dim); }
  .row-meta b{ color:var(--text); font-weight:600; }
  .row-actions{ margin-top:.6rem; display:flex; justify-content:flex-end; }
  /* Tag chip — modeled on a price/handle tag: pill body + a small punched hole */
  .tag{
    position:relative; display:inline-flex; align-items:center; gap:.4rem;
    padding:.3rem .7rem .3rem 1.3rem; border-radius:999px 8px 8px 999px;
    font-size:.74rem; font-weight:700; white-space:nowrap;
  }
  .tag::before{
    content:''; position:absolute; right:.5rem; top:50%; transform:translateY(-50%);
    width:6px; height:6px; border-radius:50%; background:var(--surface-2);
  }
  .tag-paid{ background:color-mix(in srgb, var(--paid) 22%, transparent); color:var(--paid); }
  .tag-unpaid{ background:color-mix(in srgb, var(--unpaid) 22%, transparent); color:var(--unpaid); }
  .money-line{ display:flex; gap:.9rem; font-size:.82rem; }
  .money-line b{ font-weight:600; color:var(--text-dim); }
  .money-debt{ color:var(--unpaid); font-weight:700; }
  .money-paid{ color:var(--paid); font-weight:700; }
  .orders-toggle{ background:none; border:none; color:var(--accent); font-weight:600; font-size:.78rem; padding:0; cursor:pointer; }
  .orders-panel{ margin-top:.6rem; padding-top:.6rem; border-top:1px dashed var(--border); display:flex; flex-direction:column; gap:.5rem; }
  .order-line{
    display:flex; align-items:center; justify-content:space-between; gap:.6rem;
    background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:.5rem .65rem; font-size:.78rem;
  }
  .order-line .order-info{ display:flex; flex-direction:column; gap:.15rem; color:var(--text-dim); }
  .order-line .order-info b{ color:var(--text); font-weight:600; }
  .order-line .order-actions{ display:flex; align-items:center; gap:.5rem; flex-shrink:0; }
  .order-toggle-btn{ padding:.25rem .6rem; font-size:.72rem; }
  .empty{ text-align:center; color:var(--text-dim); font-size:.85rem; padding:1.5rem 0; }
  .pager{ display:flex; justify-content:center; gap:.6rem; margin-top:1rem; }
  .status-msg{ font-size:.8rem; color:var(--paid); margin:.6rem 0 0; display:none; }
  .auth-wrap{ min-height:100vh; display:flex; align-items:center; justify-content:center; padding:1.5rem; }
  .auth-card{ width:100%; max-width:360px; text-align:center; }
  .auth-brand{ font-weight:800; font-size:1.15rem; margin-bottom:1.5rem; }
  .error{ color:var(--unpaid); font-size:.82rem; margin:0 0 .8rem; }
  @media (max-width:420px){ .field-grid{ grid-template-columns:1fr; } }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

async function handleAdminSetupOrLogin(request, env) {
  const authRow = await env.DB.prepare(`SELECT * FROM admin_auth LIMIT 1`).first();
  const cookies = parseCookies(request);
  const session = await getAdminSession(env, cookies.session);

  if (request.method === 'POST') {
    const form = await request.formData();
    if (!authRow) {
      // first-run setup
      const password = form.get('password');
      if (!password || password.length < 6) {
        return new Response(htmlPage(setupForm('رمز عبور باید حداقل ۶ کاراکتر باشد.')), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      const salt = randomHex(16);
      const hash = await pbkdf2Hash(password, salt);
      await env.DB.prepare(`INSERT INTO admin_auth (password_hash, salt) VALUES (?, ?)`)
        .bind(hash, salt)
        .run();
      const token = await createAdminSession(env);
      return redirectWithSession('/admin', token);
    } else {
      // login
      const lockedMs = adminLockRemainingMs(authRow);
      if (lockedMs > 0) {
        const mins = Math.ceil(lockedMs / 60000);
        return new Response(
          htmlPage(loginForm(`به دلیل تلاش‌های ناموفق زیاد، ورود موقتاً مسدود شده. حدود ${mins} دقیقه دیگر دوباره امتحان کنید.`)),
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
      const password = form.get('password');
      const hash = await pbkdf2Hash(password || '', authRow.salt);
      if (!timingSafeEqual(hash, authRow.password_hash)) {
        await recordAdminLoginFailure(env, authRow);
        return new Response(htmlPage(loginForm('رمز عبور اشتباه است.')), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      await resetAdminLoginFailures(env, authRow);
      const token = await createAdminSession(env);
      return redirectWithSession('/admin', token);
    }
  }

  // GET
  if (!authRow) {
    return new Response(htmlPage(setupForm()), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (!session) {
    const lockedMs = adminLockRemainingMs(authRow);
    if (lockedMs > 0) {
      const mins = Math.ceil(lockedMs / 60000);
      return new Response(
        htmlPage(loginForm(`به دلیل تلاش‌های ناموفق زیاد، ورود موقتاً مسدود شده. حدود ${mins} دقیقه دیگر دوباره امتحان کنید.`)),
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
    return new Response(htmlPage(loginForm()), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  return new Response(htmlPage(dashboardHtml()), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function redirectWithSession(location, token) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Set-Cookie': `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${
        SESSION_TTL_MS / 1000
      }`,
    },
  });
}

function setupForm(error) {
  return `<div class="auth-wrap"><div class="card auth-card">
    <div class="auth-brand">پلاستیک دسته‌دار</div>
    <h2>تعیین رمز عبور ادمین</h2>
    <p class="hint">این صفحه فقط در اولین بازدید نمایش داده می‌شود.</p>
    ${error ? `<p class="error">${error}</p>` : ''}
    <form method="POST">
      <input type="password" name="password" placeholder="رمز عبور جدید" required minlength="6">
      <button type="submit" style="width:100%">ثبت رمز عبور</button>
    </form>
  </div></div>`;
}

function loginForm(error) {
  return `<div class="auth-wrap"><div class="card auth-card">
    <div class="auth-brand">پلاستیک دسته‌دار</div>
    <h2>ورود ادمین</h2>
    ${error ? `<p class="error">${error}</p>` : ''}
    <form method="POST">
      <input type="password" name="password" placeholder="رمز عبور" required>
      <button type="submit" style="width:100%">ورود</button>
    </form>
  </div></div>`;
}

function dashboardHtml() {
  const optionsHtml = BUSINESS_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('');
  return `
  <div class="topbar">
    <h1>پلاستیک دسته‌دار</h1>
    <a href="/admin/logout">خروج</a>
  </div>
  <div class="wrap">

  <div class="card">
    <h2>لیست مشتریان</h2>
    <p class="hint">فیلتر کنید و روی «اعمال فیلتر» بزنید.</p>
    <div class="field-grid">
      <input id="f-address" class="full" placeholder="فیلتر آدرس">
      <select id="f-business-type">
        <option value="">همه اصناف</option>
        ${optionsHtml}
      </select>
      <select id="f-payment-status">
        <option value="">همه وضعیت‌ها</option>
        <option value="paid">پرداخت شده</option>
        <option value="unpaid">پرداخت نشده</option>
      </select>
      <select id="f-area">
        <option value="">همه مناطق</option>
      </select>
      <input id="f-min-kg" type="number" placeholder="حداقل کیلوگرم">
      <input id="f-max-kg" type="number" placeholder="حداکثر کیلوگرم">
    </div>
    <button class="toolbar-btn" onclick="loadPage(0)">اعمال فیلتر</button>
  </div>

  <div class="card">
    <div id="results" class="list"></div>
    <div id="pager" class="pager"></div>
  </div>

  <div class="card">
    <h2>مدیریت ادمین‌ها</h2>
    <p class="hint">شناسه عددی تلگرام یا نام کاربری (با یا بدون @) را وارد کنید. فقط افراد این لیست در بات، لیست کامل مشتریان را می‌بینند و می‌توانند وضعیت پرداخت را نهایی کنند؛ بقیه فقط اطلاعات خودشان را می‌بینند.</p>
    <div class="field-grid">
      <input id="new-admin-identifier" placeholder="آیدی عددی یا @username">
      <input id="new-admin-label" placeholder="برچسب (اختیاری)">
    </div>
    <button class="toolbar-btn" onclick="addAdmin()">افزودن ادمین</button>
    <div id="admins-list" class="list" style="margin-top:1rem"></div>
  </div>

  <div class="card">
    <h2>اطلاعات فاکتور</h2>
    <p class="hint">این اطلاعات در بالای فاکتوری که برای مشتری ارسال می‌شود نمایش داده می‌شود.</p>
    <div class="field-grid">
      <input id="business-name-input" placeholder="نام کسب‌وکار">
      <input id="business-phone-input" placeholder="شماره تماس">
    </div>
    <input id="business-address-input" placeholder="آدرس" style="margin-top:0.5rem">
    <h2 style="margin-top:1.5rem">لینک پرداخت</h2>
    <p class="hint">این لینک در پایین فاکتور مشتری عادی (نه ادمین) درج می‌شود.</p>
    <input id="payment-link-input" placeholder="https://...">
    <h2 style="margin-top:1.5rem">کارت به کارت</h2>
    <p class="hint">این اطلاعات هنگام انتخاب «کارت به کارت» توسط مشتری نمایش داده می‌شود.</p>
    <div class="field-grid">
      <input id="card-number-input" placeholder="شماره کارت">
      <input id="card-holder-input" placeholder="به نام">
    </div>
    <button class="toolbar-btn" onclick="saveSettings()">ذخیره</button>
    <p id="payment-link-status" class="status-msg">ذخیره شد ✅</p>
  </div>

  <div class="card">
    <h2>مناطق تحویل</h2>
    <p class="hint">لیست محله‌ها/مناطق تحویل، با کاما جدا کنید (مثلاً: ولنجک، سعادت‌آباد، شهرک غرب). این لیست هنگام ثبت آدرس مشتری — چه با صدا و چه دستی — برای انتخاب منطقه نمایش داده می‌شود و برای فیلتر کردن لیست مشتریان هم استفاده می‌شود.</p>
    <input id="delivery-areas-input" placeholder="ولنجک، سعادت‌آباد، شهرک غرب">
    <button class="toolbar-btn" onclick="saveDeliveryAreas()" style="margin-top:0.5rem">ذخیره</button>
    <p id="delivery-areas-status" class="status-msg">ذخیره شد ✅</p>
  </div>

  <div class="card">
    <h2>قیمت هر سایز</h2>
    <p class="hint">قیمت هر کیلوگرم (تومان) برای هر سایز پلاستیک — این قیمت‌ها هنگام ثبت سفارش در فاکتور استفاده می‌شوند.</p>
    <div id="prices-grid" class="field-grid"></div>
    <button class="toolbar-btn" onclick="savePrices()">ذخیره قیمت‌ها</button>
    <p id="prices-status" class="status-msg">ذخیره شد ✅</p>
  </div>

  <div class="card">
    <h2>پاکسازی دیتابیس</h2>
    <p class="hint">اسکن برای یافتن داده‌های ناقص یا باقی‌مانده (آدرس خالی/تکراری، نشست منقضی، ردیف‌های یتیم). چیزی حذف نمی‌شود مگر اینکه موارد را انتخاب کرده و «پاکسازی» را بزنید.</p>
    <button class="toolbar-btn" onclick="scanCleanup()">بررسی دیتابیس</button>
    <div id="cleanup-results" class="list" style="margin-top:1rem"></div>
    <button id="cleanup-run-btn" class="toolbar-btn" style="display:none;margin-top:0.75rem" onclick="runCleanup()">پاکسازی موارد انتخاب‌شده</button>
    <p id="cleanup-status" class="status-msg">پاکسازی انجام شد ✅</p>
  </div>

  <div class="card">
    <h2>مرورگر جداول دیتابیس</h2>
    <p class="hint">دسترسی مستقیم به هر جدول دیتابیس — مشاهده، ویرایش و حذف تک‌تک ردیف‌ها. برای حذف مشتری از این ابزار استفاده نکنید، از دکمه‌ی «حذف مشتری» در لیست بالا استفاده کنید تا سفارش‌های مرتبط هم پاک شوند.</p>
    <select id="db-table-select" onchange="loadDbTable(0)"></select>
    <div id="db-table-wrap" style="overflow-x:auto"><div id="db-table-results"></div></div>
    <div id="db-table-pager" class="pager"></div>
  </div>

  <div class="card">
    <h2>دانلود / پشتیبان‌گیری</h2>
    <p class="hint">خروجی یک جدول یا کل دیتابیس را دانلود کنید.</p>
    <div class="field-grid">
      <select id="export-table-select">
        <option value="">همه‌ی جداول (پشتیبان کامل، JSON)</option>
      </select>
    </div>
    <div style="display:flex;gap:.6rem">
      <button class="toolbar-btn secondary" onclick="downloadExport('json')" style="flex:1">دانلود JSON</button>
      <button id="export-csv-btn" class="toolbar-btn secondary" onclick="downloadExport('csv')" style="flex:1">دانلود CSV</button>
    </div>
  </div>

  </div>
  <script>
    // Any DB-sourced field (customer name, address, phone, admin identifier,
    // label, business type, ...) that gets interpolated into innerHTML must
    // go through this first — none of it is escaped server-side. Used
    // throughout the customer and admin list renderers below.
    function escHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[ch]));
    }
    function tag(status){
      const paid = status === 'paid';
      return \`<span class="tag \${paid ? 'tag-paid' : 'tag-unpaid'}">\${paid ? 'پرداخت شده' : 'پرداخت نشده'}</span>\`;
    }

    async function loadSettings() {
      const res = await fetch('/api/settings');
      if (res.status === 401) { window.location = '/admin'; return; }
      const data = await res.json();
      document.getElementById('payment-link-input').value = data.payment_link || '';
      document.getElementById('business-name-input').value = data.business_name || '';
      document.getElementById('business-address-input').value = data.business_address || '';
      document.getElementById('business-phone-input').value = data.business_phone || '';
      document.getElementById('card-number-input').value = data.card_number || '';
      document.getElementById('card-holder-input').value = data.card_holder_name || '';
      document.getElementById('delivery-areas-input').value = data.delivery_areas || '';
      const areaSelect = document.getElementById('f-area');
      const currentAreaFilter = areaSelect.value;
      const areasList = (data.delivery_areas || '').split(',').map((a) => a.trim()).filter(Boolean);
      areaSelect.innerHTML = '<option value="">همه مناطق</option>' +
        areasList.map((a) => \`<option value="\${escHtml(a)}">\${escHtml(a)}</option>\`).join('');
      areaSelect.value = currentAreaFilter; // preserve selection across re-populates (e.g. after saveDeliveryAreas)
    }
    async function saveDeliveryAreas() {
      const delivery_areas = document.getElementById('delivery-areas-input').value.trim();
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delivery_areas }),
      });
      if (!res.ok) { alert('خطا در ذخیره'); return; }
      const status = document.getElementById('delivery-areas-status');
      status.style.display = 'block';
      setTimeout(() => { status.style.display = 'none'; }, 2000);
      loadSettings(); // repopulate with the server-normalized (trimmed, deduped-empty) list
    }
    async function saveSettings() {
      const payment_link = document.getElementById('payment-link-input').value.trim();
      const business_name = document.getElementById('business-name-input').value.trim();
      const business_address = document.getElementById('business-address-input').value.trim();
      const business_phone = document.getElementById('business-phone-input').value.trim();
      const card_number = document.getElementById('card-number-input').value.trim();
      const card_holder_name = document.getElementById('card-holder-input').value.trim();
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_link, business_name, business_address, business_phone, card_number, card_holder_name }),
      });
      if (!res.ok) { alert('خطا در ذخیره'); return; }
      const status = document.getElementById('payment-link-status');
      status.style.display = 'block';
      setTimeout(() => { status.style.display = 'none'; }, 2000);
    }
    loadSettings();

    const SIZES = [1, 2, 3, 4, 5];
    async function loadPrices() {
      const res = await fetch('/api/prices');
      if (res.status === 401) { window.location = '/admin'; return; }
      const data = await res.json();
      const grid = document.getElementById('prices-grid');
      grid.innerHTML = SIZES.map(s => \`
        <label style="display:flex;flex-direction:column;gap:0.25rem;font-size:0.85rem;color:var(--text-dim)">
          سایز \${s} (تومان/کیلوگرم)
          <input type="number" min="0" step="1000" id="price-size-\${s}" value="\${data.prices?.[s] ?? 0}">
        </label>
      \`).join('');
    }
    async function savePrices() {
      const prices = {};
      SIZES.forEach(s => { prices[s] = document.getElementById('price-size-' + s).value; });
      const res = await fetch('/api/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'خطا در ذخیره'); return; }
      const status = document.getElementById('prices-status');
      status.style.display = 'block';
      setTimeout(() => { status.style.display = 'none'; }, 2000);
    }
    loadPrices();
  </script>
  <script>
    const CLEANUP_ORDER = [
      'trim_customer_addresses', 'admin_linked_customers', 'blank_customer_addresses',
      'empty_saved_addresses', 'duplicate_saved_addresses', 'orphaned_addresses',
      'orphaned_order_items', 'orphaned_payments', 'orphaned_receipts', 'expired_sessions',
    ];
    async function scanCleanup() {
      const box = document.getElementById('cleanup-results');
      box.innerHTML = '<div class="hint">در حال بررسی...</div>';
      document.getElementById('cleanup-run-btn').style.display = 'none';
      const res = await fetch('/api/cleanup/scan');
      if (res.status === 401) { window.location = '/admin'; return; }
      const data = await res.json();
      const keys = CLEANUP_ORDER.filter(k => data.issues[k] && data.issues[k].count > 0);
      if (!keys.length) {
        box.innerHTML = '<div class="empty">مشکلی پیدا نشد ✅</div>';
        return;
      }
      box.innerHTML = keys.map(k => {
        const issue = data.issues[k];
        const examplesHtml = issue.examples && issue.examples.length
          ? \`<div class="row-meta">\${issue.examples.map(e => \`<span>\${e}</span>\`).join('')}</div>\`
          : '';
        if (!issue.fixable) {
          return \`<div class="row"><div class="row-top"><span class="row-name">⚠️ \${issue.label} — \${issue.count} مورد</span></div>\${examplesHtml}</div>\`;
        }
        return \`<div class="row">
          <div class="row-top">
            <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
              <input type="checkbox" class="cleanup-check" value="\${k}" checked>
              <span class="row-name">\${issue.label} — \${issue.count} مورد</span>
            </label>
          </div>
          \${examplesHtml}
        </div>\`;
      }).join('');
      const anyFixable = keys.some(k => data.issues[k].fixable);
      document.getElementById('cleanup-run-btn').style.display = anyFixable ? 'inline-block' : 'none';
    }
    async function runCleanup() {
      const actions = Array.from(document.querySelectorAll('.cleanup-check:checked')).map(el => el.value);
      if (!actions.length) return;
      if (!confirm('این عملیات غیرقابل بازگشت است. مطمئنید؟')) return;
      const res = await fetch('/api/cleanup/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'خطا در پاکسازی'); return; }
      const status = document.getElementById('cleanup-status');
      status.style.display = 'block';
      setTimeout(() => { status.style.display = 'none'; }, 2500);
      scanCleanup();
    }
  </script>
  <script>
    let dbTables = [];
    let dbCurrentTable = null;
    let dbCurrentPage = 0;

    async function loadDbTableList() {
      const res = await fetch('/api/db/tables');
      if (res.status === 401) { window.location = '/admin'; return; }
      const data = await res.json();
      dbTables = data.tables || [];
      const tableSelect = document.getElementById('db-table-select');
      tableSelect.innerHTML = dbTables.map(t => \`<option value="\${t}">\${t}</option>\`).join('');
      const exportSelect = document.getElementById('export-table-select');
      exportSelect.innerHTML = '<option value="">همه‌ی جداول (پشتیبان کامل، JSON)</option>' +
        dbTables.map(t => \`<option value="\${t}">\${t}</option>\`).join('');
      if (dbTables.length) loadDbTable(0);
    }

    function dbCellInput(col, value) {
      const safe = (value === null || value === undefined ? '' : String(value)).replace(/"/g, '&quot;');
      return \`<input type="text" data-col="\${col}" value="\${safe}" style="margin:0;padding:.35rem .5rem;font-size:.78rem">\`;
    }

    async function loadDbTable(page) {
      const table = document.getElementById('db-table-select').value;
      if (!table) return;
      dbCurrentTable = table;
      dbCurrentPage = page;
      const box = document.getElementById('db-table-results');
      box.innerHTML = '<div class="hint">در حال بارگذاری...</div>';
      const res = await fetch('/api/db/tables/' + table + '/rows?page=' + page);
      if (res.status === 401) { window.location = '/admin'; return; }
      const data = await res.json();
      if (!res.ok) { box.innerHTML = '<div class="empty">' + (data.error || 'خطا') + '</div>'; return; }
      if (!data.rows.length) {
        box.innerHTML = '<div class="empty">ردیفی وجود ندارد.</div>';
      } else {
        const cols = data.columns;
        box.innerHTML = \`<table style="width:100%;border-collapse:collapse;font-size:.78rem">
          <thead><tr>\${cols.map(c => \`<th style="text-align:right;padding:.4rem;border-bottom:1px solid var(--border);color:var(--text-dim);white-space:nowrap">\${c}</th>\`).join('')}<th></th></tr></thead>
          <tbody>\${data.rows.map((row, i) => \`
            <tr data-row-index="\${i}" data-pk="\${row[data.primaryKey]}">
              \${cols.map(c => \`<td style="padding:.4rem;border-bottom:1px solid var(--border);white-space:nowrap">\${
                c === data.primaryKey
                  ? \`<b>\${row[c]}</b>\`
                  : \`<span class="db-cell-view">\${row[c] === null || row[c] === undefined ? '<span style="color:var(--text-dim)">NULL</span>' : String(row[c])}</span>\`
              }</td>\`).join('')}
              <td style="padding:.4rem;border-bottom:1px solid var(--border);white-space:nowrap">
                <button class="secondary" style="padding:.25rem .55rem;font-size:.72rem" onclick="dbEditRow(this)">ویرایش</button>
                <button class="secondary" style="padding:.25rem .55rem;font-size:.72rem;color:var(--unpaid)" onclick="dbDeleteRow(this)">حذف</button>
              </td>
            </tr>\`).join('')}
          </tbody>
        </table>\`;
      }
      const pager = document.getElementById('db-table-pager');
      pager.innerHTML = '';
      if (page > 0) {
        const b = document.createElement('button');
        b.className = 'secondary'; b.textContent = '← قبلی'; b.onclick = () => loadDbTable(page - 1);
        pager.appendChild(b);
      }
      if ((page + 1) * data.pageSize < data.total) {
        const b = document.createElement('button');
        b.className = 'secondary'; b.textContent = 'بعدی →'; b.onclick = () => loadDbTable(page + 1);
        pager.appendChild(b);
      }
    }

    function dbEditRow(btn) {
      const tr = btn.closest('tr');
      const pk = tr.dataset.pk;
      tr.querySelectorAll('td').forEach(td => {
        const view = td.querySelector('.db-cell-view');
        if (!view) return;
        const col = tr.closest('table').querySelectorAll('thead th')[Array.from(td.parentNode.children).indexOf(td)].textContent;
        td.innerHTML = dbCellInput(col, view.textContent === 'NULL' ? '' : view.textContent);
      });
      const actionsTd = tr.lastElementChild;
      actionsTd.innerHTML = \`
        <button class="secondary" style="padding:.25rem .55rem;font-size:.72rem" onclick="dbSaveRow(this, '\${pk}')">ذخیره</button>
        <button class="secondary" style="padding:.25rem .55rem;font-size:.72rem" onclick="loadDbTable(dbCurrentPage)">انصراف</button>
      \`;
    }

    async function dbSaveRow(btn, pk) {
      const tr = btn.closest('tr');
      const body = {};
      tr.querySelectorAll('input[data-col]').forEach(inp => { body[inp.dataset.col] = inp.value; });
      const res = await fetch('/api/db/tables/' + dbCurrentTable + '/rows/' + encodeURIComponent(pk), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data.error || 'خطا در ذخیره'); return; }
      loadDbTable(dbCurrentPage);
    }

    async function dbDeleteRow(btn) {
      const tr = btn.closest('tr');
      const pk = tr.dataset.pk;
      if (!confirm('این ردیف برای همیشه از جدول «' + dbCurrentTable + '» حذف می‌شود. ادامه می‌دهید؟')) return;
      const res = await fetch('/api/db/tables/' + dbCurrentTable + '/rows/' + encodeURIComponent(pk), { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data.error || 'خطا در حذف'); return; }
      loadDbTable(dbCurrentPage);
    }

    function downloadExport(format) {
      const table = document.getElementById('export-table-select').value;
      const params = new URLSearchParams({ format });
      if (table) params.set('table', table);
      window.location = '/api/db/export?' + params.toString();
    }

    document.getElementById('export-table-select').addEventListener('change', () => {
      const isAll = !document.getElementById('export-table-select').value;
      document.getElementById('export-csv-btn').style.display = isAll ? 'none' : 'inline-block';
    });

    loadDbTableList();
  </script>
  <script>
    async function loadAdmins() {
      const res = await fetch('/api/admins');
      if (res.status === 401) { window.location = '/admin'; return; }
      const data = await res.json();
      const list = document.getElementById('admins-list');
      if (!data.results.length) {
        list.innerHTML = '<div class="empty">هنوز ادمینی اضافه نشده است.</div>';
        return;
      }
      list.innerHTML = data.results.map(a => {
        const linked = a.identifier_type === 'id' || !!a.telegram_user_id;
        const linkBadge = a.identifier_type === 'username'
          ? \`<span class="tag \${linked ? 'tag-paid' : 'tag-unpaid'}">\${linked ? 'متصل — پیام دریافت می‌کند' : 'منتظر اولین پیام به بات'}</span>\`
          : '';
        return \`<div class="row">
        <div class="row-top">
          <span class="row-name">\${escHtml(a.identifier)}</span>
          <span class="tag secondary" style="background:var(--surface);color:var(--text-dim)">\${a.identifier_type === 'id' ? 'آیدی عددی' : 'یوزرنیم'}</span>
        </div>
        <div class="row-meta">\${a.label ? \`<span><b>برچسب:</b> \${escHtml(a.label)}</span>\` : ''}</div>
        <div class="row-actions" style="justify-content:space-between">\${linkBadge}<button class="secondary" onclick="removeAdmin(\${a.id})">حذف</button></div>
      </div>\`;
      }).join('');
    }
    async function addAdmin() {
      const identifier = document.getElementById('new-admin-identifier').value.trim();
      const label = document.getElementById('new-admin-label').value.trim();
      if (!identifier) return;
      const res = await fetch('/api/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, label }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'خطا'); return; }
      document.getElementById('new-admin-identifier').value = '';
      document.getElementById('new-admin-label').value = '';
      loadAdmins();
    }
    async function removeAdmin(id) {
      await fetch('/api/admins/' + id, { method: 'DELETE' });
      loadAdmins();
    }
    loadAdmins();
  </script>
  <script>
    // customers.address only ever holds the FIRST address a customer ever
    // registered — it goes stale the moment they save a new one via the bot's
    // address manager. all_addresses (from the API) is every row currently in
    // the addresses table for this customer, so this renders whichever of
    // those aren't just the same text as the (editable) primary address above.
    function otherAddressesHtml(c) {
      if (!c.all_addresses) return '';
      const primary = (c.address || '').trim();
      const others = c.all_addresses.split('|||').map(a => a.trim()).filter(a => a && a !== primary);
      const unique = [...new Set(others)];
      if (!unique.length) return '';
      return \`<span><b>آدرس‌های دیگر:</b> \${unique.map(a => escHtml(a)).join('؛ ')}</span>\`;
    }
    function formatToman(n) {
      return Math.round(Number(n) || 0).toLocaleString('en-US');
    }
    // Expandable per-order breakdown for a customer row. Lazy-loads via
    // /api/customers/:id (handleApiCustomerDetail) the first time it's
    // opened; toggling closed just hides the panel without refetching.
    // This is what makes "customer has multiple orders, only the latest is
    // paid" actually visible/inspectable from the web panel, instead of
    // just the aggregate paid/unpaid badge.
    async function toggleOrders(id, btn) {
      const panel = document.getElementById('orders-panel-' + id);
      if (panel.style.display !== 'none' && panel.dataset.loaded) {
        panel.style.display = 'none';
        btn.textContent = 'نمایش سفارش‌ها ▾';
        return;
      }
      panel.style.display = 'flex';
      btn.textContent = 'بستن سفارش‌ها ▴';
      if (panel.dataset.loaded) return;
      panel.innerHTML = '<div class="empty" style="padding:.5rem 0">در حال بارگذاری…</div>';
      const res = await fetch('/api/customers/' + id);
      if (res.status === 401) { window.location = '/admin'; return; }
      const data = await res.json();
      renderOrdersPanel(id, data.orders || []);
      panel.dataset.loaded = '1';
    }
    function renderOrdersPanel(customerId, orders) {
      const panel = document.getElementById('orders-panel-' + customerId);
      if (!orders.length) {
        panel.innerHTML = '<div class="empty" style="padding:.5rem 0">سفارشی ثبت نشده است.</div>';
        return;
      }
      panel.innerHTML = orders.map(o => {
        const itemsStr = (o.items || []).map(it => \`سایز \${it.size}: \${it.weight_kg} کیلوگرم\`).join('، ') || 'بدون آیتم';
        const paid = o.payment_status === 'paid';
        return \`<div class="order-line">
          <div class="order-info">
            <b>سفارش #\${o.id} — \${escHtml(o.order_date || '')}</b>
            <span>\${escHtml(itemsStr)}</span>
            <span>مبلغ: \${formatToman(o.total)} تومان</span>
          </div>
          <div class="order-actions">
            \${tag(o.payment_status)}
            <button class="secondary order-toggle-btn" onclick="toggleOrderPayment(\${o.id}, '\${paid ? 'unpaid' : 'paid'}', \${customerId})">
              \${paid ? 'لغو پرداخت' : 'ثبت پرداخت'}
            </button>
          </div>
        </div>\`;
      }).join('');
    }
    // Flips one order's payment status from the web panel (new — previously
    // only possible via the Telegram admin-chat inline button). Reloads the
    // whole customer list afterward so the row's aggregate badge and
    // debt/paid totals (which only recomputeCustomerPaymentStatus knows how
    // to get right across a customer's other orders) stay authoritative,
    // rather than trying to patch them client-side.
    async function toggleOrderPayment(orderId, newStatus, customerId) {
      const res = await fetch('/api/orders/' + orderId + '/payment', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.status === 401) { window.location = '/admin'; return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data.error || 'خطا در ثبت وضعیت پرداخت'); return; }
      await loadPage(currentPage);
    }
    let currentPage = 0;
    async function loadPage(page) {
      currentPage = page;
      const params = new URLSearchParams({
        address: document.getElementById('f-address').value,
        business_type: document.getElementById('f-business-type').value,
        area: document.getElementById('f-area').value,
        payment_status: document.getElementById('f-payment-status').value,
        min_kg: document.getElementById('f-min-kg').value,
        max_kg: document.getElementById('f-max-kg').value,
        page: page,
      });
      const res = await fetch('/api/customers?' + params.toString());
      if (res.status === 401) { window.location = '/admin'; return; }
      const data = await res.json();
      const list = document.getElementById('results');
      if (!data.results.length) {
        list.innerHTML = '<div class="empty">مشتری‌ای با این فیلتر یافت نشد.</div>';
      } else {
        list.innerHTML = data.results.map(c => \`<div class="row">
          <div class="row-top">
            <span class="row-name">\${escHtml(c.first_name)} \${escHtml(c.last_name)}</span>
            \${tag(c.payment_status)}
          </div>
          <div class="row-meta">
            <span id="address-view-\${c.id}" data-address="\${escHtml(c.address || '')}">
              <b>آدرس:</b> \${escHtml(c.address)}
              <button class="secondary" style="padding:.2rem .5rem;font-size:.72rem;margin-right:.4rem" onclick="editAddress(\${c.id})">ویرایش</button>
            </span>
            \${otherAddressesHtml(c)}
            <span><b>صنف:</b> \${escHtml(c.business_type)} &nbsp;·&nbsp; <b>منطقه:</b> \${escHtml(c.area) || '-'} &nbsp;·&nbsp; <b>مجموع:</b> \${c.total_kg.toFixed(1)} کیلوگرم</span>
            <span id="phone-view-\${c.id}" data-phone="\${escHtml(c.phone_number || '')}">
              <b>تلفن:</b> \${escHtml(c.phone_number) || 'ثبت نشده'}
              <button class="secondary" style="padding:.2rem .5rem;font-size:.72rem;margin-right:.4rem" onclick="editPhone(\${c.id})">ویرایش</button>
            </span>
            <span id="shopname-view-\${c.id}" data-shopname="\${escHtml(c.shop_name || '')}">
              <b>نام مغازه:</b> \${escHtml(c.shop_name) || 'ثبت نشده'}
              <button class="secondary" style="padding:.2rem .5rem;font-size:.72rem;margin-right:.4rem" onclick="editShopName(\${c.id})">ویرایش</button>
            </span>
            <span class="money-line">
              <span><b>بدهی:</b> <span class="money-debt">\${formatToman(c.debt_amount)} تومان</span></span>
              <span><b>پرداخت‌شده:</b> <span class="money-paid">\${formatToman(c.paid_amount)} تومان</span></span>
            </span>
          </div>
          <div class="row-actions" style="justify-content:space-between">
            <button class="orders-toggle" onclick="toggleOrders(\${c.id}, this)">نمایش سفارش‌ها ▾</button>
            <button class="secondary" style="padding:.3rem .7rem;font-size:.76rem;color:var(--unpaid)" data-id="\${c.id}" data-name="\${escHtml(c.first_name + ' ' + c.last_name)}" onclick="deleteCustomer(this)">حذف مشتری</button>
          </div>
          <div id="orders-panel-\${c.id}" class="orders-panel" style="display:none"></div>
        </div>\`).join('');
      }
      const pager = document.getElementById('pager');
      pager.innerHTML = '';
      if (page > 0) {
        const b = document.createElement('button');
        b.className = 'secondary';
        b.textContent = '← قبلی'; b.onclick = () => loadPage(page - 1);
        pager.appendChild(b);
      }
      if (data.has_next) {
        const b = document.createElement('button');
        b.className = 'secondary';
        b.textContent = 'بعدی →'; b.onclick = () => loadPage(page + 1);
        pager.appendChild(b);
      }
    }

    function editAddress(id) {
      const el = document.getElementById('address-view-' + id);
      const current = el.dataset.address || '';
      el.innerHTML = \`
        <input type="text" id="address-input-\${id}" value="\${escHtml(current)}" placeholder="آدرس"
          style="display:inline-block;width:auto;min-width:14rem;margin:0 .4rem 0 0;padding:.35rem .5rem">
        <button class="secondary" style="padding:.2rem .5rem;font-size:.72rem" onclick="saveAddress(\${id})">ذخیره</button>
        <button class="secondary" style="padding:.2rem .5rem;font-size:.72rem" onclick="loadPage(currentPage)">انصراف</button>
      \`;
      document.getElementById('address-input-' + id).focus();
    }

    async function saveAddress(id) {
      const input = document.getElementById('address-input-' + id);
      const address = input.value.trim();
      if (!address) { alert('آدرس نمی‌تواند خالی باشد'); return; }
      const res = await fetch('/api/customers/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      if (!res.ok) { alert('خطا در ذخیره آدرس'); return; }
      loadPage(currentPage);
    }

    function editPhone(id) {
      const el = document.getElementById('phone-view-' + id);
      const current = el.dataset.phone || '';
      el.innerHTML = \`
        <input type="tel" id="phone-input-\${id}" value="\${escHtml(current)}" placeholder="شماره تماس"
          style="display:inline-block;width:auto;min-width:9rem;margin:0 .4rem 0 0;padding:.35rem .5rem">
        <button class="secondary" style="padding:.2rem .5rem;font-size:.72rem" onclick="savePhone(\${id})">ذخیره</button>
        <button class="secondary" style="padding:.2rem .5rem;font-size:.72rem" onclick="loadPage(currentPage)">انصراف</button>
      \`;
      document.getElementById('phone-input-' + id).focus();
    }

    async function savePhone(id) {
      const input = document.getElementById('phone-input-' + id);
      const phone_number = input.value.trim();
      const res = await fetch('/api/customers/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number }),
      });
      if (!res.ok) { alert('خطا در ذخیره شماره تماس'); return; }
      loadPage(currentPage);
    }
    function editShopName(id) {
      const el = document.getElementById('shopname-view-' + id);
      const current = el.dataset.shopname || '';
      el.innerHTML = \`
        <input type="text" id="shopname-input-\${id}" value="\${escHtml(current)}" placeholder="نام مغازه"
          style="display:inline-block;width:auto;min-width:10rem;margin:0 .4rem 0 0;padding:.35rem .5rem">
        <button class="secondary" style="padding:.2rem .5rem;font-size:.72rem" onclick="saveShopName(\${id})">ذخیره</button>
        <button class="secondary" style="padding:.2rem .5rem;font-size:.72rem" onclick="loadPage(currentPage)">انصراف</button>
      \`;
      document.getElementById('shopname-input-' + id).focus();
    }

    async function saveShopName(id) {
      const input = document.getElementById('shopname-input-' + id);
      const shop_name = input.value.trim();
      const res = await fetch('/api/customers/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop_name }),
      });
      if (!res.ok) { alert('خطا در ذخیره نام مغازه'); return; }
      loadPage(currentPage);
    }
    async function deleteCustomer(btn) {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      if (!confirm('مشتری «' + name + '» و همه‌ی سفارش‌ها، آدرس‌ها، پرداخت‌ها و رسیدهای او برای همیشه حذف می‌شود.\\nاین عملیات غیرقابل بازگشت است. ادامه می‌دهید؟')) return;
      const res = await fetch('/api/customers/' + id, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data.error || 'خطا در حذف مشتری'); return; }
      loadPage(currentPage);
    }
    loadPage(0);
  </script>`;
}

async function handleAdminLogout(request, env) {
  const cookies = parseCookies(request);
  if (cookies.session) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ? AND kind = 'admin'`)
      .bind(cookies.session)
      .run();
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/admin',
      'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
    },
  });
}

// ---------------------------------------------------------------------------
// Payment webhook (Zarinpal callback_url)
// ---------------------------------------------------------------------------

function paymentResultPage({ ok, title, message, retryUrl }) {
  // Escaped here (rather than at every call site) since this is the one
  // remaining place in the file that interpolated free-text/gateway-supplied
  // content into an HTML response without going through escapeHtml — kept
  // consistent with the same discipline applied to Telegram HTML messages.
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const retryButton = !ok && retryUrl
    ? `<a href="${escapeHtml(retryUrl)}" style="display:inline-block;margin-top:1rem;padding:.7rem 1.6rem;border-radius:10px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600">🔁 تلاش دوباره برای پرداخت</a>`
    : '';
  return new Response(
    `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <style>
      body{font-family:Tahoma,sans-serif;background:#0b0f14;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem}
      .card{background:#131a22;border-radius:16px;padding:2rem;max-width:420px;text-align:center;border:1px solid ${ok ? '#1f6f43' : '#7a2a2a'}}
      .icon{font-size:3rem;margin-bottom:0.5rem}
      h1{font-size:1.2rem;margin:0.5rem 0}
      p{color:#9fb0bf;line-height:1.8}
    </style></head>
    <body><div class="card">
      <div class="icon">${ok ? '✅' : '❌'}</div>
      <h1>${safeTitle}</h1>
      <p>${safeMessage}</p>
      ${retryButton}
    </div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: ok ? 200 : 400 }
  );
}

// Shared by the payment-verify webhook AND the reconciliation cron below —
// flips a payment+order to paid and sends the same customer/admin
// notifications either way, so a payment the cron silently picks up (e.g.
// the customer closed their browser before Zarinpal could redirect them
// back) looks identical downstream to one confirmed via the live callback.
async function finalizePaymentSuccess(env, payment, refId) {
  const customerId = await setOrderPaymentStatus(env, payment.order_id, 'paid');
  if (!customerId) return;
  // Recompute from ALL of the customer's orders rather than forcing 'paid'
  // outright — a customer with other still-unpaid orders must stay 'unpaid'
  // even though this particular order just cleared the gateway.
  await recomputeCustomerPaymentStatus(env, customerId);

  const customer = await env.DB.prepare(`SELECT * FROM customers WHERE id = ?`).bind(customerId).first();
  if (customer && customer.telegram_chat_id) {
    try {
      await sendMessage(
        env,
        customer.telegram_chat_id,
        `✅ پرداخت فاکتور شماره ${payment.order_id} با موفقیت انجام شد.\nشماره پیگیری: ${refId}`
      );
    } catch (e) {
      // customer may have blocked the bot — ignore
    }
  }

  const adminChatIds = await getNotifiableAdminChatIds(env);
  for (const chatId of adminChatIds) {
    try {
      await sendMessage(
        env,
        chatId,
        `💰 پرداخت آنلاین فاکتور شماره ${payment.order_id} تایید شد.\nشماره پیگیری: ${refId}`
      );
    } catch (e) {
      // admin blocked the bot — skip
    }
  }
}

// Reconciles Zarinpal payments that never got a live callback — e.g. the
// customer completed payment on Zarinpal's page but closed the tab or lost
// connection before being redirected back to /payment/verify, leaving the
// row stuck at status='pending' forever even though the money was actually
// captured. Only reconciles payments at least 10 minutes old (so a customer
// mid-checkout isn't double-processed) and at most 3 days old (older stuck
// authorities are almost certainly genuinely abandoned, not worth the
// per-run Zarinpal API calls forever).
//
// NOTE: this only runs if a Cron Trigger is configured for this Worker in
// the Cloudflare dashboard (Settings → Triggers → Cron Triggers, e.g.
// "*/15 * * * *" for every 15 minutes) or in wrangler.toml — a single
// Worker file has no way to schedule itself.
async function reconcilePendingPayments(env) {
  const stale = await env.DB.prepare(
    `SELECT * FROM payments
     WHERE status = 'pending'
       AND created_at <= datetime('now', '-10 minutes')
       AND created_at >= datetime('now', '-3 days')`
  ).all();

  for (const payment of stale.results || []) {
    const result = await verifyZarinpalPayment(env, { authority: payment.authority, amount: payment.amount });
    if (result.ok) {
      // Same atomic-claim pattern as the webhook: only actually finalize if
      // this call is the one that flips status away from 'pending', so a
      // cron run racing a delayed live callback for the same authority can't
      // double-send notifications or double-count debt/paid amounts.
      const claim = await env.DB.prepare(
        `UPDATE payments SET status = 'paid', ref_id = ?, verified_at = datetime('now') WHERE authority = ? AND status != 'paid'`
      )
        .bind(String(result.refId), payment.authority)
        .run();
      if (claim?.meta?.changes) {
        await finalizePaymentSuccess(env, payment, result.refId);
      }
    } else if (result.reason !== 'network') {
      // A definitive rejection (expired/cancelled authority) — mark failed so
      // it stops being re-checked on every future run. 'network' is treated
      // as transient and left pending for the next run to retry.
      await env.DB.prepare(`UPDATE payments SET status = 'failed' WHERE authority = ?`)
        .bind(payment.authority)
        .run();
    }
  }
}

// Generates a fresh Zarinpal pay link for a failed/expired payment so the
// failure page can offer a one-tap retry instead of leaving the customer to
// go find the bot again and re-request an invoice. Returns null (button
// simply doesn't render) if the gateway isn't configured, the order is
// already paid through some other channel by the time this runs, or the
// gateway call itself fails — same "never throws" contract as
// createZarinpalPaymentLink.
async function buildRetryPaymentLink(env, request, payment) {
  if (!env.ZARINPAL_MERCHANT_ID) return null;
  const order = await env.DB.prepare(`SELECT payment_status FROM orders WHERE id = ?`)
    .bind(payment.order_id)
    .first();
  if (!order || order.payment_status === 'paid') return null;
  const origin = new URL(request.url).origin;
  return await createZarinpalPaymentLink(env, {
    orderId: payment.order_id,
    amount: payment.amount,
    description: `فاکتور شماره ${payment.order_id} (تلاش مجدد)`,
    callbackUrl: `${origin}/payment/verify`,
  });
}

async function handlePaymentVerify(request, env) {
  const url = new URL(request.url);
  const authority = url.searchParams.get('Authority');
  const status = url.searchParams.get('Status');

  if (!authority) {
    return paymentResultPage({ ok: false, title: 'خطا', message: 'اطلاعات پرداخت ناقص است.' });
  }

  const payment = await env.DB.prepare(`SELECT * FROM payments WHERE authority = ?`)
    .bind(authority)
    .first();
  if (!payment) {
    return paymentResultPage({ ok: false, title: 'تراکنش یافت نشد', message: 'این تراکنش در سیستم ثبت نشده است.' });
  }

  // Idempotent: if we already processed this authority, just show the result again.
  if (payment.status === 'paid') {
    return paymentResultPage({
      ok: true,
      title: 'پرداخت قبلاً تایید شده',
      message: `شماره پیگیری: ${payment.ref_id || '-'}`,
    });
  }

  if (status !== 'OK') {
    await env.DB.prepare(`UPDATE payments SET status = 'failed' WHERE authority = ?`).bind(authority).run();
    return paymentResultPage({
      ok: false,
      title: 'پرداخت ناموفق',
      message: 'پرداخت توسط شما لغو شد یا انجام نشد. می‌توانید دوباره تلاش کنید یا با ادمین تماس بگیرید.',
      retryUrl: await buildRetryPaymentLink(env, request, payment),
    });
  }

  const result = await verifyZarinpalPayment(env, { authority, amount: payment.amount });
  if (!result.ok) {
    await env.DB.prepare(`UPDATE payments SET status = 'failed' WHERE authority = ?`).bind(authority).run();
    return paymentResultPage({
      ok: false,
      title: 'تایید پرداخت ناموفق بود',
      message: 'در تایید تراکنش با درگاه مشکلی پیش آمد. اگر مبلغی از حساب شما کسر شده، با ادمین تماس بگیرید.',
      retryUrl: await buildRetryPaymentLink(env, request, payment),
    });
  }

  // Atomically claim this payment: the WHERE status != 'paid' clause means
  // only ONE concurrent request (double-tap "return to site", a retried
  // gateway redirect, the reconciliation cron landing on the same authority,
  // etc.) actually finalizes it — a loser sees meta.changes=0 and just shows
  // the success page without repeating any side effects. This closes the
  // race the old two-step (read-then-write) version had.
  const claim = await env.DB.prepare(
    `UPDATE payments SET status = 'paid', ref_id = ?, verified_at = datetime('now') WHERE authority = ? AND status != 'paid'`
  )
    .bind(String(result.refId), authority)
    .run();
  if (claim?.meta?.changes) {
    await finalizePaymentSuccess(env, payment, result.refId);
  }

  return paymentResultPage({
    ok: true,
    title: 'پرداخت با موفقیت انجام شد',
    message: `شماره پیگیری: ${result.refId}`,
  });
}

// ---------------------------------------------------------------------------
// API (/api/*) — requires a valid admin session cookie
// ---------------------------------------------------------------------------

async function requireAdminSession(request, env) {
  const cookies = parseCookies(request);
  return getAdminSession(env, cookies.session);
}

async function handleApiCustomers(request, env) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  const url = new URL(request.url);
  const address = url.searchParams.get('address') || '';
  const businessType = url.searchParams.get('business_type') || '';
  const area = url.searchParams.get('area') || '';
  const paymentStatus = url.searchParams.get('payment_status') || '';
  const minKg = parseFloat(url.searchParams.get('min_kg'));
  const maxKg = parseFloat(url.searchParams.get('max_kg'));
  const page = parseInt(url.searchParams.get('page') || '0', 10) || 0;

  const conditions = [];
  const params = [];
  if (address) {
    // customers.address only ever holds the customer's FIRST address (set
    // once at registration) — it goes stale the moment a new address is
    // added later via the address manager (the addresses table). Matching
    // via a subquery here (rather than an extra LEFT JOIN) avoids inflating
    // total_kg, since a JOIN against addresses would multiply order_items
    // rows for any customer with more than one saved address.
    // Escape LIKE wildcards (% and _) in the user-supplied search term so a
    // literal percent sign or underscore in an address doesn't get treated
    // as a wildcard; ESCAPE '\' tells SQLite to treat \% and \_ literally.
    const likeTerm = `%${address.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push("(c.address LIKE ? ESCAPE '\\' OR c.id IN (SELECT customer_id FROM addresses WHERE address LIKE ? ESCAPE '\\'))");
    params.push(likeTerm, likeTerm);
  }
  if (businessType) {
    conditions.push('c.business_type = ?');
    params.push(businessType);
  }
  if (area) {
    // area lives on addresses, not customers — same subquery-not-JOIN
    // reasoning as the address filter above, to avoid inflating total_kg.
    // Exact match (not LIKE) since area values always come from the fixed
    // delivery_areas list, same as business_type.
    conditions.push('c.id IN (SELECT customer_id FROM addresses WHERE area = ?)');
    params.push(area);
  }
  if (paymentStatus) {
    conditions.push('c.payment_status = ?');
    params.push(paymentStatus);
  }
  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const baseQuery = `
    SELECT c.*, COALESCE(SUM(oi.weight_kg), 0) AS total_kg,
      (SELECT area FROM addresses WHERE customer_id = c.id AND area IS NOT NULL ORDER BY id DESC LIMIT 1) AS area,
      (SELECT GROUP_CONCAT(address, '|||') FROM addresses WHERE customer_id = c.id ORDER BY id) AS all_addresses
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    ${whereSql}
    GROUP BY c.id
    ${!isNaN(minKg) ? 'HAVING total_kg >= ' + minKg : ''}
    ${!isNaN(maxKg) ? (!isNaN(minKg) ? 'AND' : 'HAVING') + ' total_kg <= ' + maxKg : ''}
    ORDER BY c.id DESC
    LIMIT ? OFFSET ?
  `;

  const stmt = env.DB.prepare(baseQuery).bind(...params, PAGE_SIZE + 1, page * PAGE_SIZE);
  const rows = await stmt.all();
  const results = rows.results || [];
  const hasNext = results.length > PAGE_SIZE;

  return new Response(
    JSON.stringify({ results: results.slice(0, PAGE_SIZE), has_next: hasNext, page }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleApiCustomerDetail(request, env, id) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  const customer = await env.DB.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first();
  if (!customer) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });

  const orders = await env.DB.prepare(`SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC`)
    .bind(id)
    .all();
  const orderList = orders.results || [];
  for (const order of orderList) {
    const items = await env.DB.prepare(`SELECT * FROM order_items WHERE order_id = ?`)
      .bind(order.id)
      .all();
    order.items = items.results || [];
    // Snapshotted total (weight_kg × unit_price at order time), same
    // authoritative figure used by setOrderPaymentStatus/debt tracking —
    // computed here rather than left to the client so the admin panel's
    // per-order breakdown always matches what the debt/paid columns are
    // actually derived from.
    order.total = order.items.reduce((sum, it) => sum + it.weight_kg * it.unit_price, 0);
  }

  return new Response(JSON.stringify({ customer, orders: orderList }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// Lets an admin flip a single order's payment status from the web panel
// (previously this was only reachable via the Telegram admin-chat inline
// "pay:" callback button). Routes through the same setOrderPaymentStatus +
// recomputeCustomerPaymentStatus pair the Telegram path and Zarinpal
// webhook use, so debt_amount/paid_amount and the customer's aggregate
// payment_status stay consistent no matter which surface triggered the
// change, and a customer with other still-unpaid orders correctly stays
// 'unpaid' overall.
async function handleApiOrderPaymentStatus(request, env, orderId) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
  }
  const status = body.status === 'paid' ? 'paid' : body.status === 'unpaid' ? 'unpaid' : null;
  if (!status) {
    return new Response(JSON.stringify({ error: "status باید 'paid' یا 'unpaid' باشد" }), { status: 400 });
  }

  const customerId = await setOrderPaymentStatus(env, orderId, status);
  if (!customerId) return new Response(JSON.stringify({ error: 'سفارش یافت نشد' }), { status: 404 });
  await recomputeCustomerPaymentStatus(env, customerId);

  return new Response(JSON.stringify({ ok: true, order_id: orderId, status, customer_id: customerId }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// Lets admins add/edit a customer's phone number, address, or shop name
// from the panel. Scoped to just these fields for now — other customer
// fields aren't editable here.
async function handleApiCustomerUpdate(request, env, id) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  const existing = await env.DB.prepare(`SELECT id FROM customers WHERE id = ?`).bind(id).first();
  if (!existing) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
  }
  if (body.phone_number === undefined && body.address === undefined && body.shop_name === undefined) {
    return new Response(JSON.stringify({ error: 'phone_number، address یا shop_name الزامی است' }), { status: 400 });
  }

  const sets = [];
  const binds = [];
  const result = { ok: true };

  if (body.phone_number !== undefined) {
    const phoneNumber = String(body.phone_number || '').trim();
    sets.push('phone_number = ?');
    binds.push(phoneNumber || null);
    result.phone_number = phoneNumber;
  }
  if (body.address !== undefined) {
    const address = String(body.address || '').trim();
    if (!address) {
      return new Response(JSON.stringify({ error: 'آدرس نمی‌تواند خالی باشد' }), { status: 400 });
    }
    sets.push('address = ?');
    binds.push(address);
    result.address = address;
  }
  if (body.shop_name !== undefined) {
    const shopName = String(body.shop_name || '').trim();
    sets.push('shop_name = ?');
    binds.push(shopName || null);
    result.shop_name = shopName;
  }

  binds.push(id);
  await env.DB.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// Deletes a customer and everything that references it (orders, order
// items, payments, receipts, saved addresses), since `orders.customer_id`
// etc. have no ON DELETE CASCADE in the schema — leaving those behind would
// just create the exact orphaned rows the cleanup tool has to mop up later.
// Done as a single batch so it's all-or-nothing.
async function handleApiCustomerDelete(request, env, id) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  const existing = await env.DB.prepare(`SELECT id FROM customers WHERE id = ?`).bind(id).first();
  if (!existing) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });

  const orderRows = await env.DB.prepare(`SELECT id FROM orders WHERE customer_id = ?`).bind(id).all();
  const orderIds = (orderRows.results || []).map((r) => r.id);

  const stmts = [];
  for (const orderId of orderIds) {
    stmts.push(env.DB.prepare(`DELETE FROM order_items WHERE order_id = ?`).bind(orderId));
    stmts.push(env.DB.prepare(`DELETE FROM payments WHERE order_id = ?`).bind(orderId));
    stmts.push(env.DB.prepare(`DELETE FROM receipts WHERE order_id = ?`).bind(orderId));
  }
  stmts.push(env.DB.prepare(`DELETE FROM orders WHERE customer_id = ?`).bind(id));
  stmts.push(env.DB.prepare(`DELETE FROM addresses WHERE customer_id = ?`).bind(id));
  stmts.push(env.DB.prepare(`DELETE FROM customers WHERE id = ?`).bind(id));
  await env.DB.batch(stmts);

  return new Response(JSON.stringify({ ok: true, deleted_orders: orderIds.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleApiAdminsList(request, env) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const rows = await env.DB.prepare(`SELECT * FROM admins ORDER BY id DESC`).all();
  return new Response(JSON.stringify({ results: rows.results || [] }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleApiAdminsAdd(request, env) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
  }
  const raw = String(body.identifier || '').trim();
  if (!raw) return new Response(JSON.stringify({ error: 'شناسه الزامی است' }), { status: 400 });

  const isNumeric = /^\d+$/.test(raw);
  const identifier = isNumeric ? raw : normalizeUsername(raw);
  const identifierType = isNumeric ? 'id' : 'username';
  const label = body.label ? String(body.label).trim() : null;

  try {
    await env.DB.prepare(
      `INSERT INTO admins (identifier, identifier_type, label) VALUES (?, ?, ?)`
    )
      .bind(identifier, identifierType, label)
      .run();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'این شناسه قبلاً ثبت شده است' }), { status: 409 });
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleApiAdminsDelete(request, env, id) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  await env.DB.prepare(`DELETE FROM admins WHERE id = ?`).bind(id).run();
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleApiSettingsGet(request, env) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const {
    payment_link: paymentLink,
    business_name: businessName,
    business_address: businessAddress,
    business_phone: businessPhone,
    card_number: cardNumber,
    card_holder_name: cardHolderName,
    delivery_areas: deliveryAreas,
  } = await getSettings(env, [
    'payment_link',
    'business_name',
    'business_address',
    'business_phone',
    'card_number',
    'card_holder_name',
    'delivery_areas',
  ]);
  return new Response(
    JSON.stringify({
      payment_link: paymentLink || '',
      business_name: businessName || '',
      business_address: businessAddress || '',
      business_phone: businessPhone || '',
      card_number: cardNumber || '',
      card_holder_name: cardHolderName || '',
      delivery_areas: deliveryAreas || '',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleApiSettingsSet(request, env) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
  }
  if (body.payment_link !== undefined) {
    await setSetting(env, 'payment_link', String(body.payment_link || '').trim());
  }
  if (body.business_name !== undefined) {
    await setSetting(env, 'business_name', String(body.business_name || '').trim());
  }
  if (body.business_address !== undefined) {
    await setSetting(env, 'business_address', String(body.business_address || '').trim());
  }
  if (body.business_phone !== undefined) {
    await setSetting(env, 'business_phone', String(body.business_phone || '').trim());
  }
  if (body.card_number !== undefined) {
    await setSetting(env, 'card_number', String(body.card_number || '').trim());
  }
  if (body.card_holder_name !== undefined) {
    await setSetting(env, 'card_holder_name', String(body.card_holder_name || '').trim());
  }
  if (body.delivery_areas !== undefined) {
    // Normalize: trim each comma-separated entry, drop empties, so
    // getDeliveryAreas never has to defend against "تهران, , کرج" style
    // input from the admin panel textarea.
    const cleaned = String(body.delivery_areas || '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .join(', ');
    await setSetting(env, 'delivery_areas', cleaned);
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleApiPricesGet(request, env) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const prices = await getSizePrices(env);
  return new Response(JSON.stringify({ prices }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleApiPricesSet(request, env) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
  }
  const prices = body.prices || {};
  const updates = [];
  for (const size of SIZES) {
    if (prices[size] === undefined) continue;
    const val = parseFloat(prices[size]);
    if (isNaN(val) || val < 0) {
      return new Response(JSON.stringify({ error: `قیمت نامعتبر برای سایز ${size}` }), { status: 400 });
    }
    updates.push(setSizePrice(env, size, val));
  }
  await Promise.all(updates);
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// Database cleanup (admin panel) — scans for common data issues that have
// shown up in practice (blank/duplicate addresses from voice-order glitches,
// expired sessions piling up, rows left orphaned by future features like
// customer deletion) and lets an admin fix them on demand. Scanning is
// read-only; nothing is changed until the admin explicitly picks actions and
// runs them.
// ---------------------------------------------------------------------------

const CLEANUP_CHECKS = [
  'trim_customer_addresses',
  'admin_linked_customers',
  'empty_saved_addresses',
  'duplicate_saved_addresses',
  'orphaned_addresses',
  'orphaned_order_items',
  'orphaned_payments',
  'orphaned_receipts',
  'expired_sessions',
];

// Finds customer rows whose telegram_chat_id is actually an admin's own
// Telegram chat rather than a real customer's — residue from a past bug
// where the admin's "add new customer" wizard stamped the ADMIN's chat id
// onto every customer they registered (see createOrderAndRoute). That in
// turn made findCustomerByChatId(adminChatId) match one of these rows on
// the admin's next "add customer" tap and skip straight past name/phone/
// address entry. Matches against both id-based admins (identifier itself)
// and username-based admins (their backfilled telegram_user_id).
const ADMIN_LINKED_CUSTOMER_IDS_SQL = `
  SELECT identifier FROM admins WHERE identifier_type = 'id'
  UNION
  SELECT telegram_user_id FROM admins WHERE telegram_user_id IS NOT NULL
`;

// Re-applies the same normalization findOrCreateAddress uses for new
// addresses, but retroactively over the whole `addresses` table — catches
// near-duplicate rows that slipped in before dedup existed, or from any
// future bug that bypasses findOrCreateAddress. Keeps the earliest row per
// customer+normalized-text and flags the rest as duplicates.
async function findDuplicateAddressRows(env) {
  const rows = await env.DB.prepare(
    `SELECT id, customer_id, address FROM addresses ORDER BY customer_id, id`
  ).all();
  const keepIdByKey = new Map();
  const duplicates = [];
  for (const row of rows.results || []) {
    const normalized = normalizeAddressForDedup(row.address);
    if (!normalized) continue; // blank rows are handled by empty_saved_addresses instead
    const key = `${row.customer_id}::${normalized}`;
    if (keepIdByKey.has(key)) {
      duplicates.push({ id: row.id, address: row.address, keep_id: keepIdByKey.get(key) });
    } else {
      keepIdByKey.set(key, row.id);
    }
  }
  return duplicates;
}

async function scanCleanupIssues(env) {
  const trimCustomerAddresses = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM customers WHERE address != TRIM(address)`
  ).first();
  const adminLinkedCustomersCount = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM customers WHERE telegram_chat_id IN (${ADMIN_LINKED_CUSTOMER_IDS_SQL})`
  ).first();
  const adminLinkedCustomers = await env.DB.prepare(
    `SELECT id, first_name, last_name FROM customers WHERE telegram_chat_id IN (${ADMIN_LINKED_CUSTOMER_IDS_SQL}) LIMIT 10`
  ).all();
  const blankCustomerAddressesCount = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM customers WHERE TRIM(address) = ''`
  ).first();
  const blankCustomerAddresses = await env.DB.prepare(
    `SELECT id, first_name, last_name FROM customers WHERE TRIM(address) = '' LIMIT 10`
  ).all();
  const emptySavedAddresses = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM addresses WHERE TRIM(address) = ''`
  ).first();
  const duplicateRows = await findDuplicateAddressRows(env);
  const orphanedAddresses = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM addresses WHERE customer_id NOT IN (SELECT id FROM customers)`
  ).first();
  const orphanedOrderItems = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM order_items WHERE order_id NOT IN (SELECT id FROM orders)`
  ).first();
  const orphanedPayments = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM payments WHERE order_id NOT IN (SELECT id FROM orders)`
  ).first();
  const orphanedReceipts = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM receipts WHERE order_id NOT IN (SELECT id FROM orders)`
  ).first();
  const expiredSessions = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM sessions WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`
  ).first();

  return {
    trim_customer_addresses: {
      count: trimCustomerAddresses.c,
      fixable: true,
      label: 'آدرس مشتری با فاصله‌ی اضافه در ابتدا/انتها',
    },
    admin_linked_customers: {
      count: adminLinkedCustomersCount.c,
      fixable: true,
      label: 'مشتری اشتباهاً متصل به چت ادمین (باقی‌مانده از باگ قبلی «افزودن مشتری»)',
      examples: (adminLinkedCustomers.results || []).map((r) => `#${r.id} ${r.first_name} ${r.last_name}`),
    },
    blank_customer_addresses: {
      count: blankCustomerAddressesCount.c,
      fixable: false,
      label: 'مشتری با آدرس خالی (آدرس اجباری است — باید دستی ویرایش شود)',
      examples: (blankCustomerAddresses.results || []).map((r) => `#${r.id} ${r.first_name} ${r.last_name}`),
    },
    empty_saved_addresses: {
      count: emptySavedAddresses.c,
      fixable: true,
      label: 'آدرس ذخیره‌شده‌ی خالی',
    },
    duplicate_saved_addresses: {
      count: duplicateRows.length,
      fixable: true,
      label: 'آدرس ذخیره‌شده‌ی تکراری (برای همان مشتری)',
      examples: duplicateRows.slice(0, 10).map((d) => `#${d.id} → ${d.address}`),
    },
    orphaned_addresses: {
      count: orphanedAddresses.c,
      fixable: true,
      label: 'آدرس متعلق به مشتری حذف‌شده',
    },
    orphaned_order_items: {
      count: orphanedOrderItems.c,
      fixable: true,
      label: 'قلم سفارش متعلق به سفارش حذف‌شده',
    },
    orphaned_payments: {
      count: orphanedPayments.c,
      fixable: true,
      label: 'پرداخت متعلق به سفارش حذف‌شده',
    },
    orphaned_receipts: {
      count: orphanedReceipts.c,
      fixable: true,
      label: 'رسید متعلق به سفارش حذف‌شده',
    },
    expired_sessions: {
      count: expiredSessions.c,
      fixable: true,
      label: 'نشست منقضی‌شده‌ی ادمین',
    },
  };
}

// Executes a single cleanup action and returns the number of rows affected
// (or null for an unrecognized action, so the caller can report it as skipped).
async function runCleanupAction(env, action) {
  switch (action) {
    case 'trim_customer_addresses': {
      const res = await env.DB.prepare(
        `UPDATE customers SET address = TRIM(address) WHERE address != TRIM(address)`
      ).run();
      return res.meta.changes || 0;
    }
    case 'admin_linked_customers': {
      const res = await env.DB.prepare(
        `UPDATE customers SET telegram_chat_id = NULL WHERE telegram_chat_id IN (${ADMIN_LINKED_CUSTOMER_IDS_SQL})`
      ).run();
      return res.meta.changes || 0;
    }
    case 'empty_saved_addresses': {
      const res = await env.DB.prepare(`DELETE FROM addresses WHERE TRIM(address) = ''`).run();
      return res.meta.changes || 0;
    }
    case 'duplicate_saved_addresses': {
      const duplicates = await findDuplicateAddressRows(env);
      if (!duplicates.length) return 0;
      const stmts = [];
      for (const d of duplicates) {
        // Repoint any order that referenced the duplicate row at the row
        // being kept before removing the duplicate, so nothing dangles.
        stmts.push(env.DB.prepare(`UPDATE orders SET address_id = ? WHERE address_id = ?`).bind(d.keep_id, d.id));
        stmts.push(env.DB.prepare(`DELETE FROM addresses WHERE id = ?`).bind(d.id));
      }
      await env.DB.batch(stmts);
      return duplicates.length;
    }
    case 'orphaned_addresses': {
      const res = await env.DB.prepare(
        `DELETE FROM addresses WHERE customer_id NOT IN (SELECT id FROM customers)`
      ).run();
      return res.meta.changes || 0;
    }
    case 'orphaned_order_items': {
      const res = await env.DB.prepare(
        `DELETE FROM order_items WHERE order_id NOT IN (SELECT id FROM orders)`
      ).run();
      return res.meta.changes || 0;
    }
    case 'orphaned_payments': {
      const res = await env.DB.prepare(
        `DELETE FROM payments WHERE order_id NOT IN (SELECT id FROM orders)`
      ).run();
      return res.meta.changes || 0;
    }
    case 'orphaned_receipts': {
      const res = await env.DB.prepare(
        `DELETE FROM receipts WHERE order_id NOT IN (SELECT id FROM orders)`
      ).run();
      return res.meta.changes || 0;
    }
    case 'expired_sessions': {
      const res = await env.DB.prepare(
        `DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`
      ).run();
      return res.meta.changes || 0;
    }
    default:
      return null;
  }
}

async function handleApiCleanupScan(request, env) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const issues = await scanCleanupIssues(env);
  return new Response(JSON.stringify({ issues }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleApiCleanupRun(request, env) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
  }
  const requested = Array.isArray(body.actions) ? body.actions : [];
  const actions = requested.filter((a) => CLEANUP_CHECKS.includes(a));
  if (!actions.length) {
    return new Response(JSON.stringify({ error: 'هیچ اقدامی انتخاب نشده است' }), { status: 400 });
  }
  const results = {};
  for (const action of actions) {
    results[action] = await runCleanupAction(env, action);
  }
  return new Response(JSON.stringify({ ok: true, results }), { headers: { 'Content-Type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// Generic table browser & export (admin panel) — lets an admin view/edit/
// delete rows in any table (not just customers) and download a table or the
// whole database as JSON/CSV. Table and column names are always validated
// against the live schema (sqlite_master / PRAGMA table_info) before being
// interpolated into SQL, since D1 can't bind identifiers as parameters —
// only values coming from the schema itself ever reach a query string.
// ---------------------------------------------------------------------------

// admin_auth holds the password hash/salt and sessions holds live auth
// tokens — both are excluded from the generic browser/export since exposing
// or editing them from here would be a straightforward way to hijack the
// panel itself.
const DB_BROWSER_HIDDEN_TABLES = ['admin_auth', 'sessions'];

async function listDbTables(env) {
  const rows = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`
  ).all();
  return (rows.results || []).map((r) => r.name).filter((t) => !DB_BROWSER_HIDDEN_TABLES.includes(t));
}

async function getTableSchema(env, table) {
  const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  const cols = info.results || [];
  const pk = cols.find((c) => c.pk === 1) || cols.find((c) => c.pk > 0);
  return { columns: cols.map((c) => c.name), primaryKey: pk ? pk.name : null };
}

function rowsToCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(','));
  return lines.join('\n');
}

async function handleApiDbTables(request, env) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const tables = await listDbTables(env);
  return new Response(JSON.stringify({ tables }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleApiDbTableRows(request, env, table) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const tables = await listDbTables(env);
  if (!tables.includes(table)) return new Response(JSON.stringify({ error: 'جدول نامعتبر است' }), { status: 400 });

  const url = new URL(request.url);
  const page = Math.max(0, parseInt(url.searchParams.get('page') || '0', 10) || 0);
  const pageSize = 20;
  const { columns, primaryKey } = await getTableSchema(env, table);

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  const orderBy = primaryKey ? `ORDER BY ${primaryKey} DESC` : '';
  const rows = await env.DB.prepare(`SELECT * FROM ${table} ${orderBy} LIMIT ? OFFSET ?`)
    .bind(pageSize, page * pageSize)
    .all();

  return new Response(
    JSON.stringify({
      columns,
      primaryKey,
      total: totalRow.c,
      page,
      pageSize,
      rows: rows.results || [],
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleApiDbRowUpdate(request, env, table, pkValue) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const tables = await listDbTables(env);
  if (!tables.includes(table)) return new Response(JSON.stringify({ error: 'جدول نامعتبر است' }), { status: 400 });

  const { columns, primaryKey } = await getTableSchema(env, table);
  if (!primaryKey) {
    return new Response(JSON.stringify({ error: 'این جدول کلید اصلی مشخصی ندارد و از این پنل قابل ویرایش نیست' }), {
      status: 400,
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
  }

  const sets = [];
  const binds = [];
  for (const [col, val] of Object.entries(body || {})) {
    if (col === primaryKey) continue; // the PK itself is never editable through this endpoint
    if (!columns.includes(col)) continue; // unknown field — ignore rather than trust caller input as SQL
    sets.push(`${col} = ?`);
    binds.push(val === '' ? null : val);
  }
  if (!sets.length) return new Response(JSON.stringify({ error: 'هیچ ستون معتبری برای تغییر ارسال نشده' }), { status: 400 });

  binds.push(pkValue);
  try {
    await env.DB.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${primaryKey} = ?`)
      .bind(...binds)
      .run();
  } catch (e) {
    const msg = String(e?.message || e);
    if (/FOREIGN KEY constraint failed/i.test(msg)) {
      return new Response(
        JSON.stringify({ error: 'مقدار وارد شده به رکوردی که وجود ندارد اشاره می‌کند (کلید خارجی نامعتبر)' }),
        { status: 409 }
      );
    }
    return new Response(JSON.stringify({ error: 'خطا در ذخیره: ' + msg }), { status: 500 });
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleApiDbRowDelete(request, env, table, pkValue) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const tables = await listDbTables(env);
  if (!tables.includes(table)) return new Response(JSON.stringify({ error: 'جدول نامعتبر است' }), { status: 400 });

  // Deleting a customer here would leave its orders/addresses/payments
  // orphaned (see the cleanup tool) — send admins to the dedicated cascade
  // delete instead.
  if (table === 'customers') {
    return new Response(
      JSON.stringify({ error: 'برای حذف مشتری از دکمه‌ی «حذف مشتری» در لیست مشتریان استفاده کنید (همراه با حذف سفارش‌های مرتبط)' }),
      { status: 400 }
    );
  }

  const { primaryKey } = await getTableSchema(env, table);
  if (!primaryKey) return new Response(JSON.stringify({ error: 'این جدول کلید اصلی مشخصی ندارد' }), { status: 400 });

  try {
    await env.DB.prepare(`DELETE FROM ${table} WHERE ${primaryKey} = ?`).bind(pkValue).run();
  } catch (e) {
    const msg = String(e?.message || e);
    // D1 enforces foreign keys, so deleting a row that still has children in
    // another table (e.g. an order with order_items/payments/receipts, or an
    // address tied to a customer) throws instead of failing silently. Catch
    // that specifically so the admin sees why, instead of a generic crash
    // that isn't even valid JSON on the client side.
    if (/FOREIGN KEY constraint failed/i.test(msg)) {
      return new Response(
        JSON.stringify({
          error: 'این ردیف توسط رکوردهای دیگری در جدول‌های مرتبط استفاده شده و قابل حذف نیست (ابتدا آن رکوردهای وابسته را حذف کنید)',
        }),
        { status: 409 }
      );
    }
    return new Response(JSON.stringify({ error: 'خطا در حذف: ' + msg }), { status: 500 });
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleApiDbExport(request, env) {
  const session = await requireAdminSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  const url = new URL(request.url);
  const table = url.searchParams.get('table');
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const tables = await listDbTables(env);

  if (table) {
    if (!tables.includes(table)) return new Response(JSON.stringify({ error: 'جدول نامعتبر است' }), { status: 400 });
    const rows = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    const data = rows.results || [];
    if (format === 'csv') {
      return new Response(rowsToCsv(data), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${table}.csv"`,
        },
      });
    }
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${table}.json"`,
      },
    });
  }

  // No table specified — full-database export, JSON only (CSV doesn't make
  // sense across multiple differently-shaped tables in one file).
  const dump = {};
  for (const t of tables) {
    const rows = await env.DB.prepare(`SELECT * FROM ${t}`).all();
    dump[t] = rows.results || [];
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(dump, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="backup-${stamp}.json"`,
    },
  });
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    await ensureSchema(env);
    const url = new URL(request.url);

    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }

    if (url.pathname === '/payment/verify' && request.method === 'GET') {
      return handlePaymentVerify(request, env);
    }

    if (url.pathname === '/admin') {
      return handleAdminSetupOrLogin(request, env);
    }
    if (url.pathname === '/admin/logout') {
      return handleAdminLogout(request, env);
    }

    if (url.pathname === '/api/customers' && request.method === 'GET') {
      return handleApiCustomers(request, env);
    }
    const detailMatch = url.pathname.match(/^\/api\/customers\/(\d+)$/);
    if (detailMatch && request.method === 'GET') {
      return handleApiCustomerDetail(request, env, parseInt(detailMatch[1], 10));
    }
    if (detailMatch && request.method === 'PATCH') {
      return handleApiCustomerUpdate(request, env, parseInt(detailMatch[1], 10));
    }
    if (detailMatch && request.method === 'DELETE') {
      return handleApiCustomerDelete(request, env, parseInt(detailMatch[1], 10));
    }
    const orderPaymentMatch = url.pathname.match(/^\/api\/orders\/(\d+)\/payment$/);
    if (orderPaymentMatch && request.method === 'PATCH') {
      return handleApiOrderPaymentStatus(request, env, parseInt(orderPaymentMatch[1], 10));
    }

    if (url.pathname === '/api/admins' && request.method === 'GET') {
      return handleApiAdminsList(request, env);
    }
    if (url.pathname === '/api/admins' && request.method === 'POST') {
      return handleApiAdminsAdd(request, env);
    }
    const adminDeleteMatch = url.pathname.match(/^\/api\/admins\/(\d+)$/);
    if (adminDeleteMatch && request.method === 'DELETE') {
      return handleApiAdminsDelete(request, env, parseInt(adminDeleteMatch[1], 10));
    }

    if (url.pathname === '/api/settings' && request.method === 'GET') {
      return handleApiSettingsGet(request, env);
    }
    if (url.pathname === '/api/settings' && request.method === 'POST') {
      return handleApiSettingsSet(request, env);
    }

    if (url.pathname === '/api/prices' && request.method === 'GET') {
      return handleApiPricesGet(request, env);
    }
    if (url.pathname === '/api/prices' && request.method === 'POST') {
      return handleApiPricesSet(request, env);
    }

    if (url.pathname === '/api/cleanup/scan' && request.method === 'GET') {
      return handleApiCleanupScan(request, env);
    }
    if (url.pathname === '/api/cleanup/run' && request.method === 'POST') {
      return handleApiCleanupRun(request, env);
    }

    if (url.pathname === '/api/db/tables' && request.method === 'GET') {
      return handleApiDbTables(request, env);
    }
    if (url.pathname === '/api/db/export' && request.method === 'GET') {
      return handleApiDbExport(request, env);
    }
    const dbRowsMatch = url.pathname.match(/^\/api\/db\/tables\/([a-zA-Z_][a-zA-Z0-9_]*)\/rows$/);
    if (dbRowsMatch && request.method === 'GET') {
      return handleApiDbTableRows(request, env, dbRowsMatch[1]);
    }
    const dbRowMatch = url.pathname.match(/^\/api\/db\/tables\/([a-zA-Z_][a-zA-Z0-9_]*)\/rows\/([^/]+)$/);
    if (dbRowMatch && request.method === 'PATCH') {
      return handleApiDbRowUpdate(request, env, dbRowMatch[1], decodeURIComponent(dbRowMatch[2]));
    }
    if (dbRowMatch && request.method === 'DELETE') {
      return handleApiDbRowDelete(request, env, dbRowMatch[1], decodeURIComponent(dbRowMatch[2]));
    }

    return new Response('Not found', { status: 404 });
  },

  // Only invoked if a Cron Trigger is configured for this Worker (Cloudflare
  // dashboard → Settings → Triggers, or wrangler.toml `[triggers] crons`) —
  // see the note above reconcilePendingPayments(). ctx.waitUntil keeps the
  // invocation alive until the reconciliation pass finishes.
  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil(reconcilePendingPayments(env));
  },
};
