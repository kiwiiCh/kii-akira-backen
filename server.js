// ═══════════════════════════════════════════════════════════
//  Kii Akira — Backend  (Node.js / Express)
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const session = require('express-session');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

const {
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI,
  DISCORD_BOT_TOKEN, SESSION_SECRET, FRONTEND_URL,
} = process.env;

// ─────────────────────────────────────────────────────────────
//  ① MIDDLEWARE
// ─────────────────────────────────────────────────────────────
const FileStore  = require('session-file-store')(session);
app.use(cors({ origin: true, credentials: true }));
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  store: new FileStore({ path: path.join(__dirname, 'sessions'), retries: 1, ttl: 7 * 24 * 60 * 60 }),
  secret: SESSION_SECRET || 'kiiakira_super_secret_2025',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
//  ② DATA STORES
// ─────────────────────────────────────────────────────────────

const OWNER_USERNAME  = 'kiiakira';
const OWNER_DISCORDID = '1093442344310820895';
const OWNER_EMAIL     = 'mikeorbita02@gmail.com';

const adminWhitelist  = new Map();
const vipUsers        = new Map();
const registeredUsers = new Map();
const activityLogs    = [];
const bannedUsers     = new Map();
const userMemory      = new Map();
const pendingCodes    = new Map();
const userBotConfigs  = new Map(); // persisted bot configs
let   maintenanceMode = { enabled: false, message: 'Maintenance in progress.', version: 'v1.0.0', notes: [] };

const VIP_DURATION_MS  = 365 * 24 * 60 * 60 * 1000;
const MAX_LOGS         = 500;
const MAX_HISTORY_FREE = 30;
const MAX_HISTORY_VIP  = 1000;
const MAX_FACTS_FREE   = 50;
const MAX_FACTS_VIP    = 200;

// ─────────────────────────────────────────────────────────────
//  ③ PERSISTENCE
// ─────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'kii-data.json');

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      adminWhitelist:  [...adminWhitelist.entries()],
      vipUsers:        [...vipUsers.entries()],
      bannedUsers:     [...bannedUsers.entries()],
      registeredUsers: [...registeredUsers.entries()],
      userMemory:      [...userMemory.entries()],
      userBotConfigs:  [...userBotConfigs.entries()],
      dollCoins:       [...dollCoins.entries()],
      maintenanceMode,
      savedAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) { console.error('⚠️ Save failed:', e.message); }
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) { console.log('ℹ️  No saved data — fresh start'); return; }
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    (raw.adminWhitelist  || []).forEach(([k,v]) => adminWhitelist.set(k,v));
    (raw.vipUsers        || []).forEach(([k,v]) => vipUsers.set(k,v));
    (raw.bannedUsers     || []).forEach(([k,v]) => bannedUsers.set(k,v));
    (raw.registeredUsers || []).forEach(([k,v]) => registeredUsers.set(k,v));
    (raw.userMemory      || []).forEach(([k,v]) => userMemory.set(k,v));
    (raw.userBotConfigs  || []).forEach(([k,v]) => userBotConfigs.set(k,v));
    (raw.dollCoins       || []).forEach(([k,v]) => dollCoins.set(k,v));
    if (raw.maintenanceMode) Object.assign(maintenanceMode, raw.maintenanceMode);
    console.log(`✅ Loaded — admins:${adminWhitelist.size} vip:${vipUsers.size} users:${registeredUsers.size} bans:${bannedUsers.size} bots:${userBotConfigs.size}`);
  } catch (e) { console.error('⚠️ Load failed:', e.message); }
}

loadData();
setInterval(saveData, 60 * 1000);

// ─────────────────────────────────────────────────────────────
//  ④ ROLE / AUTH HELPERS
// ─────────────────────────────────────────────────────────────

function getUserRole(username, discordId, email) {
  if (username === OWNER_USERNAME || discordId === OWNER_DISCORDID || email === OWNER_EMAIL) return 'developer';
  if (adminWhitelist.has(username)) return 'admin';
  return 'user';
}

function checkVIP(discordId, username, email) {
  const role = getUserRole(username, discordId, email);
  if (role === 'developer' || role === 'admin') return true;
  const vip = vipUsers.get(discordId);
  return !!(vip && Date.now() < vip.expiresAt);
}

// FIX: use getUserRole consistently — no raw string comparison that breaks on username changes
function requireDev(req, res, next) {
  const { username, discordId, email } = req.session?.user || {};
  const role = getUserRole(username, discordId, email);
  if (role !== 'developer') return res.status(403).json({ error: 'Owner only' });
  next();
}

