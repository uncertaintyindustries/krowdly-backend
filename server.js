
// ─────────────────────────────────────────────────────────────────
// SUPABASE SQL SCHEMA — run once in SQL Editor
// ─────────────────────────────────────────────────────────────────
/*
-- Communities
CREATE TABLE IF NOT EXISTS public.communities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  creator_id  UUID REFERENCES public.users(id) ON DELETE SET NULL,
  type        TEXT NOT NULL DEFAULT 'public' CHECK (type IN ('public','private','paid')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.community_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  community_id UUID REFERENCES public.communities(id) ON DELETE CASCADE NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, community_id)
);

-- Threads
CREATE TABLE IF NOT EXISTS public.threads (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id   UUID REFERENCES public.communities(id) ON DELETE CASCADE NOT NULL,
  user_id        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  content        TEXT,
  type           TEXT NOT NULL DEFAULT 'discussion'
                   CHECK (type IN ('discussion','debate','poll','media','anon')),
  visibility     TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','members')),
  is_live        BOOLEAN DEFAULT FALSE,
  pinned_reply_id UUID,
  poll_a         TEXT,
  poll_b         TEXT,
  votes_a        INT DEFAULT 0,
  votes_b        INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Replies
CREATE TABLE IF NOT EXISTS public.replies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id      UUID REFERENCES public.threads(id) ON DELETE CASCADE NOT NULL,
  user_id        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  content        TEXT NOT NULL,
  media_url      TEXT,
  voice_note_url TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Likes (threads + replies)
CREATE TABLE IF NOT EXISTS public.likes (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  thread_id UUID REFERENCES public.threads(id) ON DELETE CASCADE,
  reply_id  UUID REFERENCES public.replies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, thread_id),
  UNIQUE (user_id, reply_id)
);

-- Enable Row Level Security
ALTER TABLE public.communities       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.threads           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.replies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.likes             ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Anyone can read public communities" ON public.communities FOR SELECT USING (type = 'public');
CREATE POLICY "Auth users can create communities"  ON public.communities FOR INSERT WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Anyone can read threads"            ON public.threads     FOR SELECT USING (visibility = 'public');
CREATE POLICY "Auth users can post threads"        ON public.threads     FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Anyone can read replies"            ON public.replies     FOR SELECT USING (TRUE);
CREATE POLICY "Auth users can post replies"        ON public.replies     FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Auth users can like"                ON public.likes       FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can see likes"                ON public.likes       FOR SELECT USING (TRUE);
CREATE POLICY "Users can manage own likes"         ON public.likes       FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Anyone can join communities"        ON public.community_members FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Members can view"                   ON public.community_members FOR SELECT USING (TRUE);
CREATE POLICY "Members can leave"                  ON public.community_members FOR DELETE USING (auth.uid() = user_id);

-- Enable Realtime on forum tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.threads;
ALTER PUBLICATION supabase_realtime ADD TABLE public.replies;
ALTER PUBLICATION supabase_realtime ADD TABLE public.likes;
*/

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// NOTE: No dotenv — Vercel injects env vars directly.
// For local dev: npm install dotenv, then add require('dotenv').config() here.

const app = express();

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '10mb' }));

// ── Helpers ───────────────────────────────────────────────────────────────────
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
      '2. Add SUPABASE_URL  =  your Supabase project URL (https://xxx.supabase.co)',
      '3. Add SUPABASE_SERVICE_KEY  =  your service_role key (from Supabase dashboard)',
      '4. Add PASSWORD_SALT  =  any random string',
      '5. Click Redeploy',
    ],
  });
}

// Fire-and-forget notification helper — never blocks a response
function notify(sb, payload) {
  sb.from('notifications')
    .insert([payload])
    .then(() => {})
    .catch(() => {});
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const missing = [];
  if (!process.env.SUPABASE_URL)         missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (missing.length > 0) {
    return res.status(500).json({
      status: 'Backend running but NOT configured',
      missing_env_vars: missing,
      fix: 'Add missing vars in Vercel → Project → Settings → Environment Variables → Redeploy',
    });
  }
  res.json({ status: 'Krowdly backend is live', db: 'connected' });
});

