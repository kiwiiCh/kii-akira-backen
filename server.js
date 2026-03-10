// ═══════════════════════════════════════════════════════════
//  Kii Akira — Discord OAuth Backend  (Node.js / Express)
//  Run:  node server.js
//  Needs: npm install express axios cors dotenv express-session
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
  DISCORD_REDIRECT_URI,   // e.g. http://localhost:3000/auth/callback
  SESSION_SECRET,
  FRONTEND_URL,           // e.g. http://localhost:3000  or your domain
} = process.env;

// ── Middleware ──────────────────────────────────────────────
app.use(cors({
  origin: FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // true in prod (HTTPS)
    httpOnly: true,
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
//  Start server
// ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Kii Akira backend running → http://0.0.0.0:${PORT}`);
  console.log(`   Discord OAuth:  http://0.0.0.0:${PORT}/auth/discord`);
  console.log(`   Callback URL:   ${DISCORD_REDIRECT_URI}`);
  console.log(`   Auth check:     http://0.0.0.0:${PORT}/auth/me\n`);
});