function requireAdmin(req, res, next) {
  const { username, discordId, email } = req.session?.user || {};
  const role = getUserRole(username, discordId, email);
  if (role !== 'developer' && role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  next();
}

function logActivity(username, discordId, type, action, status = 'OK') {
  activityLogs.unshift({ time: new Date().toTimeString().slice(0,8), timestamp: Date.now(), user: username||'unknown', discordId: discordId||null, type, action, status });
  if (activityLogs.length > MAX_LOGS) activityLogs.pop();
}

function registerUser(discordId, username, email, avatar, role, isVIP) {
  const ex = registeredUsers.get(discordId);
  registeredUsers.set(discordId, {
    discordId, username, email: email||null, avatar: avatar||null, role, isVIP,
    banned:   bannedUsers.has(discordId),
    joinedAt: ex?.joinedAt || new Date().toISOString().slice(0,10),
    lastSeen: new Date().toISOString(),
    botCount: ex?.botCount || 0,
  });
}

// ─────────────────────────────────────────────────────────────
//  ⑤ MEMORY ENGINE  (bot-scoped: each bot has its own memory per user)
// ─────────────────────────────────────────────────────────────

function memKey(botId, userId) {
  // Key format: "botId:userId" — completely isolated per bot per user
  return `${botId}:${userId}`;
}

function getMemoryLimits(userId) {
  const vip = vipUsers.get(userId);
  if (vip && Date.now() < vip.expiresAt) return { history: MAX_HISTORY_VIP, facts: MAX_FACTS_VIP };
  const u = registeredUsers.get(userId);
  const role = u ? getUserRole(u.username, u.discordId) : 'user';
  if (role === 'developer' || role === 'admin') return { history: MAX_HISTORY_VIP, facts: MAX_FACTS_VIP };
  return { history: MAX_HISTORY_FREE, facts: MAX_FACTS_FREE };
}

function getMemory(botId, userId) {
  const k = memKey(botId, userId);
  if (!userMemory.has(k)) userMemory.set(k, { facts: [], history: [], updatedAt: Date.now() });
  return userMemory.get(k);
}

function addToHistory(botId, userId, role, content) {
  const mem = getMemory(botId, userId);
  const lim = getMemoryLimits(userId);
  mem.history.push({ role, content: content.slice(0, 800) });
  while (mem.history.length > lim.history) mem.history.shift();
  mem.updatedAt = Date.now();
}

function extractFacts(botId, userId, userMsg) {
  const mem = getMemory(botId, userId);
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
    { r: /call me ([a-zA-Z0-9_\-\s]+)/i,               f: m => `User wants to be called "${m[1].trim()}"` },
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

function buildMessages(botId, systemPrompt, userId, userMsg, ctx = {}, personalityMode = 'custom') {
  const mem  = getMemory(botId, userId);
  const API_CONTEXT_LIMIT = 40;
  const history = mem.history.slice(-API_CONTEXT_LIMIT);

  const locText = ctx.guildName
    ? `\nServer: "${ctx.guildName}" | Channel: #${ctx.channelName || 'unknown'}`
    : ctx.isDM ? '\nThis is a private DM.' : '';

  let fullSystem;

  if (personalityMode === 'sentient') {
    const observed = mem.facts.length
      ? `\n\n[THINGS YOU HAVE OBSERVED SO FAR]\n${mem.facts.map(f => `- ${f}`).join('\n')}`
      : '';
    fullSystem = systemPrompt + observed;
  } else if (personalityMode === 'human') {
    const remembered = mem.facts.length
      ? `\n\n[WHAT YOU REMEMBER ABOUT THIS PERSON]\n${mem.facts.map(f => `- ${f}`).join('\n')}`
      : '';
    fullSystem = systemPrompt + remembered + (locText ? `\n\n[WHERE YOU ARE]${locText}` : '');
  } else {
    const facts = mem.facts.length
      ? `\n\n[USER CONTEXT]\n${mem.facts.map(f => `- ${f}`).join('\n')}`
      : '';
    fullSystem = systemPrompt + facts + (locText ? `\n\n[LOCATION]${locText}` : '');
  }

  return [
    { role: 'system', content: fullSystem },
    ...history,
    { role: 'user', content: userMsg },
  ];
}

// ─────────────────────────────────────────────────────────────
//  IMAGE GENERATION — Pollinations.ai (free, no API key)
// ─────────────────────────────────────────────────────────────

const IMAGE_TRIGGERS = [
  /^(draw|paint|sketch|generate|create|make|show|give me|send|produce)\s+(me\s+)?(a\s+|an\s+|the\s+)?(image|picture|photo|pic|illustration|drawing|artwork|art|painting|portrait|wallpaper|thumbnail|meme)\s+(of\s+)?/i,
  /\b(image|picture|photo|pic|draw|paint|sketch)\s+(of|me|showing|depicting)\b/i,
  /^imagine\s+/i,
  /^visualize\s+/i,
  /can you (draw|paint|generate|create|make|show)\b/i,
  /show me (a |an |the )?(image|picture|photo|pic|drawing|painting)\b/i,
];

function detectImageRequest(msg) {
  const clean = msg.trim();
  for (const pattern of IMAGE_TRIGGERS) {
    if (pattern.test(clean)) {
      const subject = clean
        .replace(/^(draw|paint|sketch|generate|create|make|show me|give me|send|produce|imagine|visualize|can you draw|can you paint|can you generate|can you create|can you make|can you show|show me)\s*/i, '')
        .replace(/^(me\s+)?(a\s+|an\s+|the\s+)?(image|picture|photo|pic|illustration|drawing|artwork|art|painting|portrait|wallpaper|thumbnail|meme)\s+(of\s+)?/i, '')
        .trim();
      return subject || clean;
    }
  }
  return null;
}

async function generateImage(prompt) {
  // Return URL directly — Discord fetches the image itself, not Railway
  // This avoids network restriction issues on the server
  const encoded = encodeURIComponent(prompt.slice(0, 500));
  const seed = Math.floor(Math.random() * 99999);
  return `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}`;
}

async function getMessageImageUrl(message) {
  // Discord.js attachments is a Collection — use .first() or iterate
  if (message.attachments && message.attachments.size > 0) {
    const att = message.attachments.first();
    if (att && (att.contentType?.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp)$/i.test(att.url))) {
      return att.url;
    }
  }
  // Check embeds
  if (message.embeds && message.embeds.length > 0) {
    for (const embed of message.embeds) {
      if (embed.image?.url) return embed.image.url;
      if (embed.thumbnail?.url) return embed.thumbnail.url;
    }
  }
  return null;
}

async function describeImage(imageUrl, userQuestion, systemPrompt) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return null;
  try {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: imageUrl, detail: 'auto' } },
          { type: 'text', text: userQuestion || 'What do you see in this image?' },
        ]},
      ],
      max_tokens: 1024,
    }, { headers: { Authorization: `Bearer ${openaiKey}` }, timeout: 20000 });
    return res.data.choices[0].message.content;
  } catch(e) {
    console.error('Vision error:', e?.response?.data?.error?.message || e.message);
    return null;
  }
}



const PLATFORM_MODELS = {
  'akira':    { label: 'Akira AI',       provider: 'groq',     model: 'llama-3.1-8b-instant',    vipOnly: true  },
  'llama70b': { label: 'Llama 3 70B',    provider: 'groq',     model: 'llama-3.3-70b-versatile', vipOnly: false },
  'mistral':  { label: 'Mistral 8x7B',   provider: 'groq',     model: 'mixtral-8x7b-32768',      vipOnly: false },
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
  // No content filtering — AI runs fully unrestricted as configured by the bot owner
  const opts = { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 20000 };
  const body = { model, messages, max_tokens: 1024, temperature }; // 1024 for full responses
  if (provider === 'groq')     return (await axios.post('https://api.groq.com/openai/v1/chat/completions',  body, opts)).data.choices[0].message.content;
  if (provider === 'cerebras') return (await axios.post('https://api.cerebras.ai/v1/chat/completions',       body, opts)).data.choices[0].message.content;
  if (provider === 'openai')   return (await axios.post('https://api.openai.com/v1/chat/completions',         body, opts)).data.choices[0].message.content;
  throw new Error('Unknown provider: ' + provider);
}

// ─────────────────────────────────────────────────────────────
//  ⑦ KIARA BOT
// ─────────────────────────────────────────────────────────────
const { Client: DJSClientKiara, GatewayIntentBits: GWI, Events: DJSEvents } = require('discord.js');

