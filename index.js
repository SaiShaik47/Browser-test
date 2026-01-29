import { Telegraf, Markup } from "telegraf";
import { chromium } from "playwright";
import pTimeout from "p-timeout";
import dns from "dns/promises";
import { URL } from "url";
import fs from "fs/promises";
import path from "path";
import os from "os";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN env var");

const bot = new Telegraf(BOT_TOKEN);

// ----------------- Limits / Settings -----------------
const DESKTOP_VIEWPORT = { width: 1280, height: 720 };
const MOBILE_VIEWPORT = { width: 390, height: 844 }; // iPhone-like

const NAV_TIMEOUT_MS = 15000;
const TOTAL_TIMEOUT_MS = 25000;
const MAX_URL_LEN = 2048;

const MAX_LINKS = 8;
const SCROLL_PX = 650;
const MAX_MEDIA_ITEMS = 6;
const MAX_MEDIA_BYTES = 45 * 1024 * 1024;

// Grid tap settings
const GRID_COLS = 6; // A..F
const GRID_ROWS = 4; // 1..4

const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

function isAllowedDomain(hostname) {
  if (ALLOWED_DOMAINS.length === 0) return true;
  return ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith("." + d));
}

// SSRF-ish blocks (basic IPv4)
function isPrivateIp(ip) {
  const p = ip.split(".").map(n => Number(n));
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

async function validateUrl(input) {
  if (!input || input.length > MAX_URL_LEN) throw new Error("URL missing/too long.");

  let u;
  try {
    u = new URL(input.startsWith("http") ? input : `https://${input}`);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http/https allowed.");

  const host = u.hostname.toLowerCase();
  if (!isAllowedDomain(host)) throw new Error(`Domain not allowed: ${host}`);

  const resolved = await dns.lookup(host, { all: true });
  for (const r of resolved) {
    if (r.family === 4 && isPrivateIp(r.address)) throw new Error("Blocked private/internal host.");
  }
  return u.toString();
}

function argText(text) {
  return (text || "").split(" ").slice(1).join(" ").trim();
}

async function safeRun(fn) {
  return await pTimeout(fn(), TOTAL_TIMEOUT_MS);
}

// ----------------- Browser + Sessions (Multi-tabs) -----------------
let browser;
async function getBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

/**
 * Per chat session:
 * {
 *   context,
 *   pages: Page[],
 *   active: number,
 *   links: {text, href}[],
 *   media: {label, url, type}[],
 *   lastMsgId: number|null,
 *   zoom: number,              // 1.0 = 100%
 *   mobile: boolean,           // mobile emulation on/off
 *   viewport: {width,height}   // current viewport
 * }
 */
const sessions = new Map();

async function createContext(mobile, viewport) {
  const b = await getBrowser();

  const userAgentMobile =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const userAgentDesktop =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

  const context = await b.newContext({
    viewport,
    userAgent: mobile ? userAgentMobile : userAgentDesktop,
    isMobile: mobile,
    hasTouch: mobile
  });

  return context;
}

async function getSession(chatId) {
  if (sessions.has(chatId)) return sessions.get(chatId);

  const mobile = false;
  const viewport = { ...DESKTOP_VIEWPORT };
  const context = await createContext(mobile, viewport);

  const page = await context.newPage();
  await page.goto("https://duckduckgo.com", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});

  const sess = {
    context,
    pages: [page],
    active: 0,
    links: [],
    media: [],
    lastMsgId: null,
    zoom: 1.0,
    mobile,
    viewport
  };

  // apply default zoom
  await applyZoomToAll(sess);

  sessions.set(chatId, sess);
  return sess;
}

function getActivePage(sess) {
  return sess.pages[sess.active];
}

async function applyZoomToPage(page, zoom) {
  // Playwright's page.setViewportSize doesn't zoom. We use CSS zoom on body/html.
  await page.evaluate((z) => {
    document.documentElement.style.zoom = String(z);
  }, zoom).catch(() => {});
}

async function applyZoomToAll(sess) {
  await Promise.all(sess.pages.map(p => applyZoomToPage(p, sess.zoom)));
}

async function recreateSessionContext(chatId, sess, mobile) {
  // Close old context and make a new one (needed for real mobile emulation)
  const oldPages = sess.pages;
  const activeIndex = sess.active;
  const oldUrls = await Promise.all(oldPages.map(async (p) => p.url().catch(() => "https://duckduckgo.com")));

  try { await sess.context.close(); } catch {}

  const viewport = mobile ? { ...MOBILE_VIEWPORT } : { ...DESKTOP_VIEWPORT };
  const context = await createContext(mobile, viewport);

  // recreate pages
  const pages = [];
  for (const u of oldUrls) {
    const p = await context.newPage();
    await p.goto(u || "https://duckduckgo.com", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
    pages.push(p);
  }

  sess.context = context;
  sess.pages = pages;
  sess.active = Math.min(activeIndex, pages.length - 1);
  sess.mobile = mobile;
  sess.viewport = viewport;

  await applyZoomToAll(sess);
}

async function collectLinks(page) {
  return await page.evaluate(({ maxLinks }) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (!r || r.width < 40 || r.height < 10) return false;
      if (r.bottom < 0 || r.top > window.innerHeight) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      return true;
    };

    const anchors = Array.from(document.querySelectorAll("a[href]"))
      .filter(a => isVisible(a))
      .slice(0, maxLinks);

    return anchors.map(a => ({
      text: (a.innerText || a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60) || "Link",
      href: a.href
    }));
  }, { maxLinks: MAX_LINKS });
}

