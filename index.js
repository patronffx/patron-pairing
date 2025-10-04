require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const crypto = require('crypto');

const bot = new Telegraf(process.env.BOT_TOKEN);
const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const OWNER_ID = process.env.OWNER;

const HEADERS = {
  Authorization: `Bearer ${process.env.HEROKU_API_KEY}`,
  Accept: "application/vnd.heroku+json; version=3",
  "Content-Type": "application/json"
};

const usedUsers = "./db/used_users.json";
const usedKeys = "./db/used_keys.json";
const keys = "./db/keys.json";
const userApps = "./db/user_apps.json";
const activeDeploys = {}; // In-memory tracker

// Paystack config (set PAYSTACK_SECRET_KEY in your .env)
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_BASE = 'https://api.paystack.co';

const load = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
const resellsFile = './db/resells.json';

// // FORCELY JOIN MY CHANNEL 
async function checkMembership(userId) {
  try {
    const res = await bot.telegram.getChatMember("@patrontechhub", userId);
    return !['left', 'kicked'].includes(res.status);
  } catch {
    return false;
  }
}



// FETCH SESSION ID FROM API
async function generateSession(number) {
  try {
    const url = `https://patron-pairing.onrender.com/pair?phone=${number}`;
    const response = await axios.get(url);

    // Use "code" instead of "session"
    const sessionId = response.data.code;

    if (!sessionId) {
      throw new Error("No code found in response");
    }

    return sessionId;
  } catch (err) {
    console.error("Failed to generate session:", err.message);
    return null;
  }
}

// // START FIRST COMMAND
bot.command("start", (ctx) => {
  ctx.reply(
    `👋 *Welcome to Patron MD Deploy Bot!*

Use /menu to see available commands.

🔧 Powered by [@Justt_patron2](https://t.me/patrontechhub)`,
    { parse_mode: "Markdown" }
  );
});