global.kiaraConfig = {
  activeChannels: new Set(),
  personality: 'You are Kiara KiI, a friendly and helpful AI assistant. Be casual, chill, and talk like a real person.',
};

const kiaraBot = new DJSClientKiara({
  intents: [ GWI.Guilds, GWI.GuildMessages, GWI.MessageContent, GWI.DirectMessages, GWI.DirectMessageTyping ],
  partials: ['CHANNEL','MESSAGE'],
});

kiaraBot.once(DJSEvents.ClientReady, c => {
  console.log(`🤖 Kiara online as ${c.user.tag}`);
  c.user.setPresence({ status: 'online', activities: [{ name: 'Kii Akira Dashboard', type: 0 }] });
  registerSlashCommands(c, DISCORD_BOT_TOKEN);
});

const KIARA_BOT_ID = 'kiara'; // fixed ID for Kiara's memory namespace

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
    const userId = message.author.id;

    // ── Vision: user sent an image ──
    const attachedImg = await getMessageImageUrl(message);
    if (attachedImg) {
      const question = userMsg || 'What do you see in this image?';
      const visionReply = await describeImage(attachedImg, question, global.kiaraConfig.personality);
      if (visionReply) {
        addToHistory(KIARA_BOT_ID, userId, 'user', `[Sent an image] ${question}`);
        addToHistory(KIARA_BOT_ID, userId, 'assistant', visionReply);
        extractFacts(KIARA_BOT_ID, userId, question);
        saveData();
        return await message.reply(visionReply.slice(0, 1900));
      }
      if (!userMsg) return message.reply('I can see you sent an image! Add OPENAI_API_KEY to enable image reading. 👀');
    }

    if (!userMsg) return message.reply('Hey! How can I help? 👋');

    const imageSubject = detectImageRequest(userMsg);
    if (imageSubject) {
      try {
        const imgUrl = await generateImage(imageSubject);
        addToHistory(KIARA_BOT_ID, message.author.id, 'user', userMsg);
        addToHistory(KIARA_BOT_ID, message.author.id, 'assistant', `[Generated image: ${imageSubject}]`);
        saveData();
        return await message.reply({ content: `Here's "" 🎨
${imgUrl}` });
      } catch {}
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return message.reply('⚠️ GROQ_API_KEY not set.');
    const ctx    = isDM ? { isDM: true } : { guildName: message.guild.name, channelName: message.channel.name };
    const msgs   = buildMessages(KIARA_BOT_ID, global.kiaraConfig.personality, userId, userMsg, ctx, 'professional');

    let reply = null;
    try {
      reply = await callAI('groq', groqKey, msgs, 0.85, 'llama-3.1-8b-instant');
    } catch (e1) {
      console.error('Kiara Groq error:', e1?.response?.data?.error?.message || e1.message);
      try {
        reply = await callAI('cerebras', process.env.CEREBRAS_API_KEY || groqKey, msgs, 0.85, 'llama3.1-8b');
      } catch (e2) {
        return message.reply(`⚠️ AI error: ${e2?.response?.data?.error?.message || e2.message}`);
      }
    }

    if (!reply) return message.reply('Got an empty response — try again!');
    addToHistory(KIARA_BOT_ID, userId, 'user', userMsg);
    addToHistory(KIARA_BOT_ID, userId, 'assistant', reply);
    extractFacts(KIARA_BOT_ID, userId, userMsg);
    logActivity(message.author.username, userId, 'ai', `Kiara in ${isDM ? 'DMs' : message.guild.name}`);
    saveData();
    await message.reply(reply.slice(0, 1900));
  } catch(e) {
    console.error('Kiara handler error:', e.message);
    await message.reply(`⚠️ Error: ${e.message.slice(0, 200)}`);
  }
});

if (DISCORD_BOT_TOKEN) {
  kiaraBot.login(DISCORD_BOT_TOKEN).catch(e => console.warn('⚠️ Kiara login failed:', e.message));
} else {
  console.warn('⚠️ DISCORD_BOT_TOKEN not set — Kiara offline');
}

// ─────────────────────────────────────────────────────────────
//  ⑧ USER BOT SYSTEM
// ─────────────────────────────────────────────────────────────
const { Client: DJSClient, GatewayIntentBits, Events } = require('discord.js');
const userBotInstances = new Map(); // botId → { client, config }