// ── PWA MANIFEST ──────────────────────────────────────────────────────────────
// Served as a static route so the PWA install works when hosted on Vercel.
// The frontend also generates a blob manifest as fallback for direct file opens.
app.get('/manifest.json', (req, res) => {
  const ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 110 110">' +
    '<rect width="110" height="110" rx="24" fill="#1a0b2e"/>' +
    '<ellipse cx="40" cy="28" rx="15" ry="24" transform="rotate(-35 40 28)" fill="#ff2d95"/>' +
    '<ellipse cx="68" cy="22" rx="15" ry="24" transform="rotate(25 68 22)" fill="#f97316"/>' +
    '<ellipse cx="20" cy="58" rx="15" ry="24" transform="rotate(-65 20 58)" fill="#fbbf24"/>' +
    '<ellipse cx="36" cy="80" rx="15" ry="24" transform="rotate(-15 36 80)" fill="#10b981"/>' +
    '<ellipse cx="64" cy="86" rx="15" ry="24" transform="rotate(20 64 86)" fill="#06b6d4"/>' +
    '<ellipse cx="90" cy="58" rx="15" ry="24" transform="rotate(65 90 58)" fill="#3b82f6"/>' +
    '<ellipse cx="76" cy="32" rx="14" ry="22" transform="rotate(10 76 32)" fill="#a855f7"/>' +
    '<ellipse cx="52" cy="50" rx="12" ry="18" fill="rgba(230,180,255,0.7)"/>' +
    '</svg>';
  const iconSrc = 'data:image/svg+xml,' + encodeURIComponent(ICON_SVG);

  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: 'Krowdly — Where Your Squad Hangs',
    short_name: 'Krowdly',
    description: 'Discover events, connect with your squad, and never miss a vibe.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#1a0b2e',
    theme_color: '#ff2d95',
    categories: ['social', 'entertainment', 'lifestyle'],
    icons: [
      { src: iconSrc, sizes: '192x192', type: 'image/svg+xml', purpose: 'any maskable' },
      { src: iconSrc, sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
    ],
    shortcuts: [
      { name: 'Discover Events', short_name: 'Discover', url: '/?view=discover' },
      { name: 'Host an Event',   short_name: 'Host',     url: '/?view=create'   },
    ],
  });
});

