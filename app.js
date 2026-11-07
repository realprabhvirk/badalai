(function () {
  'use strict';

  const API_URL = '/api/chat';
  const MAX_HISTORY = 20;          // turns kept in memory and sent to the backend
  const MAX_INPUT_BYTES = 15 * 1024 * 1024; // raw file size accepted before compression
  const MAX_IMAGE_EDGE = 1600;
  const TARGET_BASE64 = 2_200_000; // stay well under the backend limit
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  // In-memory only. Nothing is written to localStorage, IndexedDB or the server.
  const state = {
    history: [],     // { role: 'user' | 'assistant', content: string }
    busy: false,
    image: null,     // { dataUrl, mimeType, data, name } while previewing
  };

  const $ = (sel) => document.querySelector(sel);
  const els = {
    welcome: $('#welcome'),
    messages: $('#messages'),
    stage: $('#stage'),
    form: $('#composer'),
    input: $('#input'),
    send: $('#send-btn'),
    attachBtn: $('#attach-btn'),
    cameraBtn: $('#camera-btn'),
    fileInput: $('#file-input'),
    cameraInput: $('#camera-input'),
    preview: $('#attach-preview'),
    thumb: $('#attach-thumb'),
    attachName: $('#attach-name'),
    attachRemove: $('#attach-remove'),
    newChat: $('#new-chat-btn'),
    info: $('#info-btn'),
    infoDialog: $('#info-dialog'),
    infoClose: $('#info-close'),
  };

  /* ---------------- Markdown (safe: escape first, then format) ---------------- */

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function linkTag(url, label) {
    return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  }

  function renderInline(raw) {
    let s = escapeHtml(raw.replace(/\u0000/g, ''));
    const codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) {
      codes.push(c);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, t, u) {
      return linkTag(u, t);
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_, p, u) {
      return p + linkTag(u, u);
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) {
      return '<code>' + escapeHtml(codes[Number(i)]) + '</code>';
    });
    return s;
  }

  function renderMarkdown(src) {
    const lines = String(src).replace(/\r/g, '').split('\n');
    const out = [];
    let para = [];
    let list = null; // { type: 'ul' | 'ol', items: [] }
    let inCode = false;
    let code = [];

    function flushPara() {
      if (para.length) {
        out.push('<p>' + para.map(renderInline).join('<br>') + '</p>');
        para = [];
      }
    }
    function flushList() {
      if (list) {
        out.push('<' + list.type + '>' + list.items.map(function (i) {
          return '<li>' + renderInline(i) + '</li>';
        }).join('') + '</' + list.type + '>');
        list = null;
      }
    }

    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (inCode) {
          out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
          code = [];
          inCode = false;
        } else {
          flushPara(); flushList();
          inCode = true;
        }
        continue;
      }
      if (inCode) { code.push(line); continue; }

      if (!line.trim()) { flushPara(); flushList(); continue; }

      const h = line.match(/^\s*(#{1,4})\s+(.*)$/);
      if (h) {
        flushPara(); flushList();
        const tag = h[1].length <= 2 ? 'h3' : 'h4';
        out.push('<' + tag + '>' + renderInline(h[2]) + '</' + tag + '>');
        continue;
      }

      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const type = ul ? 'ul' : 'ol';
        if (!list || list.type !== type) { flushList(); list = { type: type, items: [] }; }
        list.items.push((ul || ol)[1]);
        continue;
      }

      flushList();
      para.push(line.trim());
    }

    if (inCode) out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
    flushPara();
    flushList();
    return out.join('');
  }

  /* ---------------- DOM helpers ---------------- */

  function scrollToBottom() {
    requestAnimationFrame(function () {
      els.stage.scrollTo({ top: els.stage.scrollHeight, behavior: 'smooth' });
    });
  }

  function hideWelcome() {
    if (els.welcome.hidden || els.welcome.classList.contains('leaving')) return;
    els.welcome.classList.add('leaving');
    setTimeout(function () { els.welcome.hidden = true; }, 340);
  }

  function addUserMessage(text, imageUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    if (imageUrl) {
      const img = document.createElement('img');
      img.className = 'user-image';
      img.src = imageUrl;
      img.alt = 'Uploaded image';
      wrap.appendChild(img);
    }
    if (text) {
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = text;
      wrap.appendChild(b);
    }
    els.messages.appendChild(wrap);
    scrollToBottom();
  }

  function addAiMessage(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-ai';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = renderMarkdown(text);
    wrap.appendChild(bubble);

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'icon-btn';
    copy.setAttribute('aria-label', 'Copy response');
    copy.title = 'Copy response';
    copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
    copy.addEventListener('click', function () {
      copyText(text).then(function (ok) {
        copy.classList.toggle('copied', ok);
        copy.title = ok ? 'Copied' : 'Copy failed';
        setTimeout(function () { copy.classList.remove('copied'); copy.title = 'Copy response'; }, 1500);
      });
    });
    actions.appendChild(copy);
    wrap.appendChild(actions);

    els.messages.appendChild(wrap);
    scrollToBottom();
  }

  function addErrorMessage(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-ai msg-error';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.setAttribute('role', 'alert');
    bubble.textContent = text;
    wrap.appendChild(bubble);
    els.messages.appendChild(wrap);
    scrollToBottom();
  }

  function showTyping() {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-ai';
    wrap.id = 'typing';
    wrap.setAttribute('aria-label', 'Badal AI is typing');
    wrap.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    els.messages.appendChild(wrap);
    scrollToBottom();
  }

  function hideTyping() {
    const t = document.getElementById('typing');
    if (t) t.remove();
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  /* ---------------- Composer ---------------- */

  function autoGrow() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 180) + 'px';
  }

  function updateSendState() {
    const hasText = els.input.value.trim().length > 0;
    els.send.disabled = state.busy || (!hasText && !state.image);
    els.send.classList.toggle('busy', state.busy);
  }

  function setImage(img) {
    state.image = img;
    if (img) {
      els.thumb.src = img.dataUrl;
      els.attachName.textContent = img.name;
      els.preview.hidden = false;
    } else {
      els.thumb.removeAttribute('src');
      els.attachName.textContent = '';
      els.preview.hidden = true;
    }
    updateSendState();
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  // Resize and re-encode as JPEG so every upload is small and uniform.
  async function compressImage(file) {
    const img = await loadImage(file);
    let scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    let quality = 0.86;
    for (let attempt = 0; attempt < 4; attempt++) {
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; // flatten transparent PNGs onto white
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
      if (data.length <= TARGET_BASE64) {
        return { dataUrl: dataUrl, mimeType: 'image/jpeg', data: data };
      }
      scale *= 0.75;
      quality = Math.max(0.6, quality - 0.1);
    }
    throw new Error('too-large');
  }

  async function handleFile(file) {
    if (!file) return;
    if (!ALLOWED_TYPES.includes(file.type)) {
      addErrorMessage('That image format is not supported. Please upload a JPEG, PNG or WebP image.');
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      addErrorMessage('That image is too large. Please choose one under 15 MB.');
      return;
    }
    try {
      const compressed = await compressImage(file);
      setImage({ dataUrl: compressed.dataUrl, mimeType: compressed.mimeType, data: compressed.data, name: file.name || 'photo.jpg' });
      els.input.focus();
    } catch (err) {
      const tooLarge = err && err.message === 'too-large';
      addErrorMessage(tooLarge
        ? 'That image could not be compressed small enough. Please try a smaller image.'
        : 'Could not read that image. Please try another file.');
    }
  }

  /* ---------------- Chat flow ---------------- */

  function describeError(status, payload) {
    if (status === 404 || status === 405) {
      return 'The chat backend is missing or misconfigured. /api/chat was not found, so the Cloudflare Pages Functions deployment needs to be checked.';
    }
    if (payload && payload.error && typeof payload.error.message === 'string') {
      return payload.error.message;
    }
    if (status === 429) return 'Too many requests right now. Please wait a moment and try again.';
    if (status >= 500) return 'The server had a problem. Please try again shortly.';
    return 'Something went wrong. Please try again.';
  }

  async function sendMessage(rawText) {
    if (state.busy) return;
    const text = (rawText || '').trim();
    const image = state.image;
    if (!text && !image) return;

    state.busy = true;
    hideWelcome();
    updateSendState();

    const prior = state.history.slice(-MAX_HISTORY);
    addUserMessage(text, image ? image.dataUrl : null);

    // Only text is kept in history; image bytes are not re-sent on later turns.
    const historyText = image ? (text ? text + ' [image attached]' : '[image attached]') : text;
    state.history.push({ role: 'user', content: historyText });

    els.input.value = '';
    autoGrow();
    setImage(null);
    showTyping();

    const payload = { message: text, history: prior };
    if (image) payload.image = { mimeType: image.mimeType, data: image.data };

    let reply = null;
    let errorText = null;

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
        credentials: 'same-origin',
      });

      let data = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try { data = await res.json(); } catch (e) { data = null; }
      }

      if (res.ok && data && typeof data.reply === 'string' && data.reply.trim()) {
        reply = data.reply;
      } else if (res.ok) {
        errorText = 'The server returned an unexpected response. Please try again.';
      } else if (!ct.includes('application/json') && res.status !== 404 && res.status !== 405) {
        errorText = 'The server returned an unexpected response. Please try again.';
      } else {
        errorText = describeError(res.status, data);
      }
    } catch (err) {
      errorText = 'Could not reach the server. Check your connection and try again.';
    }

    hideTyping();
    state.busy = false;

    if (reply !== null) {
      state.history.push({ role: 'assistant', content: reply });
      if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
      addAiMessage(reply);
    } else {
      // Roll back the failed user turn so it can be retried cleanly. No fake reply is shown.
      state.history.pop();
      addErrorMessage(errorText);
      if (!els.input.value && text) {
        els.input.value = text;
        autoGrow();
      }
    }
    updateSendState();
    els.input.focus();
  }

  function resetChat() {
    if (state.busy) return;
    state.history = [];
    state.image = null;
    els.messages.innerHTML = '';
    els.input.value = '';
    autoGrow();
    setImage(null);
    els.welcome.classList.remove('leaving');
    els.welcome.hidden = false;
    els.stage.scrollTo({ top: 0, behavior: 'auto' });
    updateSendState();
    els.input.focus();
  }

  /* ---------------- Events ---------------- */

  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    sendMessage(els.input.value);
  });

  els.input.addEventListener('keydown', function (e) {
    // Enter sends; Shift+Enter inserts a newline. Ignore Enter while composing (IME).
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (!els.send.disabled) sendMessage(els.input.value);
    }
  });

  els.input.addEventListener('input', function () {
    autoGrow();
    updateSendState();
  });

  els.attachBtn.addEventListener('click', function () { els.fileInput.click(); });
  els.cameraBtn.addEventListener('click', function () { els.cameraInput.click(); });

  els.fileInput.addEventListener('change', function () {
    const f = els.fileInput.files[0];
    els.fileInput.value = '';
    handleFile(f);
  });
  els.cameraInput.addEventListener('change', function () {
    const f = els.cameraInput.files[0];
    els.cameraInput.value = '';
    handleFile(f);
  });

  els.attachRemove.addEventListener('click', function () { setImage(null); els.input.focus(); });

  els.newChat.addEventListener('click', resetChat);

  els.info.addEventListener('click', function () {
    if (typeof els.infoDialog.showModal === 'function') els.infoDialog.showModal();
  });
  els.infoClose.addEventListener('click', function () { els.infoDialog.close(); });
  els.infoDialog.addEventListener('click', function (e) {
    if (e.target === els.infoDialog) els.infoDialog.close();
  });

  autoGrow();
  updateSendState();
})();