bot.command("menu", async (ctx) => {
  try {
    await ctx.reply(
`<b>╭━[ ⚙️ Patron MD Deploy Menu ]━╮</b>

🛠 /deploy &lt;session_id&gt; &lt;key?&gt;
↳ Deploy your Patron-md bot

🖇️ /pair &lt;number&gt;
↳ Get session ID for your number

📋 /listapps
↳ List your deployed bots

💳 /pay
↳ Buy a deployment key to deploy a bot

Note: If you deploy for others dm me for discounts @Justt_patron2

⏱ Deploy Time: ~1–2 mins

© ᴘᴀᴛʀᴏɴ ᴍᴅ ²⁵

<b>╰━━━━━━━━━━━━━━━━━━━╯</b>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "📂 View GitHub Repo",
                url: "https://github.com/Itzpatron/PATRON-MD3"
              }
            ]
          ]
        }
      }
    );
  } catch (err) {
    console.error("Menu command failed:", err.message);
    ctx.reply("❌ Failed to send menu.");
  }
});


// // SEND JOIN TEXT
bot.use(async (ctx, next) => {
  if (!ctx.message || ctx.from.id == OWNER_ID) return next();

  const userId = String(ctx.from.id);
  const isMember = await checkMembership(userId);
  if (!isMember) {
    return ctx.reply(
      "🔐 Please join *our channel* to use this bot:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📢 Join Channel", url: "https://t.me/patrontechhub" }],
            [{ text: "✅ I Joined — Try Again", callback_data: "retry_deploy" }]
          ]
        }
      }
    );
  }

  return next();
});

// // GENERATE KEY FOR DEPLOYMENT 
bot.command("key", (ctx) => {
  if (ctx.from.id != OWNER_ID) return;
  const parts = ctx.message.text.trim().split(" ");
  if (parts.length !== 2 || isNaN(parts[1])) return ctx.reply("Usage: /key <limit>");

  const limit = parseInt(parts[1]);
  const id = Math.random().toString(36).substring(2, 12).toUpperCase();
  const all = load(keys);
  all[id] = { limit, used: 0 };
  save(keys, all);
  ctx.reply(`🔑 Key Generated: \`${id}\`\n📦 Limit: ${limit}`, { parse_mode: "Markdown" });
});

// /pay - initialize Paystack payment (users will receive a key after payment via webhook)
bot.command('pay', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!PAYSTACK_SECRET_KEY) return ctx.reply('⚠️ Payment is not configured. Contact the owner.');

  // Build a fake email for Paystack (Paystack requires an email)
  const email = ctx.from.username
    ? `${ctx.from.username}@example.com`
    : `user${userId}@example.com`;
  const reference = `tg_${userId}_${Date.now()}`;

  try {
    const res = await axios.post(`${PAYSTACK_BASE}/transaction/initialize`, {
      email,
      amount: 200000, // 2000 NGN (amount is in kobo)
      reference,
      metadata: { telegram_id: userId }
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } });

    const url = res.data.data.authorization_url;
    return ctx.reply(
      `💳 To purchase a one-use deployment key, open the link below and complete payment:\n${url}\n\nYou will receive the key here after payment is confirmed.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Paystack init error:', err.response?.data || err.message);
    return ctx.reply('❌ Failed to create payment link. Try again later or DM the owner.');
  }
});

// /resell <limit> <price> - owner creates a resell offer (price in NGN)
bot.command('resell', async (ctx) => {
  if (ctx.from.id != OWNER_ID) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length !== 3 || isNaN(parts[1]) || isNaN(parts[2])) return ctx.reply('Usage: /resell <limit> <price_NGN>');
  const limit = parseInt(parts[1]);
  const priceNgn = parseFloat(parts[2]);

  const reference = `resell_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
  const resells = load(resellsFile);
  resells[reference] = { limit, price: priceNgn, created_at: new Date().toISOString(), paid: false, delivered: false };
  save(resellsFile, resells);

  // Create Paystack payment link for this exact price and reference
  if (!PAYSTACK_SECRET_KEY) return ctx.reply('⚠️ Paystack not configured. Add PAYSTACK_SECRET_KEY to .env');
  try {
  const email = `buyer${Date.now()}@example.com`;
    const amount = Math.round(priceNgn * 100); // NGN to kobo
    const res = await axios.post(`${PAYSTACK_BASE}/transaction/initialize`, {
      email,
      amount,
      reference,
      metadata: { resell_reference: reference }
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } });

  const url = res.data.data.authorization_url;
  const msg = `✅ Reseller ready — \n\nReference: \`${reference}\`\nLimit: ${limit} deploys\nPrice: ${priceNgn} NGN\nPay: ${url}\n\nBuyer instructions:\n1) Open the link and complete payment.\n2) If you paid via this link, the key will be sent to this Telegram account automatically.\n3) If you paid but didn't receive a key, open the bot and send:\n   /claim ${reference}`;
  return ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Resell init error:', e.response?.data || e.message);
    return ctx.reply('❌ Failed to initialize resell payment link.');
  }
});

// /claim <reference> - buyer can claim or check status of their resell purchase
bot.command('claim', (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length !== 2) return ctx.reply('Usage: /claim <reference>');
  const reference = parts[1];
  const resells = load(resellsFile);
  const info = resells[reference];
  if (!info) return ctx.reply('❌ Unknown reference.');

  if (!info.paid) return ctx.reply(`ℹ️ Payment pending for \`${reference}\`. Use the payment link sent by seller.` , { parse_mode: 'Markdown' });
  if (info.delivered) return ctx.reply(`✅ Payment received. Your key has been delivered.`);

  // Not delivered but paid - owner may need to send manually; notify owner
  ctx.reply('✅ Payment recorded. Awaiting delivery. The owner will send your key soon.');
  try { bot.telegram.sendMessage(OWNER_ID, `Resell paid but not delivered: ${reference}. Use /resend ${reference} to send key.`); } catch (e) { console.error('Failed to notify owner:', e.message); }
});

// 🔑 /keys (Owner Only)
bot.command("keys", (ctx) => {
  if (ctx.from.id != OWNER_ID) return;
  
  const allKeys = load(keys);
  const count = Object.keys(allKeys).length;

  if (!count) return ctx.reply("📭 No active keys.");

  let text = `🔐 *Active Keys (${count}):*\n\n`;
  for (const [id, info] of Object.entries(allKeys)) {
    const remaining = info.limit - info.used;
    text += `• \`${id}\` → ${info.used}/${info.limit} used • ${remaining} left\n`;
  }

  return ctx.reply(text, { parse_mode: "Markdown" });
});

