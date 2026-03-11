// ═══════════════════════════════════════════════════════════
//  Kii Akira — Discord OAuth Backend  (Node.js / Express)
//  Run:  node server.js
//  Needs: npm install express axios cors dotenv express-session discord.js
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const cors       = require('cors');
const session    = require('express-session');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config (loaded from .env) ──────────────────────────────
const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_BOT_TOKEN,
  SESSION_SECRET,
  FRONTEND_URL,
} = process.env;

// ── Start Discord bot ───────────────────────────────────────
const { Client: DJSClientKiara, GatewayIntentBits: GWI, Events: DJSEvents } = require('discord.js');

global.kiaraConfig = global.kiaraConfig || {
  activeChannels: new Set(),
  personality: 'You are Kiara KiI, a friendly and helpful AI assistant. Keep responses short and conversational.',
};

const kiaraBot = new DJSClientKiara({
  intents: [GWI.Guilds, GWI.GuildMessages, GWI.MessageContent],
});

kiaraBot.once(DJSEvents.ClientReady, c => {
  console.log(`🤖 Kiara KiI online as ${c.user.tag}`);
  c.user.setPresence({ status: 'online', activities: [{ name: 'Kii Akira Dashboard', type: 0 }] });
});

kiaraBot.on(DJSEvents.MessageCreate, async message => {
  if (message.author.bot) return;
  const mentioned = message.mentions.has(kiaraBot.user);
  const inActive = global.kiaraConfig.activeChannels.has(message.channel.id);
  if (!mentioned && !inActive) return;
  if (!mentioned && message.content.trim().length < 2) return;
  try {
    await message.channel.sendTyping();
    const userMsg = message.content.replace(`<@${kiaraBot.user.id}>`, '').trim();
    if (!userMsg) return message.reply('Hey! How can I help? 👋');
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return message.reply('No AI key configured yet!');
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama3-8b-8192',
      messages: [{ role: 'system', content: global.kiaraConfig.personality }, { role: 'user', content: userMsg }],
      max_tokens: 300, temperature: 0.7,
    }, { headers: { Authorization: `Bearer ${groqKey}` } });
    const reply = r.data.choices[0]?.message?.content || 'I couldn\'t think of a response!';
    await message.reply(reply.slice(0, 1900));
  } catch (e) {
    console.error('Kiara bot error:', e.message);
    await message.reply('Sorry, having trouble right now!');
  }
});

if (DISCORD_BOT_TOKEN) {
  kiaraBot.login(DISCORD_BOT_TOKEN).catch(e => console.warn('Kiara bot login failed:', e.message));
} else {
  console.warn('⚠️  DISCORD_BOT_TOKEN not set — Kiara bot offline');
}

// ── Middleware ──────────────────────────────────────────────
app.use(cors({
  origin: true, // allow all origins
  credentials: true,
}));
app.set('trust proxy', 1); // trust Railway's proxy
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// Serve the dashboard HTML from /public folder
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
//  STEP 1 — Redirect user to Discord's OAuth page
//  Frontend hits: GET /auth/discord
// ─────────────────────────────────────────────────────────────
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify email',
    prompt:        'consent',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ─────────────────────────────────────────────────────────────
//  STEP 2 — Discord redirects back here with a "code"
//  Discord hits: GET /auth/callback?code=XXXX
// ─────────────────────────────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    // Exchange the code for an access token
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  DISCORD_REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, token_type } = tokenRes.data;

    // Use the token to fetch the user's Discord profile
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `${token_type} ${access_token}` },
    });

    const discordUser = userRes.data;
    // discordUser = { id, username, discriminator, email, avatar, ... }

    // Save to session
    req.session.user = {
      discordId:  discordUser.id,
      username:   discordUser.username,
      email:      discordUser.email,
      avatar:     discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : null,
      loggedIn:   true,
    };

    // Redirect back to the dashboard (it will call /auth/me to get the user)
    res.redirect(`${FRONTEND_URL || '/'}?discord_login=success`);

  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ─────────────────────────────────────────────────────────────
