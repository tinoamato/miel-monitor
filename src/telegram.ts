import type { Update } from './scraper';

/** Con `token` usa un bot propio; si no, el bot compartido a través del relay (`relayUrl` + `relayKey`). */
export interface TelegramConfig {
  chatId: string;
  token?: string;
  relayUrl?: string;
  relayKey?: string;
}

const MAX_DETAIL_LENGTH = 700;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Se usa parse_mode HTML: es mucho más tolerante que MarkdownV2 con textos arbitrarios. */
export function formatUpdate(u: Update): string {
  const lines = [
    '🔔 <b>Nueva actualización en MIeL</b>',
    '',
    `📚 <b>Materia:</b> ${escapeHtml(u.course)}`,
    `📂 <b>Sección:</b> ${u.section}${u.unread ? ' (no leído)' : ''}`,
  ];
  if (u.sender) lines.push(`👤 <b>Remitente:</b> ${escapeHtml(u.sender)}`);
  lines.push(`📝 <b>Detalle:</b> ${escapeHtml(truncate(u.detail, MAX_DETAIL_LENGTH))}`);
  lines.push(`📅 <b>Fecha:</b> ${escapeHtml(u.date ?? 'no disponible')}`);
  if (u.url) lines.push('', `<a href="${escapeHtml(u.url)}">Abrir en MIeL</a>`);
  return lines.join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendTelegram(text: string, cfg: TelegramConfig, attempt = 1): Promise<void> {
  // El relay responde igual que Telegram (mismo status y JSON), así que los reintentos sirven para ambos.
  const url = cfg.token ? `https://api.telegram.org/bot${cfg.token}/sendMessage` : `${cfg.relayUrl}/send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: cfg.chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      key: cfg.relayKey,
    }),
  });

  if (res.ok) return;

  const body = (await res.json().catch(() => ({}))) as {
    description?: string;
    parameters?: { retry_after?: number };
  };

  // 429 = rate limit; Telegram indica cuántos segundos esperar.
  if (res.status === 429 && attempt <= 3) {
    await sleep(((body.parameters?.retry_after ?? 5) + 1) * 1000);
    return sendTelegram(text, cfg, attempt + 1);
  }
  if (res.status >= 500 && attempt <= 3) {
    await sleep(2000 * attempt);
    return sendTelegram(text, cfg, attempt + 1);
  }
  throw new Error(`Telegram respondió ${res.status}: ${body.description ?? res.statusText}`);
}

/** Envía varios mensajes respetando ~1 msg/seg por chat (límite de Telegram). */
export async function sendMany(texts: string[], cfg: TelegramConfig, onSent?: (i: number) => Promise<void>) {
  for (let i = 0; i < texts.length; i++) {
    await sendTelegram(texts[i], cfg);
    await onSent?.(i);
    if (i < texts.length - 1) await sleep(1100);
  }
}
