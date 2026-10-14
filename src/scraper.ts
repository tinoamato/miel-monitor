import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from './storage';

export const BASE_URL = 'https://miel.unlam.edu.ar/';
const INTERNAL_URL_RE = /\/principal\/interno/;
const CONCURRENCY = 3;

/**
 * Selectores. Los de login están verificados contra el HTML público de MIeL.
 * Los de las vistas internas se detectan por heurística; si MIeL cambia o la
 * heurística falla, se pueden fijar por variable de entorno sin tocar código.
 */
export const SELECTORS = {
  user: '#usuario',
  pass: '#clave',
  submit: '#btnLogin',
  courseBlocks: process.env.MIEL_SEL_COURSE_BLOCKS ?? '',
  messageItems: process.env.MIEL_SEL_MESSAGE_ITEMS ?? '',
  portfolioItems: process.env.MIEL_SEL_PORTFOLIO_ITEMS ?? '',
};

export type Section = 'Mensajes' | 'Portafolio';

export interface Update {
  id: string;
  course: string;
  section: Section;
  detail: string;
  sender?: string;
  date?: string;
  url?: string;
  unread: boolean;
}

export interface Course {
  name: string;
  /** Identificador estable de la comisión (se usa en el hash de cada elemento). */
  url: string;
  badge: number | null;
  sections: SectionLink[];
}

interface RawItem {
  text: string;
  cells: { header: string; text: string }[];
  href: string | null;
  unread: boolean;
}

/** Elemento ya interpretado por los parsers específicos de MIeL. */
interface ParsedItem {
  key: string;
  detail: string;
  sender: string | null;
  date: string | null;
  href: string | null;
  unread: boolean;
}

interface SectionLink {
  section: Section;
  url: string;
  badge: number | null;
}

export interface ScrapeOptions {
  headed: boolean;
  dump: boolean;
  /** Si true, sólo entra a materias cuyo badge en el panel principal sea > 0. */
  onlyWithBadges: boolean;
}

export interface ScrapeResult {
  updates: Update[];
  courses: Course[];
  warnings: string[];
}

/**
 * Helpers que corren dentro de la página. Van como string plano (no como
 * funciones TS) porque tsx/esbuild inyecta `__name()` en funciones anidadas y
 * eso rompe dentro de page.evaluate.
 */