async function collectMedia(page) {
  return await page.evaluate(({ maxItems }) => {
    const cleanText = (text) => (text || "").trim().replace(/\s+/g, " ").slice(0, 60);

    const items = [];
    const seen = new Set();

    const pushItem = (url, type, label) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      items.push({ url, type, label: cleanText(label) || type.toUpperCase() });
    };

    const videos = Array.from(document.querySelectorAll("video"));
    for (const video of videos) {
      const src = video.currentSrc || video.src;
      if (src) pushItem(src, "video", video.getAttribute("title") || video.getAttribute("aria-label") || "Video");
      const sources = Array.from(video.querySelectorAll("source"));
      for (const source of sources) {
        if (items.length >= maxItems) break;
        pushItem(source.src, "video", source.getAttribute("title") || source.getAttribute("label") || "Video source");
      }
      if (items.length >= maxItems) break;
    }

    const audios = Array.from(document.querySelectorAll("audio"));
    for (const audio of audios) {
      if (items.length >= maxItems) break;
      const src = audio.currentSrc || audio.src;
      if (src) pushItem(src, "audio", audio.getAttribute("title") || audio.getAttribute("aria-label") || "Audio");
      const sources = Array.from(audio.querySelectorAll("source"));
      for (const source of sources) {
        if (items.length >= maxItems) break;
        pushItem(source.src, "audio", source.getAttribute("title") || source.getAttribute("label") || "Audio source");
      }
    }

    return items.slice(0, maxItems);
  }, { maxItems: MAX_MEDIA_ITEMS });
}

