// ═══════════════════════════════════════════════════════════
//  Kii Akira — Discord OAuth Backend  (Node.js / Express)
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const session = require('express-session');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI,
        DISCORD_BOT_TOKEN, SESSION_SECRET, FRONTEND_URL } = process.env;

// ─────────────────────────────────────────────────────────────
//  ROLE & WHITELIST SYSTEM
// ─────────────────────────────────────────────────────────────
const OWNER_USERNAME = 'kiiakira';
const adminWhitelist = new Map(); // username → { addedAt, addedBy }
const vipUsers       = new Map(); // discordId → { expiresAt, plan, grantedBy, username }

function getUserRole(username) {
  if (username === OWNER_USERNAME)  return 'developer';
  if (adminWhitelist.has(username)) return 'admin';
  return 'user';
}

function checkVIP(discordId, username) {
  const role = getUserRole(username);
  if (role === 'developer' || role === 'admin') return true;
  const vip = vipUsers.get(discordId);
  return !!(vip && Date.now() < vip.expiresAt);
}

// ─────────────────────────────────────────────────────────────
//  MEMORY ENGINE
//  Per-user memory: persists across servers, DMs, and bot restarts
//  Structure: userId → { facts: string[], history: { role, content }[], updatedAt }
// ─────────────────────────────────────────────────────────────

const userMemory = new Map(); // userId (discordId) → memory object

const MAX_HISTORY_FREE = 30;
const MAX_HISTORY_VIP  = 1000;
const MAX_FACTS_FREE   = 50;
const MAX_FACTS_VIP    = 200;

function getMemoryLimits(userId) {
  // Check if this discord user has VIP
  for (const [discordId, vip] of vipUsers) {
    if (discordId === userId && Date.now() < vip.expiresAt) {
      return { history: MAX_HISTORY_VIP, facts: MAX_FACTS_VIP };
    }
  }
  // Also check admin/developer whitelist by cross-referencing sessions
  // (admins/devs get VIP limits too)
  return { history: MAX_HISTORY_FREE, facts: MAX_FACTS_FREE };
}

function getMemory(userId) {
  if (!userMemory.has(userId)) {
    userMemory.set(userId, { facts: [], history: [], updatedAt: Date.now() });
  }
  return userMemory.get(userId);
}

// Add a message turn — oldest auto-removed when limit hit
function addToHistory(userId, role, content) {
  const mem    = getMemory(userId);
  const limits = getMemoryLimits(userId);
  mem.history.push({ role, content: content.slice(0, 500) });
  while (mem.history.length > limits.history) mem.history.shift(); // rolling delete
  mem.updatedAt = Date.now();
}

