// ═══════════════════════════════════════════════════════════
//  Kii Akira — Backend  (Node.js / Express)
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const session = require('express-session');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const {
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI,
  DISCORD_BOT_TOKEN, SESSION_SECRET, FRONTEND_URL,
} = process.env;

// ─────────────────────────────────────────────────────────────
//  ① MIDDLEWARE — must come before routes
// ─────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET || 'kiiakira_super_secret_2025',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
//  ② DATA STORES — declared before anything uses them
// ─────────────────────────────────────────────────────────────

const OWNER_USERNAME  = 'kiiakira';
const OWNER_DISCORDID = '1093442344310820895';

const adminWhitelist  = new Map(); // username → { addedAt, addedBy }
const vipUsers        = new Map(); // discordId → { expiresAt, plan, ... }
const registeredUsers = new Map(); // discordId → user object
const activityLogs    = [];
const bannedUsers     = new Map(); // discordId → { username, reason, ... }
const userMemory      = new Map(); // discordId → { facts[], history[], updatedAt }
const pendingCodes    = new Map();

const VIP_DURATION_MS  = 365 * 24 * 60 * 60 * 1000;
const MAX_LOGS         = 500;
const MAX_HISTORY_FREE = 30;
const MAX_HISTORY_VIP  = 1000;
const MAX_FACTS_FREE   = 50;
const MAX_FACTS_VIP    = 200;

// ─────────────────────────────────────────────────────────────
//  ③ HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────

function getUserRole(username, discordId) {
  if (username === OWNER_USERNAME || discordId === OWNER_DISCORDID) return 'developer';
  if (adminWhitelist.has(username)) return 'admin';
  return 'user';
}

function checkVIP(discordId, username) {
  const role = getUserRole(username, discordId);
  if (role === 'developer' || role === 'admin') return true;
  const vip = vipUsers.get(discordId);
  return !!(vip && Date.now() < vip.expiresAt);
}

function requireDev(req, res, next) {
  const u = req.session?.user;
  if (u?.username !== OWNER_USERNAME && u?.discordId !== OWNER_DISCORDID)
    return res.status(403).json({ error: 'Owner only' });
  next();
}

function requireAdmin(req, res, next) {
  const role = getUserRole(req.session?.user?.username, req.session?.user?.discordId);
  if (role !== 'developer' && role !== 'admin')
    return res.status(403).json({ error: 'Admin required' });
  next();
}

function logActivity(username, discordId, type, action, status = 'OK') {
  activityLogs.unshift({ time: new Date().toTimeString().slice(0,8), timestamp: Date.now(), user: username || 'unknown', discordId: discordId || null, type, action, status });
  if (activityLogs.length > MAX_LOGS) activityLogs.pop();
}

function registerUser(discordId, username, email, avatar, role, isVIP) {
  const existing = registeredUsers.get(discordId);
  registeredUsers.set(discordId, {
    discordId, username, email: email||null, avatar: avatar||null, role, isVIP,
    banned:   bannedUsers.has(discordId),
    joinedAt: existing?.joinedAt || new Date().toISOString().slice(0,10),
    lastSeen: new Date().toISOString(),
    botCount: existing?.botCount || 0,
  });
}

function getMemoryLimits(userId) {
  const vip = vipUsers.get(userId);
  if (vip && Date.now() < vip.expiresAt) return { history: MAX_HISTORY_VIP, facts: MAX_FACTS_VIP };
  const u = registeredUsers.get(userId);
  const role = u ? getUserRole(u.username, u.discordId) : 'user';
  if (role === 'developer' || role === 'admin') return { history: MAX_HISTORY_VIP, facts: MAX_FACTS_VIP };
  return { history: MAX_HISTORY_FREE, facts: MAX_FACTS_FREE };
}

function getMemory(userId) {
  if (!userMemory.has(userId)) userMemory.set(userId, { facts: [], history: [], updatedAt: Date.now() });
  return userMemory.get(userId);
}