// WAIT FOR HEROKU BUILD
const waitForBuild = async (appName, buildId, retries = 20, delay = 4000) => {
  for (let i = 0; i < retries; i++) {
    const res = await axios.get(
      `https://api.heroku.com/apps/${appName}/builds/${buildId}`,
      { headers: HEADERS }
    );
    if (res.data.status === "succeeded") return true;
    if (res.data.status === "failed") throw new Error("Heroku build failed.");
    await new Promise(r => setTimeout(r, delay));
  }
  throw new Error("Timeout: Heroku build didn’t finish.");
};

// Helper to run Heroku steps with logging + notify owner
async function herokuStep(description, fn) {
  console.log(`→ Heroku: ${description}`);
  try {
    const res = await fn();
    console.log(`✓ Heroku success: ${description}`);
    await new Promise(r => setTimeout(r, 300));
    return res;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const url = err.config?.url;
    const method = err.config?.method?.toUpperCase();
    const body = err.config?.data;
    const msg = err.message;

    console.error(`✖ Heroku failed: ${description}`);
    console.error(`  URL: ${method} ${url}`);
    if (status) console.error(`  Status: ${status}`);
    if (data) console.error(`  Response: ${JSON.stringify(data)}`);
    if (body) console.error(`  Request body: ${body}`);
    console.error(`  Error: ${msg}`);

    try {
      const text = `⚠️ Heroku step failed: ${description}\n\nURL: ${method} ${url}\nStatus: ${status || 'n/a'}\nError: ${data?.message || data || msg}`;
      await bot.telegram.sendMessage(OWNER_ID, text);
    } catch (e) {
      console.error("Failed to notify owner:", e.message);
    }

    throw err;
  }
}