async function downloadMedia(url, type) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download media: ${response.status}`);

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_MEDIA_BYTES) {
    throw new Error("Media too large to send. Try opening it directly.");
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_MEDIA_BYTES) {
    throw new Error("Media too large to send. Try opening it directly.");
  }

  const ext = type === "audio" ? ".mp3" : ".mp4";
  const filePath = path.join(os.tmpdir(), `tg-browser-${Date.now()}${ext}`);
  await fs.writeFile(filePath, Buffer.from(arrayBuffer));
  return filePath;
}

function buildKeyboard(sess) {
  const tabInfo = `Tab ${sess.active + 1}/${sess.pages.length}`;
  const modeInfo = sess.mobile ? "📱" : "🖥️";
  const zoomInfo = `${Math.round(sess.zoom * 100)}%`;

  const row1 = [
    Markup.button.callback("⬆️", "nav:up"),
    Markup.button.callback("⬇️", "nav:down"),
    Markup.button.callback("🔄", "nav:reload"),
    Markup.button.callback(tabInfo, "noop")
  ];

  const row2 = [
    Markup.button.callback("⬅️", "nav:back"),
    Markup.button.callback("➡️", "nav:fwd"),
    Markup.button.callback("🏠", "nav:home"),
    Markup.button.callback("➕Tab", "tab:new")
  ];

  const row3 = [
    Markup.button.callback(`🧊 Grid`, "grid:show"),
    Markup.button.callback(`🔍➖`, "zoom:out"),
    Markup.button.callback(`🔍➕`, "zoom:in"),
    Markup.button.callback(`${modeInfo} ${zoomInfo}`, "noop")
  ];

  const linkButtons = sess.links.map((l, i) =>
    Markup.button.callback(`${i + 1}) ${l.text}`, `link:${i}`)
  );

  const linkRows = [];
  for (let i = 0; i < linkButtons.length; i += 2) linkRows.push(linkButtons.slice(i, i + 2));

  const rows = [row1, row2, row3, ...linkRows];
  return Markup.inlineKeyboard(rows);
}

function gridKeyboard() {
  // A..F columns, 1..4 rows
  const cols = Array.from({ length: GRID_COLS }, (_, i) => String.fromCharCode(65 + i)); // A-F
  const rows = [];

  for (let r = 1; r <= GRID_ROWS; r++) {
    const rowButtons = cols.map((c) => Markup.button.callback(`${c}${r}`, `grid:cell:${c}${r}`));
    rows.push(rowButtons);
  }
  rows.push([Markup.button.callback("❌ Close Grid", "grid:close")]);
  return Markup.inlineKeyboard(rows);
}

function cellToCenterCoords(cell, viewport) {
  // cell like "B3"
  const colChar = cell[0].toUpperCase();
  const rowNum = Number(cell.slice(1));
  const colIndex = colChar.charCodeAt(0) - 65; // A=0
  const rowIndex = rowNum - 1;

  const cellW = viewport.width / GRID_COLS;
  const cellH = viewport.height / GRID_ROWS;

  const x = Math.floor(colIndex * cellW + cellW / 2);
  const y = Math.floor(rowIndex * cellH + cellH / 2);

  return { x, y };
}

async function render(ctx, chatId, captionExtra = "") {
  const sess = await getSession(chatId);
  const page = getActivePage(sess);

  const url = page.url() || "";
  const title = await page.title().catch(() => "");

  const shot = await page.screenshot({ fullPage: false });

  sess.links = await collectLinks(page);
  sess.media = await collectMedia(page);

  const caption =
    `🌐 ${title || "Page"}\n` +
    `🔗 ${url || "(no url)"}\n` +
    `🧩 Tab: ${sess.active + 1}/${sess.pages.length}  |  ${sess.mobile ? "📱 Mobile" : "🖥️ Desktop"}  |  🔍 ${Math.round(sess.zoom * 100)}%\n` +
    `🖱️ Tap: /tap x y  |  Grid: /grid\n` +
    (sess.links.length ? `\nLinks: tap buttons or /click 1..${sess.links.length}` : "\nNo visible links detected.") +
    (sess.media.length ? `\nMedia: /media or /video 1..${sess.media.length}` : "") +
    (captionExtra ? `\n\n${captionExtra}` : "");

  if (sess.lastMsgId) {
    try {
      await ctx.telegram.editMessageMedia(
        chatId,
        sess.lastMsgId,
        undefined,
        { type: "photo", media: { source: shot }, caption },
        { ...buildKeyboard(sess) }
      );
      return;
    } catch {
      // fall through to send new
    }
  }

  const msg = await ctx.replyWithPhoto({ source: shot }, { caption, ...buildKeyboard(sess) });
  sess.lastMsgId = msg.message_id;
}

// ----------------- Commands -----------------
bot.start(async (ctx) => {
  await ctx.reply(
`🧭 Remote Browser (Grid + Zoom + Mobile)