async function spawnUserBot(botId, cfg) {
  if (userBotInstances.has(botId)) {
    try { userBotInstances.get(botId).client.destroy(); } catch {}
  }
  const botClient = new DJSClient({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.DirectMessageTyping],
    partials: ['CHANNEL','MESSAGE'],
  });
  botClient.once(Events.ClientReady, c => {
    c.user.setPresence({ status: 'online', activities: [{ name: cfg.name, type: 0 }] });
    console.log(`🤖 User bot "${cfg.name}" online as ${c.user.tag}`);
    registerSlashCommands(c, cfg.token);
  });

  // Slash command handler for user bots
  botClient.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const live = userBotInstances.get(botId)?.config;
    if (!live || live.paused) return;
    const uid = interaction.user.id;
    const username = interaction.user.username;
    const md = PLATFORM_MODELS[live.modelId];
    const key = md ? getPlatformKey(md.provider) : null;

    if (interaction.commandName === 'chat') {
      const userMsg = interaction.options.getString('message');
      await interaction.deferReply();
      try {
        if (!md || !key) return interaction.editReply('⚠️ Bot model not configured.');
        const ctx = interaction.guild
          ? { guildName: interaction.guild.name, channelName: interaction.channel?.name }
          : { isDM: true };
        const msgs = buildMessages(botId, live.systemPrompt, uid, userMsg, ctx, live.personalityMode || 'custom');
        const reply = await callAI(md.provider, key, msgs, live.temperature, md.model);
        addToHistory(botId, uid, 'user', userMsg);
        addToHistory(botId, uid, 'assistant', reply);
        extractFacts(botId, uid, userMsg);
        logActivity(username, uid, 'ai', `Used ${live.modelId} via bot "${live.name}" /chat`);
        saveData();
        await interaction.editReply(reply.slice(0, 2000));
      } catch(e) { await interaction.editReply(`⚠️ ${(e?.response?.data?.error?.message || e.message).slice(0, 200)}`); }

    } else if (interaction.commandName === 'imagine') {
      const prompt = interaction.options.getString('prompt');
      await interaction.deferReply();
      try {
        const imgUrl = await generateImage(prompt);
        addToHistory(botId, uid, 'user', `/imagine ${prompt}`);
        addToHistory(botId, uid, 'assistant', `[Generated image: ${prompt}]`);
        saveData();
        await interaction.editReply({ embeds: [{ title: '🎨 Here you go!', image: { url: imgUrl }, color: 0x5865f2 }] });
      } catch(e) { await interaction.editReply(`⚠️ Could not generate image: ${e.message.slice(0, 100)}`); }

    } else if (interaction.commandName === 'memory') {
      const mem = userMemory.get(memKey(botId, uid));
      if (!mem || (!mem.facts.length && !mem.history.length)) {
        return interaction.reply({ content: "I don't remember anything about you yet.", ephemeral: true });
      }
      const factsText = mem.facts.length ? `**Facts I know about you:**\n${mem.facts.map(f => `• ${f}`).join('\n')}` : '';
      const histText = `**Conversation history:** ${mem.history.length} messages stored`;
      await interaction.reply({ content: [factsText, histText].filter(Boolean).join('\n\n'), ephemeral: true });

    } else if (interaction.commandName === 'forget') {
      userMemory.delete(memKey(botId, uid));
      saveData();
      await interaction.reply({ content: '✅ Done — cleared everything I remembered about you.', ephemeral: true });

    } else if (interaction.commandName === 'yap') {
      if (!interaction.channel) return interaction.reply({ content: '⚠️ Cannot yap here.', ephemeral: true });
      if (!live.yapChannels) live.yapChannels = new Map();
      if (live.yapChannels.has(interaction.channel.id)) {
        return interaction.reply({ content: 'Already yapping here! Use /unyap to stop.', ephemeral: true });
      }
      const interval = setInterval(async () => {
        try {
          if (!md || !key) return;
          const yapPrompts = ['What\'s on everyone\'s mind?','Talk to me 👀','Anyone home?','What\'s good?','Say something!','Bored... entertain me'];
          const prompt = yapPrompts[Math.floor(Math.random() * yapPrompts.length)];
          const msgs = [{ role: 'system', content: live.systemPrompt }, { role: 'user', content: prompt }];
          const reply = await callAI(md.provider, key, msgs, live.temperature, md.model);
          const ch = await botClient.channels.fetch(interaction.channel.id);
          await ch.send(reply.slice(0, 1900));
        } catch(e) { console.error(`Yap error (${live.name}):`, e.message); }
      }, 15000 + Math.random() * 15000);
      live.yapChannels.set(interaction.channel.id, interval);
      await interaction.reply(`✅ ${live.name} is now yapping in <#${interaction.channel.id}>! Use /unyap to stop.`);

    } else if (interaction.commandName === 'unyap') {
      if (!live.yapChannels) return interaction.reply({ content: 'Not yapping anywhere.', ephemeral: true });
      const interval = live.yapChannels.get(interaction.channel?.id);
      if (!interval) return interaction.reply({ content: 'Not yapping in this channel.', ephemeral: true });
      clearInterval(interval);
      live.yapChannels.delete(interaction.channel.id);
      await interaction.reply(`✅ ${live.name} stopped yapping.`);
    }
  });
  botClient.on(Events.MessageCreate, async message => {
    const isDM      = !message.guild;
    const mentioned = message.mentions.has(botClient.user);
    const live = userBotInstances.get(botId)?.config;
    if (!live || live.paused) return;

    // Bot-to-bot interaction — only when yapping AND mentioned by another bot
    const isOtherBot = message.author.bot && message.author.id !== botClient.user?.id;
    if (isOtherBot) {
      if (!mentioned) return; // only respond when another bot @mentions this bot
      if (!live.yapChannels?.has(message.channel.id)) return; // only in yap channels
      // 5 second cooldown to prevent spam
      const now = Date.now();
      if (live.lastBotReply && now - live.lastBotReply < 5000) return;
      live.lastBotReply = now;
      try {
        if (!md || !key) return;
        const userMsg = message.content.replace(`<@${botClient.user.id}>`, '').trim();
        const ctx = { guildName: message.guild?.name, channelName: message.channel?.name };
        const msgs = buildMessages(botId, live.systemPrompt, message.author.id, userMsg, ctx, live.personalityMode || 'custom');
        await message.channel.sendTyping();
        const reply = await callAI(md.provider, key, msgs, live.temperature, md.model);
        addToHistory(botId, message.author.id, 'user', userMsg);
        addToHistory(botId, message.author.id, 'assistant', reply);
        saveData();
        await message.reply(reply.slice(0, 1900));
      } catch(e) { console.error(`Bot-to-bot error (${live.name}):`, e.message); }
      return;
    }

    if (message.author.bot) return; // ignore other bots unless yapping
    if (!isDM && !mentioned) return;

    try {
      await message.channel.sendTyping();
      const userMsg = message.content.replace(`<@${botClient.user.id}>`, '').trim();
      const uid = message.author.id;

      // ── Vision: user sent an image ──
      const imageUrl = await getMessageImageUrl(message);
      if (imageUrl) {
        const question = userMsg || 'What do you see in this image?';
        const visionReply = await describeImage(imageUrl, question, live.systemPrompt);
        if (visionReply) {
          addToHistory(botId, uid, 'user', `[Sent an image] ${question}`);
          addToHistory(botId, uid, 'assistant', visionReply);
          extractFacts(botId, uid, question);
          logActivity(message.author.username, uid, 'ai', `Bot "${live.name}" described image`);
          saveData();
          return await message.reply(visionReply.slice(0, 1900));
        }
        // Fall through to text if no OpenAI key
        if (!userMsg) return message.reply('I can see you sent an image! Add an OPENAI_API_KEY to enable image reading. 👀');
      }

      if (!userMsg) return message.reply(`Hey! I'm ${live.name}. How can I help? 👋`);

      const imageSubject = detectImageRequest(userMsg);
      if (imageSubject) {
        try {
          const imgUrl = await generateImage(imageSubject);
          addToHistory(botId, uid, 'user', userMsg);
          addToHistory(botId, uid, 'assistant', `[Generated image: ${imageSubject}]`);
          logActivity(message.author.username, uid, 'ai', `Bot "${live.name}" generated image: "${imageSubject}"`);
          saveData();
          return await message.reply({ content: `Here's "" 🎨
${imgUrl}` });
        } catch(imgErr) { /* fall through */ }
      }

      const md = PLATFORM_MODELS[live.modelId];
      if (!md) return message.reply('⚠️ Bot model not configured.');
      const key = getPlatformKey(md.provider);
      if (!key) return message.reply(`⚠️ ${md.provider.toUpperCase()} API key not set on server.`);
      const ctx = isDM ? { isDM: true } : { guildName: message.guild.name, channelName: message.channel.name };
      const msgs = buildMessages(botId, live.systemPrompt, uid, userMsg, ctx, live.personalityMode || 'custom');
      const reply = await callAI(md.provider, key, msgs, live.temperature, md.model);
      addToHistory(botId, uid, 'user', userMsg);
      addToHistory(botId, uid, 'assistant', reply);
      extractFacts(botId, uid, userMsg);
      logActivity(message.author.username, uid, 'ai', `Used ${live.modelId} via bot "${live.name}"`);
      saveData();
      await message.reply(reply.slice(0, 1900));
    } catch(e) {
      const errText = e?.response?.data?.error?.message || e.message || 'Unknown error';
      console.error(`Bot "${live.name}" error:`, errText);
      await message.reply(`⚠️ ${errText.slice(0, 200)}`);
    }
  });
  await botClient.login(cfg.token);
  userBotInstances.set(botId, { client: botClient, config: cfg });
}

