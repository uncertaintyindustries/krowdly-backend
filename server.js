const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// NOTE: No dotenv — Vercel injects env vars directly.
// For local dev: create a .env file and require('dotenv').config() at top, or set vars in terminal.

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
      '2. Add SUPABASE_URL = your supabase project url (https://xxx.supabase.co)',
      '3. Add SUPABASE_SERVICE_KEY = your service_role key from supabase dashboard',
      '4. Add PASSWORD_SALT = any random string',
      '5. Click Redeploy'
    ]
  });
}

// Touch last_seen without failing silently
async function touchLastSeen(sb, userId) {
  try {
    await sb.from('users').update({ last_seen: new Date().toISOString() }).eq('id', userId);
  } catch (_) {}
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const missing = [];
  if (!process.env.SUPABASE_URL)        missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (missing.length > 0) {
    return res.status(500).json({
      status: 'Backend running but NOT configured',
      missing_env_vars: missing,
      fix: 'Add missing vars in Vercel → Project → Settings → Environment Variables → Redeploy'
    });
  }
  res.json({ status: 'Krowdly backend is live ✅', db: 'connected' });
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
  const now = new Date().toISOString();

  const { data, error } = await sb
    .from('users')
    .insert([{
      username, email,
      password_hash: hashPassword(password),
      avatar: avatarUrl,
      online: true,
      last_seen: now
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
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

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
  await sb.from('users').update({ online: false, last_seen: new Date().toISOString() }).eq('id', userId);
  res.json({ success: true });
});

// ── GET ALL USERS ─────────────────────────────────────────────────────────────
// Returns last_seen so the frontend presence-poll can determine online status
app.get('/api/users', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { data, error } = await sb
    .from('users')
    .select('id, username, avatar, online, bio, profile_color, last_seen, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── GET SINGLE USER ───────────────────────────────────────────────────────────
// Used by profile modal when clicking a user in search results
app.get('/api/users/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { data, error } = await sb
    .from('users')
    .select('id, username, avatar, online, bio, profile_color, last_seen, created_at')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: 'User not found' });
  res.json(data);
});

// ── UPDATE USER ───────────────────────────────────────────────────────────────
app.patch('/api/users/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { id } = req.params;
  const { username, avatar, bio, profile_color, last_seen } = req.body;
  const updates = {};
  if (username      !== undefined) updates.username      = username;
  if (avatar        !== undefined) updates.avatar        = avatar;
  if (bio           !== undefined) updates.bio           = bio;
  if (profile_color !== undefined) updates.profile_color = profile_color;
  if (last_seen     !== undefined) updates.last_seen     = last_seen;
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
  const { data, error } = await sb.from('users').update(updates).eq('id', id)
    .select('id, username, avatar, online, bio, profile_color, last_seen, created_at').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET EVENTS ────────────────────────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { data, error } = await sb
    .from('events')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── TRENDING EVENTS ───────────────────────────────────────────────────────────
// Must be before /api/events/:id routes to prevent 'trending' matching as an :id
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
  // Sort by total RSVP count descending
  const sorted = (data || [])
    .sort((a, b) => (b.rsvps?.length || 0) - (a.rsvps?.length || 0))
    .slice(0, 10);
  res.json(sorted);
});

