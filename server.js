const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// NOTE: No dotenv — Vercel injects env vars directly. dotenv is only for local dev.
// To use locally: create a .env file OR set vars in your terminal before running.

const app = express();

// ── CORS: allow all origins ──────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '10mb' }));

// ── Helpers ──────────────────────────────────────────────────────────────────
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function hashPassword(pw) {
  const salt = process.env.PASSWORD_SALT || 'krowdly_salt_2026';
  return crypto.createHash('sha256').update(pw + salt).digest('hex');
}

function dbError(res) {
  return res.status(500).json({
    error: 'Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel environment variables.',
    steps: [
      '1. Go to vercel.com → your project → Settings → Environment Variables',
      '2. Add SUPABASE_URL = your supabase project url (https://xxx.supabase.co)',
      '3. Add SUPABASE_SERVICE_KEY = your service_role key from supabase dashboard',
      '4. Add PASSWORD_SALT = any random string',
      '5. Click Redeploy'
    ]
  });
}

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const missing = [];
  if (!url) missing.push('SUPABASE_URL');
  if (!key) missing.push('SUPABASE_SERVICE_KEY');

  if (missing.length > 0) {
    return res.status(500).json({
      status: 'Backend running but NOT configured',
      missing_env_vars: missing,
      fix: 'Add missing vars in Vercel → Project → Settings → Environment Variables → Redeploy'
    });
  }
  res.json({ status: 'Krowdly backend is live', db: 'connected' });
});

// ── SIGN UP ───────────────────────────────────────────────────────────────────
app.post('/api/users', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { username, email, password, avatar } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (!email)    return res.status(400).json({ error: 'Email required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const { data: byEmail } = await sb.from('users').select('id').eq('email', email).maybeSingle();
  if (byEmail) return res.status(409).json({ error: 'Email already registered. Please sign in.' });

  const { data: byName } = await sb.from('users').select('id').ilike('username', username).maybeSingle();
  if (byName) return res.status(409).json({ error: 'Username already taken. Try another one.' });

  const avatarUrl = avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;

  const { data, error } = await sb
    .from('users')
    .insert([{ username, email, password_hash: hashPassword(password), avatar: avatarUrl, online: true }])
    .select('id, username, email, avatar, online, bio, profile_color, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── SIGN IN ───────────────────────────────────────────────────────────────────
app.post('/api/auth/signin', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data: user, error } = await sb
    .from('users')
    .select('id, username, email, avatar, online, bio, profile_color, created_at')
    .eq('email', email)
    .eq('password_hash', hashPassword(password))
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!user)  return res.status(401).json({ error: 'Invalid email or password' });

  await sb.from('users').update({ online: true }).eq('id', user.id);
  res.json({ ...user, online: true });
});

// ── SIGN OUT ──────────────────────────────────────────────────────────────────
app.post('/api/auth/signout', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  await sb.from('users').update({ online: false }).eq('id', userId);
  res.json({ success: true });
});

// ── GET USERS ─────────────────────────────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { data, error } = await sb
    .from('users')
    .select('id, username, avatar, online, bio, profile_color, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── UPDATE USER ───────────────────────────────────────────────────────────────
app.patch('/api/users/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { id } = req.params;
  const { username, avatar, bio, profile_color } = req.body;
  const updates = {};
  if (username      !== undefined) updates.username      = username;
  if (avatar        !== undefined) updates.avatar        = avatar;
  if (bio           !== undefined) updates.bio           = bio;
  if (profile_color !== undefined) updates.profile_color = profile_color;
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
  const { data, error } = await sb.from('users').update(updates).eq('id', id)
    .select('id, username, avatar, online, bio, profile_color, created_at').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET EVENTS ────────────────────────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { data, error } = await sb.from('events').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── CREATE EVENT ──────────────────────────────────────────────────────────────
app.post('/api/events', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { name, location, category, category_color, host, host_avatar, privacy, lat, lng,
          description, date, time, max_attendees, tags, image, created_by } = req.body;
  if (!name || !location || !category || !host)
    return res.status(400).json({ error: 'name, location, category and host are required' });
  const { data, error } = await sb.from('events').insert([{
    name, location, category,
    category_color: category_color || '#a855f7',
    host, host_avatar: host_avatar || null,
    privacy: privacy || 'public',
    lat: lat || 0, lng: lng || 0, rsvps: [],
    description: description || null,
    date: date || null, time: time || null,
    max_attendees: max_attendees ? parseInt(max_attendees) : null,
    tags: tags || [], image: image || null,
    created_by: created_by || null
  }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE EVENT ──────────────────────────────────────────────────────────────
app.delete('/api/events/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { error } = await sb.from('events').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── RSVP ──────────────────────────────────────────────────────────────────────
app.post('/api/events/:id/rsvp', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { id } = req.params;
  const { userId, username } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const { data: ev, error: fetchErr } = await sb.from('events').select('*').eq('id', id).single();
  if (fetchErr || !ev) return res.status(404).json({ error: 'Event not found' });
  let rsvps = ev.rsvps || [];
  const already = rsvps.find(r => r.userId === userId);
  rsvps = already ? rsvps.filter(r => r.userId !== userId) : [...rsvps, { userId, username }];
  const { data, error } = await sb.from('events').update({ rsvps }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── MESSAGE HISTORY ───────────────────────────────────────────────────────────
app.get('/api/messages/:userId/:otherId', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { userId, otherId } = req.params;
  const { data, error } = await sb.from('messages').select('*')
    .or(`and(from_user.eq.${userId},to_user.eq.${otherId}),and(from_user.eq.${otherId},to_user.eq.${userId})`)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── SEND MESSAGE ──────────────────────────────────────────────────────────────
app.post('/api/messages', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { from_user, to_user, message } = req.body;
  if (!from_user || !to_user || !message)
    return res.status(400).json({ error: 'from_user, to_user and message are required' });
  const { data, error } = await sb.from('messages')
    .insert([{ from_user, to_user, message }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── EXPORT for Vercel ─────────────────────────────────────────────────────────
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Krowdly running on port ${PORT}`));
}