const BROWSER_HELPERS = String.raw`
window.__miel = (function () {
  var norm = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };
  var abs = function (h) { try { return new URL(h, location.href).href; } catch (e) { return null; } };
  var isUsefulHref = function (h) {
    return h && !/^(#|javascript:|mailto:)/i.test(h) && !/logout|salir|cerrar/i.test(h);
  };
  var digits = function (el) {
    var badge = el.querySelector(BADGE_SEL);
    var t = badge ? norm(badge.textContent) : '';
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    var m = norm(el.textContent).match(/\((\d+)\)\s*$/);
    return m ? parseInt(m[1], 10) : null;
  };
  var BADGE_SEL = '.badge, .w3-badge, [class*="badge"], [class*="contador"], [class*="cantidad"], sup';
  var label = function (el) {
    var c = el.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll(BADGE_SEL), function (b) { b.remove(); });
    return norm(c.textContent).replace(/\(\d+\)\s*$/, '').trim();
  };
  var inChrome = function (el) {
    return !!el.closest('nav, header, footer, select, [role="navigation"], [role="menu"]');
  };

  return {
    // Panel principal: cada materia es un .materia-bloque con links directos a sus herramientas.
    // Las materias ocultas por el usuario (.materia-bloque-oculta) se ignoran.
    courses: function (blockSel) {
      var blocks = document.querySelectorAll(blockSel || '.materia-bloque:not(.materia-bloque-oculta)');
      return Array.prototype.map.call(blocks, function (b) {
        var title = norm((b.querySelector('.materia-titulo') || {}).textContent);
        var com = (norm((b.querySelector('.materia-descripcion .w3-small') || {}).textContent).match(/Com:\s*([\w-]+)/) || [])[1];
        var sections = [];
        [['Mensajes', 'a[href*="/mensajeria/"]'], ['Portafolio', 'a[href*="/portafolio/"]']].forEach(function (pair) {
          var a = b.querySelector(pair[1]);
          if (a) sections.push({ section: pair[0], url: abs(a.getAttribute('href')), badge: digits(a) });
        });
        return {
          name: com ? title + ' (Com ' + com + ')' : title,
          url: abs('/principal/interno/#comision-' + (b.getAttribute('data-id') || title)),
          badge: sections.reduce(function (n, s) { return s.badge == null ? n : (n || 0) + s.badge; }, null),
          sections: sections
        };
      }).filter(function (c) { return c.name && c.sections.length; });
    },

    // Bandeja de entrada de una comisión (/mensajeria/entrada/...). Columnas reales:
    // fecha | remitente | adjunto | asunto (a.verMensaje) | favorito + leído | fecha
    messages: function () {
      var out = [];
      Array.prototype.forEach.call(document.querySelectorAll('table tbody tr'), function (tr) {
        var a = tr.querySelector('a.verMensaje');
        if (!a) return;
        var tds = tr.querySelectorAll('td');
        var leido = tr.querySelector('.botonLeido');
        var id = (leido && leido.getAttribute('data-id')) || (a.getAttribute('href').match(/\/id\/(\d+)/) || [])[1] || norm(a.textContent);
        out.push({
          key: 'msg:' + id,
          detail: norm(a.textContent) + (tr.querySelector('[title*="adjunto"]') ? ' 📎' : ''),
          sender: norm(tds[1] && tds[1].textContent) || null,
          date: norm(tds[0] && tds[0].textContent) || null,
          href: abs(a.getAttribute('href')),
          unread: !tr.classList.contains('mensaje-leido') || (!!leido && leido.getAttribute('data-estado') === '0')
        });
      });
      return out;
    },

    // Portafolio (/portafolio/practicas/...). Columnas por encabezado:
    // Práctica | Entrega | F. vencim. | Detalle entregas | F. entrega | F. correc. | Estado | Nota
    portfolio: function () {
      var table = document.querySelector('table');
      if (!table) return [];
      var heads = Array.prototype.map.call(table.querySelectorAll('thead th'), function (th) { return norm(th.textContent).toLowerCase(); });
      var col = function (re, fallback) { var i = heads.findIndex(function (h) { return re.test(h); }); return i >= 0 ? i : fallback; };
      var iPr = col(/pr[aá]ctica/, 0), iTipo = col(/^entrega$/, 1), iVenc = col(/venc/, 2), iDet = col(/detalle/, 3),
          iEnt = col(/f\.?\s*entrega/, 4), iCor = col(/correc/, 5), iEst = col(/estado/, 6), iNota = col(/nota/, 7);
      var out = [];
      Array.prototype.forEach.call(table.querySelectorAll('tbody tr'), function (tr) {
        var tds = tr.querySelectorAll('td');
        if (tds.length < 4) return;
        // innerText respeta los <br> ("Opcional<br>Individual" → "Opcional Individual").
        var cell = function (i) { var t = norm(tds[i] && (tds[i].innerText || tds[i].textContent)); return t && t !== '---' ? t : ''; };
        var nameLink = tds[iPr].querySelector('a');
        // Filas como "Otras prácticas" tienen el link vacío: se usa el texto de la celda.
        var name = (nameLink && norm(nameLink.textContent)) || cell(iPr);
        var detLink = tds[iDet] && tds[iDet].querySelector('a[href]');
        var href = detLink ? abs(detLink.getAttribute('href')) : nameLink ? abs(nameLink.getAttribute('href')) : null;
        var practicaId = (href && (href.match(/\/id\/(\d+)/) || [])[1]) || name;
        var estado = cell(iEst), nota = cell(iNota), ent = cell(iEnt), cor = cell(iCor), venc = cell(iVenc), tipo = cell(iTipo);
        var parts = [name];
        if (estado) parts.push('Estado: ' + estado);
        if (nota) parts.push('Nota: ' + nota);
        if (!estado && !nota) parts.push(tipo ? 'Práctica ' + tipo.toLowerCase() : 'Práctica publicada');
        if (venc) parts.push('Vence: ' + venc);
        out.push({
          // Cambia cuando se entrega, se corrige, cambia el estado o se carga la nota.
          key: 'pf:' + practicaId + '|' + [ent, cor, estado, nota].join('|'),
          detail: parts.join(' · '),
          sender: null,
          date: cor ? cor + ' (corrección)' : ent ? ent + ' (entrega)' : venc ? venc + ' (vencimiento)' : null,
          href: href,
          unread: false
        });
      });
      return out;
    },

    // Extractor genérico, sólo se usa si se fija un selector manual por variable de entorno.
    items: function (customSel) {
      var scope = document.querySelector('main, #contenido, .contenido, #content, .content') || document.body;
      var rows = [];
      var headers = [];
      if (customSel) {
        rows = Array.prototype.slice.call(document.querySelectorAll(customSel));
      } else {
        var tables = Array.prototype.slice.call(scope.querySelectorAll('table')).filter(function (t) { return !inChrome(t); });
        var best = null, bestCount = 0;
        tables.forEach(function (t) {
          var n = t.querySelectorAll('tbody tr').length;
          if (n > bestCount) { best = t; bestCount = n; }
        });
        if (best) {
          headers = Array.prototype.slice.call(best.querySelectorAll('thead th, tr:first-child th')).map(function (th) { return norm(th.textContent); });
          rows = Array.prototype.slice.call(best.querySelectorAll('tbody tr')).filter(function (tr) {
            return tr.querySelectorAll('td').length > 0;
          });
        }
        if (!rows.length) {
          // Sin tabla: el grupo más grande de hermanos con mismo tag+clase y texto.
          var groups = {};
          var all = scope.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (!el.parentElement || inChrome(el) || /^(SCRIPT|STYLE|OPTION|BR|HR|SPAN|A|B|I|STRONG|EM|SMALL|IMG|SVG|PATH|INPUT|BUTTON|LABEL)$/.test(el.tagName)) continue;
            if (norm(el.textContent).length < 8) continue;
            if (!el.parentElement.__mielId) el.parentElement.__mielId = 'p' + i;
            var key = el.parentElement.__mielId + '|' + el.tagName + '.' + el.className;
            (groups[key] = groups[key] || []).push(el);
          }
          // Mayor cantidad de elementos; ante empate, el grupo más "hoja" (menos descendientes).
          var size = function (g) { return g.reduce(function (n, e) { return n + e.getElementsByTagName('*').length; }, 0); };
          Object.keys(groups).forEach(function (k) {
            var g = groups[k];
            if (g.length > rows.length || (g.length === rows.length && size(g) < size(rows))) rows = g;
          });
          if (rows.length < 2) rows = [];
        }
      }
      return rows.map(function (row) {
        var cells = Array.prototype.slice.call(row.querySelectorAll('td')).map(function (td, idx) {
          return { header: headers[idx] || '', text: norm(td.textContent) };
        });
        var link = Array.prototype.slice.call(row.querySelectorAll('a[href]')).find(function (a) { return isUsefulHref(a.getAttribute('href')); });
        var cls = (row.className || '') + ' ' + Array.prototype.slice.call(row.querySelectorAll('[class]')).map(function (e) { return e.className; }).join(' ');
        var weight = parseInt(getComputedStyle(row.querySelector('td') || row).fontWeight, 10) || 400;
        var unread = /no[-_\s]?le[ií]d|nuevo|unread|sin[-_\s]?leer|novedad/i.test(cls + ' ' + (row.getAttribute('title') || '')) || weight >= 600;
        return { text: norm(row.innerText || row.textContent), cells: cells, href: link ? abs(link.getAttribute('href')) : null, unread: unread };
      }).filter(function (r) { return r.text.length > 0; });
    }
  };
})();
`;

