// Gift Links for Ghost — client.js
// https://giftlinks.net
//
// Injected via Ghost code injection. Detects gift links, shows gift button for paid members.

(function () {
  if (window.__gl4g_loaded) return;
  window.__gl4g_loaded = true;

  // Override with data-gl4g-api attribute for self-hosting: <script src="..." data-gl4g-api="https://your-worker.example.com">
  const API_BASE = document.querySelector('script[data-gl4g-api]')?.dataset.gl4gApi || 'https://giftlinks.net';
  const CONTENT_SELECTOR = document.querySelector('script[data-gl4g-content]')?.dataset.gl4gContent || null;
  const maxViewsAttr = document.querySelector('script[data-gl4g-max-views]')?.dataset.gl4gMaxViews;
  const MAX_VIEWS = maxViewsAttr !== undefined ? parseInt(maxViewsAttr, 10) : null;

  // Paywall gate detection with fallback chain
  function findPaywallGate() {
    const custom = document.querySelector('script[data-gl4g-gate]')?.dataset.gl4gGate;
    if (custom) return document.querySelector(custom);

    for (const sel of ['.gh-post-upgrade-cta', '.gh-cta', '.single-cta', '.content-cta', '.post-sneak-peek']) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    return null;
  }

  // Content container lookup with fallback chain
  function findContentContainer() {
    if (CONTENT_SELECTOR) {
      const matches = document.querySelectorAll(CONTENT_SELECTOR);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) console.error(`[gl4g] data-gl4g-content selector "${CONTENT_SELECTOR}" matched ${matches.length} elements — expected 1`);
      return null;
    }

    const ghContent = document.querySelector('.gh-content');
    if (ghContent) return ghContent;

    for (const sel of ['.post-content', '.post__content', '.post-body', 'article.post', 'article', '.content']) {
      const matches = document.querySelectorAll(sel);
      if (matches.length === 1) return matches[0];
    }

    return null;
  }

  // User-facing strings — site admins can override via window.gl4g_strings
  const DEFAULTS = {
    button_text: 'Gift this article',
    creating_text: 'Creating link\u2026',
    loading_text: 'Loading gifted article\u2026',
    expired_text: 'This gift link has expired.',
    limit_text: 'This gift link has reached its view limit.',
    error_text: 'There was a problem loading your gift link. Reload the page to try again.',
    created_text: 'Gift link created! Copy it below, or just share this page\u2019s URL.',
    gift_banner: 'This post was gifted to you by a paying member. <a href="#/portal/signup">Subscribe</a> for full access to the site.',
    copy_text: 'Copy',
    copied_text: 'Copied!',
  };
  const S = Object.assign({}, DEFAULTS, window.gl4g_strings);

  // Only run on post pages
  if (!document.body.classList.contains('post-template')) return;

  injectStyles();

  const giftToken = new URLSearchParams(location.search).get('gift');
  const paywallGate = findPaywallGate();

  if (giftToken) {
    redeemGiftLink(giftToken);
  } else {
    maybeShowGiftButton();
  }

  // — Styles —
  // Selectors use .gl4g prefix to avoid theme collisions.
  // Theme authors can override with .gh-content .gl4g-bar { ... } etc.

  // The button uses the theme's gh-button class (the subscribe button style)
  // so it inherits whatever the site admin's theme defines. We only inject
  // positioning overrides and bar styles (no Ghost class exists for inline banners).
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .gl4g-bar {
        padding: 12px 16px;
        margin-bottom: 24px;
        border-radius: 8px;
        border-left: 4px solid var(--ghost-accent-color, #333);
        background: #f9f9f9;
        color: #15171a;
        font-size: 15px;
        text-align: center;
        line-height: 1.5;
      }
      .gl4g-bar.gl4g-error {
        border-left-color: #c00;
        background: #fff3f3;
        color: #c00;
      }
      @keyframes gl4g-spin { to { transform: rotate(360deg); } }
      .gl4g-spinner {
        display: inline-block;
        width: 14px;
        height: 14px;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: gl4g-spin 0.6s linear infinite;
        vertical-align: middle;
        margin-right: 6px;
      }
      .gl4g-bar a {
        color: var(--ghost-accent-color, #333);
        font-weight: 600;
        text-decoration: underline;
      }
      .gl4g-url-row {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      .gl4g-url-input {
        flex: 1;
        min-width: 0;
        padding: 8px;
        border: 1px solid #dcdcdc;
        border-radius: 4px;
        font-size: 13px;
        color: #15171a;
        background: #fff;
        box-sizing: border-box;
      }
      .gl4g-copy-btn {
        padding: 8px 14px;
        border: 1px solid #dcdcdc;
        border-radius: 4px;
        background: #fff;
        color: #15171a;
        font-size: 13px;
        cursor: pointer;
        white-space: nowrap;
      }
      .gl4g-copy-btn:hover {
        background: #f0f0f0;
      }
      .gl4g-button--float {
        position: fixed;
        bottom: 24px;
        left: 24px;
        z-index: 9999;
        box-shadow: 0 2px 8px rgba(0,0,0,.2);
        border: none;
        font: inherit;
      }
      .gl4g-button:disabled {
        opacity: 0.5;
        cursor: default;
      }
    `;
    document.head.appendChild(style);
  }

  // — Gift Link Redemption —

  async function redeemGiftLink(token) {
    if (!paywallGate) {
      console.info('[gl4g] Gift token present but no paywall gate found — post may be public');
      return;
    }

    const container = findContentContainer();
    if (!container) {
      console.warn('[gl4g] No content container found — gift link not redeemed');
      return;
    }

    const loadingBar = showBar(container, '<span class="gl4g-spinner"></span>' + S.loading_text, 'info');

    try {
      const fetchBody = { token, url: location.href.split('?')[0] };
      if (CONTENT_SELECTOR) fetchBody.content_selector = CONTENT_SELECTOR;
      const response = await retryFetch(`${API_BASE}/api/gift-link/fetch-content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fetchBody),
      });

      if (response.ok) {
        const { html, gifter_name } = await response.json();
        paywallGate.remove();
        container.innerHTML = html;
        showBar(container, S.gift_banner.replace(/\{name\}/g, gifter_name), 'info');
        history.replaceState(null, '', removeQueryParam(location.href, 'gift'));
      } else {
        const { error } = await response.json();
        console.error(`[gl4g] Redeem failed: ${response.status} ${error}`);
        const msg = error === 'expired' ? S.expired_text : error === 'redemption_limit' ? S.limit_text : S.error_text;
        showBar(container, msg, 'error');
      }
    } catch (error) {
      console.error('[gl4g] Redeem failed:', error);
      showBar(container, S.error_text, 'error');
    } finally {
      loadingBar.hidden = true;
    }
  }


  // — Gift Button (for paid members) —

  async function maybeShowGiftButton() {
    if (paywallGate) {
      console.info('[gl4g] Paywall gate detected — user lacks access, no gift button');
      return;
    }

    if (!findContentContainer()) {
      console.warn('[gl4g] No content container found — gift button hidden');
      return;
    }

    // Check if user is logged in
    const sessionResponse = await fetch('/members/api/session', { credentials: 'same-origin' });
    if (sessionResponse.status === 204 || !sessionResponse.ok) {
      console.info('[gl4g] No member session — gift button not shown');
      return;
    }

    // Check if post is paywalled via Content API
    const portalScript = document.querySelector('script[data-ghost]');
    if (!portalScript || !portalScript.dataset.key) {
      console.error('[gl4g] Cannot find Ghost Portal script with data-key attribute');
      return;
    }
    const contentApiKey = portalScript.dataset.key;

    // TODO: consider using JSON-LD structured data for a more robust post identifier
    const canonicalLink = document.querySelector('link[rel="canonical"]');
    if (!canonicalLink) {
      console.error('[gl4g] No canonical link found');
      return;
    }
    const slug = new URL(canonicalLink.href).pathname.split('/').filter(Boolean).pop();
    const apiResponse = await fetch(`/ghost/api/content/posts/slug/${slug}/?key=${contentApiKey}&fields=access`);
    if (!apiResponse.ok) {
      console.error(`[gl4g] Content API returned ${apiResponse.status}`);
      return;
    }
    const { posts } = await apiResponse.json();
    if (!posts?.[0]) {
      console.error(`[gl4g] No post found for slug: ${slug}`);
      return;
    }
    if (posts[0].access === true) {
      console.info('[gl4g] Post is not paywalled — gift button not needed');
      return;
    }

    // Post is paywalled and user has access — show gift button
    const existing = document.querySelector('.gl4g-button');
    if (existing) {
      existing.addEventListener('click', handleGiftClick);
      const wrapper = existing.closest('.gl4g-button-wrapper');
      if (wrapper) wrapper.style.display = '';
    } else {
      const button = document.createElement('button');
      button.className = 'gl4g-button gl4g-button--float gh-button';
      button.textContent = S.button_text;
      button.addEventListener('click', handleGiftClick);
      document.body.appendChild(button);
    }
  }

  async function handleGiftClick(e) {
    e.preventDefault();
    const button = e.currentTarget;
    button.disabled = true;
    button.textContent = S.creating_text;

    try {
      const sessionResponse = await fetch('/members/api/session', { credentials: 'same-origin' });
      const jwt = await sessionResponse.text();

      const createBody = {
        jwt,
        url: location.origin + location.pathname,
        gifter_name: getMemberName(jwt),
      };
      if (MAX_VIEWS !== null) createBody.max_views = MAX_VIEWS;
      const response = await retryFetch(`${API_BASE}/api/gift-link/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      });

      if (!response.ok) throw new Error('create failed');
      const { token } = await response.json();
      if (!token) throw new Error('no token');

      const giftUrl = `${location.origin}${location.pathname}?gift=${token}`;

      history.replaceState(null, '', `${location.pathname}?gift=${token}`);

      button.remove();
      showCreateConfirmation(giftUrl);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      console.error('[gl4g] Gift link creation failed:', error);
      button.disabled = false;
      button.textContent = S.button_text;
      const container = findContentContainer();
      if (container) showBar(container, S.error_text, 'error');
    }
  }

  function showCreateConfirmation(giftUrl) {
    const container = findContentContainer();
    if (!container) return;

    const bar = showBar(container, S.created_text, 'success');

    const row = document.createElement('div');
    row.className = 'gl4g-url-row';

    const urlBox = document.createElement('input');
    urlBox.className = 'gl4g-url-input';
    urlBox.type = 'text';
    urlBox.readOnly = true;
    urlBox.value = giftUrl;
    urlBox.addEventListener('click', function () { this.select(); });

    const copyBtn = document.createElement('button');
    copyBtn.className = 'gl4g-copy-btn';
    copyBtn.textContent = S.copy_text;
    copyBtn.addEventListener('click', async function () {
      urlBox.select();
      try {
        await navigator.clipboard.writeText(giftUrl);
        copyBtn.textContent = S.copied_text;
      } catch (e) {
        document.execCommand('select');
      }
    });

    row.appendChild(urlBox);
    row.appendChild(copyBtn);
    bar.appendChild(row);
  }

  // — Shared UI —

  function showBar(container, html, type) {
    // Theme-placed bar: use existing element if data-gl4g-bar specifies a selector
    const barSelector = document.querySelector('script[data-gl4g-bar]')?.dataset.gl4gBar;
    const existing = barSelector && document.querySelector(barSelector);
    if (existing) {
      existing.classList.remove('gl4g-info', 'gl4g-error', 'gl4g-success');
      existing.classList.add(`gl4g-${type}`);
      existing.innerHTML = html;
      existing.hidden = !existing.textContent.trim();
      return existing;
    }

    const bar = document.createElement('div');
    bar.className = `gl4g-bar gl4g-${type}`;
    bar.innerHTML = html;
    bar.hidden = !bar.textContent.trim();
    if (container) container.prepend(bar);
    return bar;
  }

  // — Utilities —

  // Single retry after 2s for network errors or 5xx responses
  async function retryFetch(url, opts) {
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500) throw res;
      return res;
    } catch (first) {
      await new Promise(r => setTimeout(r, 2000));
      return fetch(url, opts);
    }
  }

  function getMemberName(jwt) {
    const payload = JSON.parse(atob(jwt.split('.')[1]));
    return payload.name || payload.sub.split('@')[0];
  }

  function removeQueryParam(url, param) {
    const parsed = new URL(url);
    parsed.searchParams.delete(param);
    return parsed.pathname + (parsed.searchParams.size ? '?' + parsed.searchParams : '');
  }
})();