// DEPLOY COMMAND
bot.command("deploy", async (ctx) => {
  const userId = String(ctx.from.id);
  const args = ctx.message.text.trim().split(" ");
  if (args.length < 3) {
    return ctx.reply(
      '❗ Usage: <code>/deploy &lt;session_id&gt; &lt;key&gt;</code>\n\n💳 You must provide a key.\nBuy one with <code>/pay</code>',
      { parse_mode: "HTML" }
    );
  }

  const sessionId = args[1];
  const key = args[2];

  const apps = load(userApps);
  const keyDB = load(keys);
  const usedK = load(usedKeys);

  const validPrefix = sessionId.startsWith("PATRON-MD~");
  if (!validPrefix) {
    return ctx.reply("❌ Session must start with <code>PATRON-MD~</code>", {
      parse_mode: "HTML",
    });
  }

  if (activeDeploys[userId]) {
    return ctx.reply("⏳ Deployment already in progress.", {
      parse_mode: "HTML",
    });
  }
  activeDeploys[userId] = true;

  const isOwner = ctx.from.id == OWNER_ID;
  let keyInfo = "";

  try {
    // 🔐 Require key for everyone (including non-owner)
    if (!key) {
      return ctx.reply(
        "❌ You must provide a deployment key.\n💳 Buy one with <code>/pay</code>",
        { parse_mode: "HTML" }
      );
    }
    if (!keyDB[key]) {
      return ctx.reply("❌ Invalid or expired key.\n💳 Buy with <code>/pay</code>", {
        parse_mode: "HTML",
      });
    }
    if (usedK[key]?.includes(userId)) {
      return ctx.reply("❌ You have already used this key.", {
        parse_mode: "HTML",
      });
    }

    // 🔑 Deduct usage BEFORE deploy
    if (key && keyDB[key]) {
      if (!usedK[key]) usedK[key] = [];
      usedK[key].push(userId);
      keyDB[key].used += 1;
      const remaining = keyDB[key].limit - keyDB[key].used;
  keyInfo = `\n\n🔑 Key used: ${keyDB[key].used}/${keyDB[key].limit} • ${remaining} left`;
      if (keyDB[key].used >= keyDB[key].limit) delete keyDB[key];
      save(keys, keyDB);
      save(usedKeys, usedK);
    }

    // random app name
    const appName = `patronmd-${Math.random().toString(36).substring(2, 9)}`;
    ctx.reply(
      `🚀 Deploying <b>${appName}</b>...\nPlease wait ~1–2 minutes.\nYou’ll receive a connection message on WhatsApp once the bot 🤖 connects.`,
      { parse_mode: "HTML" }
    );

    // 1. Create Heroku app
    await herokuStep("create app", async () => {
      const data = { name: appName };
      if (process.env.HEROKU_TEAM) {
        data.organization = process.env.HEROKU_TEAM;
        return axios.post("https://api.heroku.com/organizations/apps", data, {
          headers: HEADERS,
        });
      } else {
        return axios.post("https://api.heroku.com/apps", data, {
          headers: HEADERS,
        });
      }
    });

    // 2. Set ENV
    await herokuStep("set config-vars", async () => {
      return axios.patch(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        {
          SESSION_ID: sessionId,
          HEROKU_APP_NAME: appName,
          HEROKU_API_KEY: process.env.HEROKU_API_KEY,
        },
        { headers: HEADERS }
      );
    });

    // 3. Attach PostgreSQL addon
    await herokuStep("attach addon", async () => {
      return axios.post(
        `https://api.heroku.com/apps/${appName}/addons`,
        { plan: "heroku-postgresql:essential-0" },
        { headers: HEADERS }
      );
    });

    // 4. Trigger GitHub build
    const buildRes = await herokuStep("trigger build", async () => {
      return axios.post(
        `https://api.heroku.com/apps/${appName}/builds`,
        {
          source_blob: {
            url: "https://github.com/Itzpatron/PATRON-MD3/archive/refs/heads/main.tar.gz",
          },
        },
        { headers: HEADERS }
      );
    });

    const buildId = buildRes.data.id;
    await waitForBuild(appName, buildId);

    // 5. Start dyno
    await herokuStep("start dyno", async () => {
      return axios.patch(
        `https://api.heroku.com/apps/${appName}/formation`,
        { updates: [{ type: "web", quantity: 1, size: "standard-2x" }] },
        { headers: HEADERS }
      );
    });

    // 6. Save app in DB
    if (!apps[userId]) apps[userId] = [];
    apps[userId].push(appName);
    save(userApps, apps);

    // 7. Final success reply
    await ctx.reply(
      `✅ <b>Deploy complete!</b>\n🔗 Bot is now online 💯${keyInfo}`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.id || err.message;
  ctx.reply(`❌ Deployment failed:\n<code>${msg}</code>`, { parse_mode: "HTML" });
  } finally {
    delete activeDeploys[userId];
  }
});








// Command: /pair <number>
bot.command("pair", async (ctx) => {
  const input = ctx.message.text.trim().split(" ")[1];

  if (!input || !/^\d{10,15}$/.test(input)) {
    return ctx.reply(
      '❗ Usage: <code>/pair &lt;number&gt;</code>\n' +
      'Example: <code>/pair 234xxx</code>\n\n' +
      '👉 After pairing, run: <code>/deploy &lt;session_id&gt; &lt;key&gt;</code>\n' +
      'If you don’t have a key, buy one with <code>/pay</code>.',
      { parse_mode: "HTML" }
    );
  }

  const session = await generateSession(input);

  if (session) {
    ctx.reply(
      `✅ <b>Code for</b> <code>${input}</code>:\n<code>${session}</code>\n\n` +
      `👉 Then run: <code>/deploy &lt;session_id&gt; &lt;key&gt;</code>\n` +
      `If you don’t have a key, use the <code>/pay</code> command.`,
      { parse_mode: "HTML" }
    );
  } else {
    ctx.reply(
      '❌ Failed to generate code. Please try again or use <a href="https://patron-md.vercel.app">this link</a>.\n\n' +
      '👉 After getting a session ID, run: <code>/deploy &lt;session_id&gt; &lt;key&gt;</code>\n' +
      'If you don’t have a key, buy one with <code>/pay</code>.',
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  }
});





// 📋 /listapps
// 📋 /listapps — Owner sees all, users see theirs
bot.command("listapps", (ctx) => {
  const apps = load(userApps); // Use the db
  const userId = String(ctx.from.id);

  if (!apps || typeof apps !== "object") {
    return ctx.reply("❌ Failed to load deployed app data.");
  }

  // Owner: show all
  if (ctx.from.id == OWNER_ID) {
    let total = 0;
    let text = `📦 *All Deployed Bots (${Object.keys(apps).length} users):*\n\n`;

    for (const [uid, list] of Object.entries(apps)) {
      if (!Array.isArray(list) || !list.length) continue;
      text += `👤 *User:* \`${uid}\`\n`;
      list.forEach((app, i) => {
        total++;
        text += `  ${i + 1}. ${app}\n`;
      });
      text += "\n";
    }

    if (!total) return ctx.reply("📭 No deployed apps found.");

    if (text.length > 4000) {
      const filePath = './all-apps.txt';
      fs.writeFileSync(filePath, text);
      return ctx.replyWithDocument({ source: filePath, filename: 'all-apps.txt' });
    }

    return ctx.reply(text, { parse_mode: "Markdown" });
  }

  // Regular user: show only theirs
  const list = apps[userId] || [];
  if (!list.length) return ctx.reply("📭 You haven’t deployed any bots.");

  const text = "📦 Your deployed apps:\n" + list.map((a, i) => `  ${i + 1}. ${a}`).join("\n");
  ctx.reply(text);
});

// // delete
bot.command("delete", async (ctx) => {
  const apps = load(userApps);
  const userId = String(ctx.from.id);
  const parts = ctx.message.text.trim().split(" ");
  if (parts.length !== 2) return ctx.reply("❌ Usage: /delete <app_name>");

  const app = parts[1];

  const isOwner = ctx.from.id == OWNER_ID;
  const isUserApp = apps[userId]?.includes(app);

  // Permission check
  if (!isOwner && !isUserApp) {
    return ctx.reply("❌ You can't delete this app.");
  }

  try {
    await axios.delete(`https://api.heroku.com/apps/${app}`, { headers: HEADERS });

    // Remove from correct user
    if (isOwner) {
      for (const [uid, list] of Object.entries(apps)) {
        if (list.includes(app)) {
          apps[uid] = list.filter(x => x !== app);
          if (apps[uid].length === 0) delete apps[uid];
          break;
        }
      }
    } else {
      apps[userId] = apps[userId].filter(x => x !== app);
      if (apps[userId].length === 0) delete apps[userId];
    }

    save(userApps, apps);
    ctx.reply(`🗑 Deleted: ${app}`);
  } catch (err) {
    const msg = err.response?.data?.message || err.message || "Unknown error";
    ctx.reply("❌ Failed to delete app:\n" + msg);
  }
});

// Retry Join
bot.action("retry_deploy", async (ctx) => {
  ctx.answerCbQuery();
  ctx.reply("🔁 Try again with /deploy <session_id> <key>");
});

// Unknown command
bot.on("message", (ctx) => {
  ctx.reply("❓ Unknown command. Use /menu.");
});

// ✅ LAUNCH THE BOT
bot.launch().then(() => {
  const VERSION = "1.0.0"; // Optional: change to your version
  const startTime = new Date().toLocaleString();

  console.log(`
╔══════════════════════════════════════╗
║     🤖 PATRON X Telegram Bot           ║
║     Version: ${VERSION.padEnd(25)}║
║     Started: ${startTime.padEnd(25)}║
╚══════════════════════════════════════╝
`);

  console.log("📁 Database loaded.");
  console.log("🔗 Telegram bot initialized.");
  console.log("✅ Bot is now online and listening for commands!");
  // Run a quick Heroku permission check and notify owner if something looks off
  (async function checkHeroku() {
    try {
      if (!HEROKU_API_KEY) return console.warn('HEROKU_API_KEY not set; skipping Heroku checks');
      const res = await axios.get('https://api.heroku.com/account', { headers: HEADERS });
      console.log(`Heroku account: ${res.data.email} (id: ${res.data.id})`);

      if (process.env.HEROKU_TEAM) {
        try {
          const teamRes = await axios.get(`https://api.heroku.com/teams/${process.env.HEROKU_TEAM}`, { headers: HEADERS });
          console.log(`Heroku team accessible: ${teamRes.data.name} (slug: ${teamRes.data.id})`);
        } catch (teamErr) {
          console.warn('Could not access Heroku team:', teamErr.response?.data || teamErr.message);
          try { await bot.telegram.sendMessage(OWNER_ID, `⚠️ Heroku team check failed for \`${process.env.HEROKU_TEAM}\`:\n${teamErr.response?.data?.message || teamErr.message}`); } catch(e){}
        }
      }
    } catch (err) {
      console.error('Heroku API check failed:', err.response?.data || err.message);
      try { await bot.telegram.sendMessage(OWNER_ID, `⚠️ Heroku API check failed: ${err.response?.data?.message || err.message}\nMake sure HEROKU_API_KEY is valid and the account is verified.`); } catch(e){}
    }
  })();
});

// Express Web Server (For Heroku / Render Keep-Alive)
const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send(`✅ PATRON X Telegram Bot is running<br>⏰ ${new Date().toLocaleString()}`);
});

