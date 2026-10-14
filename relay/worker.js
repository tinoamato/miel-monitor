// Relay del bot compartido (Cloudflare Worker, plan gratis). Sin base de datos.
//   POST /webhook  Telegram → responde a cualquier mensaje con el TELEGRAM_CHAT_ID y la RELAY_KEY de ese chat.
//   POST /send     monitores → verifica la RELAY_KEY y reenvía el mensaje a Telegram.
//   POST /setup    admin, una vez → conecta el webhook del bot a este Worker.
// RELAY_KEY = HMAC(RELAY_SECRET, chat_id): cada clave sólo sirve para escribirle a su propio chat.
// Secrets (wrangler secret put): BOT_TOKEN, RELAY_SECRET, WEBHOOK_SECRET.

const GUIDE_URL = 'https://github.com/tinoamato/miel-monitor#instalación';
const enc = new TextEncoder();

function hmacKey(env) {
  return crypto.subtle.importKey('raw', enc.encode(env.RELAY_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const toB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function relayKeyFor(chatId, env) {
  return toB64url(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(String(chatId))));
}

async function isValidKey(chatId, key, env) {
  if (typeof key !== 'string' || !/^[\w-]{43}$/.test(key)) return false;
  // verify() compara en tiempo constante.
  return crypto.subtle.verify('HMAC', await hmacKey(env), fromB64url(key), enc.encode(String(chatId)));
}

function telegram(env, method, payload) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function welcome(chatId, key) {
  return [
    '👋 <b>MIeL monitor</b>',
    '',
    'Cargá estos dos valores como <b>Secrets</b> en tu repo de GitHub:',
    '',
    `<b>TELEGRAM_CHAT_ID</b>\n<code>${chatId}</code>`,
    '',
    `<b>RELAY_KEY</b>\n<code>${key}</code>`,
    '',
    `📖 Guía paso a paso: ${GUIDE_URL}`,
    '',
    '🔒 <b>Nunca me mandes tu DNI ni tu contraseña.</b> Van sólo en los Secrets de TU repo; este bot no los necesita ni los guarda.',
  ].join('\n');
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method !== 'POST') return new Response('MIeL relay');

    if (pathname === '/send') {
      const body = await req.json().catch(() => null);
      if (!body || typeof body.text !== 'string' || !(await isValidKey(body.chat_id, body.key, env))) {
        return Response.json({ ok: false, description: 'RELAY_KEY o TELEGRAM_CHAT_ID inválidos' }, { status: 401 });
      }
      const res = await telegram(env, 'sendMessage', {
        chat_id: body.chat_id,
        text: body.text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      // Mismo status y JSON que Telegram: el monitor reintenta 429/5xx igual que con un bot propio.
      return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json' } });
    }

    // /webhook (Telegram) y /setup (admin) exigen el WEBHOOK_SECRET.
    if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });

    if (pathname === '/setup') {
      // Apunta el webhook del bot a este Worker; devuelve el resultado y el @usuario del bot.
      await telegram(env, 'setWebhook', { url: new URL('/webhook', req.url).href, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message'] });
      return new Response((await telegram(env, 'getMe', {})).body, { headers: { 'Content-Type': 'application/json' } });
    }

    if (pathname === '/webhook') {
      const chatId = (await req.json().catch(() => null))?.message?.chat?.id;
      if (chatId) await telegram(env, 'sendMessage', { chat_id: chatId, text: welcome(chatId, await relayKeyFor(chatId, env)), parse_mode: 'HTML' });
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  },
};