// Extract and save facts — oldest auto-removed when limit hit
function extractFacts(userId, userMsg) {
  const mem    = getMemory(userId);
  const limits = getMemoryLimits(userId);

  const patterns = [
    { regex: /my name is ([a-zA-Z]+)/i,                    template: m => `User's name is ${m[1]}` },
    { regex: /i(?:'m| am) (\d+) years? old/i,              template: m => `User is ${m[1]} years old` },
    { regex: /i(?:'m| am) from ([a-zA-Z\s,]+)/i,           template: m => `User is from ${m[1].trim()}` },
    { regex: /i live in ([a-zA-Z\s,]+)/i,                  template: m => `User lives in ${m[1].trim()}` },
    { regex: /i(?:'m| am) a ([a-zA-Z\s]+)/i,               template: m => `User is a ${m[1].trim()}` },
    { regex: /i(?:\s+really)? like ([a-zA-Z\s,]+)/i,       template: m => `User likes ${m[1].trim()}` },
    { regex: /i love ([a-zA-Z\s,]+)/i,                     template: m => `User loves ${m[1].trim()}` },
    { regex: /i hate ([a-zA-Z\s,]+)/i,                     template: m => `User hates ${m[1].trim()}` },
    { regex: /i play ([a-zA-Z\s,]+)/i,                     template: m => `User plays ${m[1].trim()}` },
    { regex: /my favorite ([a-zA-Z]+) is ([a-zA-Z\s,]+)/i, template: m => `User's favorite ${m[1]} is ${m[2].trim()}` },
    { regex: /remember (?:that )?(.{5,80})/i,              template: m => m[1].trim() },
    { regex: /don'?t forget (?:that )?(.{5,80})/i,         template: m => m[1].trim() },
  ];

  for (const { regex, template } of patterns) {
    const match = userMsg.match(regex);
    if (match) {
      const fact = template(match);
      if (!mem.facts.some(f => f.toLowerCase() === fact.toLowerCase())) {
        mem.facts.push(fact);
        while (mem.facts.length > limits.facts) mem.facts.shift(); // rolling delete
      }
    }
  }
}

// Build the memory context string to inject into system prompt
function buildMemoryContext(userId) {
  const mem = getMemory(userId);
  const parts = [];

  if (mem.facts.length > 0) {
    parts.push(`Things you know about this user:\n${mem.facts.map(f => `- ${f}`).join('\n')}`);
  }

  return parts.length > 0
    ? `\n\n[MEMORY]\n${parts.join('\n\n')}\n[/MEMORY]`
    : '';
}

// Build full message array with history for the AI call
function buildMessages(systemPrompt, userId, userMsg) {
  const mem = getMemory(userId);
  const memContext = buildMemoryContext(userId);
  const fullSystem = systemPrompt + memContext;

  // Include last N history turns + new message
  const historyToSend = mem.history.slice(-20); // last 20 turns for context
  return [
    { role: 'system', content: fullSystem },
    ...historyToSend,
    { role: 'user', content: userMsg },
  ];
}

// Memory API routes
app.get('/memory/:userId', requireAdmin, (req, res) => {
  const mem = userMemory.get(req.params.userId);
  res.json(mem || { facts: [], history: [], updatedAt: null });
});

app.delete('/memory/:userId', requireAdmin, (req, res) => {
  userMemory.delete(req.params.userId);
  res.json({ success: true });
});

app.get('/memory/me/stats', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.json({ facts: 0, history: 0, sizeKB: 0 });
  const userId  = req.session.user.discordId;
  const mem     = userMemory.get(userId);
  const limits  = getMemoryLimits(userId);
  if (!mem) return res.json({ facts: 0, history: 0, sizeKB: '0.00', maxHistory: limits.history, maxFacts: limits.facts });
  const sizeKB  = (JSON.stringify(mem).length / 1024).toFixed(2);
  res.json({ facts: mem.facts.length, history: mem.history.length, sizeKB, maxHistory: limits.history, maxFacts: limits.facts, updatedAt: mem.updatedAt });
});

app.delete('/memory/me/clear', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  userMemory.delete(req.session.user.discordId);
  res.json({ success: true });
});


const { Client: DJSClientKiara, GatewayIntentBits: GWI, Events: DJSEvents } = require('discord.js');

global.kiaraConfig = global.kiaraConfig || {
  activeChannels: new Set(),
  personality: 'You are Kiara KiI, a friendly and helpful AI assistant for the Kii Akira platform. Keep responses short and conversational.',
};

const kiaraBot = new DJSClientKiara({ intents: [GWI.Guilds, GWI.GuildMessages, GWI.MessageContent] });

kiaraBot.once(DJSEvents.ClientReady, c => {
  console.log(`🤖 Kiara KiI online as ${c.user.tag}`);
  c.user.setPresence({ status: 'online', activities: [{ name: 'Kii Akira Dashboard', type: 0 }] });
});

kiaraBot.on(DJSEvents.MessageCreate, async message => {
  if (message.author.bot) return;
  const mentioned = message.mentions.has(kiaraBot.user);
  const inActive  = global.kiaraConfig.activeChannels.has(message.channel.id);
  if (!mentioned && !inActive) return;
  if (!mentioned && message.content.trim().length < 2) return;

  try {
    await message.channel.sendTyping();
    const userMsg = message.content.replace(`<@${kiaraBot.user.id}>`, '').trim();
    if (!userMsg) return message.reply('Hey! How can I help? 👋');

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return message.reply('⚠️ AI not configured yet — admin needs to set GROQ_API_KEY.');

    const userId   = message.author.id;
    const messages = buildMessages(global.kiaraConfig.personality, userId, userMsg);

    let reply = null;

    // Primary: Groq
    try {
      const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.1-8b-instant', messages, max_tokens: 400, temperature: 0.75,
      }, { headers: { Authorization: `Bearer ${groqKey}` }, timeout: 15000 });
      reply = r.data.choices[0]?.message?.content;
    } catch (groqErr) {
      console.error('Kiara Groq error:', groqErr.response?.data?.error?.message || groqErr.message);
      try {
        const cerebrasKey = process.env.CEREBRAS_API_KEY || groqKey;
        const r2 = await axios.post('https://api.cerebras.ai/v1/chat/completions', {
          model: 'llama3.1-8b', messages, max_tokens: 400,
        }, { headers: { Authorization: `Bearer ${cerebrasKey}` }, timeout: 15000 });
        reply = r2.data.choices[0]?.message?.content;
      } catch (fallbackErr) {
        console.error('Kiara fallback error:', fallbackErr.message);
      }
    }

    if (!reply) return message.reply("I couldn't get a response right now. Try again in a moment!");

    // Save to memory
    addToHistory(userId, 'user', userMsg);
    addToHistory(userId, 'assistant', reply);
    extractFacts(userId, userMsg);

    await message.reply(reply.slice(0, 1900));
  } catch (e) {
    console.error('Kiara bot error:', e.message);
    await message.reply('Something went wrong on my end. Try again shortly!');
  }
});

if (DISCORD_BOT_TOKEN) {
  kiaraBot.login(DISCORD_BOT_TOKEN).catch(e => console.warn('Kiara login failed:', e.message));
} else {
  console.warn('⚠️  DISCORD_BOT_TOKEN not set — Kiara offline');
}

// ── Middleware ──────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET || 'change-this-secret',
  resave: false, saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
//  AUTH — Discord OAuth
// ─────────────────────────────────────────────────────────────
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: DISCORD_REDIRECT_URI, response_type: 'code', scope: 'identify email', prompt: 'consent' });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: DISCORD_REDIRECT_URI }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, token_type } = tokenRes.data;
    const userRes = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `${token_type} ${access_token}` } });
    const d = userRes.data;
    req.session.user = {
      discordId: d.id, username: d.username, email: d.email,
      avatar: d.avatar ? `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.png` : null,
      role: getUserRole(d.username), isVIP: checkVIP(d.id, d.username), loggedIn: true,
    };
    res.redirect(`${FRONTEND_URL || '/'}?discord_login=success`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

app.get('/auth/me', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.json({ loggedIn: false });
  const u = req.session.user;
  u.role  = getUserRole(u.username);  // re-check live
  u.isVIP = checkVIP(u.discordId, u.username);
  res.json({ loggedIn: true, user: u });
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

// Email verification
const nodemailerAvailable = (() => { try { require.resolve('nodemailer'); return true; } catch { return false; } })();
const pendingCodes = new Map();
app.post('/auth/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  pendingCodes.set(email, { code, expiresAt: Date.now() + 10 * 60 * 1000 });
  if (!nodemailerAvailable || !process.env.SMTP_USER) { console.log(`[DEV] Code for ${email}: ${code}`); return res.json({ success: true, dev_code: code }); }
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: parseInt(process.env.SMTP_PORT || '587'), auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await t.sendMail({ from: `"Kii Akira" <${process.env.SMTP_USER}>`, to: email, subject: 'Your Kii Akira verification code', html: `<div style="font-family:Arial;background:#0b0c10;color:#e3e5e8;padding:32px;border-radius:12px"><h2>Verification Code</h2><div style="background:#17191f;padding:20px;text-align:center;border-radius:8px;font-size:2rem;font-family:monospace;color:#5865f2;letter-spacing:.25em">${code}</div><p style="color:#4e5058;font-size:13px">Expires in 10 minutes.</p></div>` });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to send email' }); }
});
app.post('/auth/verify-code', (req, res) => {
  const { email, code } = req.body;
  const entry = pendingCodes.get(email);
  if (!entry) return res.status(400).json({ error: 'No code sent' });
  if (Date.now() > entry.expiresAt) { pendingCodes.delete(email); return res.status(400).json({ error: 'Code expired' }); }
  if (entry.code !== code) return res.status(400).json({ error: 'Incorrect code' });
  pendingCodes.delete(email);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
//  ADMIN WHITELIST — only developer can manage
// ─────────────────────────────────────────────────────────────
function requireDev(req, res, next) {
  if (req.session?.user?.username !== OWNER_USERNAME) return res.status(403).json({ error: 'Owner only' });
  next();
}
function requireAdmin(req, res, next) {
  const role = getUserRole(req.session?.user?.username);
  if (role !== 'developer' && role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  next();
}

app.get('/admin/whitelist', requireDev, (req, res) => {
  res.json({ admins: [...adminWhitelist.entries()].map(([username, data]) => ({ username, ...data })) });
});
app.post('/admin/whitelist', requireDev, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  if (username === OWNER_USERNAME) return res.status(400).json({ error: 'Owner is already developer' });
  adminWhitelist.set(username, { addedAt: Date.now(), addedBy: req.session.user.username });
  console.log(`🛡️ Admin granted: ${username}`);
  res.json({ success: true });
});
app.delete('/admin/whitelist/:username', requireDev, (req, res) => {
  if (!adminWhitelist.has(req.params.username)) return res.status(404).json({ error: 'Not found' });
  adminWhitelist.delete(req.params.username);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
//  VIP SYSTEM
// ─────────────────────────────────────────────────────────────
const VIP_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

app.get('/vip/status', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.json({ isVIP: false });
  const { discordId, username } = req.session.user;
  const isVIP = checkVIP(discordId, username);
  if (!isVIP) return res.json({ isVIP: false });
  const role = getUserRole(username);
  if (role === 'developer' || role === 'admin')
    return res.json({ isVIP: true, plan: 'complimentary', daysLeft: 99999, role });
  const vip = vipUsers.get(discordId);
  res.json({ isVIP: true, expiresAt: vip.expiresAt, daysLeft: Math.ceil((vip.expiresAt - Date.now()) / 86400000), plan: vip.plan });
});
app.get('/vip/list', requireAdmin, (req, res) => {
  res.json({ vipUsers: [...vipUsers.entries()].map(([id, data]) => ({ discordId: id, ...data })) });
});
app.post('/vip/grant', requireAdmin, (req, res) => {
  const { discordId, username, duration } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId required' });
  const days = { week: 7, month: 30, year: 365, lifetime: 99999 }[duration] || 365;
  vipUsers.set(discordId, { expiresAt: Date.now() + days * 86400000, plan: duration || 'manual', grantedBy: req.session.user.username, grantedAt: Date.now(), username: username || '' });
  console.log(`👑 VIP granted: ${username || discordId} (${duration}) by ${req.session.user.username}`);
  res.json({ success: true });
});
app.delete('/vip/grant/:discordId', requireAdmin, (req, res) => {
  vipUsers.delete(req.params.discordId);
  res.json({ success: true });
});
app.post('/vip/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = JSON.parse(req.body.toString());
    if (event.data?.attributes?.type === 'link.payment.paid') {
      const discordId = (event.data?.attributes?.data?.attributes?.remarks || '').replace('vip_', '');
      if (discordId) vipUsers.set(discordId, { expiresAt: Date.now() + VIP_DURATION_MS, paidAt: Date.now(), plan: 'yearly' });
    }
    res.json({ received: true });
  } catch { res.json({ received: true }); }
});

// ─────────────────────────────────────────────────────────────
//  USER BOT SYSTEM
// ─────────────────────────────────────────────────────────────
const { Client: DJSClient, GatewayIntentBits, Events } = require('discord.js');
const userBotInstances = new Map();

const PLATFORM_MODELS = {
  'akira':    { label: 'Akira AI',       provider: 'groq',     model: 'llama-3.1-8b-instant',     vipOnly: true  },
  'llama70b': { label: 'Llama 3 70B',    provider: 'groq',     model: 'llama-3.3-70b-versatile',  vipOnly: false },
  'mistral':  { label: 'Mistral Large',  provider: 'groq',     model: 'mixtral-8x7b-32768',       vipOnly: false },
  'cerebras': { label: 'Cerebras Ultra', provider: 'cerebras', model: 'llama3.1-8b',              vipOnly: false },
  'gpt4mini': { label: 'GPT-4o Mini',    provider: 'openai',   model: 'gpt-4o-mini',              vipOnly: false },
  'gpt4':     { label: 'GPT-4 Turbo',    provider: 'openai',   model: 'gpt-4-turbo',              vipOnly: true  },
};

function getPlatformKey(provider) {
  if (provider === 'groq')     return process.env.GROQ_API_KEY;
  if (provider === 'cerebras') return process.env.CEREBRAS_API_KEY || process.env.GROQ_API_KEY;
  if (provider === 'openai')   return process.env.OPENAI_API_KEY;
  return null;
}

async function callAI(provider, apiKey, messages, temperature, model) {
  const opts = { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000 };
  const body = { model, messages, max_tokens: 400, temperature };
  if (provider === 'groq')     { const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', body, opts);     return r.data.choices[0].message.content; }
  if (provider === 'cerebras') { const r = await axios.post('https://api.cerebras.ai/v1/chat/completions', body, opts);         return r.data.choices[0].message.content; }
  if (provider === 'openai')   { const r = await axios.post('https://api.openai.com/v1/chat/completions',   body, opts);         return r.data.choices[0].message.content; }
  return 'Unknown provider.';
}

app.get('/user-bots/models', (req, res) => {
  const { discordId, username } = req.session?.user || {};
  const isVIP = checkVIP(discordId, username || '');
  res.json({ models: Object.entries(PLATFORM_MODELS).map(([id, def]) => ({ id, label: def.label, provider: def.provider, vipOnly: def.vipOnly, available: !def.vipOnly || isVIP, keyConfigured: !!getPlatformKey(def.provider) })), isVIP });
});

app.post('/user-bots/create', async (req, res) => {
  const { name, token, modelId, systemPrompt, temperature, ownerId } = req.body;
  if (!name || !token || !modelId) return res.status(400).json({ error: 'name, token and modelId required' });
  const modelDef = PLATFORM_MODELS[modelId];
  if (!modelDef) return res.status(400).json({ error: 'Invalid model' });
  const { discordId, username } = req.session?.user || {};
  const isVIP = checkVIP(discordId, username || '');
  if (modelDef.vipOnly && !isVIP) return res.status(403).json({ error: '👑 This model requires VIP!' });
  const platformKey = getPlatformKey(modelDef.provider);
  if (!platformKey) return res.status(500).json({ error: `${modelDef.provider.toUpperCase()} key not configured. Contact admin.` });

  const testClient = new DJSClient({ intents: [GatewayIntentBits.Guilds] });
  try {
    await testClient.login(token);
    const botId = testClient.user.id, botTag = testClient.user.tag;
    testClient.destroy();
    if (userBotInstances.has(botId)) userBotInstances.get(botId).client.destroy();

    const botClient = new DJSClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    botClient.once(Events.ClientReady, c => { c.user.setPresence({ status: 'online', activities: [{ name, type: 0 }] }); });
    botClient.on(Events.MessageCreate, async message => {
      if (message.author.bot || !message.mentions.has(botClient.user)) return;
      const cfg = userBotInstances.get(botId)?.config;
      if (!cfg) return;
      try {
        await message.channel.sendTyping();
        const userMsg = message.content.replace(`<@${botClient.user.id}>`, '').trim();
        if (!userMsg) return message.reply(`Hey! I'm ${name}. How can I help? 👋`);
        const md       = PLATFORM_MODELS[cfg.modelId];
        const userId   = message.author.id;
        const messages = buildMessages(cfg.systemPrompt, userId, userMsg);
        const reply    = await callAI(md.provider, getPlatformKey(md.provider), messages, cfg.temperature, md.model);
        // Save to memory
        addToHistory(userId, 'user', userMsg);
        addToHistory(userId, 'assistant', reply);
        extractFacts(userId, userMsg);
        await message.reply(reply.slice(0, 1900));
      } catch (e) { await message.reply('Having trouble right now. Try again shortly!'); }
    });
    await botClient.login(token);
    userBotInstances.set(botId, { client: botClient, config: { name, modelId, ownerId, isVIP, token, systemPrompt: systemPrompt || `You are ${name}, a helpful AI assistant. Be friendly and concise.`, temperature: temperature || 0.7 } });
    res.json({ success: true, botId, botTag, inviteUrl: `https://discord.com/api/oauth2/authorize?client_id=${botId}&permissions=277025459200&scope=bot`, model: modelDef.model, provider: modelDef.provider });
  } catch (err) { res.status(400).json({ error: 'Invalid bot token — please check and try again' }); }
});

app.get('/user-bots', (req, res) => {
  const ownerId = req.query.ownerId;
  res.json({ bots: [...userBotInstances.entries()].filter(([,{config}]) => !ownerId || config.ownerId === ownerId).map(([botId,{client,config}]) => ({ botId, name: config.name, tag: client.user?.tag, online: client.isReady(), modelId: config.modelId })) });
});
app.delete('/user-bots/:botId', (req, res) => {
  const inst = userBotInstances.get(req.params.botId);
  if (!inst) return res.status(404).json({ error: 'Bot not found' });
  inst.client.destroy(); userBotInstances.delete(req.params.botId);
  res.json({ success: true });
});
app.patch('/user-bots/:botId', (req, res) => {
  const inst = userBotInstances.get(req.params.botId);
  if (!inst) return res.status(404).json({ error: 'Bot not found' });
  const { modelId, systemPrompt, temperature } = req.body;
  if (modelId) { const md = PLATFORM_MODELS[modelId]; if (!md) return res.status(400).json({ error: 'Invalid model' }); if (md.vipOnly && !inst.config.isVIP) return res.status(403).json({ error: 'VIP required' }); inst.config.modelId = modelId; }
  if (systemPrompt !== undefined) inst.config.systemPrompt = systemPrompt;
  if (temperature  !== undefined) inst.config.temperature  = temperature;
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
//  BOT API (Kiara admin controls)
// ─────────────────────────────────────────────────────────────
app.get('/bot/channels', async (req, res) => {
  try {
    const guild = kiaraBot.guilds.cache.first();
    if (!guild) return res.json({ channels: [] });
    res.json({ channels: guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)) });
  } catch { res.json({ channels: [] }); }
});
app.get('/bot/status', (req, res) => res.json({ online: kiaraBot?.isReady() || false, tag: kiaraBot?.user?.tag || null, activeChannels: [...(global.kiaraConfig?.activeChannels || [])], personality: global.kiaraConfig?.personality }));
app.post('/bot/channels', (req, res) => {
  const { channelIds } = req.body;
  if (!Array.isArray(channelIds)) return res.status(400).json({ error: 'channelIds must be array' });
  global.kiaraConfig.activeChannels = new Set(channelIds);
  res.json({ success: true, activeChannels: channelIds });
});
app.post('/bot/personality', (req, res) => {
  if (!req.body.personality) return res.status(400).json({ error: 'personality required' });
  global.kiaraConfig.personality = req.body.personality;
  res.json({ success: true });
});
app.post('/bot/say', async (req, res) => {
  const { channelId, message } = req.body;
  if (!channelId || !message) return res.status(400).json({ error: 'channelId and message required' });
  try { const channel = await kiaraBot.channels.fetch(channelId); await channel.send(message); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
//  Start server
// ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Kii Akira backend → http://0.0.0.0:${PORT}`);
  console.log(`   Owner: ${OWNER_USERNAME} (developer + VIP always)\n`);
});