function addToHistory(userId, role, content) {
  const mem = getMemory(userId);
  const lim = getMemoryLimits(userId);
  mem.history.push({ role, content: content.slice(0,500) });
  while (mem.history.length > lim.history) mem.history.shift();
  mem.updatedAt = Date.now();
}

function extractFacts(userId, userMsg) {
  const mem = getMemory(userId);
  const lim = getMemoryLimits(userId);
  const patterns = [
    { r: /my name is ([a-zA-Z]+)/i,                    f: m => `User's name is ${m[1]}` },
    { r: /i(?:'m| am) (\d+) years? old/i,              f: m => `User is ${m[1]} years old` },
    { r: /i(?:'m| am) from ([a-zA-Z\s,]+)/i,           f: m => `User is from ${m[1].trim()}` },
    { r: /i live in ([a-zA-Z\s,]+)/i,                  f: m => `User lives in ${m[1].trim()}` },
    { r: /i(?:'m| am) a ([a-zA-Z\s]+)/i,               f: m => `User is a ${m[1].trim()}` },
    { r: /i(?:\s+really)? like ([a-zA-Z\s,]+)/i,       f: m => `User likes ${m[1].trim()}` },
    { r: /i love ([a-zA-Z\s,]+)/i,                     f: m => `User loves ${m[1].trim()}` },
    { r: /i hate ([a-zA-Z\s,]+)/i,                     f: m => `User hates ${m[1].trim()}` },
    { r: /i play ([a-zA-Z\s,]+)/i,                     f: m => `User plays ${m[1].trim()}` },
    { r: /my favorite ([a-zA-Z]+) is ([a-zA-Z\s,]+)/i, f: m => `User's favorite ${m[1]} is ${m[2].trim()}` },
    { r: /remember (?:that )?(.{5,80})/i,              f: m => m[1].trim() },
    { r: /don'?t forget (?:that )?(.{5,80})/i,         f: m => m[1].trim() },
  ];
  for (const { r, f } of patterns) {
    const match = userMsg.match(r);
    if (match) {
      const fact = f(match);
      if (!mem.facts.some(x => x.toLowerCase() === fact.toLowerCase())) {
        mem.facts.push(fact);
        while (mem.facts.length > lim.facts) mem.facts.shift();
      }
    }
  }
}

function buildMessages(systemPrompt, userId, userMsg, ctx = {}) {
  const mem    = getMemory(userId);
  const facts  = mem.facts.length ? `\n\n[MEMORY]\n${mem.facts.map(f=>`- ${f}`).join('\n')}\n[/MEMORY]` : '';
  const loc    = ctx.guildName
    ? `\n\n[CONTEXT]\nServer: "${ctx.guildName}", channel: #${ctx.channelName||'unknown'}.\n[/CONTEXT]`
    : ctx.isDM ? `\n\n[CONTEXT]\nPrivate DM.\n[/CONTEXT]` : '';
  return [
    { role: 'system', content: systemPrompt + facts + loc },
    ...mem.history.slice(-20),
    { role: 'user', content: userMsg },
  ];
}

// ─────────────────────────────────────────────────────────────
//  ④ KIARA DISCORD BOT
// ─────────────────────────────────────────────────────────────
const { Client: DJSClientKiara, GatewayIntentBits: GWI, Events: DJSEvents } = require('discord.js');

global.kiaraConfig = {
  activeChannels: new Set(),
  personality: 'You are Kiara KiI, a friendly and helpful AI assistant for the Kii Akira platform. Keep responses short and conversational.',
};

const kiaraBot = new DJSClientKiara({
  intents: [ GWI.Guilds, GWI.GuildMessages, GWI.MessageContent, GWI.DirectMessages, GWI.DirectMessageTyping ],
  partials: ['CHANNEL','MESSAGE'],
});

kiaraBot.once(DJSEvents.ClientReady, c => {
  console.log(`🤖 Kiara KiI online as ${c.user.tag}`);
  c.user.setPresence({ status: 'online', activities: [{ name: 'Kii Akira Dashboard', type: 0 }] });
});

kiaraBot.on(DJSEvents.MessageCreate, async message => {
  if (message.author.bot) return;
  const isDM      = !message.guild;
  const mentioned = message.mentions.has(kiaraBot.user);
  const inActive  = global.kiaraConfig.activeChannels.has(message.channel.id);
  if (!isDM && !mentioned && !inActive) return;
  if (!isDM && !mentioned && message.content.trim().length < 2) return;
  try {
    await message.channel.sendTyping();
    const userMsg = message.content.replace(`<@${kiaraBot.user.id}>`, '').trim();
    if (!userMsg) return message.reply('Hey! How can I help? 👋');
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return message.reply('⚠️ AI not configured — admin needs to set GROQ_API_KEY.');
    const userId  = message.author.id;
    const ctx     = isDM ? { isDM: true } : { guildName: message.guild.name, channelName: message.channel.name };
    const msgs    = buildMessages(global.kiaraConfig.personality, userId, userMsg, ctx);
    let reply = null;
    try {
      const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama-3.1-8b-instant', messages: msgs, max_tokens: 400, temperature: 0.75 },
        { headers: { Authorization: `Bearer ${groqKey}` }, timeout: 15000 });
      reply = r.data.choices[0]?.message?.content;
    } catch {
      try {
        const r2 = await axios.post('https://api.cerebras.ai/v1/chat/completions',
          { model: 'llama3.1-8b', messages: msgs, max_tokens: 400 },
          { headers: { Authorization: `Bearer ${process.env.CEREBRAS_API_KEY || groqKey}` }, timeout: 15000 });
        reply = r2.data.choices[0]?.message?.content;
      } catch(e2) { console.error('Kiara fallback error:', e2.message); }
    }
    if (!reply) return message.reply("I couldn't get a response right now. Try again shortly!");
    addToHistory(userId, 'user', userMsg);
    addToHistory(userId, 'assistant', reply);
    extractFacts(userId, userMsg);
    logActivity(message.author.username, userId, 'ai', `Kiara in ${isDM ? 'DMs' : message.guild.name}`);
    await message.reply(reply.slice(0, 1900));
  } catch(e) {
    console.error('Kiara error:', e.message);
    await message.reply('Something went wrong. Try again shortly!');
  }
});

if (DISCORD_BOT_TOKEN) {
  kiaraBot.login(DISCORD_BOT_TOKEN).catch(e => console.warn('⚠️ Kiara login failed:', e.message));
} else {
  console.warn('⚠️ DISCORD_BOT_TOKEN not set — Kiara offline');
}

// ─────────────────────────────────────────────────────────────
//  ⑤ USER BOT SYSTEM
// ─────────────────────────────────────────────────────────────
const { Client: DJSClient, GatewayIntentBits, Events } = require('discord.js');
const userBotInstances = new Map();

const PLATFORM_MODELS = {
  'akira':    { label: 'Akira AI',       provider: 'groq',     model: 'llama-3.1-8b-instant',    vipOnly: true  },
  'llama70b': { label: 'Llama 3 70B',    provider: 'groq',     model: 'llama-3.3-70b-versatile', vipOnly: false },
  'mistral':  { label: 'Mistral Large',  provider: 'groq',     model: 'mixtral-8x7b-32768',      vipOnly: false },
  'cerebras': { label: 'Cerebras Ultra', provider: 'cerebras', model: 'llama3.1-8b',             vipOnly: false },
  'gpt4mini': { label: 'GPT-4o Mini',    provider: 'openai',   model: 'gpt-4o-mini',             vipOnly: false },
  'gpt4':     { label: 'GPT-4 Turbo',    provider: 'openai',   model: 'gpt-4-turbo',             vipOnly: true  },
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
  if (provider === 'groq')     return (await axios.post('https://api.groq.com/openai/v1/chat/completions',  body, opts)).data.choices[0].message.content;
  if (provider === 'cerebras') return (await axios.post('https://api.cerebras.ai/v1/chat/completions',       body, opts)).data.choices[0].message.content;
  if (provider === 'openai')   return (await axios.post('https://api.openai.com/v1/chat/completions',         body, opts)).data.choices[0].message.content;
  return 'Unknown provider.';
}

// ─────────────────────────────────────────────────────────────
//  ⑥ ALL ROUTES
// ─────────────────────────────────────────────────────────────

// ── Auth ──
app.get('/auth/discord', (req, res) => {
  const p = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: DISCORD_REDIRECT_URI, response_type: 'code', scope: 'identify email', prompt: 'consent' });
  res.redirect(`https://discord.com/oauth2/authorize?${p}`);
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
    const { data: d } = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `${token_type} ${access_token}` } });
    if (bannedUsers.has(d.id)) return res.redirect('/?error=banned');
    const role   = getUserRole(d.username, d.id);
    const isVIP  = checkVIP(d.id, d.username);
    const avatar = d.avatar ? `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.png` : null;
    req.session.user = { discordId: d.id, username: d.username, email: d.email, avatar, role, isVIP, loggedIn: true };
    registerUser(d.id, d.username, d.email, avatar, role, isVIP);
    logActivity(d.username, d.id, 'website', 'Logged in via Discord');
    res.redirect(`${FRONTEND_URL || '/'}?discord_login=success`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

app.get('/auth/me', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.json({ loggedIn: false });
  const u = req.session.user;
  u.role  = getUserRole(u.username, u.discordId);
  u.isVIP = checkVIP(u.discordId, u.username);
  res.json({ loggedIn: true, user: u });
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

app.post('/auth/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  pendingCodes.set(email, { code, expiresAt: Date.now() + 10 * 60 * 1000 });
  const nodemailerOk = (() => { try { require.resolve('nodemailer'); return true; } catch { return false; } })();
  if (!nodemailerOk || !process.env.SMTP_USER) { console.log(`[DEV] Code for ${email}: ${code}`); return res.json({ success: true, dev_code: code }); }
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: process.env.SMTP_HOST||'smtp.gmail.com', port: 587, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
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

// ── Memory ──
app.get('/memory/me/stats', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.json({ facts: 0, history: 0, sizeKB: '0.00' });
  const userId = req.session.user.discordId;
  const mem = userMemory.get(userId);
  const lim = getMemoryLimits(userId);
  if (!mem) return res.json({ facts: 0, history: 0, sizeKB: '0.00', maxHistory: lim.history, maxFacts: lim.facts });
  res.json({ facts: mem.facts.length, history: mem.history.length, sizeKB: (JSON.stringify(mem).length/1024).toFixed(2), maxHistory: lim.history, maxFacts: lim.facts, updatedAt: mem.updatedAt });
});
app.delete('/memory/me/clear', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  userMemory.delete(req.session.user.discordId);
  res.json({ success: true });
});
app.get('/memory/:userId', requireAdmin, (req, res) => {
  res.json(userMemory.get(req.params.userId) || { facts: [], history: [], updatedAt: null });
});
app.delete('/memory/:userId', requireAdmin, (req, res) => {
  userMemory.delete(req.params.userId);
  res.json({ success: true });
});

// ── Admin ──
app.get('/admin/users', requireAdmin, (req, res) => {
  const users = [...registeredUsers.values()].map(u => ({
    ...u,
    banned:   bannedUsers.has(u.discordId),
    botCount: [...userBotInstances.values()].filter(v => v.config?.ownerId === u.username).length,
    role:     getUserRole(u.username, u.discordId),
    isVIP:    checkVIP(u.discordId, u.username),
  }));
  res.json({ users });
});
app.get('/admin/logs', requireAdmin, (req, res) => {
  const { type, limit = 200 } = req.query;
  const logs = (type && type !== 'all') ? activityLogs.filter(l => l.type === type) : activityLogs;
  res.json({ logs: logs.slice(0, parseInt(limit)) });
});
app.get('/admin/bans', requireAdmin, (req, res) => {
  res.json({ bans: [...bannedUsers.values()] });
});
app.post('/admin/ban', requireAdmin, (req, res) => {
  const { discordId, username, reason } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId required' });
  if (discordId === OWNER_DISCORDID) return res.status(403).json({ error: 'Cannot ban the developer' });
  bannedUsers.set(discordId, { discordId, username, reason: reason||'No reason', bannedAt: new Date().toISOString(), bannedBy: req.session.user.username });
  if (registeredUsers.has(discordId)) registeredUsers.get(discordId).banned = true;
  logActivity(req.session.user.username, req.session.user.discordId, 'admin', `Banned ${username}: ${reason||'No reason'}`);
  res.json({ success: true });
});
app.delete('/admin/ban/:discordId', requireAdmin, (req, res) => {
  const entry = bannedUsers.get(req.params.discordId);
  bannedUsers.delete(req.params.discordId);
  if (registeredUsers.has(req.params.discordId)) registeredUsers.get(req.params.discordId).banned = false;
  logActivity(req.session.user.username, req.session.user.discordId, 'admin', `Unbanned ${entry?.username||req.params.discordId}`);
  res.json({ success: true });
});
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

// ── VIP ──
app.get('/vip/status', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.json({ isVIP: false });
  const { discordId, username } = req.session.user;
  const isVIP = checkVIP(discordId, username);
  if (!isVIP) return res.json({ isVIP: false });
  const role = getUserRole(username, discordId);
  if (role === 'developer' || role === 'admin') return res.json({ isVIP: true, plan: 'complimentary', daysLeft: 99999, role });
  const vip = vipUsers.get(discordId);
  res.json({ isVIP: true, expiresAt: vip.expiresAt, daysLeft: Math.ceil((vip.expiresAt - Date.now()) / 86400000), plan: vip.plan });
});
app.get('/vip/list', requireAdmin, (req, res) => {
  res.json({ vipUsers: [...vipUsers.entries()].map(([id, data]) => ({ discordId: id, ...data })) });
});
app.post('/vip/grant', requireAdmin, (req, res) => {
  const { discordId, username, duration } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId required' });
  const days = { week:7, month:30, year:365, lifetime:99999 }[duration] || 365;
  vipUsers.set(discordId, { expiresAt: Date.now() + days*86400000, plan: duration||'manual', grantedBy: req.session.user.username, grantedAt: Date.now(), username: username||'' });
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
      const discordId = (event.data?.attributes?.data?.attributes?.remarks||'').replace('vip_','');
      if (discordId) vipUsers.set(discordId, { expiresAt: Date.now() + VIP_DURATION_MS, paidAt: Date.now(), plan: 'yearly' });
    }
    res.json({ received: true });
  } catch { res.json({ received: true }); }
});

// ── User Bots ──
app.get('/user-bots/models', (req, res) => {
  const { discordId, username } = req.session?.user || {};
  const isVIP = checkVIP(discordId, username||'');
  res.json({ models: Object.entries(PLATFORM_MODELS).map(([id, def]) => ({ id, label: def.label, provider: def.provider, vipOnly: def.vipOnly, available: !def.vipOnly||isVIP, keyConfigured: !!getPlatformKey(def.provider) })), isVIP });
});

app.post('/user-bots/create', async (req, res) => {
  const { name, token, modelId, systemPrompt, temperature, ownerId } = req.body;
  if (!name||!token||!modelId) return res.status(400).json({ error: 'name, token and modelId required' });
  const modelDef = PLATFORM_MODELS[modelId];
  if (!modelDef) return res.status(400).json({ error: 'Invalid model' });
  const { discordId, username } = req.session?.user || {};
  const isVIP = checkVIP(discordId, username||'');
  if (modelDef.vipOnly && !isVIP) return res.status(403).json({ error: '👑 This model requires VIP!' });
  const platformKey = getPlatformKey(modelDef.provider);
  if (!platformKey) return res.status(500).json({ error: `${modelDef.provider.toUpperCase()} key not configured.` });
  const testClient = new DJSClient({ intents: [GatewayIntentBits.Guilds] });
  try {
    await testClient.login(token);
    const botId = testClient.user.id, botTag = testClient.user.tag;
    testClient.destroy();
    if (userBotInstances.has(botId)) userBotInstances.get(botId).client.destroy();
    const botClient = new DJSClient({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.DirectMessageTyping],
      partials: ['CHANNEL','MESSAGE'],
    });
    botClient.once(Events.ClientReady, c => { c.user.setPresence({ status: 'online', activities: [{ name, type: 0 }] }); });
    botClient.on(Events.MessageCreate, async message => {
      if (message.author.bot) return;
      const isDM      = !message.guild;
      const mentioned = message.mentions.has(botClient.user);
      if (!isDM && !mentioned) return;
      const cfg = userBotInstances.get(botId)?.config;
      if (!cfg) return;
      try {
        await message.channel.sendTyping();
        const userMsg = message.content.replace(`<@${botClient.user.id}>`, '').trim();
        if (!userMsg) return message.reply(`Hey! I'm ${name}. How can I help? 👋`);
        const md    = PLATFORM_MODELS[cfg.modelId];
        const uid   = message.author.id;
        const ctx   = isDM ? { isDM: true } : { guildName: message.guild.name, channelName: message.channel.name };
        const msgs  = buildMessages(cfg.systemPrompt, uid, userMsg, ctx);
        const reply = await callAI(md.provider, getPlatformKey(md.provider), msgs, cfg.temperature, md.model);
        addToHistory(uid, 'user', userMsg);
        addToHistory(uid, 'assistant', reply);
        extractFacts(uid, userMsg);
        logActivity(message.author.username, uid, 'ai', `Used ${cfg.modelId} via bot "${name}"`);
        await message.reply(reply.slice(0, 1900));
      } catch(e) { await message.reply('Having trouble. Try again shortly!'); }
    });
    await botClient.login(token);
    userBotInstances.set(botId, { client: botClient, config: { name, modelId, ownerId, isVIP, token, systemPrompt: systemPrompt||`You are ${name}, a helpful AI assistant. Be friendly and concise.`, temperature: temperature||0.7 } });
    res.json({ success: true, botId, botTag, inviteUrl: `https://discord.com/api/oauth2/authorize?client_id=${botId}&permissions=277025459200&scope=bot`, model: modelDef.model, provider: modelDef.provider });
  } catch { res.status(400).json({ error: 'Invalid bot token — please check and try again' }); }
});

