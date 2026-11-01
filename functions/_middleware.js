// Cloudflare Pages middleware: подставляет значения в HTML так же, как server.js
// (пиксель Meta, SITE_URL, BOT_LINK, ключ Turnstile). Остальные ответы не трогает.

function pixelSnippet(id) {
  return `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${id}');fbq('track','PageView');</script>`;
}

export async function onRequest(context) {
  const { env } = context;
  const response = await context.next();
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return response;

  let html = await response.text();
  const siteUrl = (env.SITE_URL || new URL(context.request.url).origin).replace(/\/$/, "");
  html = html
    .replace("<!--PIXEL-->", env.META_PIXEL_ID ? pixelSnippet(env.META_PIXEL_ID) : "")
    .replace(/\{\{SITE_URL\}\}/g, siteUrl)
    .replace(/\{\{BOT_LINK\}\}/g, env.BOT_LINK || "")
    .replace(/\{\{TURNSTILE_SITEKEY\}\}/g, env.TURNSTILE_SITEKEY || "");

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-cache");
  return new Response(html, { status: response.status, headers });
}