// ── SIGN UP ───────────────────────────────────────────────────────────────────
app.post('/api/users', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { username, email, password, avatar } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (!email)    return res.status(400).json({ error: 'Email required' });
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const { data: byEmail } = await sb
    .from('users').select('id').eq('email', email).maybeSingle();
  if (byEmail)
    return res.status(409).json({ error: 'Email already registered. Please sign in.' });

  const { data: byName } = await sb
    .from('users').select('id').ilike('username', username).maybeSingle();
  if (byName)
    return res.status(409).json({ error: 'Username already taken. Try another one.' });

  const avatarUrl =
    avatar ||
    `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;
  const now = new Date().toISOString();

  const { data, error } = await sb
    .from('users')
    .insert([{
      username, email,
      password_hash: hashPassword(password),
      avatar: avatarUrl,
      online: true,
      last_seen: now,
    }])
    .select('id, username, email, avatar, online, bio, profile_color, last_seen, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── SIGN IN ───────────────────────────────────────────────────────────────────
app.post('/api/auth/signin', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const { data: user, error } = await sb
    .from('users')
    .select('id, username, email, avatar, online, bio, profile_color, last_seen, created_at')
    .eq('email', email)
    .eq('password_hash', hashPassword(password))
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!user)  return res.status(401).json({ error: 'Invalid email or password' });

  const now = new Date().toISOString();
  await sb.from('users').update({ online: true, last_seen: now }).eq('id', user.id);
  res.json({ ...user, online: true, last_seen: now });
});

// ── SIGN OUT ──────────────────────────────────────────────────────────────────
app.post('/api/auth/signout', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  await sb
    .from('users')
    .update({ online: false, last_seen: new Date().toISOString() })
    .eq('id', userId);
  res.json({ success: true });
});

// ── GET ALL USERS ─────────────────────────────────────────────────────────────
// Supports ?q=... for server-side username/bio search (search dropdown fallback).
// Returns last_seen so the frontend presence-poll can compute online status.
app.get('/api/users', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { q } = req.query;
  let query = sb
    .from('users')
    .select('id, username, avatar, online, bio, profile_color, last_seen, created_at')
    .order('created_at', { ascending: false });

  if (q && q.trim()) {
    query = query.or(`username.ilike.%${q.trim()}%,bio.ilike.%${q.trim()}%`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── GET SINGLE USER ───────────────────────────────────────────────────────────
// Used by the profile modal (search result click).
// Includes event_count so the modal can display it without a second request.
app.get('/api/users/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { data: user, error } = await sb
    .from('users')
    .select('id, username, avatar, online, bio, profile_color, last_seen, created_at')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!user)  return res.status(404).json({ error: 'User not found' });

  // Attach event count (non-critical, silently fails)
  let event_count = 0;
  try {
    const { count } = await sb
      .from('events')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', req.params.id);
    event_count = count || 0;
  } catch (_) {}

  res.json({ ...user, event_count });
});

// ── UPDATE USER ───────────────────────────────────────────────────────────────
// Accepts avatar, bio, profile_color, last_seen (presence heartbeat),
// username (name update), notif_pref and visibility (settings tab).
app.patch('/api/users/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { id } = req.params;
  const ALLOWED = [
    'username', 'avatar', 'bio', 'profile_color',
    'last_seen', 'notif_pref', 'visibility',
  ];
  const updates = {};
  ALLOWED.forEach(field => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });
  if (!Object.keys(updates).length)
    return res.status(400).json({ error: 'Nothing to update' });

  const { data, error } = await sb
    .from('users')
    .update(updates)
    .eq('id', id)
    .select('id, username, avatar, online, bio, profile_color, last_seen, notif_pref, visibility, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET EVENTS ────────────────────────────────────────────────────────────────
// Supports ?category= ?location= ?privacy= ?created_by= for filtering.
app.get('/api/events', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { category, location, privacy, created_by } = req.query;
  let query = sb.from('events').select('*').order('created_at', { ascending: false });

  if (category)   query = query.ilike('category', category);
  if (privacy)    query = query.eq('privacy', privacy);
  if (created_by) query = query.eq('created_by', created_by);
  if (location)   query = query.ilike('location', `%${location}%`);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── TRENDING EVENTS ───────────────────────────────────────────────────────────
// Must stay BEFORE /api/events/:id routes so 'trending' is never matched as an :id.
// Scores going=2, interested=1 per RSVP entry.
app.get('/api/events/trending', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { data, error } = await sb
    .from('events')
    .select('*')
    .eq('privacy', 'public')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });

  const sorted = (data || [])
    .map(ev => {
      const score = (ev.rsvps || []).reduce(
        (acc, r) => acc + (r.status === 'going' ? 2 : 1), 0
      );
      return { ...ev, _score: score };
    })
    .sort((a, b) => b._score - a._score)
    .slice(0, 10)
    .map(({ _score, ...ev }) => ev);

  res.json(sorted);
});

// ── CREATE EVENT ──────────────────────────────────────────────────────────────
app.post('/api/events', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const {
    name, location, category, category_color, host, host_avatar, privacy,
    lat, lng, description, date, time, max_attendees, tags, image, created_by,
  } = req.body;

  if (!name || !location || !category || !host)
    return res.status(400).json({ error: 'name, location, category and host are required' });

  const { data, error } = await sb
    .from('events')
    .insert([{
      name, location, category,
      category_color: category_color || '#a855f7',
      host,
      host_avatar: host_avatar || null,
      privacy: privacy || 'public',
      lat: lat || 0, lng: lng || 0,
      rsvps: [],
      description: description || null,
      date: date || null, time: time || null,
      max_attendees: max_attendees ? parseInt(max_attendees) : null,
      tags: tags || [],
      image: image || null,
      created_by: created_by || null,
    }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE EVENT ──────────────────────────────────────────────────────────────
app.delete('/api/events/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { id } = req.params;
  const { userId } = req.body;

  if (userId) {
    const { data: ev } = await sb
      .from('events').select('created_by').eq('id', id).maybeSingle();
    if (ev && ev.created_by && ev.created_by !== userId)
      return res.status(403).json({ error: 'You can only delete your own events' });
  }

  const { error } = await sb.from('events').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── RSVP ─────────────────────────────────────────────────────────────────────
// Handles going / interested / cancellation.
// Stores { userId, username, avatar, status } per attendee in the rsvps array.
// Fires a notification to the event host on new RSVPs.
app.post('/api/events/:id/rsvp', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { id } = req.params;
  const { userId, username, status = 'going', avatar = '' } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const { data: ev, error: fetchErr } = await sb
    .from('events').select('*').eq('id', id).single();
  if (fetchErr || !ev) return res.status(404).json({ error: 'Event not found' });

  // Capacity guard — only "going" RSVPs count toward the cap
  if (status === 'going' && ev.max_attendees) {
    const goingCount = (ev.rsvps || []).filter(
      r => r.status === 'going' && r.userId !== userId
    ).length;
    if (goingCount >= parseInt(ev.max_attendees))
      return res.status(409).json({ error: 'This event is full' });
  }

  let rsvps = ev.rsvps || [];
  const existingIdx = rsvps.findIndex(r => r.userId === userId);
  let isNewRsvp = false;

  if (existingIdx >= 0) {
    if (rsvps[existingIdx].status === status) {
      rsvps.splice(existingIdx, 1);                            // same → cancel
    } else {
      rsvps[existingIdx] = { userId, username, avatar, status }; // different → update
    }
  } else {
    rsvps.push({ userId, username, avatar, status });
    isNewRsvp = true;
  }

  const { data, error } = await sb
    .from('events').update({ rsvps }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify host on new RSVP only (not cancellations, not self-RSVP)
  if (isNewRsvp && ev.created_by && ev.created_by !== userId) {
    const emoji = status === 'going' ? '🎉' : '👀';
    const verb  = status === 'going' ? 'is going to' : 'is interested in';
    notify(sb, {
      user_id: ev.created_by,
      type: 'rsvp',
      title: `${username} ${verb} "${ev.name}" ${emoji}`,
      body: 'Check out your event.',
      data: { event_id: id, user_id: userId, status },
    });
  }

  res.json(data);
});

// ── MESSAGE HISTORY ───────────────────────────────────────────────────────────
app.get('/api/messages/:userId/:otherId', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { userId, otherId } = req.params;
  const { data, error } = await sb
    .from('messages')
    .select('*')
    .or(
      `and(from_user.eq.${userId},to_user.eq.${otherId}),` +
      `and(from_user.eq.${otherId},to_user.eq.${userId})`
    )
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── SEND MESSAGE ──────────────────────────────────────────────────────────────
app.post('/api/messages', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { from_user, to_user, message } = req.body;
  if (!from_user || !to_user || !message)
    return res.status(400).json({ error: 'from_user, to_user and message are required' });
  if (message.length > 2000)
    return res.status(400).json({ error: 'Message too long (max 2000 chars)' });

  const { data, error } = await sb
    .from('messages')
    .insert([{ from_user, to_user, message }])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify recipient
  const { data: sender } = await sb
    .from('users').select('username').eq('id', from_user).maybeSingle();
  notify(sb, {
    user_id: to_user,
    type: 'message',
    title: `New message from ${sender?.username || 'Someone'} 💬`,
    body: message.length > 60 ? message.slice(0, 60) + '…' : message,
    data: { from_user },
  });

  res.json(data);
});

// ── FRIENDS ───────────────────────────────────────────────────────────────────

// GET /api/friends/:userId — all friendships (accepted + pending) for a user
app.get('/api/friends/:userId', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { userId } = req.params;
  const { data, error } = await sb
    .from('friends')
    .select('*')
    .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/friends — send a friend request
app.post('/api/friends', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { sender_id, receiver_id } = req.body;
  if (!sender_id || !receiver_id)
    return res.status(400).json({ error: 'sender_id and receiver_id required' });
  if (sender_id === receiver_id)
    return res.status(400).json({ error: 'Cannot send a friend request to yourself' });

  // Prevent duplicates in either direction
  const { data: existing } = await sb
    .from('friends')
    .select('id, status')
    .or(
      `and(sender_id.eq.${sender_id},receiver_id.eq.${receiver_id}),` +
      `and(sender_id.eq.${receiver_id},receiver_id.eq.${sender_id})`
    )
    .maybeSingle();

  if (existing) {
    if (existing.status === 'accepted')
      return res.status(409).json({ error: 'Already friends' });
    return res.status(409).json({ error: 'Friend request already exists' });
  }

  const { data, error } = await sb
    .from('friends')
    .insert([{ sender_id, receiver_id, status: 'pending' }])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify receiver
  const { data: sender } = await sb
    .from('users').select('username').eq('id', sender_id).maybeSingle();
  notify(sb, {
    user_id: receiver_id,
    type: 'friend_request',
    title: `${sender?.username || 'Someone'} sent you a friend request! 👋`,
    body: 'Accept or decline in the Squad page.',
    data: { sender_id, friendship_id: data.id },
  });

  res.json(data);
});

// PATCH /api/friends/:id — accept or reject a request
app.patch('/api/friends/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { id } = req.params;
  const { status, userId } = req.body;

  if (!status || !['accepted', 'rejected'].includes(status))
    return res.status(400).json({ error: 'status must be "accepted" or "rejected"' });

  const { data: row } = await sb
    .from('friends').select('*').eq('id', id).maybeSingle();
  if (!row) return res.status(404).json({ error: 'Friend request not found' });
  if (userId && row.receiver_id !== userId)
    return res.status(403).json({ error: 'Only the receiver can accept or reject' });

  const { data, error } = await sb
    .from('friends').update({ status }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify sender on acceptance
  if (status === 'accepted') {
    const { data: receiver } = await sb
      .from('users').select('username').eq('id', row.receiver_id).maybeSingle();
    notify(sb, {
      user_id: row.sender_id,
      type: 'friend_accepted',
      title: `${receiver?.username || 'Someone'} accepted your friend request! 🎉`,
      body: 'You can now message each other.',
      data: { friendship_id: id, receiver_id: row.receiver_id },
    });
  }

  res.json(data);
});

// DELETE /api/friends/:id — unfriend or cancel a pending request
app.delete('/api/friends/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { id } = req.params;
  const { userId } = req.body;

  if (userId) {
    const { data: row } = await sb
      .from('friends').select('sender_id, receiver_id').eq('id', id).maybeSingle();
    if (row && row.sender_id !== userId && row.receiver_id !== userId)
      return res.status(403).json({ error: 'Not your friendship to remove' });
  }

  const { error } = await sb.from('friends').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── COMMENTS ──────────────────────────────────────────────────────────────────
app.get('/api/events/:id/comments', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { data, error } = await sb
    .from('comments')
    .select('*')
    .eq('event_id', req.params.id)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/events/:id/comments', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { user_id, username, avatar, body } = req.body;
  if (!user_id || !body)
    return res.status(400).json({ error: 'user_id and body required' });
  if (body.length > 1000)
    return res.status(400).json({ error: 'Comment too long (max 1000 chars)' });

  const { data, error } = await sb
    .from('comments')
    .insert([{ event_id: req.params.id, user_id, username, avatar, body }])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify event host
  const { data: ev } = await sb
    .from('events').select('created_by, name').eq('id', req.params.id).maybeSingle();
  if (ev && ev.created_by && ev.created_by !== user_id) {
    notify(sb, {
      user_id: ev.created_by,
      type: 'comment',
      title: `${username} commented on "${ev.name}" 💬`,
      body: body.length > 60 ? body.slice(0, 60) + '…' : body,
      data: { event_id: req.params.id, user_id },
    });
  }

  res.json(data);
});

app.delete('/api/comments/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { userId } = req.body;
  if (userId) {
    const { data: comment } = await sb
      .from('comments').select('user_id').eq('id', req.params.id).maybeSingle();
    if (comment && comment.user_id !== userId)
      return res.status(403).json({ error: 'Not your comment' });
  }

  const { error } = await sb.from('comments').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── FOLLOWS ───────────────────────────────────────────────────────────────────
app.get('/api/users/:id/follows', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { id } = req.params;
  const [{ data: following }, { data: followers }] = await Promise.all([
    sb.from('follows').select('following_id').eq('follower_id', id),
    sb.from('follows').select('follower_id').eq('following_id', id),
  ]);

  res.json({
    following: (following || []).map(r => r.following_id),
    followers: (followers || []).map(r => r.follower_id),
  });
});

app.post('/api/follows', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { follower_id, following_id } = req.body;
  if (!follower_id || !following_id)
    return res.status(400).json({ error: 'follower_id and following_id required' });
  if (follower_id === following_id)
    return res.status(400).json({ error: 'Cannot follow yourself' });

  const { data: existing } = await sb
    .from('follows')
    .select('id')
    .eq('follower_id', follower_id)
    .eq('following_id', following_id)
    .maybeSingle();

  if (existing) {
    await sb.from('follows').delete().eq('id', existing.id);
    return res.json({ following: false });
  }

  await sb.from('follows').insert([{ follower_id, following_id }]);

  const { data: followerUser } = await sb
    .from('users').select('username').eq('id', follower_id).maybeSingle();
  notify(sb, {
    user_id: following_id,
    type: 'follow',
    title: `${followerUser?.username || 'Someone'} followed you! ➕`,
    body: 'Check out their profile.',
    data: { follower_id },
  });

  res.json({ following: true });
});

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────

// GET /api/notifications/:userId — fetch inbox (40 most recent)
app.get('/api/notifications/:userId', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { data, error } = await sb
    .from('notifications')
    .select('*')
    .eq('user_id', req.params.userId)
    .order('created_at', { ascending: false })
    .limit(40);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PATCH /api/notifications/:userId/read — mark ALL notifications read for a user
// Called by the "Mark all read" button in the panel
app.patch('/api/notifications/:userId/read', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { error } = await sb
    .from('notifications')
    .update({ read: true })
    .eq('user_id', req.params.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// PATCH /api/notifications/:id — mark a single notification read/unread
// Called when a user clicks a notification item in the panel
app.patch('/api/notifications/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { read = true } = req.body;
  const { data, error } = await sb
    .from('notifications')
    .update({ read })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/notifications — create a notification manually (event invites, etc.)
app.post('/api/notifications', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);

  const { user_id, type, title, body, data } = req.body;
  if (!user_id || !title)
    return res.status(400).json({ error: 'user_id and title required' });

  const { data: notif, error } = await sb
    .from('notifications')
    .insert([{
      user_id,
      type: type || 'event',
      title,
      body: body || '',
      data: data || {},
    }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(notif);
});


// ── COMMUNITIES ───────────────────────────────────────────────────────────────

// GET  /api/communities          — list all public communities
// GET  /api/communities?type=    — filter by type
app.get('/api/communities', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { type } = req.query;
  let query = sb.from('communities').select('*, community_members(count)').order('created_at', { ascending: false });
  if (type) query = query.eq('type', type);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/communities/:id — single community with member count
app.get('/api/communities/:id', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { data, error } = await sb
    .from('communities').select('*, community_members(count)').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Community not found' });
  res.json(data);
});

// POST /api/communities — create a new community
app.post('/api/communities', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { name, description, creator_id, type = 'public' } = req.body;
  if (!name || !creator_id) return res.status(400).json({ error: 'name and creator_id required' });
  const { data, error } = await sb
    .from('communities')
    .insert([{ name, description: description || '', creator_id, type }])
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  // Auto-join the creator
  await sb.from('community_members').insert([{ user_id: creator_id, community_id: data.id }]).catch(() => {});
  res.json(data);
});

// POST /api/communities/:id/join — join or leave a community (toggle)
app.post('/api/communities/:id/join', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const { data: existing } = await sb.from('community_members')
    .select('id').eq('user_id', user_id).eq('community_id', req.params.id).maybeSingle();
  if (existing) {
    await sb.from('community_members').delete().eq('id', existing.id);
    return res.json({ joined: false });
  }
  await sb.from('community_members').insert([{ user_id, community_id: req.params.id }]);
  res.json({ joined: true });
});

// ── THREADS ───────────────────────────────────────────────────────────────────

// GET /api/threads?community_id= — threads for a community, smart-scored
app.get('/api/threads', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { community_id, sort = 'hot', limit = 30 } = req.query;
  if (!community_id) return res.status(400).json({ error: 'community_id required' });
  let query = sb.from('threads').select('*, replies(count), likes(count)')
    .eq('community_id', community_id).limit(parseInt(limit));
  if (sort === 'new')    query = query.order('created_at', { ascending: false });
  else if (sort === 'live') query = query.eq('is_live', true).order('created_at', { ascending: false });
  else query = query.order('created_at', { ascending: false }); // hot: sort in app
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  // Compute smart score server-side
  const scored = (data || []).map(ev => {
    const ageH   = (Date.now() - new Date(ev.created_at).getTime()) / 3600000;
    const replies = ev.replies?.[0]?.count || 0;
    const likes   = ev.likes?.[0]?.count   || 0;
    ev._score = likes * 2 + replies * 3 + Math.max(0, 100 - ageH * 2);
    return ev;
  });
  if (sort === 'hot') scored.sort((a, b) => b._score - a._score);
  res.json(scored);
});

// GET /api/threads/:id — single thread
app.get('/api/threads/:id', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { data, error } = await sb.from('threads').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Thread not found' });
  res.json(data);
});

// POST /api/threads — create a thread
app.post('/api/threads', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { community_id, user_id, title, content, type = 'discussion', poll_a, poll_b } = req.body;
  if (!community_id || !user_id || !title)
    return res.status(400).json({ error: 'community_id, user_id and title required' });
  const { data, error } = await sb.from('threads')
    .insert([{ community_id, user_id, title, content: content || '', type, poll_a, poll_b }])
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/threads/:id — update thread (live mode, pin, etc.)
app.patch('/api/threads/:id', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const allowed = ['is_live', 'visibility', 'pinned_reply_id'];
  const updates = {};
  allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
  const { data, error } = await sb.from('threads').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/threads/:id — delete own thread
app.delete('/api/threads/:id', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { userId } = req.body;
  if (userId) {
    const { data: t } = await sb.from('threads').select('user_id').eq('id', req.params.id).maybeSingle();
    if (t && t.user_id !== userId) return res.status(403).json({ error: 'Not your thread' });
  }
  await sb.from('replies').delete().eq('thread_id', req.params.id).catch(() => {});
  const { error } = await sb.from('threads').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── REPLIES ───────────────────────────────────────────────────────────────────

// GET /api/replies?thread_id= — replies for a thread, paginated
app.get('/api/replies', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { thread_id, before, limit = 50 } = req.query;
  if (!thread_id) return res.status(400).json({ error: 'thread_id required' });
  let query = sb.from('replies').select('*').eq('thread_id', thread_id)
    .order('created_at', { ascending: true }).limit(parseInt(limit));
  if (before) query = query.lt('created_at', before);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/replies — post a reply
app.post('/api/replies', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { thread_id, user_id, content, media_url, voice_note_url, debate_side } = req.body;
  if (!thread_id || !user_id || !content)
    return res.status(400).json({ error: 'thread_id, user_id and content required' });
  if (content.length > 2000) return res.status(400).json({ error: 'Reply too long (max 2000 chars)' });

  const { data, error } = await sb.from('replies')
    .insert([{ thread_id, user_id, content, media_url: media_url || null, voice_note_url: voice_note_url || null }])
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify thread owner
  const { data: thread } = await sb.from('threads').select('user_id, title').eq('id', thread_id).maybeSingle();
  if (thread && thread.user_id !== user_id) {
    notify(sb, {
      user_id: thread.user_id, type: 'reply',
      title: 'New reply in "' + (thread.title || 'your thread') + '"',
      body: content.slice(0, 100),
      data: { thread_id, reply_id: data.id, sender_id: user_id },
    });
  }

  // Parse mentions and notify
  const mentions = (content.match(/@(\w+)/g) || []).map(m => m.slice(1));
  for (const username of mentions) {
    const { data: mentionedUser } = await sb.from('users').select('id').ilike('username', username).maybeSingle();
    if (mentionedUser && mentionedUser.id !== user_id) {
      notify(sb, {
        user_id: mentionedUser.id, type: 'mention',
        title: 'You were mentioned in a thread!',
        body: content.slice(0, 100),
        data: { thread_id, reply_id: data.id, sender_id: user_id },
      });
    }
  }

  res.json(data);
});

// DELETE /api/replies/:id — delete own reply
app.delete('/api/replies/:id', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { userId } = req.body;
  if (userId) {
    const { data: r } = await sb.from('replies').select('user_id').eq('id', req.params.id).maybeSingle();
    if (r && r.user_id !== userId) return res.status(403).json({ error: 'Not your reply' });
  }
  const { error } = await sb.from('replies').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── LIKES (threads + replies) ─────────────────────────────────────────────────

// POST /api/likes — toggle like on thread or reply
app.post('/api/likes', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { user_id, thread_id, reply_id } = req.body;
  if (!user_id || (!thread_id && !reply_id))
    return res.status(400).json({ error: 'user_id and (thread_id or reply_id) required' });

  let query = sb.from('likes').select('id').eq('user_id', user_id);
  if (thread_id) query = query.eq('thread_id', thread_id);
  if (reply_id)  query = query.eq('reply_id', reply_id);
  const { data: existing } = await query.maybeSingle();

  if (existing) {
    await sb.from('likes').delete().eq('id', existing.id);
    return res.json({ liked: false });
  }

  const ins = { user_id };
  if (thread_id) ins.thread_id = thread_id;
  if (reply_id)  ins.reply_id  = reply_id;
  const { data, error } = await sb.from('likes').insert([ins]).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify content owner
  if (thread_id) {
    const { data: t } = await sb.from('threads').select('user_id, title').eq('id', thread_id).maybeSingle();
    if (t && t.user_id !== user_id) {
      notify(sb, { user_id: t.user_id, type: 'like', title: 'Someone liked your thread "' + (t.title||'') + '" ❤️',
        body: '', data: { thread_id, liker_id: user_id } });
    }
  }

  res.json({ liked: true, like: data });
});

// GET /api/likes?user_id=&thread_id= — check if user liked something
app.get('/api/likes', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { user_id, thread_id, reply_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  let query = sb.from('likes').select('id').eq('user_id', user_id);
  if (thread_id) query = query.eq('thread_id', thread_id);
  if (reply_id)  query = query.eq('reply_id', reply_id);
  const { data, error } = await query.maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ liked: !!data });
});

// ── USER REPUTATION ───────────────────────────────────────────────────────────

// GET /api/reputation/:userId — get user's reputation stats
app.get('/api/reputation/:userId', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const uid = req.params.userId;
  const [threads, replies, likes] = await Promise.all([
    sb.from('threads').select('id', { count: 'exact', head: true }).eq('user_id', uid),
    sb.from('replies').select('id', { count: 'exact', head: true }).eq('user_id', uid),
    sb.from('likes').select('id', { count: 'exact', head: true }).eq('user_id', uid),
  ]);
  const points = (threads.count || 0) * 5 + (replies.count || 0) * 3 + (likes.count || 0) * 2;
  const rankNames = ['Newbie', 'Contributor', 'Influencer', 'Authority'];
  const rankMins  = [0, 50, 200, 500];
  let rankIdx = 0;
  for (let i = rankMins.length - 1; i >= 0; i--) {
    if (points >= rankMins[i]) { rankIdx = i; break; }
  }
  res.json({
    user_id: uid, points,
    threads_count: threads.count || 0,
    replies_count: replies.count || 0,
    likes_count:   likes.count   || 0,
    rank: rankNames[rankIdx],
  });
});

// ── EXPORT ────────────────────────────────────────────────────────────────────
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Krowdly running on port ${PORT}`));
}