app.get('/user-bots', (req, res) => {
  const ownerId = req.query.ownerId;
  res.json({ bots: [...userBotInstances.entries()].filter(([,{config}]) => !ownerId||config.ownerId===ownerId).map(([botId,{client,config}]) => ({ botId, name: config.name, tag: client.user?.tag, online: client.isReady(), modelId: config.modelId })) });
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
  if (modelId) {
    const md = PLATFORM_MODELS[modelId];
    if (!md) return res.status(400).json({ error: 'Invalid model' });
    if (md.vipOnly && !inst.config.isVIP) return res.status(403).json({ error: 'VIP required' });
    inst.config.modelId = modelId;
  }
  if (systemPrompt !== undefined) inst.config.systemPrompt = systemPrompt;
  if (temperature  !== undefined) inst.config.temperature  = temperature;
  res.json({ success: true });
});

// ── Kiara Admin Controls ──
app.get('/bot/channels', async (req, res) => {
  try {
    const guild = kiaraBot.guilds.cache.first();
    if (!guild) return res.json({ channels: [] });
    res.json({ channels: guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name })).sort((a,b) => a.name.localeCompare(b.name)) });
  } catch { res.json({ channels: [] }); }
});
app.get('/bot/status', (req, res) => {
  res.json({ online: kiaraBot?.isReady()||false, tag: kiaraBot?.user?.tag||null, activeChannels: [...(global.kiaraConfig?.activeChannels||[])], personality: global.kiaraConfig?.personality });
});
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
  if (!channelId||!message) return res.status(400).json({ error: 'channelId and message required' });
  try { const ch = await kiaraBot.channels.fetch(channelId); await ch.send(message); res.json({ success: true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
//  ⑦ START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Kii Akira backend → http://0.0.0.0:${PORT}`);
  console.log(`   Owner: ${OWNER_USERNAME} (developer + VIP always)\n`);
});
