// Chequeo rápido del relay sin Cloudflare: node relay/test.mjs
import assert from 'node:assert/strict';
import worker, { relayKeyFor } from './worker.js';

const env = { BOT_TOKEN: 'T', RELAY_SECRET: 'secreto', WEBHOOK_SECRET: 'wh' };
const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body) });
  return Response.json({ ok: true });
};
const post = (path, body, headers = {}) =>
  worker.fetch(new Request(`https://relay.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), env);

const key = await relayKeyFor(123, env);
assert.equal((await post('/send', { chat_id: 123, key, text: 'hola' })).status, 200);
assert.equal(sent.at(-1).body.chat_id, 123);
assert.equal(sent.at(-1).url, 'https://api.telegram.org/botT/sendMessage');

// La clave de un chat no sirve para otro, ni una clave inventada.
assert.equal((await post('/send', { chat_id: 456, key, text: 'x' })).status, 401);
assert.equal((await post('/send', { chat_id: 123, key: 'a'.repeat(43), text: 'x' })).status, 401);
assert.equal((await post('/send', { chat_id: 123, text: 'x' })).status, 401);
assert.equal(sent.length, 1);

// Webhook: sin el secret de Telegram se rechaza; con él responde la clave correcta.
assert.equal((await post('/webhook', { message: { chat: { id: 123 } } })).status, 403);
await post('/webhook', { message: { chat: { id: 123 } } }, { 'X-Telegram-Bot-Api-Secret-Token': 'wh' });
assert.ok(sent.at(-1).body.text.includes(key));

// Setup: protegido por el mismo secret; apunta el webhook a este Worker.
assert.equal((await post('/setup', {})).status, 403);
await post('/setup', {}, { 'X-Telegram-Bot-Api-Secret-Token': 'wh' });
assert.equal(sent.at(-2).body.url, 'https://relay.test/webhook');

console.log('✅ relay ok');