const DATE_RE = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?:\s*-?\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*hs\.?)?)?/i;
/** Textos relativos que cambian solos ("hace 2 horas") y generarían falsos positivos. */
const VOLATILE_RE = /\b(hace|faltan?|quedan?|resta[n]?)\s+\d+\s+\p{L}+/giu;

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

let dumpCounter = 0;
async function dumpPage(page: Page, label: string, enabled: boolean): Promise<void> {
  if (!enabled) return;
  const dir = path.join(CACHE_DIR, 'debug');
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, `${String(++dumpCounter).padStart(2, '0')}-${label.replace(/[^\w-]+/g, '_').slice(0, 50)}`);
  await fs.writeFile(`${base}.html`, await page.content(), 'utf8');
  await page.screenshot({ path: `${base}.png`, fullPage: true });
  console.log(`   🗂  dump: ${base}.{html,png}`);
}

export async function saveFailureScreenshot(page: Page | undefined): Promise<void> {
  if (!page || page.isClosed()) return;
  const dir = path.join(CACHE_DIR, 'debug');
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, 'error.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(dir, 'error.html'), await page.content().catch(() => ''), 'utf8');
}

async function closePopups(page: Page): Promise<void> {
  // MIeL a veces muestra avisos en modales (magnific-popup) al entrar.
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('.mfp-close').first().click({ timeout: 1000 }).catch(() => {});
}

