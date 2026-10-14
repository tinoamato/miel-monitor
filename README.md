# MIeL monitor

Te avisa por Telegram cuando aparece algo nuevo en **Mensajes** o **Portafolio** de tus materias de [MIeL (UNLaM)](https://miel.unlam.edu.ar/). Es gratis y corre en **tu propia cuenta de GitHub**. Tu DNI y tu contraseña no pasan por ningún servidor de otra persona.

## ¿Quién ve mis datos?

| Dato | Dónde queda | Quién lo puede ver |
|---|---|---|
| DNI y contraseña de MIeL | Secrets de **tu** repo privado (GitHub los guarda cifrados y los tapa en los logs) | Sólo tu cuenta de GitHub. Ni el autor ni el bot los reciben nunca |
| Estado (qué ya te avisó) | Caché de Actions de **tu** repo | Sólo vos |
| Texto de cada aviso (materia, asunto) | Pasa por el bot compartido para llegarte por Telegram | Si no querés eso, usá tu propio bot (ver abajo) |

> La contraseña no se puede *hashear*: el monitor tiene que escribirla en el login de MIeL, así que necesita el valor real. Por eso queda **cifrada** en GitHub, dentro de tu cuenta, y nadie más la ve.

## Instalación

Necesitás una cuenta de GitHub (gratis) y Telegram. Lleva unos 5 minutos.

### 1. Hablale al bot

Abrí **[@miel_centinela_bot](https://t.me/miel_centinela_bot)** en Telegram y mandale `/start`. Te responde con dos valores: `TELEGRAM_CHAT_ID` y `RELAY_KEY`. Tenelos a mano.

🔒 **Nunca le mandes tu DNI ni tu contraseña al bot.** No los necesita.

### 2. Creá tu copia (privada)

1. Entrá a [github.com/tinoamato/miel-monitor](https://github.com/tinoamato/miel-monitor) → botón verde **Use this template** → **Create a new repository**.
2. Ponele cualquier nombre y marcá **Private**. Es importante: tu repo tiene que ser privado.
3. **Create repository**.

### 3. Cargá tus credenciales

En tu repo nuevo: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Creá estos 4, uno por uno:

| Name | Valor |
|---|---|
| `MIEL_USER` | tu DNI (el usuario de MIeL) |
| `MIEL_PASS` | tu contraseña de MIeL |
| `TELEGRAM_CHAT_ID` | el número que te dio el bot |
| `RELAY_KEY` | la clave que te dio el bot |

Una vez guardado, un secret no se puede volver a leer, ni siquiera vos: sólo se puede reemplazar.

### 4. Probalo

Pestaña **Actions** → **MIeL monitor** → **Run workflow** → **Run workflow**. A los 30 segundos más o menos te llega **"MIeL monitor activo"** por Telegram.

Listo. Desde ahora revisa cada 30 minutos, de 8 a 22 h, y sólo te avisa cuando hay algo nuevo. La primera corrida registra lo que ya existe sin avisarte, para no mandarte 80 mensajes viejos.

¿Querés que revise cada 12 minutos y en horario exacto? Mirá [Opcional: avisos más rápidos](#opcional-avisos-más-rápidos-cada-12-min).

### Problemas comunes

| Síntoma | Solución |
|---|---|
| La corrida queda en rojo con *"Falta la variable de entorno …"* | Te faltó un secret o tiene otro nombre (paso 3) |
| *"RELAY_KEY o TELEGRAM_CHAT_ID inválidos"* | Volvé a mandarle `/start` al bot y copiá los valores de nuevo |
| Te llega *"MIeL monitor falló: login"* | Revisá `MIEL_USER`/`MIEL_PASS`. Si cambiaste la contraseña de MIeL, actualizá el secret |
| No corre solo | GitHub a veces atrasa los horarios automáticos. Si pasan horas sin correr, revisá que Actions esté habilitado |
| Con cron-job.org, la tarea da **401** o **404** | Venció el token o la URL tiene mal el usuario o repo. Revisá el paso 1 de "Avisos más rápidos" |

### Para dejar de usarlo

Borrá tu repo (**Settings** → **Delete this repository**). Con eso se borran también tus secrets. Si querés, bloqueá el bot en Telegram.

### Opcional: tu propio bot

Si no querés que los avisos pasen por el bot compartido: creá un bot con **@BotFather** (`/newbot`), mandale `/start` y agregá el secret `TELEGRAM_BOT_TOKEN` con su token. Tu `TELEGRAM_CHAT_ID` te lo da **@userinfobot**. Con ese secret cargado, `RELAY_KEY` no hace falta.

### Opcional: avisos más rápidos (cada 12 min)

El horario automático de GitHub es "mejor esfuerzo": atrasa o saltea corridas. Con [cron-job.org](https://cron-job.org) (gratis), tu monitor corre puntual y más seguido:

| Tarea | Días | Horas | Minutos | Corridas por día |
|---|---|---|---|---|
| Día hábil | Lunes a viernes | `8-20` | `7,19,31,43,55` (cada 12 min) | 65 |
| Fin de semana | Sábado y domingo | `9-20` | `7,37` (cada 30 min) | 24 |
| Tarde-noche | Todos los días | `6,21,22,23` | `7` | 4 |

Usa unos 1.800 de los 2.000 minutos gratis por mes. GitHub sigue corriendo 2 veces por día como respaldo.

**1. Token de GitHub**

1. Entrá a [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. **Token name:** `miel cron`. **Expiration:** la más larga que te deje (anotá la fecha).
3. **Repository access** → *Only select repositories* → elegí **tu** repo del monitor.
4. **Permissions** → *Repository permissions* → **Actions: Read and write**. No hace falta nada más.
5. **Generate token** y copialo (empieza con `github_pat_`). Sólo sirve para disparar el monitor de ese repo.

**2. Las 3 tareas en cron-job.org**

Creá una cuenta en [cron-job.org](https://cron-job.org) → **Create cronjob**:

- **URL:** `https://api.github.com/repos/TU_USUARIO/TU_REPO/actions/workflows/monitor.yml/dispatches`. Reemplazá `TU_USUARIO/TU_REPO` por los de tu copia, tal como aparecen en la barra del navegador.
- **Execution schedule** → *Custom*: los valores de la fila "Día hábil" de la tabla.
- Pestaña **Advanced**:
  - **Time zone:** `America/Argentina/Buenos_Aires`
  - **Request method:** `POST`
  - **Headers** (agregá los 3):
    - `Authorization` = `Bearer github_pat_…` (tu token)
    - `Accept` = `application/vnd.github+json`
    - `X-GitHub-Api-Version` = `2022-11-28`
  - **Request body:** `{"ref":"main"}`
- Guardá y tocá **Test run**. Tiene que responder **204**, y en la pestaña **Actions** de tu repo aparece una corrida nueva.

Duplicá la tarea (**⋮ → Clone**) dos veces y cambiale el horario a cada copia: una con la fila "Fin de semana" y otra con "Tarde-noche".

**3. Apagá el horario de 30 min de GitHub**

Si no lo apagás, se suman los dos horarios y te pasás de los minutos gratis. En tu repo: **Settings** → **Secrets and variables** → **Actions** → pestaña **Variables** → **New repository variable**:

- **Name:** `CRON_EXTERNO`
- **Value:** `true`

**Cuando venza el token**, generá uno nuevo y reemplazalo en las 3 tareas. Mientras tanto el monitor sigue andando, pero sólo con el respaldo de GitHub (2 veces por día).

**Para volver al modo normal**, borrá la variable `CRON_EXTERNO` y pausá las tareas de cron-job.org.

### Seguridad: fijar la versión

Tu copia usa el código de `tinoamato/miel-monitor@v1`, que se actualiza solo cuando MIeL cambia algo. Si preferís que no cambie sin que lo revises, en `.github/workflows/monitor.yml` reemplazá `@v1` por el SHA de un commit y agregá `ref: <ese SHA>` debajo de `with:`.

---

## Cómo funciona

```
src/
  index.ts     orquestador: flags, deduplicación, envío, manejo de errores
  scraper.ts   Playwright: login, materias, secciones, extracción
  telegram.ts  formateo HTML + envío (bot propio o relay) con reintentos (429/5xx)
  storage.ts   .cache/state.json (escritura atómica, purga a 90 días)
relay/         Cloudflare Worker del bot compartido (ver ADMIN.md)
.github/workflows/
  monitor.yml  el que corre en cada copia (horario + botón manual)
  run.yml      la lógica, reutilizable; baja el código de este repo en @v1
```

- **Deduplicación:** los mensajes se identifican por su link, así que no se vuelven a avisar cuando pasan de "no leído" a "leído". El portafolio se identifica por su texto, así que un cambio de estado, corrección o nota genera una alerta nueva.
- **Nunca abre los mensajes:** sólo lee los listados, así que no los marca como leídos.
- Si hay más de 10 novedades juntas, manda un único mensaje resumen.
- Si falla (login, cambios en el HTML), avisa **una vez** por cada error distinto y la corrida queda en rojo.
- El estado vive en la caché de Actions. Si no hay corridas por más de 7 días, GitHub lo borra y la siguiente corrida vuelve a registrar todo en silencio.

## Desarrollo local

Requiere Node.js 20 o superior.

```bash
cp .env.example .env          # completar MIEL_USER, MIEL_PASS y Telegram
npm install
npx playwright install chromium
npm run test:telegram
```

| Comando | Qué hace |
|---|---|
| `npm start` | Corrida normal |
| `npm run headed` | Navegador visible + `--dump` + `--dry-run` (no envía ni guarda estado) |
| `npm run dry` | Imprime las novedades por consola sin enviarlas |
| `npm run test:telegram` | Sólo envía un mensaje de prueba |
| `node relay/test.mjs` | Chequeo del relay sin Cloudflare |

Si MIeL cambia el HTML: corré `npm run headed`, mirá `.cache/debug/` y ajustá los parsers en `BROWSER_HELPERS` (`src/scraper.ts`). Como parche rápido, cada usuario puede cargar **Variables** en su repo (`MIEL_SEL_COURSE_BLOCKS`, `MIEL_SEL_MESSAGE_ITEMS`, `MIEL_SEL_PORTFOLIO_ITEMS`).