Open / Navigate:
• /go <url>
• /click <n>

Tap:
• /tap <x> <y>
• /grid            (tap a cell like A1..F4)

Zoom:
• /zoom 80..200
• /zin  /zout

Mobile:
• /mobile on|off

Tabs:
• /tabs
• /tab new
• /tab <n>
• /tab close
• /close`
  );
});

bot.command("media", async (ctx) => {
  const chatId = ctx.chat.id;
  const sess = await getSession(chatId);

  if (!sess.media.length) {
    return ctx.reply("No media detected on this page.");
  }

  const lines = sess.media.map((item, i) => {
    const safeUrl = item.url.length > 100 ? `${item.url.slice(0, 97)}...` : item.url;
    return `${i + 1}) ${item.label} (${item.type})\n${safeUrl}`;
  });

  await ctx.reply(
    `🎬 Media found:\n\n${lines.join("\n\n")}\n\nUse /video <n> to play or /download <n> to download.`
  );
});

bot.command("go", async (ctx) => {
  const chatId = ctx.chat.id;
  const raw = argText(ctx.message.text);
  try {
    const url = await validateUrl(raw);
    const sess = await getSession(chatId);
    const page = getActivePage(sess);

    await safeRun(async () => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(600);
      await applyZoomToPage(page, sess.zoom);
    });

    await render(ctx, chatId);
  } catch (e) {
    await ctx.reply(`❌ ${e.message || "Failed to open."}`);
  }
});

bot.command("click", async (ctx) => {
  const chatId = ctx.chat.id;
  const n = Number(argText(ctx.message.text));
  if (!Number.isFinite(n) || n < 1) return ctx.reply("Usage: /click <number>");

  const sess = await getSession(chatId);
  const link = sess.links[n - 1];
  if (!link) return ctx.reply(`No link #${n}.`);

  try {
    const url = await validateUrl(link.href);
    const page = getActivePage(sess);

    await safeRun(async () => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(450);
      await applyZoomToPage(page, sess.zoom);
    });

    await render(ctx, chatId);
  } catch (e) {
    await ctx.reply(`❌ ${e.message || "Click failed."}`);
  }
});

// Tap anywhere (coords)
bot.command("tap", async (ctx) => {
  const chatId = ctx.chat.id;
  const parts = argText(ctx.message.text).split(/\s+/).filter(Boolean);
  if (parts.length < 2) return ctx.reply("Usage: /tap <x> <y>   e.g. /tap 640 360");

  const x = Number(parts[0]);
  const y = Number(parts[1]);

  const sess = await getSession(chatId);
  const vp = sess.viewport;

  if (!Number.isFinite(x) || !Number.isFinite(y)) return ctx.reply("❌ x and y must be numbers.");
  if (x < 0 || y < 0 || x >= vp.width || y >= vp.height) {
    return ctx.reply(`❌ Out of bounds. x:0-${vp.width - 1}, y:0-${vp.height - 1}`);
  }

  const page = getActivePage(sess);

  try {
    await safeRun(async () => {
      await page.mouse.move(x, y);
      await page.mouse.click(x, y, { delay: 30 });
      await page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(350);
      await applyZoomToPage(page, sess.zoom);
    });

    await render(ctx, chatId, `🖱️ tapped: (${x}, ${y})`);
  } catch (e) {
    await ctx.reply(`❌ ${e.message || "Tap failed."}`);
  }
});

// Grid tap (buttons)
bot.command("grid", async (ctx) => {
  const chatId = ctx.chat.id;
  const sess = await getSession(chatId);
  const vp = sess.viewport;
  await ctx.reply(
    `🧊 Grid Tap is ON\nViewport: ${vp.width}×${vp.height}\nTap a cell (A1..${String.fromCharCode(64 + GRID_COLS)}${GRID_ROWS}).`,
    gridKeyboard()
  );
});