//  STEP 3 — Frontend polls this to check if logged in
//  Frontend hits: GET /auth/me
// ─────────────────────────────────────────────────────────────
app.get('/auth/me', (req, res) => {
  if (req.session?.user?.loggedIn) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// ─────────────────────────────────────────────────────────────
//  STEP 4 — Log out
//  Frontend hits: POST /auth/logout
// ─────────────────────────────────────────────────────────────
app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// ─────────────────────────────────────────────────────────────
//  OPTIONAL — Send verification email code
//  Frontend hits: POST /auth/send-code  { email: "x@y.com" }
//  Requires: npm install nodemailer
// ─────────────────────────────────────────────────────────────
const nodemailerAvailable = (() => {
  try { require.resolve('nodemailer'); return true; } catch { return false; }
})();

const pendingCodes = new Map(); // email → { code, expiresAt }

app.post('/auth/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  pendingCodes.set(email, { code, expiresAt: Date.now() + 10 * 60 * 1000 }); // 10 min TTL

  if (!nodemailerAvailable || !process.env.SMTP_USER) {
    // No mail server configured — return code directly (for development)
    console.log(`[DEV] Verification code for ${email}: ${code}`);
    return res.json({ success: true, dev_code: code, note: 'Mail not configured — code returned in response for dev.' });
  }

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST || 'smtp.gmail.com',
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from:    `"Kii Akira" <${process.env.SMTP_USER}>`,
      to:      email,
      subject: 'Your Kii Akira verification code',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0b0c10;color:#e3e5e8;border-radius:12px;padding:32px;">
          <h2 style="color:#fff;margin-bottom:8px;">Your verification code</h2>
          <p style="color:#80848e;">Use this code to log in to Kii Akira Dashboard.</p>
          <div style="background:#17191f;border:1px solid #2a2d36;border-radius:8px;padding:20px 28px;text-align:center;margin:24px 0;">
            <span style="font-size:2rem;font-weight:800;letter-spacing:.25em;font-family:monospace;color:#5865f2;">${code}</span>
          </div>
          <p style="color:#4e5058;font-size:13px;">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
        </div>
      `,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Mail error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// Frontend hits: POST /auth/verify-code  { email, code }
app.post('/auth/verify-code', (req, res) => {
  const { email, code } = req.body;
  const entry = pendingCodes.get(email);
  if (!entry) return res.status(400).json({ error: 'No code sent to this email' });
  if (Date.now() > entry.expiresAt) { pendingCodes.delete(email); return res.status(400).json({ error: 'Code expired' }); }
  if (entry.code !== code) return res.status(400).json({ error: 'Incorrect code' });
  pendingCodes.delete(email);
  req.session.verifiedEmail = email;
  res.json({ success: true, verifiedEmail: email });
});

// ─────────────────────────────────────────────────────────────
//  USER BOT SYSTEM — Each user deploys their own bot
// ─────────────────────────────────────────────────────────────
const { Client: DJSClient, GatewayIntentBits, Events } = require('discord.js');

// Store active user bot instances: botId → { client, config }
const userBotInstances = new Map();

// Create + start a user's bot
app.post('/user-bots/create', async (req, res) => {
  const { name, token, provider, model, apiKey, systemPrompt, temperature, ownerId } = req.body;
  if (!name || !token || !apiKey) return res.status(400).json({ error: 'name, token and apiKey required' });

  // First validate the token by logging in
  const testClient = new DJSClient({ intents: [GatewayIntentBits.Guilds] });
  try {
    await testClient.login(token);
    const botId = testClient.user.id;
    const botTag = testClient.user.tag;
    testClient.destroy();

    // Stop existing instance if any
    if (userBotInstances.has(botId)) {
      userBotInstances.get(botId).client.destroy();
    }

    // Start full bot instance
    const botClient = new DJSClient({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    botClient.once(Events.ClientReady, c => {
      console.log(`🤖 User bot online: ${c.user.tag} (owner: ${ownerId})`);
      c.user.setPresence({ status: 'online', activities: [{ name: name, type: 0 }] });
    });

    botClient.on(Events.MessageCreate, async message => {
      if (message.author.bot) return;
      const mentioned = message.mentions.has(botClient.user);
      if (!mentioned) return;
      try {
        await message.channel.sendTyping();
        const userMsg = message.content.replace(`<@${botClient.user.id}>`, '').trim();
        if (!userMsg) return message.reply(`Hey! I'm ${name}. How can I help? 👋`);

        const aiRes = await callAI(provider, apiKey, systemPrompt, userMsg, temperature, model);
        await message.reply(aiRes.slice(0, 1900));
      } catch (e) {
        await message.reply('Sorry, I\'m having trouble right now!');
      }
    });

    await botClient.login(token);
    userBotInstances.set(botId, { client: botClient, config: { name, provider, apiKey, systemPrompt, temperature, ownerId } });

    const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${botId}&permissions=277025459200&scope=bot`;
    res.json({ success: true, botId, botTag, inviteUrl });

  } catch (err) {
    console.error('User bot error:', err.message);
    res.status(400).json({ error: 'Invalid bot token — please check and try again' });
  }
});

// Get user's bots
app.get('/user-bots', (req, res) => {
  const ownerId = req.query.ownerId;
  const bots = [];
  for (const [botId, { client, config }] of userBotInstances) {
    if (!ownerId || config.ownerId === ownerId) {
      bots.push({ botId, name: config.name, tag: client.user?.tag, online: client.isReady(), provider: config.provider });
    }
  }
  res.json({ bots });
});

// Stop a user's bot
app.delete('/user-bots/:botId', (req, res) => {
  const { botId } = req.params;
  if (userBotInstances.has(botId)) {
    userBotInstances.get(botId).client.destroy();
    userBotInstances.delete(botId);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Bot not found' });
  }
});

// AI call helper
async function callAI(provider, apiKey, systemPrompt, userMsg, temperature, model) {
  if (provider === 'groq') {
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: model || 'llama3-8b-8192',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
      max_tokens: 300, temperature,
    }, { headers: { Authorization: `Bearer ${apiKey}` } });
    return r.data.choices[0].message.content;
  }
  if (provider === 'cerebras') {
    const r = await axios.post('https://api.cerebras.ai/v1/chat/completions', {
      model: model || 'llama3.1-8b',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
      max_tokens: 300, temperature,
    }, { headers: { Authorization: `Bearer ${apiKey}` } });
    return r.data.choices[0].message.content;
  }
  if (provider === 'openai') {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: model || 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
      max_tokens: 300, temperature,
    }, { headers: { Authorization: `Bearer ${apiKey}` } });
    return r.data.choices[0].message.content;
  }
  return 'Unknown AI provider.';
}

// ─────────────────────────────────────────────────────────────
//  BOT API — Get list of channels in the guild
//  GET /bot/channels?guild_id=xxx
// ─────────────────────────────────────────────────────────────
app.get('/bot/channels', async (req, res) => {
  try {
    const guild = kiaraBot.guilds.cache.first();
    if (!guild) return res.json({ channels: [] });
    const channels = guild.channels.cache
      .filter(c => c.type === 0) // text channels only
      .map(c => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ channels });
  } catch (err) {
    res.json({ channels: [] });
  }
});

// GET /bot/status — returns bot online status + active channels
app.get('/bot/status', (req, res) => {
  const config = global.kiaraConfig || { activeChannels: new Set() };
  res.json({
    online: kiaraBot?.isReady() || false,
    tag: kiaraBot?.user?.tag || null,
    activeChannels: [...config.activeChannels],
    personality: config.personality,
  });
});

// POST /bot/channels — set which channels the bot talks in
app.post('/bot/channels', (req, res) => {
  const { channelIds } = req.body; // array of channel IDs
  if (!Array.isArray(channelIds)) return res.status(400).json({ error: 'channelIds must be array' });
  if (!global.kiaraConfig) global.kiaraConfig = { activeChannels: new Set() };
  global.kiaraConfig.activeChannels = new Set(channelIds);
  console.log('Bot active channels updated:', channelIds);
  res.json({ success: true, activeChannels: channelIds });
});

// POST /bot/personality — update bot personality/system prompt
app.post('/bot/personality', (req, res) => {
  const { personality } = req.body;
  if (!personality) return res.status(400).json({ error: 'personality required' });
  if (!global.kiaraConfig) global.kiaraConfig = { activeChannels: new Set() };
  global.kiaraConfig.personality = personality;
  res.json({ success: true });
});

// POST /bot/say — send a message as the bot to a channel
app.post('/bot/say', async (req, res) => {
  const { channelId, message } = req.body;
  if (!channelId || !message) return res.status(400).json({ error: 'channelId and message required' });
  try {
    const channel = await kiaraBot.channels.fetch(channelId);
    await channel.send(message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  Start server
// ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Kii Akira backend running → http://0.0.0.0:${PORT}`);
  console.log(`   Discord OAuth:  http://0.0.0.0:${PORT}/auth/discord`);
  console.log(`   Callback URL:   ${DISCORD_REDIRECT_URI}`);
  console.log(`   Auth check:     http://0.0.0.0:${PORT}/auth/me\n`);
});
