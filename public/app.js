'use strict';

(function () {
  const GROUP_WINDOW_MS = 5 * 60 * 1000; // messages closer than this stack together

  const $ = (id) => document.getElementById(id);

  const el = {
    authView: $('auth-view'),
    authForm: $('auth-form'),
    authError: $('auth-error'),
    authSubmit: $('auth-submit'),
    authSubmitText: document.querySelector('#auth-submit span:first-child'),
    authKicker: $('auth-kicker'),
    authTitle: $('auth-title'),
    authSubtitle: $('auth-subtitle'),
    username: $('username'),
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
    currentUserAvatar: $('current-user-avatar'),
    onlineCount: $('online-count'),
    presenceToggle: $('presence-toggle'),
    presenceList: $('presence-list'),
    connection: $('connection'),
  };

  const state = {
    me: null,
    /** Ordered timeline of { kind: 'message' | 'system', ... }. */
    items: [],
    oldestId: null,
    newestId: null,
    hasMore: false,
    authMode: 'login',
    socket: null,
    loadingHistory: false,
  };

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      ...options,
    });

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* empty or non-JSON body */
    }

    if (!res.ok) {
      const err = new Error((data && data.error) || 'Something went wrong.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

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

  function itemTime(item) {
    return item.kind === 'system' ? item.at : item.createdAt;
  }

  function avatarHue(username) {
    let hash = 0;
    for (const character of username) {
      hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    return (hash % 250) + 20;
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

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

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
    wrapper.classList.toggle('is-own', Boolean(state.me && item.userId === state.me.id));
    wrapper.dataset.id = item.id;
    wrapper.dataset.initial = item.username.charAt(0).toUpperCase();
    wrapper.style.setProperty('--avatar-hue', avatarHue(item.username));

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

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  async function loadInitialHistory() {
    const { messages, hasMore } = await api('/api/messages');
    state.items = messages.map((m) => ({ kind: 'message', ...m }));
    state.hasMore = hasMore;
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
      const { messages, hasMore } = await api(`/api/messages?before=${state.oldestId}`);
      const heightBefore = el.messages.scrollHeight;
      const scrollBefore = el.messages.scrollTop;

      state.items.unshift(...messages.map((m) => ({ kind: 'message', ...m })));
      state.hasMore = hasMore;
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

  /** After a reconnect, pull anything that was sent while the socket was down. */
  async function catchUp() {
    if (state.newestId === null) return loadInitialHistory();

    const { messages } = await api(`/api/messages?after=${state.newestId}`);
    if (!messages.length) return;

    trackBounds(messages);
    messages.forEach((m) => appendItem({ kind: 'message', ...m }));
  }

  // -------------------------------------------------------------------------
  // Socket
  // -------------------------------------------------------------------------

  function connectSocket() {
    const socket = io({ withCredentials: true });
    state.socket = socket;

    socket.on('connect', () => {
      el.connection.hidden = true;
      catchUp().catch(() => {});
    });

    socket.on('disconnect', () => {
      el.connection.hidden = false;
    });

    socket.on('connect_error', (err) => {
      // The session expired or was cleared — send them back to the sign-in screen.
      if (err && err.message === 'unauthorized') {
        socket.close();
        showAuth();
        return;
      }
      el.connection.hidden = false;
    });

    socket.on('message', (message) => {
      if (state.newestId !== null && message.id <= state.newestId) return; // already have it
      trackBounds([message]);
      appendItem({ kind: 'message', ...message });
    });

    socket.on('system', (event) => {
      appendItem({ kind: 'system', text: event.text, at: event.at });
    });

    socket.on('presence', ({ users }) => {
      el.onlineCount.textContent = `${users.length} online`;
      el.presenceList.replaceChildren();

      for (const name of users) {
        const row = document.createElement('p');
        row.textContent = name;
        el.presenceList.appendChild(row);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Composer
  // -------------------------------------------------------------------------

  function autoGrow() {
    el.composerInput.style.height = 'auto';
    el.composerInput.style.height = `${el.composerInput.scrollHeight}px`;
    el.send.disabled = el.composerInput.value.trim().length === 0;
  }

  function sendMessage() {
    const body = el.composerInput.value.trim();
    if (!body || !state.socket) return;

    el.composerInput.value = '';
    el.composerError.hidden = true;
    autoGrow();

    state.socket.emit('message', { body }, (reply) => {
      if (reply && reply.error) {
        // Give the text back so nothing is lost.
        el.composerInput.value = el.composerInput.value || body;
        autoGrow();
        el.composerError.textContent = reply.error;
        el.composerError.hidden = false;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  function showAuth() {
    state.me = null;
    el.chatView.hidden = true;
    el.authView.hidden = false;
    el.username.focus();
  }

  async function showChat(user) {
    state.me = user;
    el.currentUser.textContent = user.username;
    el.currentUserAvatar.textContent = user.username.charAt(0);
    el.authView.hidden = true;
    el.chatView.hidden = false;

    await loadInitialHistory();
    connectSocket();
    el.composerInput.focus();
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    el.authError.hidden = true;

    el.tabs.forEach((tab) => {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });

    const isLogin = mode === 'login';
    el.authSubmitText.textContent = isLogin ? 'Sign in' : 'Create account';
    el.authKicker.textContent = isLogin ? 'Welcome back' : 'New here?';
    el.authTitle.textContent = isLogin
      ? 'Pick up where you left off.'
      : 'Make yourself at home.';
    el.authSubtitle.textContent = isLogin
      ? 'Sign in to see what everyone has been talking about.'
      : 'Create an account and jump straight into the conversation.';
    el.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    el.password.placeholder =
      mode === 'login' ? 'Your password' : 'At least 8 characters';
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  el.tabs.forEach((tab) => {
    tab.addEventListener('click', () => setAuthMode(tab.dataset.mode));
  });

  el.authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    el.authError.hidden = true;
    el.authSubmit.disabled = true;

    try {
      const { user } = await api(`/api/${state.authMode === 'login' ? 'login' : 'register'}`, {
        method: 'POST',
        body: JSON.stringify({
          username: el.username.value,
          password: el.password.value,
        }),
      });

      el.authForm.reset();
      await showChat(user);
    } catch (err) {
      el.authError.textContent = err.message;
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
    if (state.socket) state.socket.close();
    await api('/api/logout', { method: 'POST', body: JSON.stringify({}) }).catch(() => {});

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

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  setAuthMode('login');
  autoGrow();

  api('/api/me')
    .then(({ user }) => showChat(user))
    .catch(() => showAuth());
})();