// Zoom commands
bot.command("zoom", async (ctx) => {
  const chatId = ctx.chat.id;
  const val = Number(argText(ctx.message.text));
  if (!Number.isFinite(val) || val < 50 || val > 250) {
    return ctx.reply("Usage: /zoom <50..250>  (example: /zoom 120)");
  }

  const sess = await getSession(chatId);
  sess.zoom = Math.round(val) / 100;

  await applyZoomToAll(sess);
  await render(ctx, chatId, `🔍 zoom set to ${Math.round(sess.zoom * 100)}%`);
});

bot.command("zin", async (ctx) => {
  const chatId = ctx.chat.id;
  const sess = await getSession(chatId);
  sess.zoom = Math.min(2.5, Math.round((sess.zoom + 0.1) * 10) / 10);
  await applyZoomToAll(sess);
  await render(ctx, chatId, `🔍 zoom: ${Math.round(sess.zoom * 100)}%`);
});

bot.command("zout", async (ctx) => {
  const chatId = ctx.chat.id;
  const sess = await getSession(chatId);
  sess.zoom = Math.max(0.5, Math.round((sess.zoom - 0.1) * 10) / 10);
  await applyZoomToAll(sess);
  await render(ctx, chatId, `🔍 zoom: ${Math.round(sess.zoom * 100)}%`);
});

// Mobile toggle
bot.command("mobile", async (ctx) => {
  const chatId = ctx.chat.id;
  const arg = argText(ctx.message.text).trim().toLowerCase();
  if (!["on", "off"].includes(arg)) return ctx.reply("Usage: /mobile on | /mobile off");

  const sess = await getSession(chatId);
  const target = arg === "on";

  if (sess.mobile === target) {
    return ctx.reply(`Already in ${target ? "mobile" : "desktop"} mode.`);
  }

  await ctx.reply(`Switching to ${target ? "📱 mobile" : "🖥️ desktop"} mode...`);

  await safeRun(async () => {
    await recreateSessionContext(chatId, sess, target);
  });

  await render(ctx, chatId, `✅ mode: ${target ? "📱 Mobile" : "🖥️ Desktop"}`);
});

bot.command("type", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = argText(ctx.message.text);
  if (!text) return ctx.reply("Usage: /type <text>");

  const sess = await getSession(chatId);
  const page = getActivePage(sess);

  try {
    await safeRun(async () => {
      const selectors = [
        'input[type="search"]',
        'input[name="q"]',
        'input[aria-label*="search" i]',
        'input[placeholder*="search" i]',
        "input",
        "textarea"
      ];

      let found = false;
      for (const sel of selectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click({ timeout: 2000 }).catch(() => {});
          await el.fill("").catch(() => {});
          await el.type(text, { delay: 12 }).catch(() => {});
          found = true;
          break;
        }
      }
      if (!found) throw new Error("No input box found on this page.");
    });

    await render(ctx, chatId, `⌨️ typed: ${text}`);
  } catch (e) {
    await ctx.reply(`❌ ${e.message || "Type failed."}`);
  }
});

bot.command("enter", async (ctx) => {
  const chatId = ctx.chat.id;
  const sess = await getSession(chatId);
  const page = getActivePage(sess);

  try {
    await safeRun(async () => {
      await page.keyboard.press("Enter");
      await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(600);
      await applyZoomToPage(page, sess.zoom);
    });

    await render(ctx, chatId, "⏎ submitted");
  } catch (e) {
    await ctx.reply(`❌ ${e.message || "Enter failed."}`);
  }
});

