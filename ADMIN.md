# Administración (sólo el dueño del bot)

Todo se puede hacer con planes gratis: GitHub (repo público) y Cloudflare Workers (100.000 requests/día). Cada usuario gasta sus propios minutos de Actions, no los tuyos.

## 1. Bot

Podés usar el mismo bot de tu monitor personal: poner un webhook no afecta los `sendMessage` que ya hace. En @BotFather:

- `/setdescription`: *"Avisos de MIeL. Mandá /start para obtener tus claves. Nunca envíes tu DNI ni tu contraseña."*
- `/setcommands`: `start - Obtener TELEGRAM_CHAT_ID y RELAY_KEY`

## 2. Relay en Cloudflare

Necesitás una cuenta gratis en dash.cloudflare.com. Después:

```bash
cd relay
npx wrangler login
npx wrangler deploy                    # imprime la URL: https://miel-relay.<tu-subdominio>.workers.dev
npx wrangler secret put BOT_TOKEN      # token de BotFather
npx wrangler secret put RELAY_SECRET   # valor aleatorio, ver abajo
npx wrangler secret put WEBHOOK_SECRET # otro valor aleatorio distinto
```

Para generar los valores aleatorios: `node -e "console.log(crypto.randomBytes(32).toString('base64url'))"`.

Conectá el bot al Worker (una sola vez):

```bash
curl -X POST -H "X-Telegram-Bot-Api-Secret-Token: <WEBHOOK_SECRET>" https://miel-relay.<tu-subdominio>.workers.dev/setup
```

Responde con los datos del bot (`"username"`). Si cambiás de bot o de URL, volvé a correrlo.

Probalo: mandale `/start` al bot. Te tiene que responder con tu chat id y una clave.

## 3. Datos de este despliegue

| Dato | Valor | Dónde aparece |
|---|---|---|
| URL del relay | `https://miel-relay.tinoo-amato.workers.dev` | `.github/workflows/run.yml`, `.env.example` |
| Bot | `@miel_centinela_bot` | `README.md` |

Si cambiás de bot o de URL, actualizá esos archivos y mové el tag `v1` (ver abajo). Si el repo cambia de nombre `tinoamato/miel-monitor`, buscá y reemplazá ese nombre en `run.yml`, `monitor.yml`, `README.md` y `relay/worker.js`.

## 4. Publicar

```bash
git add . && git commit -m "MIeL monitor compartible"
gh repo create miel-monitor --public --source=. --push
git tag v1 && git push origin v1
```

Después, en GitHub: **Settings** → **General** → tildá **Template repository**.

Para compartirlo, pasá el link del repo. El README tiene la guía completa.

## Publicar un arreglo

Cuando MIeL cambie el HTML, arreglalo, commiteá y mové el tag. Les llega a todos en la siguiente corrida:

```bash
git tag -f v1 && git push -f origin v1
```

Si un cambio rompe la compatibilidad (por ejemplo, secrets nuevos), creá `v2` y avisá. Las copias existentes siguen en `v1`.

## Límites y mantenimiento

- **Revocar claves:** cambiar `RELAY_SECRET` invalida **todas** las `RELAY_KEY`, y cada usuario tiene que mandar `/start` de nuevo. No hay revocación individual porque el relay no guarda nada.
- **Qué ve el relay:** el texto de los avisos (materias, asuntos), pero nunca las credenciales. No los guarda: no hay logs persistentes salvo que actives *Workers Logs*.
- **Abuso:** una clave sólo sirve para escribirle a su propio chat. Si alguien satura el Worker, en el plan gratis Cloudflare corta al llegar a 100k requests/día. No se cobra nada; los avisos se cortan hasta el día siguiente.
- **Tu monitor personal** (`centinela-miel`, privado) sigue funcionando igual, independiente de esto.
