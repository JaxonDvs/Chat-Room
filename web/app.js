// supabase-js is vendored in web/vendor/ rather than pulled from a CDN, so the
// page is self-contained: no third-party request on load, and it keeps working
// if a CDN is blocked or goes down.
const { createClient } = window.supabase;

const GROUP_WINDOW_MS = 5 * 60 * 1000; // messages closer than this stack together
const PAGE_SIZE = 50;

const $ = (id) => document.getElementById(id);

const el = {
  setupView: $('setup-view'),

  authView: $('auth-view'),
  authForm: $('auth-form'),
  authError: $('auth-error'),
  authNotice: $('auth-notice'),
  authSubmit: $('auth-submit'),
  usernameField: $('username-field'),
  usernameHint: $('username-hint'),
  username: $('username'),
  email: $('email'),
  password: $('password'),
  tabs: document.querySelectorAll('.tab'),

  chatView: $('chat-view'),
  messages: $('messages'),
  messageList: $('message-list'),
  loadMore: $('load-more'),
  historyStart: $('history-start'),
  composerForm: $('composer-form'),
  composerInput: $('composer-input'),
  composerError: $('composer-error'),
  send: $('send'),
  logout: $('logout'),
  currentUser: $('current-user'),
  onlineCount: $('online-count'),
  presenceToggle: $('presence-toggle'),
  presenceList: $('presence-list'),
  connection: $('connection'),
};

