/**
 * Shared constants for the peakplast Telegram bot Worker.
 * Extracted from peakplast.js as modularization step 1 (see PLAN.md).
 */

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const BUSINESS_TYPES = ['سوپرمارکت', 'میوه و تره‌بار', 'آرایشی بهداشتی', 'عمده‌فروشی', 'سایر'];
export const SIZES = [1, 2, 3, 4, 5];
export const PRESET_WEIGHTS = [1, 5, 10]; // quick-add buttons, in kg — tap repeatedly to build up a total
export const PAGE_SIZE = 5;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h for admin sessions
export const TG_STATE_TTL_MS = 60 * 60 * 1000; // 1h for stale conversation state

// ---------------------------------------------------------------------------
// Gemini voice AI
// ---------------------------------------------------------------------------

// gemini-2.5-flash started returning 404 "no longer available" on 2026-07-09
// (Google prematurely retired it ahead of its official Oct 16 2026 shutdown
// date — a known bug on Google's side, confirmed via Workers Logs and the
// Gemini API forums). Previously there was only ONE model string and no
// fallback for this failure mode at all — API-key rotation only covers
// 429/RESOURCE_EXHAUSTED, so a model-level 404 threw immediately on the
// very first key, regardless of how many keys were configured. Now we try
// a small ordered list of models, falling through to the next one on a
// 404/NOT_FOUND (model retired/unavailable) in addition to quota errors,
// so a single Google-side deprecation can't take voice ordering down
// completely. First entry is the primary/preferred model.
export const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];

// Default similarity threshold for the automatic duplicate-catch confirm
// (see findSimilarAddresses, planned for src/domain/customers.js). Proposed
// 2026-07-11, not yet explicitly confirmed by the user — reasonable
// default, revisit if it misfires.
export const ADDRESS_SIMILARITY_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Admin login brute-force lockout
// Full rationale lives with the lockout implementation (adminLockRemainingMs
// / recordAdminLoginFailure / resetAdminLoginFailures in peakplast.js, to be
// moved to src/admin-panel/auth.js in a later step) — an escalating lockout
// after repeated failed /admin password attempts.
// ---------------------------------------------------------------------------

export const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
export const ADMIN_LOGIN_BASE_LOCKOUT_MS = 60 * 1000; // 1 minute base, doubles per extra failure
export const ADMIN_LOGIN_MAX_LOCKOUT_MS = 30 * 60 * 1000; // cap at 30 minutes

// ---------------------------------------------------------------------------
// Per-chat lock
// Full rationale lives with the locking implementation (acquireChatLock /
// releaseChatLock / withChatLock in peakplast.js, to be moved to
// src/db/sessions.js in a later step) — serializes concurrent Telegram
// updates for the same chat to prevent tg_state clobbering.
// ---------------------------------------------------------------------------

export const CHAT_LOCK_TTL_MS = 20000; // generous vs. the ~3s Gemini call this guards against
export const CHAT_LOCK_POLL_MS = 350;
export const CHAT_LOCK_MAX_WAIT_MS = 8000; // give up and let the user know rather than hang the request

// ---------------------------------------------------------------------------
// Voice-message flood limit
// Full rationale lives with checkVoiceFloodLimit (in peakplast.js, to be
// moved to src/db/sessions.js in a later step) — caps how many voice notes
// (each a real Gemini API call) a single chat can send per window.
// ---------------------------------------------------------------------------

export const VOICE_FLOOD_WINDOW_MS = 60 * 1000; // rolling window
export const VOICE_FLOOD_MAX = 5; // max voice messages per chat per window

// ---------------------------------------------------------------------------
// Zarinpal payment gateway
// ---------------------------------------------------------------------------

export const ZARINPAL_REQUEST_URL = 'https://payment.zarinpal.com/pg/v4/payment/request.json';
export const ZARINPAL_VERIFY_URL = 'https://payment.zarinpal.com/pg/v4/payment/verify.json';
export const ZARINPAL_STARTPAY_URL = 'https://payment.zarinpal.com/pg/StartPay/';