// ─────────────────────────────────────────────────────────────
//  ⑨ ROUTES
// ─────────────────────────────────────────────────────────────

// Android App Links verification — required for deep links to work
// This tells Android that the KiiAkira app owns this domain
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.kiiakira.app',
      sha256_cert_fingerprints: [
        // Debug keystore fingerprint (works for debug APK builds)
        'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C'
      ]
    }
  }]);
});


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
    saveData();
    res.redirect(`${FRONTEND_URL || '/'}?discord_login=success`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

app.get('/auth/me', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.json({ loggedIn: false });
  const u = req.session.user;
  u.role  = getUserRole(u.username, u.discordId, u.email);
  u.isVIP = checkVIP(u.discordId, u.username, u.email);
  req.session.user = u;
  res.json({ loggedIn: true, user: u });
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

app.post('/auth/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  pendingCodes.set(email, { code, expiresAt: Date.now() + 10 * 60 * 1000 });
  if (!process.env.SMTP_USER) { console.log(`[DEV] Email code for ${email}: ${code}`); return res.json({ success: true, dev_code: code }); }
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

  // Create session for email login — link owner email to developer role
  const username = email === OWNER_EMAIL ? OWNER_USERNAME : email.split('@')[0].replace(/[^a-z0-9]/gi,'').toLowerCase() || 'user';
  const discordId = email === OWNER_EMAIL ? OWNER_DISCORDID : null;
  const role = getUserRole(username, discordId, email);
  const isVIP = checkVIP(discordId, username, email);
  req.session.user = { username, discordId, email, role, isVIP, loggedIn: true, avatar: null };
  res.json({ success: true });
});

// ── Memory routes ──
app.get('/memory/me/stats', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.json({ facts: 0, history: 0, sizeKB: '0.00' });
  const userId = req.session.user.discordId;
  const lim = getMemoryLimits(userId);
  // Aggregate across all bots for this user
  let totalFacts = 0, totalHistory = 0, totalSize = 0;
  for (const [k, mem] of userMemory.entries()) {
    if (k.endsWith(':' + userId)) {
      totalFacts   += mem.facts.length;
      totalHistory += mem.history.length;
      totalSize    += JSON.stringify(mem).length;
    }
  }
  if (!totalHistory && !totalFacts) return res.json({ facts: 0, history: 0, sizeKB: '0.00', maxHistory: lim.history, maxFacts: lim.facts });
  res.json({ facts: totalFacts, history: totalHistory, sizeKB: (totalSize/1024).toFixed(2), maxHistory: lim.history, maxFacts: lim.facts });
});
app.delete('/memory/me/clear', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  const userId = req.session.user.discordId;
  // Clear all bot memories for this user
  for (const k of userMemory.keys()) {
    if (k.endsWith(':' + userId)) userMemory.delete(k);
  }
  saveData();
  res.json({ success: true });
});
app.get('/memory/:userId', requireAdmin, (req, res) => {
  res.json(userMemory.get(req.params.userId) || { facts: [], history: [], updatedAt: null });
});
app.delete('/memory/:userId', requireAdmin, (req, res) => {
  userMemory.delete(req.params.userId);
  saveData();
  res.json({ success: true });
});