const state = {
  me: null, // { id, username }
  items: [],
  oldestId: null,
  newestId: null,
  hasMore: false,
  authMode: 'login',
  channel: null,
  loadingHistory: false,
  started: false,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config = window.CHAT_CONFIG || {};
const configured =
  typeof config.SUPABASE_URL === 'string' &&
  typeof config.SUPABASE_ANON_KEY === 'string' &&
  config.SUPABASE_URL.startsWith('http') &&
  !config.SUPABASE_URL.includes('YOUR_') &&
  !config.SUPABASE_ANON_KEY.includes('YOUR_');

if (!configured) {
  el.setupView.hidden = false;
  throw new Error('Supabase is not configured — see web/config.js');
}

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDay(ts) {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);

  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';

  return date.toLocaleDateString([], {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

const itemTime = (item) => (item.kind === 'system' ? item.at : item.createdAt);

/** Rows come back with ISO timestamps; the renderer works in milliseconds. */
function toMessage(row) {
  return {
    kind: 'message',
    id: row.id,
    body: row.body,
    username: row.username,
    userId: row.user_id,
    createdAt: new Date(row.created_at).getTime(),
  };
}

/**
 * Turns bare URLs into links using real DOM nodes — message text is never
 * passed through innerHTML, so it cannot inject markup.
 */
function renderBody(target, text) {
  const pattern = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,!?;:'"]/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      target.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    const link = document.createElement('a');
    link.href = match[0];
    link.textContent = match[0];
    link.target = '_blank';
    link.rel = 'noopener noreferrer nofollow';
    target.appendChild(link);

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    target.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function isNearBottom() {
  const node = el.messages;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 120;
}

function scrollToBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function buildItemNode(item, previous) {
  const fragment = document.createDocumentFragment();

  const needsDivider =
    !previous ||
    new Date(itemTime(previous)).toDateString() !== new Date(itemTime(item)).toDateString();

  if (needsDivider) {
    const divider = document.createElement('div');
    divider.className = 'day-divider';
    divider.textContent = formatDay(itemTime(item));
    fragment.appendChild(divider);
  }

  if (item.kind === 'system') {
    const line = document.createElement('p');
    line.className = 'system';
    line.textContent = item.text;
    fragment.appendChild(line);
    return fragment;
  }

  const isLead =
    needsDivider ||
    !previous ||
    previous.kind !== 'message' ||
    previous.userId !== item.userId ||
    item.createdAt - previous.createdAt > GROUP_WINDOW_MS;

  const wrapper = document.createElement('article');
  wrapper.className = isLead ? 'msg is-lead' : 'msg';
  wrapper.dataset.id = item.id;

  if (isLead) {
    const head = document.createElement('div');
    head.className = 'msg-head';

    const author = document.createElement('span');
    author.className = 'msg-author';
    author.textContent = item.username;

    const time = document.createElement('time');
    time.className = 'msg-time';
    time.dateTime = new Date(item.createdAt).toISOString();
    time.textContent = formatTime(item.createdAt);

    head.append(author, time);
    wrapper.appendChild(head);
  }

  const body = document.createElement('p');
  body.className = 'msg-body';
  body.title = `${item.username} · ${new Date(item.createdAt).toLocaleString()}`;
  renderBody(body, item.body);
  wrapper.appendChild(body);

  fragment.appendChild(wrapper);
  return fragment;
}

function renderAll() {
  el.messageList.replaceChildren();
  state.items.forEach((item, index) => {
    el.messageList.appendChild(buildItemNode(item, state.items[index - 1]));
  });
}

function appendItem(item) {
  const stick = isNearBottom();
  const previous = state.items[state.items.length - 1];
  state.items.push(item);
  el.messageList.appendChild(buildItemNode(item, previous));
  if (stick) scrollToBottom();
}

function trackBounds(messages) {
  for (const message of messages) {
    if (state.oldestId === null || message.id < state.oldestId) state.oldestId = message.id;
    if (state.newestId === null || message.id > state.newestId) state.newestId = message.id;
  }
}

function updateHistoryControls() {
  el.loadMore.hidden = !state.hasMore;
  el.historyStart.hidden = state.hasMore || state.items.length === 0;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const MESSAGE_COLUMNS = 'id, body, username, user_id, created_at';

async function loadInitialHistory() {
  const { data, error } = await supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .order('id', { ascending: false })
    .limit(PAGE_SIZE);

  if (error) throw error;

  const messages = data.map(toMessage).reverse();
  state.items = messages;
  state.hasMore = data.length === PAGE_SIZE;
  trackBounds(messages);

  renderAll();
  updateHistoryControls();
  scrollToBottom();
}

async function loadOlder() {
  if (state.loadingHistory || !state.hasMore || state.oldestId === null) return;

  state.loadingHistory = true;
  el.loadMore.disabled = true;

  try {
    const { data, error } = await supabase
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .lt('id', state.oldestId)
      .order('id', { ascending: false })
      .limit(PAGE_SIZE);

    if (error) throw error;

    const heightBefore = el.messages.scrollHeight;
    const scrollBefore = el.messages.scrollTop;

    const messages = data.map(toMessage).reverse();
    state.items.unshift(...messages);
    state.hasMore = data.length === PAGE_SIZE;
    trackBounds(messages);

    renderAll();
    updateHistoryControls();

    // Keep the reader looking at the same message after older ones slot in above.
    el.messages.scrollTop = scrollBefore + (el.messages.scrollHeight - heightBefore);
  } finally {
    state.loadingHistory = false;
    el.loadMore.disabled = false;
  }
}

/** After a reconnect, pull anything that was posted while we were away. */
async function catchUp() {
  if (state.newestId === null) return loadInitialHistory();

  const { data, error } = await supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .gt('id', state.newestId)
    .order('id', { ascending: true })
    .limit(200);

  if (error || !data.length) return;

  trackBounds(data.map(toMessage));
  data.map(toMessage).forEach(appendItem);
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

function subscribe() {
  const channel = supabase.channel('chat-room', {
    config: { presence: { key: state.me.id } },
  });
  state.channel = channel;

  channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
    const message = toMessage(payload.new);
    if (state.newestId !== null && message.id <= state.newestId) return; // already have it
    trackBounds([message]);
    appendItem(message);
  });

  channel.on('presence', { event: 'sync' }, () => {
    const names = Object.values(channel.presenceState())
      .map((entries) => entries[0] && entries[0].username)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    el.onlineCount.textContent = `${names.length} online`;
    el.presenceList.replaceChildren();

    for (const name of names) {
      const row = document.createElement('p');
      row.textContent = name;
      el.presenceList.appendChild(row);
    }
  });

  channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      el.connection.hidden = true;
      await channel.track({ username: state.me.username });
      catchUp().catch(() => {});
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      el.connection.hidden = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function autoGrow() {
  el.composerInput.style.height = 'auto';
  el.composerInput.style.height = `${el.composerInput.scrollHeight}px`;
  el.send.disabled = el.composerInput.value.trim().length === 0;
}

async function sendMessage() {
  const body = el.composerInput.value.trim();
  if (!body || !state.me) return;

  el.composerInput.value = '';
  el.composerError.hidden = true;
  autoGrow();

  const { error } = await supabase
    .from('messages')
    .insert({ user_id: state.me.id, body: body.slice(0, 2000) });

  if (error) {
    // Give the text back so nothing is lost.
    el.composerInput.value = el.composerInput.value || body;
    autoGrow();
    el.composerError.textContent = /slow down/i.test(error.message)
      ? 'Slow down a moment.'
      : 'Could not send that. Check your connection and try again.';
    el.composerError.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function showAuth() {
  state.me = null;
  state.started = false;
  el.chatView.hidden = true;
  el.authView.hidden = false;
  el.email.focus();
}

async function showChat(profile) {
  if (state.started) return;
  state.started = true;

  state.me = profile;
  el.currentUser.textContent = `Signed in as ${profile.username}`;
  el.authView.hidden = true;
  el.chatView.hidden = false;

  await loadInitialHistory();
  subscribe();
  autoGrow();
  el.composerInput.focus();
}

function setAuthMode(mode) {
  state.authMode = mode;
  el.authError.hidden = true;
  el.authNotice.hidden = true;

  el.tabs.forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  const registering = mode === 'register';
  el.usernameField.hidden = !registering;
  el.usernameHint.hidden = !registering;
  el.username.required = registering;

  el.authSubmit.textContent = registering ? 'Create account' : 'Sign in';
  el.password.autocomplete = registering ? 'new-password' : 'current-password';
  el.password.placeholder = registering ? 'At least 8 characters' : 'Your password';
}

/** Reads the signed-in user's profile row, retrying while the signup trigger runs. */
async function loadProfile(userId, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const { data } = await supabase
      .from('profiles')
      .select('id, username')
      .eq('id', userId)
      .maybeSingle();

    if (data) return data;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auth actions
// ---------------------------------------------------------------------------

async function register(username, email, password) {
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) {
    throw new Error('Display name must be 3-20 characters: letters, numbers, hyphens or underscores.');
  }

  const { data: available, error: checkError } = await supabase.rpc('username_available', {
    candidate: username,
  });

  if (!checkError && available === false) {
    throw new Error('That display name is taken.');
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username } },
  });

  if (error) throw error;

  // With email confirmation switched on there is no session yet.
  if (!data.session) {
    el.authNotice.textContent = 'Check your email to confirm your account, then sign in.';
    el.authNotice.hidden = false;
    return null;
  }

  return data.user;
}

async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Wrong email or password.');
  return data.user;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

el.tabs.forEach((tab) => {
  tab.addEventListener('click', () => setAuthMode(tab.dataset.mode));
});

el.authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.authError.hidden = true;
  el.authNotice.hidden = true;
  el.authSubmit.disabled = true;

  try {
    const email = el.email.value.trim();
    const password = el.password.value;

    const user =
      state.authMode === 'register'
        ? await register(el.username.value.trim(), email, password)
        : await login(email, password);

    if (user) {
      const profile = await loadProfile(user.id);
      if (!profile) throw new Error('Account created, but the profile is still setting up. Try signing in.');

      el.authForm.reset();
      await showChat(profile);
    }
  } catch (err) {
    el.authError.textContent = err.message || 'Something went wrong.';
    el.authError.hidden = false;
  } finally {
    el.authSubmit.disabled = false;
  }
});

el.composerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});

