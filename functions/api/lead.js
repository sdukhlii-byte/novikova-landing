// Cloudflare Pages Function: POST /api/lead
// Те же правила, что в server.js, но под Workers (без файловой системы).
// Переменные окружения: BOT_TOKEN, LEADS_CHAT_ID, META_PIXEL_ID, META_CAPI_TOKEN,
// META_TEST_EVENT_CODE, SITE_URL, TURNSTILE_SECRET (необязательно), LEADS_KV (необязательная привязка KV).

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s, n) => String(s || "").trim().slice(0, n);

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

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

async function verifyTurnstile(env, token, ip) {
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token || "");
  if (ip) form.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  return !!j.success;
}

async function sendToTelegram(env, d, meta) {
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
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.LEADS_CHAT_ID,
      text: lines.join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "Написать родителю", url: `https://t.me/${d.tg}` }]] },
    }),
  });
  if (!res.ok) throw new Error("telegram " + res.status + " " + (await res.text()));
}

async function sendCapi(env, request, meta, eventId) {
  if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) return;
  const body = {
    data: [
      {
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: "website",
        event_source_url: meta.url || (env.SITE_URL || ""),
        user_data: {
          client_ip_address: request.headers.get("CF-Connecting-IP") || undefined,
          client_user_agent: request.headers.get("user-agent") || "",
          fbp: meta.fbp || undefined,
          fbc: meta.fbc || undefined,
        },
      },
    ],
  };
  if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;
  await fetch(`https://graph.facebook.com/v19.0/${env.META_PIXEL_ID}/events?access_token=${env.META_CAPI_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 20000) return json({ ok: false, error: "Слишком большой запрос" }, 413);
    body = JSON.parse(raw || "{}");
  } catch (e) {
    return json({ ok: false, error: "Неверный запрос" }, 400);
  }

  if (body.website) return json({ ok: true }); // honeypot

  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(env, clip(body.turnstile, 2048), ip);
    if (!ok) return json({ ok: false, error: "Не удалось подтвердить, что вы не робот. Обновите страницу и попробуйте ещё раз" }, 400);
  }

  const { errors, data } = validate(body);
  if (Object.keys(errors).length) return json({ ok: false, errors }, 400);

  const meta = {
    utm_source: clip(body.utm_source, 60),
    utm_campaign: clip(body.utm_campaign, 80),
    utm_content: clip(body.utm_content, 80),
    fbp: clip(body.fbp, 120),
    fbc: clip(body.fbc, 200),
    url: clip(body.url, 300),
  };

  // Необязательная копия заявки в KV
  if (env.LEADS_KV) {
    const key = "lead:" + new Date().toISOString() + ":" + crypto.randomUUID().slice(0, 8);
    context.waitUntil(env.LEADS_KV.put(key, JSON.stringify({ ...data, ...meta })).catch(() => {}));
  }

  try {
    if (!env.BOT_TOKEN || !env.LEADS_CHAT_ID) {
      console.error("BOT_TOKEN / LEADS_CHAT_ID не заданы");
      return json({ ok: false, error: "Сервис временно недоступен, попробуйте позже" }, 500);
    }
    await sendToTelegram(env, data, meta);
  } catch (e) {
    console.error("lead error", e.message);
    return json({ ok: false, error: "Не получилось отправить, попробуйте ещё раз" }, 500);
  }

  const eventId = clip(body.event_id, 64) || crypto.randomUUID();
  context.waitUntil(sendCapi(env, request, meta, eventId).catch((e) => console.error("capi", e.message)));
  return json({ ok: true });
}

// Всё остальное на этом адресе недопустимо
export async function onRequest() {
  return json({ ok: false, error: "Method not allowed" }, 405);
}
