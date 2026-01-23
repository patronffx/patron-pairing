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

async function startnigg(phone) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!fs.existsSync(sessionFolder)) {
        fs.mkdirSync(sessionFolder, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

      // ✅ Socket creation with fixed version and browser
      const negga = Baileys.makeWASocket({
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Windows', 'Chrome', '10.0'],
        auth: state,
        version: [2, 3000, 1027934701],
      });

      let hasValidCreds = false;
      let isWaitingForPair = false;

      // ─── Pairing Code ───────────────────────────────
      if (!negga.authState.creds.registered) {
        const phoneNumber = phone ? phone.replace(/[^0-9]/g, '') : '';
        if (phoneNumber.length < 11) {
          return reject(new Error('Please Enter Your Number With Country Code !!'));
        }

        isWaitingForPair = true;
        setTimeout(async () => {
          try {
            const customPair = 'PATRONMD';
            const code = await negga.requestPairingCode(phoneNumber, customPair);
            console.log(`Your Pairing Code : ${code}`);
            resolve(code);
          } catch (err) {
            console.error('Error requesting pairing code:', err);
            reject(new Error('Error requesting pairing code from WhatsApp'));
          }
        }, 2000);
      }

      // ─── Creds Update ───────────────────────────────
      negga.ev.on('creds.update', async (creds) => {
        try {
          await saveCreds();
          if (creds && creds.myAppStateKeyId) {
            console.log('Found myAppStateKeyId:', creds.myAppStateKeyId);
            hasValidCreds = true;
          } else if (isWaitingForPair) return;
          else if (!hasValidCreds) console.log('Waiting for credentials to be established...');
        } catch (error) {
          console.error('Error in creds update:', error);
        }
      });

      // ─── Connection Update ───────────────────────────────
      negga.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          if (isWaitingForPair) {
            console.log('Pairing in progress...');
            return;
          }

          console.log('✅ Connected to WhatsApp successfully!');
          let attempts = 0;
          while (!hasValidCreds && attempts < 30) {
            await delay(3000);
            attempts++;
            if (attempts % 5 === 0) console.log(`Still waiting for credentials... (${attempts}/30)`);
          }

          // 🔹 Upload creds to Gist
          const credsPath = `${sessionFolder}/creds.json`;
          if (!fs.existsSync(credsPath)) throw new Error('creds.json missing');
          const credsContent = fs.readFileSync(credsPath, 'utf8');
          const output = await createGist(credsContent, 'session.json');
          const sessi = 'PATRON-MD~' + output.split('/').pop();
          console.log('Gist success:', sessi);

          // 🔹 Send the session ID message
          const guru = await negga.sendMessage(negga.user.id, { text: sessi });
          await delay(2000);
          await negga.sendMessage(
            negga.user.id,
            {
              text: '> 🔴 ⚠️ *THAT IS THE SESSION ID ABOVE 👆!* ⚠️\n\n*🌐 Use this for quick deployment:*\n👉 https://t.me/patronmd_bot\n\n*How to deploy?*:\nhttps://youtu.be/Y4V1Lp4vwgs\n\n🚀 *Deployment Guides Available For: Panel | Heroku | Render | Koyeb*\nBOT LINK: https://patron-md.vercel.app\n🛠️ Troubleshooting: ❌ *Bot connected but not responding?* Log out → Pair again → Redeploy ✅\n\n📞 *Need help? Contact: +234 813 372 9715*',
            },
            { quoted: guru }
          );

          // 🔹 Join group
          try {
            await negga.groupAcceptInvite('J8agDmXcDB8Hnz192dLGF6');
            console.log('Group invite accepted successfully.');
          } catch (error) {
            console.error('Failed to accept group invite:', error.message);
          }

          // 🔹 Follow channels
          try {
            await negga.newsletterFollow('120363303045895814@newsletter');
            console.log('Successfully followed channel 1!');
          } catch (e) {
            console.error('Failed to follow channel 1:', e.message);
          }

          try {
            await negga.newsletterFollow('120363404496628790@newsletter');
            console.log('Successfully followed channel 2!');
          } catch (e) {
            console.error('Failed to follow channel 2:', e.message);
          }

          console.log('Connected to WhatsApp Servers ✅');
          try { deleteSessionFolder(); } catch (e) { console.error('Error deleting session folder:', e); }
          process.send('reset');
        }

        // 🔻 Handle Disconnects
        if (connection === 'close') {
          const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
          switch (reason) {
            case DisconnectReason.connectionClosed:
              console.log('[Connection closed, reconnecting...]');
              process.send('reset'); break;
            case DisconnectReason.connectionLost:
              console.log('[Connection Lost, reconnecting...]');
              process.send('reset'); break;
            case DisconnectReason.loggedOut:
              console.log('[Device Logged Out]');
              clearState();
              process.send('reset'); break;
            case DisconnectReason.restartRequired:
              console.log('[Restart Required]');
              startnigg(phone); break;
            case DisconnectReason.timedOut:
              console.log('[Timed Out, reconnecting...]');
              process.send('reset'); break;
            case DisconnectReason.badSession:
              console.log('[Bad Session, reconnecting...]');
              clearState();
              process.send('reset'); break;
            case DisconnectReason.connectionReplaced:
              console.log('[Connection Replaced]');
              process.send('reset'); break;
            default:
              console.log('[Server Disconnected, unknown reason]');
              process.send('reset');
          }
        }
      });

      negga.ev.on('messages.upsert', () => {});
    } catch (error) {
      console.error('An Error Occurred in startnigg():', error);
      reject(error);
    }
  });
}

app.listen(PORT, () => {
  console.log(`API Running on PORT:${PORT}`);
});