// ── CREATE EVENT ──────────────────────────────────────────────────────────────
app.post('/api/events', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const {
    name, location, category, category_color, host, host_avatar, privacy,
    lat, lng, description, date, time, max_attendees, tags, image, created_by
  } = req.body;
  if (!name || !location || !category || !host)
    return res.status(400).json({ error: 'name, location, category and host are required' });
  const { data, error } = await sb.from('events').insert([{
    name, location, category,
    category_color: category_color || '#a855f7',
    host, host_avatar: host_avatar || null,
    privacy: privacy || 'public',
    lat: lat || 0, lng: lng || 0,
    rsvps: [],
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
// Only the creator can delete their own event
app.delete('/api/events/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { id } = req.params;
  const { userId } = req.body;

  if (userId) {
    // Verify ownership before deleting
    const { data: ev } = await sb.from('events').select('created_by').eq('id', id).maybeSingle();
    if (ev && ev.created_by && ev.created_by !== userId) {
      return res.status(403).json({ error: 'You can only delete your own events' });
    }
  }

  const { error } = await sb.from('events').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── RSVP ─────────────────────────────────────────────────────────────────────
// Handles going / interested / cancellation. Stores status per user.
// Sends a notification to the event host when someone RSVPs.
app.post('/api/events/:id/rsvp', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { id } = req.params;
  const { userId, username, status = 'going', avatar = '' } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const { data: ev, error: fetchErr } = await sb.from('events').select('*').eq('id', id).single();
  if (fetchErr || !ev) return res.status(404).json({ error: 'Event not found' });

  // Capacity check
  if (status === 'going' && ev.max_attendees) {
    const goingCount = (ev.rsvps || []).filter(r => r.status === 'going' && r.userId !== userId).length;
    if (goingCount >= parseInt(ev.max_attendees)) {
      return res.status(409).json({ error: 'This event is full' });
    }
  }

  let rsvps = ev.rsvps || [];
  const existingIdx = rsvps.findIndex(r => r.userId === userId);

  if (existingIdx >= 0) {
    // Toggle off if same status, otherwise update status
    if (rsvps[existingIdx].status === status) {
      rsvps.splice(existingIdx, 1); // cancel
    } else {
      rsvps[existingIdx] = { userId, username, avatar, status };
    }
  } else {
    rsvps.push({ userId, username, avatar, status });
  }

  const { data, error } = await sb.from('events').update({ rsvps }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify the host when someone RSVPs (not when cancelling)
  const isNewRsvp = existingIdx < 0 || (rsvps.findIndex(r => r.userId === userId) >= 0);
  if (isNewRsvp && ev.created_by && ev.created_by !== userId) {
    const emoji = status === 'going' ? '🎉' : '👀';
    const verb  = status === 'going' ? 'is going to' : 'is interested in';
    sb.from('notifications').insert([{
      user_id: ev.created_by,
      type: 'rsvp',
      title: `${username} ${verb} "${ev.name}" ${emoji}`,
      body: 'Check out your event.',
      data: { event_id: id, user_id: userId, status }
    }]).then(() => {}).catch(() => {});
  }

  res.json(data);
});

// ── MESSAGE HISTORY ───────────────────────────────────────────────────────────
app.get('/api/messages/:userId/:otherId', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { userId, otherId } = req.params;

  // Only allow users to fetch their own messages
  const { data, error } = await sb.from('messages').select('*')
    .or(`and(from_user.eq.${userId},to_user.eq.${otherId}),and(from_user.eq.${otherId},to_user.eq.${userId})`)
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
  if (message.length > 2000) return res.status(400).json({ error: 'Message too long (max 2000 chars)' });
  const { data, error } = await sb.from('messages')
    .insert([{ from_user, to_user, message }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── FRIENDS ───────────────────────────────────────────────────────────────────
// GET  /api/friends/:userId  — fetch all friendships (accepted + pending) for a user
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

// POST /api/friends  — send a friend request
app.post('/api/friends', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { sender_id, receiver_id } = req.body;
  if (!sender_id || !receiver_id) return res.status(400).json({ error: 'sender_id and receiver_id required' });
  if (sender_id === receiver_id)  return res.status(400).json({ error: 'Cannot send a friend request to yourself' });

  // Prevent duplicates
  const { data: existing } = await sb.from('friends').select('id, status')
    .or(`and(sender_id.eq.${sender_id},receiver_id.eq.${receiver_id}),and(sender_id.eq.${receiver_id},receiver_id.eq.${sender_id})`)
    .maybeSingle();
  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: 'Already friends' });
    return res.status(409).json({ error: 'Friend request already exists' });
  }

  const { data, error } = await sb.from('friends')
    .insert([{ sender_id, receiver_id, status: 'pending' }])
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify the receiver
  const { data: sender } = await sb.from('users').select('username').eq('id', sender_id).maybeSingle();
  sb.from('notifications').insert([{
    user_id: receiver_id,
    type: 'friend_request',
    title: `${sender?.username || 'Someone'} sent you a friend request! 👋`,
    body: 'Accept or decline in the Squad page.',
    data: { sender_id, friendship_id: data.id }
  }]).then(() => {}).catch(() => {});

  res.json(data);
});

// PATCH /api/friends/:id  — accept or reject a request
app.patch('/api/friends/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { id } = req.params;
  const { status, userId } = req.body; // userId = the person accepting/rejecting (must be receiver)
  if (!status || !['accepted', 'rejected'].includes(status))
    return res.status(400).json({ error: 'status must be "accepted" or "rejected"' });

  // Verify the requester is the receiver
  const { data: row } = await sb.from('friends').select('*').eq('id', id).maybeSingle();
  if (!row) return res.status(404).json({ error: 'Friend request not found' });
  if (userId && row.receiver_id !== userId)
    return res.status(403).json({ error: 'Only the receiver can accept or reject a request' });

  const { data, error } = await sb.from('friends').update({ status }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify the sender if accepted
  if (status === 'accepted') {
    const { data: receiver } = await sb.from('users').select('username').eq('id', row.receiver_id).maybeSingle();
    sb.from('notifications').insert([{
      user_id: row.sender_id,
      type: 'friend_accepted',
      title: `${receiver?.username || 'Someone'} accepted your friend request! 🎉`,
      body: 'You can now message each other.',
      data: { friendship_id: id, receiver_id: row.receiver_id }
    }]).then(() => {}).catch(() => {});
  }

  res.json(data);
});

// DELETE /api/friends/:id  — remove a friend or cancel a request
app.delete('/api/friends/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return dbError(res);
  const { id } = req.params;
  const { userId } = req.body;

  // Verify the requester is part of the friendship
  if (userId) {
    const { data: row } = await sb.from('friends').select('sender_id, receiver_id').eq('id', id).maybeSingle();
    if (row && row.sender_id !== userId && row.receiver_id !== userId) {
      return res.status(403).json({ error: 'Not your friendship to remove' });
    }
  }

  const { error } = await sb.from('friends').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── COMMENTS ──────────────────────────────────────────────────────────────────
app.get('/api/events/:id/comments', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { data, error } = await sb.from('comments').select('*')
    .eq('event_id', req.params.id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/events/:id/comments', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { user_id, username, avatar, body } = req.body;
  if (!user_id || !body) return res.status(400).json({ error: 'user_id and body required' });
  if (body.length > 1000) return res.status(400).json({ error: 'Comment too long (max 1000 chars)' });
  const { data, error } = await sb.from('comments')
    .insert([{ event_id: req.params.id, user_id, username, avatar, body }])
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/comments/:id', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { userId } = req.body;
  // Only comment author can delete
  if (userId) {
    const { data: comment } = await sb.from('comments').select('user_id').eq('id', req.params.id).maybeSingle();
    if (comment && comment.user_id !== userId) return res.status(403).json({ error: 'Not your comment' });
  }
  const { error } = await sb.from('comments').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── FOLLOWS ───────────────────────────────────────────────────────────────────
app.get('/api/users/:id/follows', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { id } = req.params;
  const [{ data: following }, { data: followers }] = await Promise.all([
    sb.from('follows').select('following_id').eq('follower_id', id),
    sb.from('follows').select('follower_id').eq('following_id', id)
  ]);
  res.json({
    following: (following || []).map(r => r.following_id),
    followers: (followers || []).map(r => r.follower_id),
  });
});

app.post('/api/follows', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { follower_id, following_id } = req.body;
  if (!follower_id || !following_id) return res.status(400).json({ error: 'follower_id and following_id required' });
  if (follower_id === following_id) return res.status(400).json({ error: 'Cannot follow yourself' });
  const { data: existing } = await sb.from('follows')
    .select('id').eq('follower_id', follower_id).eq('following_id', following_id).maybeSingle();
  if (existing) {
    await sb.from('follows').delete().eq('id', existing.id);
    return res.json({ following: false });
  }
  await sb.from('follows').insert([{ follower_id, following_id }]);
  const { data: followerUser } = await sb.from('users').select('username').eq('id', follower_id).maybeSingle();
  sb.from('notifications').insert([{
    user_id: following_id,
    type: 'follow',
    title: `${followerUser?.username || 'Someone'} followed you!`,
    body: 'Check out their profile.',
    data: { follower_id }
  }]).then(() => {}).catch(() => {});
  res.json({ following: true });
});

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
app.get('/api/notifications/:userId', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { data, error } = await sb.from('notifications').select('*')
    .eq('user_id', req.params.userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.patch('/api/notifications/:userId/read', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  await sb.from('notifications').update({ read: true }).eq('user_id', req.params.userId);
  res.json({ success: true });
});

app.post('/api/notifications', async (req, res) => {
  const sb = getSupabase(); if (!sb) return dbError(res);
  const { user_id, type, title, body, data } = req.body;
  if (!user_id || !title) return res.status(400).json({ error: 'user_id and title required' });
  const { data: notif, error } = await sb.from('notifications')
    .insert([{ user_id, type: type || 'event', title, body: body || '', data: data || {} }])
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(notif);
});

// ── EXPORT ────────────────────────────────────────────────────────────────────
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`🚀 Krowdly running on port ${PORT}`));
}