bot.command("video", async (ctx) => {
  const chatId = ctx.chat.id;
  const n = Number(argText(ctx.message.text));
  if (!Number.isFinite(n) || n < 1) return ctx.reply("Usage: /video <number>");

  const sess = await getSession(chatId);
  const item = sess.media[n - 1];
  if (!item) return ctx.reply(`No media #${n}. Use /media to list.`);

  if (!item.url.startsWith("http")) {
    return ctx.reply("❌ This media source can't be downloaded (non-http URL). Try opening it in the page.");
  }

  try {
    const filePath = await downloadMedia(item.url, item.type);
    if (item.type === "audio") {
      await ctx.replyWithAudio({ source: filePath }, { caption: item.label });
    } else {
      await ctx.replyWithVideo({ source: filePath }, { caption: item.label });
    }
    await fs.unlink(filePath).catch(() => {});
  } catch (e) {
    await ctx.reply(`❌ ${e.message || "Failed to send media."}`);
  }
});

bot.command("download", async (ctx) => {
  const chatId = ctx.chat.id;
  const n = Number(argText(ctx.message.text));
  if (!Number.isFinite(n) || n < 1) return ctx.reply("Usage: /download <number>");

  const sess = await getSession(chatId);
  const item = sess.media[n - 1];
  if (!item) return ctx.reply(`No media #${n}. Use /media to list.`);

  if (!item.url.startsWith("http")) {
    return ctx.reply("❌ This media source can't be downloaded (non-http URL). Try opening it in the page.");
  }

  try {
    const filePath = await downloadMedia(item.url, item.type);
    await ctx.replyWithDocument({ source: filePath }, { caption: item.label });
    await fs.unlink(filePath).catch(() => {});
  } catch (e) {
    await ctx.reply(`❌ ${e.message || "Failed to download media."}`);
  }
});

// Multi-tabs
bot.command("tabs", async (ctx) => {
  const chatId = ctx.chat.id;
  const sess = await getSession(chatId);

  const lines = await Promise.all(sess.pages.map(async (p, i) => {
    const t = await p.title().catch(() => "");
    const u = p.url?.() || "";
    const active = i === sess.active ? "✅" : "  ";
    return `${active} ${i + 1}) ${t || "Untitled"}\n   ${u}`;
  }));

  await ctx.reply(lines.join("\n\n") || "No tabs.");
});

