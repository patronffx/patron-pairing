import dotenv from 'dotenv';
dotenv.config();
import { Boom } from '@hapi/boom';
import Baileys, {
  DisconnectReason,
  delay,
  useMultiFileAuthState,
  Browsers
} from 'baileys';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';

// GitHub Gist upload function
async function createGist(content, filename = 'session.json') {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set in environment variables.');
  const response = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'session-uploader'
    }, 
    body: JSON.stringify({
      description: 'PATRON-MD Session',
      public: false,
      files: {
        [filename]: { content }
      }
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error('GitHub Gist upload failed: ' + response.status + ' ' + errText);
  }
  const data = await response.json();
  if (!data.html_url) throw new Error('GitHub did not return a gist url');
  return data.html_url;
}

import path, { dirname } from 'path';
import pino from 'pino';
import { fileURLToPath } from 'url';


const app = express();

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(cors());
let PORT = process.env.PORT || 8000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createRandomId() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 10; i++) {
    id += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return id;
}

let sessionFolder = `./auth/${createRandomId()}`;
if (fs.existsSync(sessionFolder)) {
  try {
    fs.rmdirSync(sessionFolder, { recursive: true });
    console.log('Deleted the "SESSION" folder.');
  } catch (err) {
    console.error('Error deleting the "SESSION" folder:', err);
  }
}

let clearState = () => {
  fs.rmdirSync(sessionFolder, { recursive: true });
};

function deleteSessionFolder() {
  try {
    if (fs.existsSync(sessionFolder)) {
      fs.rmSync(sessionFolder, { recursive: true, force: true });
      console.log('Deleted the "SESSION" folder.');
    } else {
      console.log('The "SESSION" folder does not exist.');
    }
  } catch (err) {
    console.error('Error deleting the "SESSION" folder:', err);
  }
}

app.get('/', async (req, res) => {
  res.sendFile(path.join(__dirname, 'pair.html'));
});

app.get('/pair', async (req, res) => {
  let phone = req.query.phone;

  if (!phone) return res.json({ error: 'Please Provide Phone Number' });

  try {
    const code = await startnigg(phone);
    res.json({ code: code });
  } catch (error) {
    console.error('Error in WhatsApp authentication:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function startnigg(phone) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!fs.existsSync(sessionFolder)) {
        fs.mkdirSync(sessionFolder, { recursive: true })
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionFolder)

      const negga = Baileys.makeWASocket({
        printQRInTerminal: false,
        logger: pino({ level: 'debug' }), // change to 'silent' if you want quiet logs
        browser: Browsers.ubuntu('Edge'),
        auth: state,
        version: [2, 3000, 1025190524], // your specified WA Web version
      })

      let hasValidCreds = false
      let isWaitingForPair = false

      // ─── pairing code section ───────────────────────────────
      if (!negga.authState.creds.registered) {
        let phoneNumber = phone ? phone.replace(/[^0-9]/g, '') : ''
        if (phoneNumber.length < 11) {
          return reject(new Error('Please Enter Your Number With Country Code !!'))
        }

        isWaitingForPair = true
        setTimeout(async () => {
          try {
            const customPair = 'PATRONMD'
            const code = await negga.requestPairingCode(phoneNumber, customPair)
            console.log(`📱 Your Pairing Code: ${code}`)
            resolve(code)
          } catch (err) {
            console.error('❌ Error requesting pairing code:', err)
            reject(new Error('Error requesting pairing code from WhatsApp'))
          }
        }, 2000)
      }

      // ─── creds update handler ───────────────────────────────
      negga.ev.on('creds.update', async (creds) => {
        try {
          await saveCreds()
          if (creds && creds.myAppStateKeyId) {
            console.log('✅ myAppStateKeyId detected:', creds.myAppStateKeyId)
            hasValidCreds = true
          } else if (!hasValidCreds && !isWaitingForPair) {
            console.log('⌛ Waiting for credentials to establish...')
          }
        } catch (error) {
          console.error('⚠️ Error saving creds:', error)
        }
      })

      // ─── connection updates + full debug ─────────────────────
      negga.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update

        if (connection === 'open') {
          if (isWaitingForPair) {
            console.log('Pairing in progress, please wait...')
            return
          }

          console.log('✅ Connected to WhatsApp successfully!')

          // wait until creds fully ready
          let attempts = 0
          while (!hasValidCreds && attempts < 20) {
            await delay(2000)
            attempts++
            if (attempts % 5 === 0) console.log(`Still waiting for credentials... (${attempts})`)
          }

          console.log('🌐 Connection verified. Bot ready.')

          // ---- your gist upload logic here (unchanged) ----
          // e.g. output = await createGist(credsContent, 'session.json')
          // sessi = 'PATRON-MD~' + output.split('/').pop()

          console.log('Connected to WhatsApp Servers ✅')

          // delete session folder only if you actually intend to
          try {
            deleteSessionFolder()
          } catch (e) {
            console.error('Error deleting session folder:', e)
          }

          process.send('reset')
        }

        if (connection === 'close') {
          console.log('\n🔻 Connection closed — debug info below:')
          console.log('lastDisconnect:', lastDisconnect)

          if (lastDisconnect?.error) {
            const err = lastDisconnect.error
            console.log('Error name:', err.name)
            console.log('Error message:', err.message)
            console.log('Error stack (trimmed):', err.stack?.split('\n')[0])
            console.log('Error statusCode:', err.output?.statusCode || err.status)
          }

          const boomReason = new Boom(lastDisconnect?.error)?.output?.statusCode
          console.log('Boom reason:', boomReason)
          console.log('DisconnectReason enums:', DisconnectReason)

          // ─── handle all disconnect reasons clearly ────────────
          switch (boomReason) {
            case DisconnectReason.connectionClosed:
              console.log('[⚠️ Connection closed, reconnecting...]')
              return process.send('reset')

            case DisconnectReason.connectionLost:
              console.log('[⚠️ Connection lost from server, reconnecting...]')
              return process.send('reset')

            case DisconnectReason.loggedOut:
              console.log('[🚪 Device logged out — clearing session and restarting]')
              clearState()
              return process.send('reset')

            case DisconnectReason.restartRequired:
              console.log('[🔁 Restart required — restarting now]')
              return startnigg(phone)

            case DisconnectReason.timedOut:
              console.log('[⏱️ Timed out — reconnecting...]')
              return process.send('reset')

            case DisconnectReason.badSession:
              console.log('[❌ Bad session — clearing state and restarting]')
              clearState()
              return process.send('reset')

            case DisconnectReason.connectionReplaced:
              console.log('[🔄 Connection replaced — reconnecting]')
              return process.send('reset')

            default:
              const status = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.status
              if (status) console.log('Status code from error:', status)
              console.log('[❗ Unknown disconnect reason — check debug info above]')
              return process.send('reset')
          }
        }
      })

      negga.ev.on('messages.upsert', () => {})
    } catch (error) {
      console.error('💥 Fatal error in startnigg():', error)
      reject(error)
    }
  })
}

app.listen(PORT, () => {
  console.log(`API Running on PORT:${PORT}`);
});
