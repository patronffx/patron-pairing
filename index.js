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
        await fs.mkdirSync(sessionFolder);
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

      // ✅ Updated socket creation with version + browser
      const negga = Baileys.makeWASocket({
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Baileys.Browsers.ubuntu('Edge'),
        auth: state,
        version: [2, 3000, 1025190524],
      });

      let hasValidCreds = false;
      let isWaitingForPair = false;

      // ─── Pairing Code Section ───────────────────────────────
      if (!negga.authState.creds.registered) {
        let phoneNumber = phone ? phone.replace(/[^0-9]/g, '') : '';
        if (phoneNumber.length < 11) {
          return reject(new Error('Please Enter Your Number With Country Code !!'));
        }

        isWaitingForPair = true;
        setTimeout(async () => {
          try {
            let customPair = 'PATRONMD';
            let code = await negga.requestPairingCode(phoneNumber, customPair);
            console.log(`Your Pairing Code : ${code}`);
            resolve(code);
          } catch (requestPairingCodeError) {
            const errorMessage = 'Error requesting pairing code from WhatsApp';
            console.error(errorMessage, requestPairingCodeError);
            return reject(new Error(errorMessage));
          }
        }, 2000);
      }

      // ─── Credentials Update ───────────────────────────────
      negga.ev.on('creds.update', async (creds) => {
        try {
          // Always save credentials first
          await saveCreds();

          if (creds && creds.myAppStateKeyId) {
            console.log('Found myAppStateKeyId:', creds.myAppStateKeyId);
            hasValidCreds = true;
          } else if (isWaitingForPair) {
            // During pairing process, don't show waiting message
            return;
          } else if (!hasValidCreds) {
            console.log('Waiting for credentials to be established...');
          }
        } catch (error) {
          console.error('Error in creds update:', error);
        }
      });
    } catch (error) {
      console.error('Error in startnigg:', error);
      reject(error);
    }
  });

      negga.ev.on('connection.update', async update => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          // If we're in pairing mode, don't proceed with connection
          if (isWaitingForPair) {
            console.log('Pairing in progress...');
            return;
          }

          // Wait for credentials to be properly set up
          let attempts = 0;
          const maxAttempts = 30; // Extended wait time for myAppStateKeyId
          while (!hasValidCreds && attempts < maxAttempts) {
            await delay(3000); // Increased delay between attempts
            attempts++;
            if (attempts % 5 === 0) { // Show message every 15 seconds
              console.log(`Still waiting for credentials... (${attempts}/${maxAttempts})`);
            }
          }

          let credsPath = `${sessionFolder}/creds.json`;
          let credsContent = '';
          try {
            credsContent = fs.readFileSync(credsPath, 'utf-8');
            const credsData = JSON.parse(credsContent);
            
            let hasAppStateKey = false;
            if (!credsData.myAppStateKeyId) {
              console.log('Warning: myAppStateKeyId not found, but proceeding with upload');
            } else {
              hasAppStateKey = true;
              console.log('Connection verified with myAppStateKeyId:', credsData.myAppStateKeyId);
            }

          } catch (err) {
            console.error('Failed to read or validate creds.json:', err);
            credsContent = '';
          }

          if (!credsContent) {
            throw new Error('creds.json is empty or missing.');
          }

          let output, sessi;
          try {
            output = await createGist(credsContent, 'session.json');
            sessi = 'PATRON-MD~' + output.split('/').pop();
            console.log('Gist success:', sessi);
          } catch (err) {
            console.error('Gist error:', err);
            throw new Error('Failed to upload session to GitHub Gist: ' + (err && err.message ? err.message : err));
          }

          let guru = await negga.sendMessage(negga.user.id, { text: sessi });
          await delay(2000);
          await negga.sendMessage(
            negga.user.id,
            {
              text: '> 🔴 ⚠️ *THAT IS THE SESSION ID ABOVE 👆!* ⚠️\n\n*🌐 Use this for quick deployment:*\n👉 https://t.me/patronmd_bot\n\n*How to deploy?*:\nhttps://youtu.be/Y4V1Lp4vwgs\n(please click this link to watch how to deploy)\n\n🚀 *Deployment Guides Available For: Panel | Heroku | Render | Koyeb*\nBOT LINK: https://patron-md.vercel.app\n🛠️ Troubleshooting: ❌ *Bot connected but not responding? 1️⃣ Log out → 2️⃣ Pair again → 3️⃣ Redeploy* ✅\n\n📞 *Still stuck? 📲 Contact: +234 813 372 9715*',
            },
            { quoted: guru }
          );

          // Accept group invite
          try {
            await negga.groupAcceptInvite('J8agDmXcDB8Hnz192dLGF6');
            console.log('Group invite accepted successfully.');
          } catch (error) {
            console.error('Failed to accept group invite:', error);
            if (error?.message === 'bad-request') {
              console.error('The group invite code may be invalid, expired, or malformed. Try generating a new invite link.');
            }
          }

          try {
            await negga.newsletterFollow("120363303045895814@newsletter");
            console.log("Successfully followed the channel!");
          } catch (e) {
            console.error("Failed to follow channel:", e.message);
          }
          

            try {
            await negga.newsletterFollow("120363404496628790@newsletter");
            console.log("Successfully followed the channel2!");
          } catch (e) {
            console.error("Failed to follow channel:", e.message);
          }

          
          console.log('Connected to WhatsApp Servers');

          try {
            deleteSessionFolder();
          } catch (error) {
            console.error('Error deleting session folder:', error);
          }

          process.send('reset');
        }

        if (connection === 'close') {
          let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
          if (reason === DisconnectReason.connectionClosed) {
            console.log('[Connection closed, reconnecting....!]');
            process.send('reset');
          } else if (reason === DisconnectReason.connectionLost) {
            console.log('[Connection Lost from Server, reconnecting....!]');
            process.send('reset');
          } else if (reason === DisconnectReason.loggedOut) {
            console.log('[Device Logged Out, Please Try to Login Again....!]');
            clearState();
            process.send('reset');
          } else if (reason === DisconnectReason.restartRequired) {
            console.log('[Server Restarting....!]');
            startnigg();
          } else if (reason === DisconnectReason.timedOut) {
            console.log('[Connection Timed Out, Trying to Reconnect....!]');
            process.send('reset');
          } else if (reason === DisconnectReason.badSession) {
            console.log('[BadSession exists, Trying to Reconnect....!]');
            clearState();
            process.send('reset');
          } else if (reason === DisconnectReason.connectionReplaced) {
            console.log('[Connection Replaced, Trying to Reconnect....!]');
            process.send('reset');
          } else {
            console.log('[Server Disconnected: Maybe Your WhatsApp Account got Fucked....!]');
            process.send('reset');
          }
        }
      });

      negga.ev.on('messages.upsert', () => {});
    } catch (error) {
      console.error('An Error Occurred:', error);
      throw new Error('An Error Occurred');
    }
  });
}

app.listen(PORT, () => {
  console.log(`API Running on PORT:${PORT}`);
});