bot.command("tab", async (ctx) => {
  const chatId = ctx.chat.id;
  const sess = await getSession(chatId);
  const a = argText(ctx.message.text).trim().toLowerCase();

  if (!a) return ctx.reply("Usage: /tab new | /tab <n> | /tab close");

  if (a === "new") {
    const page = await sess.context.newPage();
    await page.goto("https://duckduckgo.com", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
    sess.pages.push(page);
    sess.active = sess.pages.length - 1;
    await applyZoomToPage(page, sess.zoom);
    await render(ctx, chatId, "➕ opened new tab");
    return;
  }

  if (a === "close") {
    if (sess.pages.length === 1) return ctx.reply("❌ Can't close the last tab. Use /close to end session.");
    const closing = sess.pages[sess.active];
    try { await closing.close(); } catch {}
    sess.pages.splice(sess.active, 1);
    sess.active = Math.max(0, sess.active - 1);
    await render(ctx, chatId, "🧹 closed tab");
    return;
  }

  const n = Number(a);
  if (!Number.isFinite(n) || n < 1 || n > sess.pages.length) {
    return ctx.reply(`❌ Invalid tab. Choose 1..${sess.pages.length}`);
  }
  sess.active = n - 1;
  await render(ctx, chatId, `🧩 switched to tab ${n}`);
});

bot.command("close", async (ctx) => {
  const chatId = ctx.chat.id;
  const sess = sessions.get(chatId);
  if (!sess) return ctx.reply("No active session.");

  try { await sess.context.close(); } catch {}
  sessions.delete(chatId);
  await ctx.reply("✅ Closed your browser session.");
});

// ----------------- Inline Button Actions -----------------
bot.on("callback_query", async (ctx) => {
  const chatId = ctx.chat.id;
  const sess = await getSession(chatId);
  const page = getActivePage(sess);
  const data = ctx.callbackQuery?.data || "";

  try {
    if (data === "noop") {
      await ctx.answerCbQuery();
      return;
    }

    if (data === "tab:new") {
      const p = await sess.context.newPage();
      await p.goto("https://duckduckgo.com", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
      sess.pages.push(p);
      sess.active = sess.pages.length - 1;
      await applyZoomToPage(p, sess.zoom);
      await render(ctx, chatId, "➕ opened new tab");
      await ctx.answerCbQuery();
      return;
    }

    if (data === "grid:show") {
      await ctx.answerCbQuery("Grid opened");
      await ctx.reply("🧊 Grid Tap: choose a cell", gridKeyboard());
      return;
    }

    if (data === "grid:close") {
      await ctx.answerCbQuery("Grid closed");
      // We can't delete user messages with this bot (no delete). Just acknowledge.
      return;
    }

    if (data.startsWith("grid:cell:")) {
      const cell = data.split(":").pop(); // e.g. B3
      const { x, y } = cellToCenterCoords(cell, sess.viewport);

      await safeRun(async () => {
        await page.mouse.move(x, y);
        await page.mouse.click(x, y, { delay: 25 });
        await page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(300);
        await applyZoomToPage(page, sess.zoom);
      });

      await render(ctx, chatId, `🧊 grid tap ${cell} → (${x}, ${y})`);
      await ctx.answerCbQuery();
      return;
    }

    if (data === "zoom:in") {
      sess.zoom = Math.min(2.5, Math.round((sess.zoom + 0.1) * 10) / 10);
      await applyZoomToAll(sess);
      await render(ctx, chatId, `🔍 zoom: ${Math.round(sess.zoom * 100)}%`);
      await ctx.answerCbQuery();
      return;
    }

    if (data === "zoom:out") {
      sess.zoom = Math.max(0.5, Math.round((sess.zoom - 0.1) * 10) / 10);
      await applyZoomToAll(sess);
      await render(ctx, chatId, `🔍 zoom: ${Math.round(sess.zoom * 100)}%`);
      await ctx.answerCbQuery();
      return;
    }

    if (data.startsWith("nav:")) {
      const action = data.split(":")[1];

      await safeRun(async () => {
        if (action === "up") {
          await page.mouse.wheel(0, -SCROLL_PX);
          await page.waitForTimeout(120);
        } else if (action === "down") {
          await page.mouse.wheel(0, SCROLL_PX);
          await page.waitForTimeout(120);
        } else if (action === "reload") {
          await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
          await page.waitForTimeout(350);
        } else if (action === "back") {
          await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
          await page.waitForTimeout(300);
        } else if (action === "fwd") {
          await page.goForward({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
          await page.waitForTimeout(300);
        } else if (action === "home") {
          await page.goto("https://duckduckgo.com", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
          await page.waitForTimeout(400);
        }
        await applyZoomToPage(page, sess.zoom);
      });

      await render(ctx, chatId);
      await ctx.answerCbQuery();
      return;
    }

    if (data.startsWith("link:")) {
      const i = Number(data.split(":")[1]);
      const link = sess.links[i];
      if (!link) {
        await ctx.answerCbQuery("Link not available");
        return;
      }
      const url = await validateUrl(link.href);

      await safeRun(async () => {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await page.waitForTimeout(450);
        await applyZoomToPage(page, sess.zoom);
      });

      await render(ctx, chatId);
      await ctx.answerCbQuery();
      return;
    }

    await ctx.answerCbQuery();
  } catch (e) {
    await ctx.answerCbQuery("Error");
    await ctx.reply(`❌ ${e.message || "Action failed."}`);
  }
});

bot.launch();

process.once("SIGINT", async () => {
  try { await bot.stop("SIGINT"); } catch {}
  try { await browser?.close(); } catch {}
});
process.once("SIGTERM", async () => {
  try { await bot.stop("SIGTERM"); } catch {}
  try { await browser?.close(); } catch {}
});
