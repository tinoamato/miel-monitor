import 'dotenv/config';
import { scrape, type Update } from './scraper';
import { loadState, markSeen, hasSeen, pruneState, saveState } from './storage';
import { escapeHtml, formatUpdate, sendMany, sendTelegram, type TelegramConfig } from './telegram';

const MAX_INDIVIDUAL_MESSAGES = 10;
const REPEAT_ERROR_MS = 6 * 60 * 60 * 1000;

const args = new Set(process.argv.slice(2));
const flags = {
  headed: args.has('--headed'),
  dump: args.has('--dump') || process.env.MIEL_DUMP === 'true',
  /** No envía nada a Telegram ni modifica state.json: sólo imprime. */
  dryRun: args.has('--dry-run'),
  /** En la primera corrida, notifica todo en vez de indexar en silencio. */
  notifyAll: args.has('--notify-all'),
  testTelegram: args.has('--test-telegram'),
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`❌ Falta la variable de entorno ${name} (revisá .env o los Secrets de GitHub).`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const needsTelegram = !flags.dryRun || flags.testTelegram;
  const telegram: TelegramConfig | null = needsTelegram
    ? process.env.TELEGRAM_BOT_TOKEN?.trim()
      ? { token: requireEnv('TELEGRAM_BOT_TOKEN'), chatId: requireEnv('TELEGRAM_CHAT_ID') }
      : { relayUrl: requireEnv('TELEGRAM_RELAY_URL'), relayKey: requireEnv('RELAY_KEY'), chatId: requireEnv('TELEGRAM_CHAT_ID') }
    : null;

  if (flags.testTelegram) {
    await sendTelegram('✅ <b>MIeL monitor</b>: el bot de Telegram está bien configurado.', telegram!);
    console.log('✅ Mensaje de prueba enviado a Telegram.');
    return;
  }

  const user = requireEnv('MIEL_USER');
  const pass = requireEnv('MIEL_PASS');
  const { state, isFresh } = await loadState();
  const now = new Date();

  let updates: Update[];
  let warnings: string[];
  try {
    ({ updates, warnings } = await scrape(user, pass, {
      headed: flags.headed,
      dump: flags.dump,
      onlyWithBadges: process.env.MIEL_ONLY_WITH_BADGES === 'true',
    }));
  } catch (err) {
    const message = (err as Error).message.split('\n')[0];
    console.error(`❌ ${message}`);
    // Avisar por Telegram una vez por error distinto (y de nuevo cada 6 h si persiste), sin spamear.
    const stale = !state.lastErrorAt || now.getTime() - Date.parse(state.lastErrorAt) > REPEAT_ERROR_MS;
    if (telegram && !flags.dryRun && (state.lastError !== message || stale)) {
      await sendTelegram(`⚠️ <b>MIeL monitor falló</b>\n${escapeHtml(message)}`, telegram).catch(() => {});
      state.lastError = message;
      state.lastErrorAt = now.toISOString();
      await saveState(state);
    }
    process.exitCode = 1;
    return;
  }

  warnings.forEach((w) => console.warn(`⚠️  ${w}`));

  // Un mismo elemento puede aparecer duplicado en la página: deduplicar por id.
  const unique = [...new Map(updates.map((u) => [u.id, u])).values()];
  const fresh = unique.filter((u) => !hasSeen(state, u.id));
  console.log(`🔎 ${unique.length} elemento(s) relevados, ${fresh.length} nuevo(s).`);

  if (flags.dryRun) {
    fresh.forEach((u) => console.log(`\n${formatUpdate(u).replace(/<[^>]+>/g, '')}`));
    console.log('\n(dry-run: no se envió nada ni se modificó state.json)');
    return;
  }

  // Todo lo que sigue visible en MIeL renueva su lastSeen (evita que se purgue).
  unique.filter((u) => hasSeen(state, u.id)).forEach((u) => markSeen(state, u.id, u.course, u.section, now));

  if (isFresh && !flags.notifyAll) {
    // Primera corrida (o caché expirada): indexar sin notificar cada elemento viejo.
    fresh.forEach((u) => markSeen(state, u.id, u.course, u.section, now));
    await sendTelegram(
      `✅ <b>MIeL monitor activo</b>\nSe indexaron ${fresh.length} elemento(s) existentes. ` +
        'A partir de ahora sólo vas a recibir novedades.',
      telegram!,
    );
  } else if (fresh.length > MAX_INDIVIDUAL_MESSAGES) {
    // Muchas novedades juntas (p.ej. cambió el HTML de MIeL): un único resumen en vez de un aluvión.
    const lines = fresh.map((u) => `• <b>${escapeHtml(u.course)}</b> › ${u.section}: ${escapeHtml(u.detail.slice(0, 90))}`);
    let text = `🔔 <b>${fresh.length} novedades en MIeL</b>\n\n`;
    for (const line of lines) {
      if (text.length + line.length > 3900) {
        text += '\n…';
        break;
      }
      text += `${line}\n`;
    }
    await sendTelegram(text, telegram!);
    fresh.forEach((u) => markSeen(state, u.id, u.course, u.section, now));
  } else {
    // Se guarda el estado después de cada envío: si algo falla a mitad, no se re-notifica lo ya enviado.
    await sendMany(fresh.map(formatUpdate), telegram!, async (i) => {
      markSeen(state, fresh[i].id, fresh[i].course, fresh[i].section, now);
      await saveState(state);
    });
  }

  const pruned = pruneState(state, now);
  if (pruned) console.log(`🧹 ${pruned} entrada(s) viejas eliminadas del estado.`);
  state.lastRun = now.toISOString();
  delete state.lastError;
  delete state.lastErrorAt;
  await saveState(state);
  console.log('🏁 Listo.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
