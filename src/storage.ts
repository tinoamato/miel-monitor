import fs from 'node:fs/promises';
import path from 'node:path';

export const CACHE_DIR = path.resolve('.cache');
export const STATE_FILE = path.join(CACHE_DIR, 'state.json');

/** Días sin volver a ver un elemento antes de purgarlo del estado. */
const PRUNE_AFTER_DAYS = 90;

export interface SeenEntry {
  course: string;
  section: string;
  firstSeen: string;
  lastSeen: string;
}

export interface State {
  version: 1;
  seen: Record<string, SeenEntry>;
  lastRun?: string;
  /** Último error notificado, para no repetir la misma alerta en cada corrida. */
  lastError?: string;
  lastErrorAt?: string;
}

export interface LoadedState {
  state: State;
  /** true si no existía state.json (primera corrida o caché expirada). */
  isFresh: boolean;
}

export async function loadState(): Promise<LoadedState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as State;
    if (parsed?.version !== 1 || typeof parsed.seen !== 'object') {
      throw new Error('formato de state.json desconocido');
    }
    return { state: parsed, isFresh: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`⚠️  No se pudo leer ${STATE_FILE} (${(err as Error).message}); se inicia vacío.`);
    }
    return { state: { version: 1, seen: {} }, isFresh: true };
  }
}

/** Escritura atómica: archivo temporal + rename, para no corromper el estado si el proceso muere. */
export async function saveState(state: State): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, STATE_FILE);
}

export function hasSeen(state: State, id: string): boolean {
  return id in state.seen;
}

export function markSeen(state: State, id: string, course: string, section: string, now = new Date()): void {
  const iso = now.toISOString();
  const prev = state.seen[id];
  state.seen[id] = prev ? { ...prev, lastSeen: iso } : { course, section, firstSeen: iso, lastSeen: iso };
}

/** Elimina entradas que no aparecen en MIeL hace más de PRUNE_AFTER_DAYS días. */
export function pruneState(state: State, now = new Date()): number {
  const limit = now.getTime() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [id, entry] of Object.entries(state.seen)) {
    if (Date.parse(entry.lastSeen) < limit) {
      delete state.seen[id];
      removed++;
    }
  }
  return removed;
}