export async function login(page: Page, user: string, pass: string, dump: boolean): Promise<void> {
  console.log('🔐 Iniciando sesión…');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  if (INTERNAL_URL_RE.test(page.url())) return;

  await page.locator(SELECTORS.user).fill(user);
  await page.locator(SELECTORS.pass).fill(pass);
  await dumpPage(page, 'login', dump);

  try {
    await Promise.all([
      page.waitForURL(INTERNAL_URL_RE, { timeout: 30_000 }),
      page.locator(SELECTORS.submit).click(),
    ]);
  } catch {
    // Intentar leer el mensaje de error que muestra MIeL (credenciales inválidas, etc.).
    const msg = await page
      .locator('.error, .mensaje-error, .w3-red, .w3-pale-red, label.error:visible, [class*="error"]:visible')
      .allInnerTexts()
      .then((t) => t.map((s) => s.trim()).filter(Boolean).join(' | '))
      .catch(() => '');
    throw new Error(`Login fallido: no se llegó a /principal/interno/${msg ? ` — MIeL dice: "${msg}"` : ''}`);
  }
  await page.waitForSelector('.materia-bloque', { timeout: 10_000 }).catch(() => {});
  await closePopups(page);
  console.log('✅ Sesión iniciada');
}

async function getCourses(page: Page, dump: boolean): Promise<Course[]> {
  await dumpPage(page, 'principal', dump);
  return page.evaluate((sel) => (window as any).__miel.courses(sel), SELECTORS.courseBlocks);
}

function toUpdate(course: Course, section: Section, raw: RawItem): Update {
  const byHeader = (re: RegExp) => raw.cells.find((c) => re.test(c.header) && c.text)?.text;
  const date = byHeader(/fecha|enviado|publicad|entrega|vencimiento/i) ?? raw.text.match(DATE_RE)?.[0];
  const sender = section === 'Mensajes' ? byHeader(/remitente|^de$|autor|enviado por|docente/i) : undefined;
  const subject = byHeader(/asunto|t[ií]tulo|actividad|trabajo|nombre/i);

  const detailParts = subject
    ? [subject, ...raw.cells.filter((c) => c.text && c.text !== subject && c.text !== sender && c.text !== date).map((c) => c.text)]
    : [raw.text];
  const detail = detailParts.join(' · ');

  // Mensajes: el link es estable aunque cambie el estado leído/no leído.
  // Portafolio: se hashea el texto para detectar cambios de estado/nota/corrección.
  const stableText = raw.text.replace(VOLATILE_RE, '').replace(/\s+/g, ' ').trim();
  const key = section === 'Mensajes' && raw.href ? raw.href : stableText;
  return {
    id: sha1(`${course.url}|${section}|${key}`),
    course: course.name,
    section,
    detail,
    sender,
    date,
    url: raw.href ?? undefined,
    unread: raw.unread,
  };
}