// ── Admin routes ──
app.get('/admin/users', requireAdmin, (req, res) => {
  const users = [...registeredUsers.values()].map(u => ({
    ...u,
    banned:   bannedUsers.has(u.discordId),
    botCount: [...userBotConfigs.values()].filter(c => c.ownerId === u.username || c.ownerDiscordId === u.discordId).length,
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
app.get('/admin/bans', requireAdmin, (req, res) => res.json({ bans: [...bannedUsers.values()] }));
app.post('/admin/ban', requireAdmin, (req, res) => {
  const { discordId, username, reason } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId required' });
  if (discordId === OWNER_DISCORDID) return res.status(403).json({ error: 'Cannot ban the developer' });
  bannedUsers.set(discordId, { discordId, username, reason: reason||'No reason', bannedAt: new Date().toISOString(), bannedBy: req.session.user.username });
  if (registeredUsers.has(discordId)) registeredUsers.get(discordId).banned = true;
  logActivity(req.session.user.username, req.session.user.discordId, 'admin', `Banned ${username}: ${reason||'No reason'}`);
  saveData();
  res.json({ success: true });
});
app.delete('/admin/ban/:discordId', requireAdmin, (req, res) => {
  const entry = bannedUsers.get(req.params.discordId);
  bannedUsers.delete(req.params.discordId);
  if (registeredUsers.has(req.params.discordId)) registeredUsers.get(req.params.discordId).banned = false;
  logActivity(req.session.user.username, req.session.user.discordId, 'admin', `Unbanned ${entry?.username||req.params.discordId}`);
  saveData();
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
  saveData();
  res.json({ success: true });
});
app.delete('/admin/whitelist/:username', requireDev, (req, res) => {
  if (!adminWhitelist.has(req.params.username)) return res.status(404).json({ error: 'Not found' });
  adminWhitelist.delete(req.params.username);
  saveData();
  res.json({ success: true });
});

// ── VIP routes ──
app.get('/vip/status', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.json({ isVIP: false });
  const { discordId, username } = req.session.user;
  const role  = getUserRole(username, discordId);
  const isVIP = checkVIP(discordId, username);
  if (!isVIP) return res.json({ isVIP: false });
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
  saveData();
  res.json({ success: true });
});
app.delete('/vip/grant/:discordId', requireAdmin, (req, res) => {
  vipUsers.delete(req.params.discordId);
  saveData();
  res.json({ success: true });
});
app.post('/vip/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = JSON.parse(req.body.toString());
    if (event.data?.attributes?.type === 'link.payment.paid') {
      const discordId = (event.data?.attributes?.data?.attributes?.remarks||'').replace('vip_','');
      if (discordId) { vipUsers.set(discordId, { expiresAt: Date.now() + VIP_DURATION_MS, paidAt: Date.now(), plan: 'yearly' }); saveData(); }
    }
    res.json({ received: true });
  } catch { res.json({ received: true }); }
});

// ── User Bot routes ──
app.get('/user-bots/models', (req, res) => {
  const { discordId, username } = req.session?.user || {};
  const isVIP = checkVIP(discordId, username||'');
  res.json({ models: Object.entries(PLATFORM_MODELS).map(([id, def]) => ({ id, label: def.label, provider: def.provider, vipOnly: def.vipOnly, available: !def.vipOnly||isVIP, keyConfigured: !!getPlatformKey(def.provider) })), isVIP });
});

app.post('/user-bots/create', async (req, res) => {
  const { name, token, modelId, systemPrompt, temperature } = req.body;
  if (!name||!token||!modelId) return res.status(400).json({ error: 'name, token and modelId required' });
  const modelDef = PLATFORM_MODELS[modelId];
  if (!modelDef) return res.status(400).json({ error: 'Invalid model' });
  const { discordId, username } = req.session?.user || {};
  const isVIP = checkVIP(discordId, username||'');
  if (modelDef.vipOnly && !isVIP) return res.status(403).json({ error: `👑 ${modelDef.label} requires VIP!` });
  const platformKey = getPlatformKey(modelDef.provider);
  if (!platformKey) return res.status(500).json({ error: `${modelDef.provider.toUpperCase()} API key not configured on server.` });
  const testClient = new DJSClient({ intents: [GatewayIntentBits.Guilds] });
  try {
    await testClient.login(token);
    const botId = testClient.user.id, botTag = testClient.user.tag;
    testClient.destroy();
    const cfg = {
      name, modelId, token, isVIP,
      ownerId:        username || null,
      ownerDiscordId: discordId || null,
      systemPrompt:   systemPrompt || `You are ${name}, a helpful AI assistant. Be friendly and genuine.`,
      temperature:    temperature  || 0.8,
      personalityMode: req.body.personalityMode || 'custom',
      paused:         false,
      createdAt:      new Date().toISOString(),
    };
    await spawnUserBot(botId, cfg);
    userBotConfigs.set(botId, cfg);
    saveData();
    res.json({ success: true, botId, botTag, inviteUrl: `https://discord.com/api/oauth2/authorize?client_id=${botId}&permissions=277025459200&scope=bot%20applications.commands`, model: modelDef.model, provider: modelDef.provider });
  } catch (e) {
    res.status(400).json({ error: `Bot token error: ${e.message}` });
  }
});

// GET all bots for this user
app.get('/user-bots', (req, res) => {
  const { username, discordId } = req.session?.user || {};
  const role    = getUserRole(username, discordId);
  const isAdmin = (role === 'developer' || role === 'admin');
  const allIds  = new Set([...userBotInstances.keys(), ...userBotConfigs.keys()]);
  const bots = [...allIds].map(botId => {
    const inst   = userBotInstances.get(botId);
    const config = inst?.config || userBotConfigs.get(botId);
    if (!config) return null;
    if (!isAdmin && config.ownerId !== username && config.ownerDiscordId !== discordId) return null;
    const botUsers = new Set(activityLogs.filter(l => l.action?.includes(`"${config.name}"`)).map(l => l.discordId).filter(Boolean));
    const totalMemKB = [...botUsers].reduce((sum, uid) => { const m = userMemory.get(uid); return sum + (m ? JSON.stringify(m).length/1024 : 0); }, 0);
    const guilds = inst?.client?.isReady()
      ? inst.client.guilds.cache.map(g => ({ id: g.id, name: g.name, icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null, memberCount: g.memberCount }))
      : [];
    return {
      botId, name: config.name,
      tag:          inst?.client?.user?.tag || null,
      online:       inst?.client?.isReady() || false,
      paused:       config.paused || false,
      modelId:      config.modelId,
      ownerId:      config.ownerId,
      systemPrompt: config.systemPrompt || '',
      temperature:  config.temperature  || 0.8,
      inviteUrl:    `https://discord.com/api/oauth2/authorize?client_id=${botId}&permissions=277025459200&scope=bot%20applications.commands`,
      userCount:    botUsers.size,
      memKB:        parseFloat(totalMemKB.toFixed(2)),
      guilds,
    };
  }).filter(Boolean);
  res.json({ bots });
});

// Pause bot (stays connected, stops replying)
app.post('/user-bots/:botId/pause', (req, res) => {
  const { username, discordId } = req.session?.user || {};
  const inst   = userBotInstances.get(req.params.botId);
  const config = inst?.config || userBotConfigs.get(req.params.botId);
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  const role = getUserRole(username, discordId);
  if (role !== 'developer' && role !== 'admin' && config.ownerId !== username && config.ownerDiscordId !== discordId)
    return res.status(403).json({ error: 'Not your bot' });
  config.paused = true;
  if (userBotConfigs.has(req.params.botId)) userBotConfigs.get(req.params.botId).paused = true;
  saveData();
  res.json({ success: true, paused: true });
});

// Resume bot
app.post('/user-bots/:botId/resume', async (req, res) => {
  const { username, discordId } = req.session?.user || {};
  const inst   = userBotInstances.get(req.params.botId);
  const config = inst?.config || userBotConfigs.get(req.params.botId);
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  const role = getUserRole(username, discordId);
  if (role !== 'developer' && role !== 'admin' && config.ownerId !== username && config.ownerDiscordId !== discordId)
    return res.status(403).json({ error: 'Not your bot' });
  config.paused = false;
  if (userBotConfigs.has(req.params.botId)) userBotConfigs.get(req.params.botId).paused = false;
  // If bot was offline, try to reconnect
  if (!inst?.client?.isReady()) {
    try { await spawnUserBot(req.params.botId, config); } catch(e) { return res.status(500).json({ error: `Could not reconnect: ${e.message}` }); }
  }
  saveData();
  res.json({ success: true, paused: false });
});

// PATCH — edit name, model, personality, temperature
app.patch('/user-bots/:botId', (req, res) => {
  const { username, discordId } = req.session?.user || {};
  const inst   = userBotInstances.get(req.params.botId);
  const config = inst?.config || userBotConfigs.get(req.params.botId);
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  const role = getUserRole(username, discordId);
  const isAdmin = (role === 'developer' || role === 'admin');
  if (!isAdmin && config.ownerId !== username && config.ownerDiscordId !== discordId)
    return res.status(403).json({ error: 'Not your bot' });
  const { name, modelId, systemPrompt, temperature, personalityMode } = req.body;
  if (modelId) {
    const md = PLATFORM_MODELS[modelId];
    if (!md) return res.status(400).json({ error: 'Invalid model' });
    if (md.vipOnly && !config.isVIP) return res.status(403).json({ error: 'VIP required for this model' });
    config.modelId = modelId;
  }
  if (name             !== undefined) config.name            = name;
  if (systemPrompt     !== undefined) config.systemPrompt    = systemPrompt;
  if (temperature      !== undefined) config.temperature     = temperature;
  if (personalityMode  !== undefined) config.personalityMode = personalityMode;
  // Sync to persisted config and live instance
  if (userBotConfigs.has(req.params.botId)) Object.assign(userBotConfigs.get(req.params.botId), config);
  if (inst) inst.config = config;
  saveData();
  res.json({ success: true });
});

// DELETE
app.delete('/user-bots/:botId', (req, res) => {
  const { username, discordId } = req.session?.user || {};
  const inst   = userBotInstances.get(req.params.botId);
  const config = inst?.config || userBotConfigs.get(req.params.botId);
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  const role = getUserRole(username, discordId);
  const isAdmin = (role === 'developer' || role === 'admin');
  if (!isAdmin && config.ownerId !== username && config.ownerDiscordId !== discordId)
    return res.status(403).json({ error: 'Not your bot' });
  if (inst) { try { inst.client.destroy(); } catch {} userBotInstances.delete(req.params.botId); }
  userBotConfigs.delete(req.params.botId);
  saveData();
  res.json({ success: true });
});

// ── Kiara admin controls ──
// ── Kiara admin controls (requireAdmin on all write routes) ──
app.get('/bot/channels', requireAdmin, async (req, res) => {
  try {
    if (!kiaraBot.isReady()) return res.json({ channels: [], guilds: [] });
    // Return channels from ALL guilds Kiara is in, grouped by guild
    const guilds = kiaraBot.guilds.cache.map(g => ({
      id: g.id, name: g.name,
      channels: g.channels.cache
        .filter(c => c.type === 0) // ChannelType.GuildText = 0
        .map(c => ({ id: c.id, name: c.name, guildId: g.id, guildName: g.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
    // Flat list for backward compat + grouped for display
    const channels = guilds.flatMap(g => g.channels);
    res.json({ channels, guilds });
  } catch(e) { res.json({ channels: [], guilds: [] }); }
});

app.get('/bot/status', requireAdmin, (req, res) => {
  const guilds = kiaraBot.isReady()
    ? kiaraBot.guilds.cache.map(g => ({ id: g.id, name: g.name, memberCount: g.memberCount }))
    : [];
  res.json({
    online: kiaraBot?.isReady() || false,
    tag: kiaraBot?.user?.tag || null,
    activeChannels: [...(global.kiaraConfig?.activeChannels || [])],
    personality: global.kiaraConfig?.personality,
    guilds,
  });
});

app.post('/bot/channels', requireAdmin, (req, res) => {
  const { channelIds } = req.body;
  if (!Array.isArray(channelIds)) return res.status(400).json({ error: 'channelIds must be array' });
  global.kiaraConfig.activeChannels = new Set(channelIds);
  res.json({ success: true, activeChannels: channelIds });
});

app.post('/bot/personality', requireAdmin, (req, res) => {
  if (!req.body.personality) return res.status(400).json({ error: 'personality required' });
  global.kiaraConfig.personality = req.body.personality;
  res.json({ success: true });
});

app.post('/bot/say', requireAdmin, async (req, res) => {
  const { channelId, message } = req.body;
  if (!channelId || !message) return res.status(400).json({ error: 'channelId and message required' });
  try {
    const ch = await kiaraBot.channels.fetch(channelId);
    await ch.send(message);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Doll — coin persistence + chat ──
const dollCoins = new Map(); // discordId → coins

app.post('/doll/coins', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  const { coins } = req.body;
  if (typeof coins !== 'number') return res.status(400).json({ error: 'coins must be number' });
  const id = req.session.user.discordId;
  // Only update if higher — prevents accidental coin loss from stale local data
  const current = dollCoins.get(id) || 0;
  if (coins >= current) {
    dollCoins.set(id, coins);
    saveData();
  }
  res.json({ success: true, coins: dollCoins.get(id) });
});

app.get('/doll/coins/me', (req, res) => {
  if (!req.session?.user?.loggedIn) return res.json({ coins: 0 });
  const coins = dollCoins.get(req.session.user.discordId) || 0;
  res.json({ coins });
});

app.post('/doll/chat', async (req, res) => {
  const { message, charName } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const md = PLATFORM_MODELS['llama70b'];
  const key = getPlatformKey(md.provider);
  if (!key) return res.status(500).json({ error: 'No API key configured' });
  try {
    const name = charName || 'Mika';
    const sysPrompt = `You are ${name}, a cute anime girl companion who lives on the user's screen. You're sweet, playful, and expressive. Keep replies to 1-2 sentences max. Use light Japanese words occasionally (nyan, senpai, kawaii, ehehe etc). Use emojis. Never break character. Never say you're an AI.`;
    const reply = await callAI(md.provider, key, [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: message },
    ], 0.95, md.model);
    res.json({ reply });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});



// ── Maintenance ──
app.get('/admin/maintenance', (req, res) => res.json(maintenanceMode));
app.post('/admin/maintenance', requireDev, (req, res) => {
  const { enabled, message, version, notes } = req.body;
  if (enabled  !== undefined) maintenanceMode.enabled  = !!enabled;
  if (message  !== undefined) maintenanceMode.message  = message;
  if (version  !== undefined) maintenanceMode.version  = version;
  if (notes    !== undefined) maintenanceMode.notes    = notes;
  saveData();
  res.json({ success: true, maintenanceMode });
});

// ─────────────────────────────────────────────────────────────
//  ⑩ START + BOT RESTORE
// ─────────────────────────────────────────────────────────────

// Slash command definitions — registered for both Kiara and every user bot
const SLASH_COMMANDS = [
  {
    name: 'chat',
    description: 'Chat with the AI',
    options: [{ name: 'message', description: 'Your message', type: 3, required: true }],
  },
  {
    name: 'imagine',
    description: 'Generate an image',
    options: [{ name: 'prompt', description: 'What to draw', type: 3, required: true }],
  },
  {
    name: 'memory',
    description: 'Show what this AI remembers about you',
  },
  {
    name: 'forget',
    description: 'Clear what this AI remembers about you',
  },
  {
    name: 'yap',
    description: 'Make the AI start sending messages on its own in this channel',
  },
  {
    name: 'unyap',
    description: 'Stop the AI from sending messages on its own',
  },
];

async function registerSlashCommands(client, token) {
  try {
    const { REST, Routes } = require('discord.js');
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: SLASH_COMMANDS },
    );
    console.log(`✅ Slash commands registered for ${client.user.tag}`);
  } catch(e) {
    console.warn(`⚠️ Slash command registration failed for ${client.user?.tag}: ${e.message}`);
  }
}

kiaraBot.on(DJSEvents.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const userId = interaction.user.id;
  const username = interaction.user.username;

  if (interaction.commandName === 'chat') {
    const userMsg = interaction.options.getString('message');
    await interaction.deferReply();
    try {
      const groqKey = process.env.GROQ_API_KEY;
      if (!groqKey) return interaction.editReply('⚠️ GROQ_API_KEY not configured.');
      const ctx = interaction.guild
        ? { guildName: interaction.guild.name, channelName: interaction.channel?.name }
        : { isDM: true };
      const msgs = buildMessages(KIARA_BOT_ID, global.kiaraConfig.personality, userId, userMsg, ctx, 'professional');
      let reply;
      try { reply = await callAI('groq', groqKey, msgs, 0.85, 'llama-3.1-8b-instant'); }
      catch { reply = await callAI('cerebras', process.env.CEREBRAS_API_KEY || groqKey, msgs, 0.85, 'llama3.1-8b'); }
      addToHistory(KIARA_BOT_ID, userId, 'user', userMsg);
      addToHistory(KIARA_BOT_ID, userId, 'assistant', reply);
      extractFacts(KIARA_BOT_ID, userId, userMsg);
      saveData();
      await interaction.editReply(reply.slice(0, 2000));
    } catch(e) { await interaction.editReply(`⚠️ ${e.message.slice(0, 200)}`); }

  } else if (interaction.commandName === 'imagine') {
    const prompt = interaction.options.getString('prompt');
    await interaction.deferReply();
    try {
      const imgUrl = await generateImage(prompt);
      addToHistory(KIARA_BOT_ID, userId, 'user', `/imagine ${prompt}`);
      addToHistory(KIARA_BOT_ID, userId, 'assistant', `[Generated image: ${prompt}]`);
      saveData();
      await interaction.editReply({ embeds: [{ title: '🎨 Here you go!', image: { url: imgUrl }, color: 0x5865f2 }] });
    } catch(e) { await interaction.editReply(`⚠️ Could not generate image: ${e.message.slice(0, 100)}`); }

  } else if (interaction.commandName === 'memory') {
    const mem = userMemory.get(memKey(KIARA_BOT_ID, userId));
    if (!mem || (!mem.facts.length && !mem.history.length)) {
      return interaction.reply({ content: "I don't remember anything about you yet.", ephemeral: true });
    }
    const factsText = mem.facts.length ? `**Facts I know about you:**\n${mem.facts.map(f => `• ${f}`).join('\n')}` : '';
    const histText = `**Conversation history:** ${mem.history.length} messages stored`;
    await interaction.reply({ content: [factsText, histText].filter(Boolean).join('\n\n'), ephemeral: true });

  } else if (interaction.commandName === 'forget') {
    userMemory.delete(memKey(KIARA_BOT_ID, userId));
    saveData();
    await interaction.reply({ content: '✅ Done — cleared everything I remembered about you.', ephemeral: true });

  } else if (interaction.commandName === 'yap') {
    if (!interaction.channel) return interaction.reply({ content: '⚠️ Cannot yap here.', ephemeral: true });
    global.kiaraConfig.yapChannels = global.kiaraConfig.yapChannels || new Map();
    if (global.kiaraConfig.yapChannels.has(interaction.channel.id)) {
      return interaction.reply({ content: 'Already yapping in this channel! Use /unyap to stop.', ephemeral: true });
    }
    const interval = setInterval(async () => {
      try {
        const groqKey = process.env.GROQ_API_KEY;
        if (!groqKey) return;
        const yapPrompts = ['What\'s everyone thinking about?','Thoughts?','Anyone want to chat?','I\'m bored, talk to me 👀','What\'s good everyone?','Say something interesting!'];
        const prompt = yapPrompts[Math.floor(Math.random() * yapPrompts.length)];
        const msgs = [{ role: 'system', content: global.kiaraConfig.personality }, { role: 'user', content: prompt }];
        const reply = await callAI('groq', groqKey, msgs, 0.9, 'llama-3.1-8b-instant');
        const ch = await kiaraBot.channels.fetch(interaction.channel.id);
        await ch.send(reply.slice(0, 1900));
      } catch(e) { console.error('Yap error:', e.message); }
    }, 15000 + Math.random() * 15000); // 15-30 seconds between messages
    global.kiaraConfig.yapChannels.set(interaction.channel.id, interval);
    await interaction.reply(`✅ Yapping mode ON in <#${interaction.channel.id}>! Use /unyap to stop.`);

  } else if (interaction.commandName === 'unyap') {
    global.kiaraConfig.yapChannels = global.kiaraConfig.yapChannels || new Map();
    const interval = global.kiaraConfig.yapChannels.get(interaction.channel?.id);
    if (!interval) return interaction.reply({ content: 'Not yapping in this channel.', ephemeral: true });
    clearInterval(interval);
    global.kiaraConfig.yapChannels.delete(interaction.channel.id);
    await interaction.reply('✅ Yapping stopped.');
  }
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Kii Akira backend → http://0.0.0.0:${PORT}`);
  console.log(`   Owner: ${OWNER_USERNAME} (developer + VIP always)\n`);
  if (userBotConfigs.size > 0) {
    console.log(`🔄 Restoring ${userBotConfigs.size} user bot(s)...`);
    for (const [botId, cfg] of userBotConfigs.entries()) {
      spawnUserBot(botId, cfg).catch(e => {
        console.warn(`⚠️ Could not restore bot "${cfg.name}": ${e.message}`);
        userBotConfigs.delete(botId);
        saveData();
      });
    }
  }
});
