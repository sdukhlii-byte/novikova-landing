// Лендинг + приём заявок. Без внешних зависимостей, Node 18+.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const LEADS_CHAT_ID = process.env.LEADS_CHAT_ID || ""; // группа или канал, куда бот шлёт заявки
const PIXEL_ID = process.env.META_PIXEL_ID || "";
const CAPI_TOKEN = process.env.META_CAPI_TOKEN || "";
const CAPI_TEST_CODE = process.env.META_TEST_EVENT_CODE || "";
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");
const BOT_LINK = process.env.BOT_LINK || ""; // необязательно: ссылка на бота, показывается после отправки
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

const PUBLIC = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function render(file) {
  let html = fs.readFileSync(path.join(PUBLIC, file), "utf8");
  const pixel = PIXEL_ID
    ? `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${PIXEL_ID}');fbq('track','PageView');</script>`
    : "";
  return html
    .replace("<!--PIXEL-->", pixel)
    .replace(/\{\{SITE_URL\}\}/g, SITE_URL)
    .replace(/\{\{BOT_LINK\}\}/g, BOT_LINK)
    .replace(/\{\{TURNSTILE_SITEKEY\}\}/g, "");
}
const pages = {
  "/": render("index.html"),
  "/privacy": render("privacy.html"),
};

// ---- защита от спама: простой лимит по IP
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 5;
}
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s, n) => String(s || "").trim().slice(0, n);

function normTelegram(raw) {
  let v = clip(raw, 80).replace(/^https?:\/\//i, "").replace(/^(www\.)?(t\.me|telegram\.me)\//i, "");
  v = v.replace(/^@/, "").replace(/[/?].*$/, "");
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v) ? v : null;
}

function validate(b) {
  const errors = {};
  const parent = clip(b.parent_name, 60);
  const child = clip(b.child_name, 40);
  const age = parseInt(b.age, 10);
  const country = clip(b.country, 60);
  const tg = normTelegram(b.telegram);
  if (parent.length < 2) errors.parent_name = "Укажите ваше имя";
  if (!(age >= 5 && age <= 14)) errors.age = "Укажите возраст ребёнка";
  if (country.length < 2) errors.country = "Укажите страну";
  if (!tg) errors.telegram = "Укажите ваш ник в Telegram, например @mama_anna";
  if (b.consent !== true) errors.consent = "Нужно согласие на обработку данных";
  return {
    errors,
    data: { parent, child, age, country, tg, comment: clip(b.comment, 400), time: clip(b.time, 80) },
  };
}

async function sendToTelegram(d, meta) {
  const lines = [
    "🆕 <b>Новая заявка с лендинга</b>",
    "",
    `👤 Родитель: <b>${esc(d.parent)}</b>`,
    `✈️ Telegram: @${esc(d.tg)}`,
    `🧒 Ребёнок: ${d.child ? esc(d.child) + ", " : ""}${d.age} лет`,
    `🌍 Страна: ${esc(d.country)}`,
  ];
  if (d.time) lines.push(`🕒 Удобное время: ${esc(d.time)}`);
  if (d.comment) lines.push(`💬 ${esc(d.comment)}`);
  const src = [meta.utm_source, meta.utm_campaign, meta.utm_content].filter(Boolean).join(" / ");
  if (src) lines.push("", `📈 Источник: ${esc(src)}`);
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: LEADS_CHAT_ID,
      text: lines.join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: "Написать родителю", url: `https://t.me/${d.tg}` }]],
      },
    }),
  });
  if (!res.ok) throw new Error("telegram " + res.status + " " + (await res.text()));
}

async function sendCapi(req, meta, eventId) {
  if (!PIXEL_ID || !CAPI_TOKEN) return;
  const body = {
    data: [
      {
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: "website",
        event_source_url: meta.url || SITE_URL,
        user_data: {
          client_ip_address: clientIp(req),
          client_user_agent: req.headers["user-agent"] || "",
          fbp: meta.fbp || undefined,
          fbc: meta.fbc || undefined,
        },
      },
    ],
  };
  if (CAPI_TEST_CODE) body.test_event_code = CAPI_TEST_CODE;
  await fetch(`https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${CAPI_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function backup(d, meta) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(DATA_DIR, "leads.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), ...d, ...meta }) + "\n"
    );
  } catch (e) {
    console.error("backup failed", e.message);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 20000) {
        reject(new Error("too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (req.method === "POST" && url.pathname === "/api/lead") {
    try {
      const body = await readJson(req);
      if (body.website) return json(res, 200, { ok: true }); // honeypot
      if (rateLimited(clientIp(req))) return json(res, 429, { ok: false, error: "Слишком много попыток, попробуйте позже" });
      const { errors, data } = validate(body);
      if (Object.keys(errors).length) return json(res, 400, { ok: false, errors });
      const meta = {
        utm_source: clip(body.utm_source, 60),
        utm_campaign: clip(body.utm_campaign, 80),
        utm_content: clip(body.utm_content, 80),
        fbp: clip(body.fbp, 120),
        fbc: clip(body.fbc, 200),
        url: clip(body.url, 300),
      };
      backup(data, meta);
      if (!BOT_TOKEN || !LEADS_CHAT_ID) {
        console.error("BOT_TOKEN / LEADS_CHAT_ID не заданы, заявка сохранена только в файл");
      } else {
        await sendToTelegram(data, meta);
      }
      const eventId = clip(body.event_id, 64) || crypto.randomUUID();
      sendCapi(req, meta, eventId).catch((e) => console.error("capi", e.message));
      return json(res, 200, { ok: true });
    } catch (e) {
      console.error("lead error", e.message);
      return json(res, 500, { ok: false, error: "Не получилось отправить, попробуйте ещё раз" });
    }
  }

  if (req.method === "GET" && pages[url.pathname]) {
    res.writeHead(200, { "content-type": MIME[".html"] });
    return res.end(pages[url.pathname]);
  }
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });

  // статика
  const file = path.normalize(path.join(PUBLIC, url.pathname));
  if (req.method === "GET" && file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile() && !file.endsWith(".html")) {
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "public, max-age=3600" });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, () => console.log("listening on", PORT));