async function scrapeSection(page: Page, course: Course, link: SectionLink, dump: boolean): Promise<Update[]> {
  await page.goto(link.url, { waitUntil: 'domcontentloaded' });
  // Una bandeja vacía puede no tener tabla: el timeout corto evita esperar de más.
  await page.waitForSelector('table', { timeout: 4_000 }).catch(() => {});
  await dumpPage(page, `${course.name}-${link.section}`, dump);
  const sel = link.section === 'Mensajes' ? SELECTORS.messageItems : SELECTORS.portfolioItems;
  if (sel) {
    const raw: RawItem[] = await page.evaluate((s) => (window as any).__miel.items(s), sel);
    return raw.map((r) => toUpdate(course, link.section, r));
  }
  const fn = link.section === 'Mensajes' ? 'messages' : 'portfolio';
  const parsed: ParsedItem[] = await page.evaluate((f) => (window as any).__miel[f](), fn);
  return parsed.map((p) => ({
    id: sha1(`${course.url}|${link.section}|${p.key}`),
    course: course.name,
    section: link.section,
    detail: p.detail,
    sender: p.sender ?? undefined,
    date: p.date ?? undefined,
    url: p.href ?? undefined,
    unread: p.unread,
  }));
}

export async function scrape(user: string, pass: string, opts: ScrapeOptions): Promise<ScrapeResult> {
  let browser: Browser | undefined;
  let page: Page | undefined;
  const warnings: string[] = [];
  try {
    browser = await chromium.launch({
      headless: !opts.headed,
      slowMo: opts.headed ? 150 : 0,
      // En GitHub Actions se usa el Google Chrome preinstalado del runner (evita descargar Chromium).
      channel: process.env.MIEL_BROWSER_CHANNEL || undefined,
    });
    const context: BrowserContext = await browser.newContext({
      locale: 'es-AR',
      timezoneId: 'America/Argentina/Buenos_Aires',
      viewport: { width: 1366, height: 900 },
    });
    await context.addInitScript({ content: BROWSER_HELPERS });
    // Sólo se lee texto de las tablas: imágenes, fuentes y media son tiempo perdido.
    if (!opts.dump) {
      await context.route('**/*', (r) =>
        ['image', 'font', 'media'].includes(r.request().resourceType()) ? r.abort() : r.continue(),
      );
    }
    context.setDefaultTimeout(20_000);
    page = await context.newPage();

    await login(page, user, pass, opts.dump);
    const courses = await getCourses(page, opts.dump);
    if (!courses.length) {
      throw new Error(
        'No se encontraron materias en "Materias activas". Corré con --headed --dump y configurá MIEL_SEL_COURSE_BLOCKS.',
      );
    }
    console.log(`📚 ${courses.length} materia(s): ${courses.map((c) => `${c.name}${c.badge != null ? ` [${c.badge}]` : ''}`).join(', ')}`);

    // Materias sin mensajería (p.ej. "Autoguía") simplemente no tienen esa sección.
    const tasks = courses
      .filter((c) => !(opts.onlyWithBadges && c.badge === 0))
      .flatMap((course) => course.sections.map((link) => ({ course, link })));
    const results: Update[][] = tasks.map(() => []);
    let next = 0;
    // Pool de pestañas que comparten la sesión: las secciones se leen en paralelo.
    const worker = async (p: Page) => {
      while (next < tasks.length) {
        const i = next++;
        const { course, link } = tasks[i];
        try {
          results[i] = await scrapeSection(p, course, link, opts.dump);
          console.log(`   ${course.name} › ${link.section}: ${results[i].length} elemento(s)${link.badge ? ` (badge ${link.badge})` : ''}`);
        } catch (err) {
          warnings.push(`${course.name} › ${link.section}: ${(err as Error).message.split('\n')[0]}`);
        }
      }
    };
    const extra = await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) - 1 }, () => context.newPage()));
    await Promise.all([worker(page), ...extra.map(worker)]);
    const updates = results.flat();
    return { updates, courses, warnings };
  } catch (err) {
    await saveFailureScreenshot(page);
    throw err;
  } finally {
    await browser?.close();
  }
}
