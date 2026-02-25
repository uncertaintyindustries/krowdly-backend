/**
 * KROWDLY BACKEND — Vercel-compatible REST API
 *
 * Socket.io removed entirely. Real-time (chat, live events, online presence,
 * typing indicators) is handled by Supabase Realtime on the frontend —
 * a direct WebSocket to Supabase's servers. No persistent process needed.
 *
 * Every route here is a stateless HTTP handler → works perfectly on Vercel.
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors   = require('cors');
const crypto = require('crypto'); // built-in Node.js, no install needed
require('dotenv').config();

const app = express();

// ─── Supabase (service role — bypasses RLS, full DB access) ───
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '10mb' })); // 10 MB covers base64 event cover images

// ─────────────────────────────────────────
//  HELPER
// ─────────────────────────────────────────
function hashPassword(pw) {
  const salt = process.env.PASSWORD_SALT || 'krowdly_salt_2026';
  return crypto.createHash('sha256').update(pw + salt).digest('hex');
}

// ─────────────────────────────────────────
//  HEALTH
// ─────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'Krowdly backend is live 🚀', realtime: 'Supabase Realtime' });
});

// ─────────────────────────────────────────
//  AUTH — SIGN UP
// ─────────────────────────────────────────
app.post('/api/users', async (req, res) => {
  const { username, email, password, avatar } = req.body;

  if (!username)                        return res.status(400).json({ error: 'Username required' });
  if (!email)                           return res.status(400).json({ error: 'Email required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const { data: byEmail } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  if (byEmail) return res.status(409).json({ error: 'Email already registered. Please sign in.' });

  const { data: byName } = await supabase.from('users').select('id').ilike('username', username).maybeSingle();
  if (byName) return res.status(409).json({ error: 'Username already taken. Try another one.' });

  const avatarUrl = avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;

  const { data, error } = await supabase
    .from('users')
    .insert([{ username, email, password_hash: hashPassword(password), avatar: avatarUrl, online: true }])
    .select('id, username, email, avatar, online, bio, profile_color, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
  // Supabase Realtime broadcasts the users INSERT to all subscribers automatically
});

// ─────────────────────────────────────────
//  AUTH — SIGN IN
// ─────────────────────────────────────────
app.post('/api/auth/signin', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data: user, error } = await supabase
    .from('users')
    .select('id, username, email, avatar, online, bio, profile_color, created_at')
    .eq('email', email)
    .eq('password_hash', hashPassword(password))
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!user)  return res.status(401).json({ error: 'Invalid email or password' });

  // Mark online — Supabase Realtime broadcasts the UPDATE to all subscribers
  await supabase.from('users').update({ online: true }).eq('id', user.id);
  res.json({ ...user, online: true });
});

// ─────────────────────────────────────────
//  AUTH — SIGN OUT
// ─────────────────────────────────────────
app.post('/api/auth/signout', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  // Mark offline — Supabase Realtime broadcasts the UPDATE automatically
  await supabase.from('users').update({ online: false }).eq('id', userId);
  res.json({ success: true });
});

// ─────────────────────────────────────────
//  USERS — LIST
// ─────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, username, avatar, online, bio, profile_color, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─────────────────────────────────────────
//  USERS — UPDATE PROFILE
// ─────────────────────────────────────────
app.patch('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { username, avatar, bio, profile_color } = req.body;

  const updates = {};
  if (username      !== undefined) updates.username      = username;
  if (avatar        !== undefined) updates.avatar        = avatar;
  if (bio           !== undefined) updates.bio           = bio;
  if (profile_color !== undefined) updates.profile_color = profile_color;

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  const { data, error } = await supabase
    .from('users').update(updates).eq('id', id)
    .select('id, username, avatar, online, bio, profile_color, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─────────────────────────────────────────
//  EVENTS — LIST
// ─────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  const { data, error } = await supabase
    .from('events').select('*').order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─────────────────────────────────────────
//  EVENTS — CREATE
// ─────────────────────────────────────────
app.post('/api/events', async (req, res) => {
  const {
    name, location, category, category_color, host, host_avatar, privacy, lat, lng,
    description, date, time, max_attendees, tags, image, created_by
  } = req.body;

  if (!name || !location || !category || !host)
    return res.status(400).json({ error: 'name, location, category and host are required' });

  const { data, error } = await supabase
    .from('events')
    .insert([{
      name, location, category,
      category_color: category_color || '#a855f7',
      host,
      host_avatar:   host_avatar   || null,
      privacy:       privacy       || 'public',
      lat:           lat           || 0,
      lng:           lng           || 0,
      rsvps:         [],
      description:   description   || null,
      date:          date          || null,
      time:          time          || null,
      max_attendees: max_attendees ? parseInt(max_attendees) : null,
      tags:          tags          || [],
      image:         image         || null,
      created_by:    created_by    || null
    }])
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  // Supabase Realtime broadcasts the INSERT automatically
  res.json(data);
});

// ─────────────────────────────────────────
//  EVENTS — DELETE
// ─────────────────────────────────────────
app.delete('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('events').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  // Supabase Realtime broadcasts the DELETE automatically
  res.json({ success: true });
});

// ─────────────────────────────────────────
//  EVENTS — RSVP TOGGLE
// ─────────────────────────────────────────
app.post('/api/events/:id/rsvp', async (req, res) => {
  const { id } = req.params;
  const { userId, username } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const { data: ev, error: fetchErr } = await supabase
    .from('events').select('*').eq('id', id).single();
  if (fetchErr || !ev) return res.status(404).json({ error: 'Event not found' });

  let rsvps = ev.rsvps || [];
  const already = rsvps.find(r => r.userId === userId);
  rsvps = already
    ? rsvps.filter(r => r.userId !== userId)
    : [...rsvps, { userId, username }];

  const { data, error } = await supabase
    .from('events').update({ rsvps }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  // Supabase Realtime broadcasts the UPDATE automatically
  res.json(data);
});

// ─────────────────────────────────────────
//  MESSAGES — HISTORY
// ─────────────────────────────────────────
app.get('/api/messages/:userId/:otherId', async (req, res) => {
  const { userId, otherId } = req.params;

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .or(`and(from_user.eq.${userId},to_user.eq.${otherId}),and(from_user.eq.${otherId},to_user.eq.${userId})`)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─────────────────────────────────────────
//  MESSAGES — SEND
//  REST endpoint persists the message to Supabase.
//  Supabase Realtime then pushes the INSERT to both users' browser subscriptions.
// ─────────────────────────────────────────
app.post('/api/messages', async (req, res) => {
  const { from_user, to_user, message } = req.body;
  if (!from_user || !to_user || !message)
    return res.status(400).json({ error: 'from_user, to_user and message are required' });

  const { data, error } = await supabase
    .from('messages')
    .insert([{ from_user, to_user, message }])
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  // Supabase Realtime broadcasts the INSERT to both users automatically
  res.json(data);
});

// ─────────────────────────────────────────
//  EXPORT — required for Vercel
//  Vercel imports this file as a module, it does NOT call server.listen()
// ─────────────────────────────────────────
module.exports = app;

// Local dev only: when you run `node server.js` directly
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Krowdly running locally on port ${PORT} 🚀`));
}