const PORT = process.env.PORT || 3000;
// Paystack webhook endpoint - register this URL in Paystack dashboard
app.post('/paystack/webhook', express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }), async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.rawBody).digest('hex');
  if (!signature || signature !== hash) {
    console.warn('Invalid Paystack signature');
    return res.status(401).send('Invalid signature');
  }

  const body = req.body;
  try {
    if (body.event === 'charge.success') {
      const metadata = body.data?.metadata || {};
      const reference = body.data?.reference;

      // If this payment matches a resell reference, mark paid and try auto-deliver
      const resells = load(resellsFile);
      if (reference && resells[reference]) {
        resells[reference].paid = true;
        resells[reference].paystack = { id: body.data?.id, amount: body.data?.amount, paid_at: new Date().toISOString() };

        // Generate the key for this resell and send it to the OWNER so they can forward to the buyer.
        const limit = resells[reference].limit || 1;
        const id = Math.random().toString(36).substring(2, 12).toUpperCase();
        const all = load(keys);
        all[id] = { limit, used: 0 };
        save(keys, all);

        // Store the key but mark as not yet delivered (owner will forward)
        resells[reference].delivered = false;
        resells[reference].key = id;

        // Inform owner with concise info so they can forward the key to the buyer
        const buyerTid = metadata.telegram_id || 'Not provided';
        const ownerMsg = `💰 Payment received for reference <code>${reference}</code>\n\n🔑 Key: <code>${id}</code> (Limit: ${limit})\nPaystack ref: ${reference}\n\nPlease forward this key to the buyer.`;
        try { await bot.telegram.sendMessage(OWNER_ID, ownerMsg, { parse_mode: 'HTML' }); } catch (e) { console.error('Failed to message owner:', e.message); }

        save(resellsFile, resells);
      } else {
        // For non-resell or unknown references, if telegram_id present, issue one-use key and notify owner
        const telegramId = metadata.telegram_id;
        if (telegramId) {
          const id = Math.random().toString(36).substring(2, 12).toUpperCase();
          const all = load(keys);
          all[id] = { limit: 1, used: 0 };
          save(keys, all);

          const message = `✅ Payment confirmed!\n\n🔑 Your one-use deployment key: <code>${id}</code>\n\nUse it like: <b>/deploy &lt;session_id&gt; ${id}</b>\nThis key will expire after a single use.`;
          try { await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'HTML' }); } catch (e) { console.error('Failed to message user:', e.message); }

          // Notify owner
          const ownerMsg = `💰 Someone paid for a one-time key (limit: 1)\nKey: <code>${id}</code>`;
          try { await bot.telegram.sendMessage(OWNER_ID, ownerMsg, { parse_mode: 'HTML' }); } catch (e) { console.error('Failed to notify owner:', e.message); }
        }
      }
    }
  } catch (e) {
    console.error('Webhook handling error:', e.message);
  }

  res.sendStatus(200);
});


app.listen(PORT, () => {
  console.log(`🌐 Express server is live on port ${PORT}`);
});

// Uptime Logger (Every 15 mins)
setInterval(() => {
  console.log(`📶 [${new Date().toLocaleTimeString()}] Bot still active...`);
}, 15 * 60 * 1000);
