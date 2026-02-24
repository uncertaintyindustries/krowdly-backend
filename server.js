const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

// Supabase client (uses service role key for full DB access)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ─────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Krowdly backend is live 🚀' });
});

// ─────────────────────────────────────────
//  USERS
// ─────────────────────────────────────────

// Get all users
app.get('/api/users', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Sign Up — create new user with email + password
app.post('/api/users', async (req, res) => {
  const { username, email, password, avatar } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });

  // If email+password provided, do proper signup
  if (email && password) {
    // Check email not already taken
    const { data: existingEmail } = await supabase
      .from('users')
      .select('id')
      .ilike('email', email)
      .maybeSingle();
    if (existingEmail) return res.status(409).json({ error: 'Email already in use' });

    const hash = await bcrypt.hash(password, 10);
    const userAvatar = avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;

    const { data, error } = await supabase
      .from('users')
      .insert([{ username, email: email.toLowerCase(), password_hash: hash, avatar: userAvatar, online: true }])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    const { password_hash, ...safe } = data;
    return res.json(safe);
  }

  // Legacy: username-only (for backwards compat)
  const { data: existing } = await supabase
    .from('users').select('*').ilike('username', username).maybeSingle();
  if (existing) {
    await supabase.from('users').update({ online: true }).eq('id', existing.id);
    const { password_hash, ...safe } = existing;
    return res.json({ ...safe, online: true });
  }
  const fallbackAvatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;
  const { data, error } = await supabase
    .from('users').insert([{ username, avatar: fallbackAvatar, online: true }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  const { password_hash: ph, ...safe } = data;
  res.json(safe);
});

// Sign In — email + password
app.post('/api/auth/signin', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .ilike('email', email)
    .maybeSingle();

  if (error || !user) return res.status(401).json({ error: 'Invalid email or password' });
  if (!user.password_hash) return res.status(401).json({ error: 'Account uses a different login method' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });

  await supabase.from('users').update({ online: true }).eq('id', user.id);
  const { password_hash, ...safe } = user;
  res.json({ ...safe, online: true });
});

// ─────────────────────────────────────────
//  EVENTS
// ─────────────────────────────────────────

// Get all events
app.get('/api/events', async (req, res) => {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Create event
app.post('/api/events', async (req, res) => {
  const { name, location, category, category_color, host, host_avatar, privacy, lat, lng } = req.body;
  if (!name || !location || !category || !host) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const { data, error } = await supabase
    .from('events')
    .insert([{ name, location, category, category_color, host, host_avatar, privacy: privacy || 'public', lat: lat || 0, lng: lng || 0, rsvps: [] }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Broadcast to all connected clients
  io.emit('eventPosted', data);

  // Log activity
  io.emit('activity', {
    type: 'eventPosted',
    user: host,
    action: `posted a new event: "${name}"`,
    timestamp: new Date()
  });

  res.json(data);
});

// Delete event
app.delete('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('events').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  io.emit('eventDeleted', id);
  res.json({ success: true });
});

// RSVP toggle
app.post('/api/events/:id/rsvp', async (req, res) => {
  const { id } = req.params;
  const { userId, username } = req.body;

  const { data: ev, error: fetchErr } = await supabase
    .from('events')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchErr || !ev) return res.status(404).json({ error: 'Event not found' });

  let rsvps = ev.rsvps || [];
  const already = rsvps.find(r => r.userId === userId);

  if (already) {
    rsvps = rsvps.filter(r => r.userId !== userId);
  } else {
    rsvps.push({ userId, username });
  }

  const { data, error } = await supabase
    .from('events')
    .update({ rsvps })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  io.emit('eventUpdated', data);

  if (!already) {
    io.emit('activity', {
      type: 'rsvpAdded',
      user: username,
      action: `is going to "${ev.name}"`,
      timestamp: new Date()
    });
  }

  res.json(data);
});

// ─────────────────────────────────────────
//  MESSAGES
// ─────────────────────────────────────────

// Get conversation between two users
app.get('/api/messages/:userId/:otherId', async (req, res) => {
  const { userId, otherId } = req.params;

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .or(
      `and(from_user.eq.${userId},to_user.eq.${otherId}),and(from_user.eq.${otherId},to_user.eq.${userId})`
    )
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─────────────────────────────────────────
//  SOCKET.IO — Real-time layer
// ─────────────────────────────────────────

// Map of userId → socketId for direct messaging
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // Register user as online
  socket.on('registerUser', async (user) => {
    if (!user?._id && !user?.id) return;
    const uid = user._id || user.id;
    onlineUsers.set(uid, socket.id);

    // Mark online in DB
    await supabase.from('users').update({ online: true }).eq('id', uid);

    // Broadcast updated user list
    const { data: users } = await supabase.from('users').select('*');
    io.emit('usersOnline', users || []);

    io.emit('activity', {
      type: 'userJoined',
      user: user.username,
      action: 'joined Krowdly',
      timestamp: new Date()
    });
  });

  // Direct message
  socket.on('sendMessage', async ({ from, to, message }) => {
    const { data, error } = await supabase
      .from('messages')
      .insert([{ from_user: from, to_user: to, message }])
      .select()
      .single();

    if (error) return;

    const payload = { ...data, from, to, timestamp: data.created_at };

    // Send to recipient if online
    const recipientSocketId = onlineUsers.get(to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('newMessage', payload);
    }
    // Echo back to sender
    socket.emit('newMessage', payload);
  });

  // Typing indicators
  socket.on('typing', ({ to }) => {
    const recipientSocketId = onlineUsers.get(to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('typingStart', { from: getUserIdBySocket(socket.id) });
    }
  });

  socket.on('stopTyping', ({ to }) => {
    const recipientSocketId = onlineUsers.get(to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('typingStop', { from: getUserIdBySocket(socket.id) });
    }
  });

  // Disconnect
  socket.on('disconnect', async () => {
    let disconnectedUid = null;
    for (const [uid, sid] of onlineUsers.entries()) {
      if (sid === socket.id) { disconnectedUid = uid; break; }
    }

    if (disconnectedUid) {
      onlineUsers.delete(disconnectedUid);
      await supabase.from('users').update({ online: false }).eq('id', disconnectedUid);
      const { data: users } = await supabase.from('users').select('*');
      io.emit('usersOnline', users || []);
    }
  });
});

function getUserIdBySocket(socketId) {
  for (const [uid, sid] of onlineUsers.entries()) {
    if (sid === socketId) return uid;
  }
  return null;
}

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Krowdly backend running on port ${PORT} 🚀`);
});
