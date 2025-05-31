// index.js
// --------

// ────────────────
// Imports (all at top; ES modules require static imports)
// ────────────────
import cluster from 'cluster';
import cfonts from 'cfonts';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

import dotenv from 'dotenv';
import { Boom } from '@hapi/boom';
import Baileys, { DisconnectReason, delay, useMultiFileAuthState } from '@whiskeysockets/baileys';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';
import pino from 'pino';

// Load environment variables
dotenv.config();


// --------------------
// Master/Supervisor Logic
// --------------------
if (cluster.isPrimary) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Print a stylized banner
  cfonts.say('PATRON-MD PAIRING', {
    font: 'block',
    align: 'center',
    colors: ['cyan'],
    background: 'black',
    letterSpacing: 1,
    lineHeight: 1,
    space: true,
    maxLength: '0'
  });

  // Fork a single worker which will run the “worker” section below
  const worker = cluster.fork();

  // If the worker exits (non-zero), log the exit code or signal
  worker.on('exit', (code, signal) => {
    console.error(`\n❎ An Error occured: ${signal || code}`);
  });

  // If the master receives SIGTERM, forward it to the worker
  process.on('SIGTERM', () => {
    worker.kill('SIGTERM');
  });

} else {
  // --------------------
  // Worker Process: Express + Baileys Pairing Logic
  // --------------------

  const app = express();
  const PORT = process.env.PORT || 8000;
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Disable client‐side caching
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });
  app.use(cors());

  /**
   * Generates a random 10-character alphanumeric ID
   */
  function createRandomId() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 10; i++) {
      id += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return id;
  }

  // Path to store session credentials (multi‐file auth)
  let sessionFolder = `./auth/${createRandomId()}`;

  // Ensure parent "./auth" exists
  const parentFolder = dirname(sessionFolder);
  if (!fs.existsSync(parentFolder)) {
    fs.mkdirSync(parentFolder, { recursive: true });
  }

  // If by chance the randomly‐named folder already exists, remove it
  if (fs.existsSync(sessionFolder)) {
    try {
      fs.rmdirSync(sessionFolder, { recursive: true });
      console.log('Deleted the existing "SESSION" folder.');
    } catch (err) {
      console.error('Error deleting "SESSION" folder:', err);
    }
  }

  // Clears the session folder
  let clearState = () => {
    if (fs.existsSync(sessionFolder)) {
      fs.rmdirSync(sessionFolder, { recursive: true });
    }
  };

  // Deletes the session folder (with a console log)
  function deleteSessionFolder() {
    if (!fs.existsSync(sessionFolder)) {
      console.log('The "SESSION" folder does not exist.');
      return;
    }
    try {
      fs.rmdirSync(sessionFolder, { recursive: true });
      console.log('Deleted the "SESSION" folder.');
    } catch (err) {
      console.error('Error deleting the "SESSION" folder:', err);
    }
  }

  /**
   * Uploads the session JSON content to GitHub Gist (private).
   * Returns the Gist URL if successful.
   */
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

  // Serve the pairing HTML page at “/”
  app.get('/', async (req, res) => {
    res.sendFile(join(__dirname, 'pair.html'));
  });

  // Endpoint to start pairing: GET /pair?phone=<COUNTRYCODEPHONENUMBER>
  app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.json({ error: 'Please Provide Phone Number' });

    try {
      const code = await startPairing(phone);
      res.json({ code });
    } catch (error) {
      console.error('Error in WhatsApp authentication:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  /**
   * Initiates the WhatsApp pairing process via Baileys.
   * Returns the pairing code on success or throws on failure.
   */
  async function startPairing(phone) {
    return new Promise(async (resolve, reject) => {
      try {
        // Ensure parent “./auth” exists
        const parent = dirname(sessionFolder);
        if (!fs.existsSync(parent)) {
          fs.mkdirSync(parent, { recursive: true });
        }
        // Create the new session folder
        if (!fs.existsSync(sessionFolder)) {
          fs.mkdirSync(sessionFolder);
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

        const socket = Baileys.makeWASocket({
          printQRInTerminal: false,
          logger: pino({ level: 'silent' }),
          browser: ['Ubuntu', 'Chrome', '20.0.04'],
          auth: state
        });

        // If not yet registered, request a pairing code
        if (!socket.authState.creds.registered) {
          let phoneNumber = phone.replace(/[^0-9]/g, '');
          if (phoneNumber.length < 11) {
            return reject(new Error('Please Enter Your Number With Country Code !!'));
          }
          setTimeout(async () => {
            try {
              let customPair = 'PATRONMD';
              let code = await socket.requestPairingCode(phoneNumber, customPair);
              console.log(`Your Pairing Code : ${code}`);
              return resolve(code);
            } catch (requestPairingCodeError) {
              const errorMessage = 'Error requesting pairing code from WhatsApp';
              console.error(errorMessage, requestPairingCodeError);
              return reject(new Error(errorMessage));
            }
          }, 2000);
        }

        // Save credentials on update
        socket.ev.on('creds.update', saveCreds);

        // Listen for connection updates (open, close, etc.)
        socket.ev.on('connection.update', async (update) => {
          const { connection, lastDisconnect } = update;

          if (connection === 'open') {
            // Allow Baileys to write creds.json
            await delay(10000);

            let credsPath = `${sessionFolder}/creds.json`;
            let credsContent = '';
            try {
              credsContent = fs.readFileSync(credsPath, 'utf-8');
            } catch (err) {
              console.error('Failed to read creds.json:', err);
              credsContent = '';
            }

            if (!credsContent) {
              throw new Error('creds.json is empty or missing.');
            }

            // Upload session to GitHub Gist
            let gistUrl, sessionId;
            try {
              gistUrl = await createGist(credsContent, 'session.json');
              sessionId = 'PATRON-MD~' + gistUrl.split('/').pop();
              console.log('Gist success:', sessionId);
            } catch (err) {
              console.error('Gist error:', err);
              throw new Error('Failed to upload session to GitHub Gist: ' + (err?.message || err));
            }

            // Send the Gist-based session ID back to the bot owner
            const sentMsg = await socket.sendMessage(socket.user.id, { text: sessionId });
            await delay(2000);
            await socket.sendMessage(
              socket.user.id,
              {
                text: '> 🔴 ⚠️ *THAT IS THE SESSION ID ABOVE 👆!* ⚠️\n\n' +
                      '*🌐 Use this to see deployment methods:*\n👉 https://botportal-two.vercel.app\n\n' +
                      '*How to deploy?*: https://youtu.be/JTnfSfTRLyY\n\n' +
                      '🚀 *Deployment Guides Available For: Panel | Heroku | Render | Koyeb*\n\n' +
                      '🛠️ Troubleshooting: ❌ *Bot connected but not responding? 1️⃣ Log out → 2️⃣ Pair again → 3️⃣ Redeploy* ✅\n\n' +
                      '📞 *Still stuck? 📲 Contact: +234 813 372 9715*'
              },
              { quoted: sentMsg }
            );

            // (Optional) Accept a specific group invite
            try {
              await socket.groupAcceptInvite('I2xPWgHLrKSJhkrUdfhKzV');
              console.log('Group invite accepted successfully.');
            } catch (error) {
              console.error('Failed to accept group invite:', error);
            }

            // (Optional) Follow a specific channel/newsletter
            try {
              await socket.newsletterFollow("120363303045895814@newsletter");
              console.log("Successfully followed the channel!");
            } catch (e) {
              console.error("Failed to follow channel:", e.message);
            }

            console.log('Connected to WhatsApp Servers');

            // Clean up the local session folder after using it
            try {
              deleteSessionFolder();
            } catch (error) {
              console.error('Error deleting session folder:', error);
            }

            // Tell the master (cluster) to restart if needed
            process.send?.('reset');
          }

          if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output.statusCode;

            // Reconnection logic based on the disconnect reason:
            if (
              reason === DisconnectReason.connectionClosed ||
              reason === DisconnectReason.connectionLost ||
              reason === DisconnectReason.connectionReplaced ||
              reason === DisconnectReason.timedOut
            ) {
              console.log('[Connection closed/lost/timed out/replaced, reconnecting....]');
              process.send?.('reset');
            } else if (reason === DisconnectReason.loggedOut) {
              clearState();
              console.log('[Device Logged Out, Please Try to Login Again....]');
              process.send?.('reset');
            } else if (reason === DisconnectReason.restartRequired) {
              console.log('[Server Restarting....]');
              startPairing(phone); // attempt a fresh start
            } else if (reason === DisconnectReason.badSession) {
              console.log('[BadSession exists, Reconnecting....]');
              clearState();
              process.send?.('reset');
            } else {
              console.log('[Unknown disconnect, reconnecting....]');
              process.send?.('reset');
            }
          }
        });

        // (Optional) Swallow incoming messages if not handling them here
        socket.ev.on('messages.upsert', () => {});
      } catch (error) {
        console.error('An Error Occurred:', error);
        return reject(new Error('An Error Occurred'));
      }
    });
  }

  // Start the HTTP server
  app.listen(PORT, () => {
    console.log(`API Running on PORT: ${PORT}`);
  });

  // Catch unhandled rejections or uncaught exceptions in the worker
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception thrown:', err);
    process.exit(1); // let the master detect & restart
  });
}
