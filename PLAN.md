# peakplast.js Modularization Plan

Single-file Cloudflare Worker (~276KB, ~7,000+ lines) covering: DB schema/migrations,
Gemini voice AI, Telegram bot logic, an embedded admin SPA (HTML/CSS/JS as template
strings), Zarinpal payments, and a REST API. This plan splits it into ES modules.

**Wrangler bundles ES modules via esbuild automatically** — no build-step changes
needed, just `import`/`export`. Confirm `wrangler.toml` `main` points at `src/index.js`
once step 18 lands.

## Ground rules

- **Work on a branch**, not main directly — this is a live production bot.
- **Bottom-up order** — extract leaf modules first (no internal dependencies), then
  move up the dependency chain. Each step should leave the bot fully deployable.
- **One logical commit per step.** Pure move/re-export only — no behavior changes
  bundled into a move. Resist improving code while relocating it; file a follow-up
  instead.
- **Verify after every step**: `wrangler deploy --dry-run` (or equivalent build check)
  plus a manual smoke test of the bot (start a chat, place a button order) before
  moving to the next step.
- Dependency direction is one-way: `constants/lib/db` → `services` → `domain` →
  `bot/api/admin-panel` → `index.js`. Nothing imports "up."
- Module-scope state (`schemaReady` in schema.js, `_settingsCache` in settings.js)
  must stay colocated with the functions that use it — don't split state from its
  accessors.

## Steps (do in order, check off as completed)

- [ ] **1. `src/constants.js`** — `BUSINESS_TYPES`, `SIZES`, `PRESET_WEIGHTS`,
      `PAGE_SIZE`, `SESSION_TTL_MS`, `TG_STATE_TTL_MS`, `GEMINI_MODELS`,
      `CHAT_LOCK_*`, `VOICE_FLOOD_*`, `ADDRESS_SIMILARITY_THRESHOLD`, Zarinpal URLs.
      Zero dependencies — pure constants, safest first step.

- [ ] **2. `src/lib/crypto.js`** — `bufToHex`, `hexToBuf`, `pbkdf2Hash`, `randomHex`,
      `timingSafeEqual`. Zero dependencies.

- [ ] **3. `src/lib/telegram.js`** — `escapeHtml`, `tgApi`, `sendMessage`,
      `editMessageText`, `deleteCustomerMessage`, `answerCallbackQuery`,
      `sendWizardMessage`. Depends only on `env.BOT_TOKEN`.

- [ ] **4. `src/db/schema.js`** — `ensureSchema` + all migrations, keeps
      `schemaReady` module-scope flag colocated.

- [ ] **5. `src/db/settings.js`** — `getSettings`/`getSetting`/`setSetting`
      (with `_settingsCache`), `getDeliveryAreas`, `getSizePrices`, `setSizePrice`.

- [ ] **6. `src/db/sessions.js`** — admin sessions (`createAdminSession`,
      `getAdminSession`), tg conversation state (`getTgState`, `setTgState`,
      `clearTgState`), chat lock (`acquireChatLock`, `releaseChatLock`,
      `withChatLock`), voice flood limit (`checkVoiceFloodLimit`). All built on
      the shared `sessions` table — keep together.

- [ ] **7. `src/services/gemini.js`** — `arrayBufferToBase64`,
      `callGeminiWithFallback`, `getGeminiApiKeys`, voice-order schema/prompt
      builders + `transcribeVoiceOrder` + `sanitizeVoiceExtraction`, admin-reg
      schema/prompt builders + `transcribeAdminRegVoice` +
      `sanitizeAdminRegExtraction`, `describeKnownSoFar(AdminReg)`.

- [ ] **8. `src/services/zarinpal.js`** — `createZarinpalPaymentLink`,
      `verifyZarinpalPayment`.

- [ ] **9. `src/domain/customers.js`** — `findCustomerByChatId`,
      `normalizeAddressForDedup`, `getCustomerAddresses`, `findOrCreateAddress`,
      `findSimilarAddresses`, `normalizeUsername`, `isAdminSender`,
      `recordAdminChatId`, `getNotifiableAdminChatIds`, `computeOrderTotal`,
      `setOrderPaymentStatus`, `recomputeCustomerPaymentStatus`,
      `customerSummaryLine`.

- [ ] **10. `src/domain/orders.js`** — `createOrderAndRoute`, `buildInvoiceText`,
      `notifyAdminsOfNewOrder`, `formatToman`.

- [ ] **11. `src/bot/keyboards.js`** — every `*Keyboard`/`*InlineKeyboard`
      function, `hubText`, `fmtKg`, `weightSelectPrompt`.

- [ ] **12. `src/bot/hub.js`** — `hubMissingFields`, `resolveNameForStorage`,
      `renderHub`, `handleHubVoiceMessage`, `describeKnownSoFarAdminReg` call
      sites (function itself lives in gemini.js per step 7).

- [ ] **13. `src/bot/voiceOrder.js`** — `mergeItemIntoList`, `foldPendingItem`,
      `mergeVoicePending`, `voiceOrderIsComplete`,
      `promptForMissingVoiceOrderField`, `finalizeVoiceOrder`,
      `resendCurrentStepPrompt`.

- [ ] **14. `src/bot/handleMessage.js`** + **`src/bot/handleCallbackQuery.js`**
      + **`src/bot/webhook.js`** — the three big dispatch functions. Keep each
      dispatcher intact as one function (don't fragment the state machine by
      step/callback prefix — harder to reason about split than together).

- [ ] **15. `src/admin-panel/html.js`** — `htmlPage`, `setupForm`, `loginForm`,
      `dashboardHtml` (still large — ~2,500 lines of embedded HTML/CSS/JS).
      **`src/admin-panel/auth.js`** — `handleAdminSetupOrLogin`,
      `handleAdminLogout`, `adminLockRemainingMs`, `recordAdminLoginFailure`,
      `resetAdminLoginFailures`, `redirectWithSession`.

- [ ] **16. `src/api/*.js`** — one file per resource as they're identified in
      the still-unread tail of the file: `customers.js`, `admins.js`,
      `settings.js`, `prices.js`, `cleanup.js`, `dbBrowser.js`, `export.js`.
      (Exact boundaries to confirm once that section is fully read — the file
      has ~36KB unread past the API section start.)

- [ ] **17. `src/payment/webhook.js`** — `handlePaymentVerify`,
      `paymentResultPage`, `finalizePaymentSuccess`, `reconcilePendingPayments`,
      `buildRetryPaymentLink`.

- [ ] **18. `src/index.js`** — the Worker's `fetch()`/`scheduled()` entry point,
      routing to everything above. Confirm `wrangler.toml` `main` points here.
      Delete the old `peakplast.js` only after this step is verified working.

## Follow-ups (not part of this pass — separate plan/PR)

- **Unit tests** for the pure functions surfaced during extraction:
  `sanitizeVoiceExtraction`, `mergeItemIntoList`, `foldPendingItem`,
  `normalizeAddressForDedup`, `hubMissingFields`, `resolveNameForStorage`. These
  have zero DB/network dependency and are the highest-value/lowest-cost tests
  to add, but should come after the split is stable, not blocking it.
- **Admin panel as static assets** — moving the ~2,500 lines of embedded
  HTML/CSS/JS in `admin-panel/html.js` to real static files served via Workers
  Static Assets, instead of JS template strings. Bigger architectural change,
  deliberately out of scope here.