el.composerInput.addEventListener('input', autoGrow);

el.composerInput.addEventListener('keydown', (event) => {
  // Enter sends, Shift+Enter makes a new line.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

el.loadMore.addEventListener('click', loadOlder);

el.logout.addEventListener('click', async () => {
  if (state.channel) {
    await supabase.removeChannel(state.channel);
    state.channel = null;
  }

  await supabase.auth.signOut();

  state.items = [];
  state.oldestId = null;
  state.newestId = null;
  el.messageList.replaceChildren();
  setAuthMode('login');
  showAuth();
});

el.presenceToggle.addEventListener('click', () => {
  const open = el.presenceList.hidden;
  el.presenceList.hidden = !open;
  el.presenceToggle.setAttribute('aria-expanded', String(open));
});

document.addEventListener('click', (event) => {
  if (el.presenceList.hidden) return;
  if (el.presenceList.contains(event.target) || el.presenceToggle.contains(event.target)) return;
  el.presenceList.hidden = true;
  el.presenceToggle.setAttribute('aria-expanded', 'false');
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

setAuthMode('login');
autoGrow();

const { data: sessionData } = await supabase.auth.getSession();

if (sessionData.session) {
  const profile = await loadProfile(sessionData.session.user.id);
  if (profile) {
    await showChat(profile);
  } else {
    showAuth();
  }
} else {
  showAuth();
}
