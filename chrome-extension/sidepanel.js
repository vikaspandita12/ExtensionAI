// ─── Browser Agent — Side Panel Controller ──────────────────────────────────
// Manages the chat UI, agentic task loop, and action approval flow.
// This is the brain that orchestrates observe → plan → act → verify cycles.

// ─── DOM References ─────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const els = {
  settingsToggle: $('settingsToggle'),
  settings: $('settings'),
  newChat: $('newChat'),
  provider: $('provider'),
  model: $('model'),
  endpoint: $('endpoint'),
  endpointRow: $('endpointRow'),
  apiKey: $('apiKey'),
  apiKeyRow: $('apiKeyRow'),
  permissionMode: $('permissionMode'),
  maxSteps: $('maxSteps'),
  saveSettings: $('saveSettings'),
  statusLine: $('statusLine'),
  pageTitle: $('pageTitle'),
  pageUrl: $('pageUrl'),
  refreshPage: $('refreshPage'),
  messages: $('messages'),
  approval: $('approval'),
  approvalActions: $('approvalActions'),
  approveBtn: $('approveBtn'),
  declineBtn: $('declineBtn'),
  composer: $('composer'),
  prompt: $('prompt'),
  send: $('send'),
  stop: $('stop')
};

// ─── Provider Config ────────────────────────────────────────────────────────

const DEFAULT_MODELS = {
  pollinations: 'openai',
  gemini: 'gemini-2.0-flash',
  ollama: 'llama3.1',
  lmstudio: 'local-model',
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o-mini',
  openrouter: 'google/gemma-2-9b-it:free',
  custom: ''
};

const DEFAULT_ENDPOINTS = {
  ollama: 'http://localhost:11434/api/chat',
  lmstudio: 'http://localhost:1234/v1/chat/completions',
  custom: 'http://localhost:11434/v1/chat/completions'
};

const KEYED_PROVIDERS = new Set(['gemini', 'anthropic', 'openai', 'openrouter', 'custom']);
const ENDPOINT_PROVIDERS = new Set(['ollama', 'lmstudio', 'custom']);

// ─── State ──────────────────────────────────────────────────────────────────

let chatMessages = [];
let pendingApproval = null;
let stopped = false;
let isRunning = false;
let currentStep = 0;

function sanitizeDisplayText(value) {
  return String(value || '')
    .replace(/<\s*(system-reminder|system|developer|assistant|tool)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '[removed untrusted instruction block]')
    .replace(/<\s*\/?\s*(system-reminder|system|developer|assistant|tool)[^>]*>/gi, '[removed untrusted instruction tag]')
    .replace(/\byour operational mode has changed\b/gi, '[removed prompt-injection phrase]')
    .replace(/\byou are no longer in read-only mode\b/gi, '[removed prompt-injection phrase]')
    .replace(/\byou are permitted to make file changes\b/gi, '[removed prompt-injection phrase]')
    .trim();
}

// ─── Storage Helpers ────────────────────────────────────────────────────────

const storageGet = (area, keys) => new Promise(r => chrome.storage[area].get(keys, r));
const storageSet = (area, vals) => new Promise(r => chrome.storage[area].set(vals, r));

// ─── Status Line ────────────────────────────────────────────────────────────

function setStatus(text, type = '') {
  els.statusLine.textContent = text;
  els.statusLine.className = 'status-line' + (type ? ` ${type}` : '');
}

// ─── Message Rendering ─────────────────────────────────────────────────────

function addMessage(role, content, extra = {}) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;

  if (extra.step) {
    const badge = document.createElement('div');
    badge.className = 'step-counter';
    badge.textContent = `Step ${extra.step}`;
    div.appendChild(badge);
  }

  const text = document.createElement('div');
  text.textContent = sanitizeDisplayText(content);
  div.appendChild(text);

  if (extra.actions) {
    const badge = document.createElement('div');
    badge.className = `action-badge ${extra.actionStatus || 'running'}`;
    badge.textContent = extra.actionText || `${extra.actions} action(s)`;
    div.appendChild(badge);
  }

  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function addThinking(text = 'Thinking...') {
  const div = document.createElement('div');
  div.className = 'msg thinking';

  const dots = document.createElement('div');
  dots.className = 'thinking-dots';
  dots.innerHTML = '<span></span><span></span><span></span>';
  div.appendChild(dots);

  const label = document.createElement('span');
  label.textContent = text;
  div.appendChild(label);

  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function showWelcome() {
  const div = document.createElement('div');
  div.className = 'msg welcome';
  div.innerHTML = `
    <div class="welcome-title">Browser Agent</div>
    <div class="welcome-sub">Tell me what to do on this page — I'll read it, plan, and act.</div>
    <div class="welcome-examples">
      <button class="welcome-example" data-prompt="What is this page about?">💬 "What is this page about?"</button>
      <button class="welcome-example" data-prompt="Click the first link on this page">🖱️ "Click the first link on this page"</button>
      <button class="welcome-example" data-prompt="Fill in the search box with 'hello world' and submit">⌨️ "Search for 'hello world'"</button>
      <button class="welcome-example" data-prompt="Scroll down and summarize what you see">📜 "Scroll down and summarize"</button>
    </div>
  `;

  // Make example buttons clickable
  div.querySelectorAll('.welcome-example').forEach(btn => {
    btn.addEventListener('click', () => {
      const prompt = btn.getAttribute('data-prompt');
      if (prompt) {
        els.prompt.value = prompt;
        els.composer.dispatchEvent(new Event('submit'));
      }
    });
  });

  els.messages.appendChild(div);
}

// ─── Busy State ─────────────────────────────────────────────────────────────

function setBusy(busy) {
  isRunning = busy;
  els.send.disabled = busy;
  els.prompt.disabled = busy;
  els.refreshPage.disabled = busy;
}

// ─── Provider UI ────────────────────────────────────────────────────────────

function updateProviderUI() {
  const provider = els.provider.value;
  els.endpointRow.classList.toggle('hidden', !ENDPOINT_PROVIDERS.has(provider));
  els.apiKeyRow.classList.toggle('hidden', !KEYED_PROVIDERS.has(provider));
  els.model.placeholder = DEFAULT_MODELS[provider] || 'auto';
  els.endpoint.placeholder = DEFAULT_ENDPOINTS[provider] || '';
}

// ─── Settings Load / Save ───────────────────────────────────────────────────

async function loadSettings() {
  const data = await storageGet('local', ['agentSettings', 'agentApiKeys', 'agentHistory']);
  const s = data.agentSettings || {};
  const keys = data.agentApiKeys || {};

  els.provider.value = s.provider || 'pollinations';
  els.model.value = s.model || '';
  els.endpoint.value = s.endpoint || '';
  els.permissionMode.value = s.permissionMode || 'ask';
  els.maxSteps.value = String(s.maxSteps || 10);
  els.apiKey.value = keys[els.provider.value] || '';

  chatMessages = Array.isArray(data.agentHistory)
    ? data.agentHistory.slice(-20).map(m => ({ ...m, content: sanitizeDisplayText(m.content) }))
    : [];
  updateProviderUI();

  if (chatMessages.length) {
    chatMessages.forEach(m => addMessage(m.role === 'user' ? 'user' : 'assistant', m.content));
  } else {
    showWelcome();
  }
}

async function saveSettings(silent = false) {
  const provider = els.provider.value;
  const data = await storageGet('local', ['agentApiKeys']);
  const keys = data.agentApiKeys || {};
  if (KEYED_PROVIDERS.has(provider)) keys[provider] = els.apiKey.value.trim();

  await storageSet('local', {
    agentApiKeys: keys,
    agentSettings: {
      provider,
      model: els.model.value.trim(),
      endpoint: els.endpoint.value.trim(),
      permissionMode: els.permissionMode.value,
      maxSteps: parseInt(els.maxSteps.value) || 10
    }
  });

  if (!silent) addMessage('system', '✓ Settings saved.');
}

function getConfig() {
  const provider = els.provider.value;
  return {
    provider,
    model: els.model.value.trim() || DEFAULT_MODELS[provider] || '',
    endpoint: els.endpoint.value.trim() || DEFAULT_ENDPOINTS[provider] || '',
    apiKey: els.apiKey.value.trim(),
    permissionMode: els.permissionMode.value,
    maxSteps: parseInt(els.maxSteps.value) || 10
  };
}

// ─── Tab & Content Script ───────────────────────────────────────────────────

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error('No active tab found.');
  return tabs[0];
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['styles.css'] });
    } catch (err) {
      throw new Error('Cannot access this page. Try a regular webpage (not chrome:// or extension pages).');
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

async function readPageContext() {
  const tab = await getActiveTab();

  if (!/^https?:|^file:/.test(tab.url || '')) {
    throw new Error('Cannot control Chrome internal pages. Open a regular webpage.');
  }

  await ensureContentScript(tab.id);
  const response = await chrome.tabs.sendMessage(tab.id, { action: 'getPageContext' });
  if (response?.error) throw new Error(response.error);

  const ctx = response.pageContext;
  els.pageTitle.textContent = ctx.title || tab.title || 'Untitled';
  els.pageUrl.textContent = ctx.url || tab.url || '';
  return { tab, pageContext: ctx };
}

// ─── Action Execution ───────────────────────────────────────────────────────

async function executeAction(tab, action) {
  // Navigate is handled at the tab level
  if (action.type === 'navigate') {
    try {
      const url = new URL(action.url, tab.url);
      if (!/^https?:$/.test(url.protocol)) throw new Error(`Blocked URL: ${url.href}`);
      await chrome.tabs.update(tab.id, { url: url.href });
      // Wait for page load
      await new Promise(resolve => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        // Timeout fallback
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 8000);
      });
      await new Promise(r => setTimeout(r, 500)); // Extra settle time
      return { ok: true, type: 'navigate', url: url.href };
    } catch (err) {
      throw new Error(`Navigation failed: ${err.message}`);
    }
  }

  // Done action
  if (action.type === 'done') {
    return { ok: true, type: 'done', reason: action.reason || 'Task complete' };
  }

  // All other actions go through content script
  await ensureContentScript(tab.id);
  const response = await chrome.tabs.sendMessage(tab.id, {
    action: 'executeAction',
    agentAction: action
  });

  if (response?.error) throw new Error(response.error);
  return { ok: true, type: action.type, detail: response.result };
}

// ─── Approval Flow ──────────────────────────────────────────────────────────

function shouldAutoApprove(actions, config) {
  if (config.permissionMode === 'auto-all') return true;
  if (config.permissionMode === 'auto-low') {
    return actions.every(a => String(a.risk || 'low').toLowerCase() === 'low');
  }
  return false; // 'ask' mode
}

function renderApproval(actions) {
  els.approvalActions.innerHTML = '';

  actions.forEach(action => {
    const item = document.createElement('div');
    item.className = 'approval-item';

    const risk = String(action.risk || 'low').toLowerCase();
    item.innerHTML = `
      <span class="action-type">${action.type}</span>
      <span class="risk-badge ${risk}">${risk}</span>
      <span>${escapeHtml(action.reason || '')}${action.targetId ? ` (${action.targetId})` : ''}${action.text ? `: "${escapeHtml(action.text).slice(0, 80)}"` : ''}${action.url ? `: ${escapeHtml(action.url).slice(0, 80)}` : ''}</span>
    `;

    els.approvalActions.appendChild(item);
  });

  els.approval.classList.remove('hidden');
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ─── The Agentic Loop ───────────────────────────────────────────────────────
// This is the core: observe → query AI → execute actions → repeat
// Runs autonomously until: task done, max steps reached, user stops, or error.

async function runAgentLoop(userText) {
  if (isRunning) return;
  stopped = false;
  currentStep = 0;

  const config = getConfig();
  const maxSteps = config.maxSteps;

  // Add user message
  addMessage('user', userText);
  chatMessages.push({ role: 'user', content: sanitizeDisplayText(userText) });

  setBusy(true);

  try {
    let continueLoop = true;
    let feedbackText = userText;

    while (continueLoop && currentStep < maxSteps && !stopped) {
      currentStep++;
      const isFollowUp = currentStep > 1;

      setStatus(isFollowUp ? `Acting... (step ${currentStep}/${maxSteps})` : 'Thinking...', isFollowUp ? 'acting' : 'thinking');
      const thinkingEl = addThinking(isFollowUp ? `Step ${currentStep}: Observing page...` : 'Reading page and thinking...');

      try {
        // 1. OBSERVE — read the page
        const { tab, pageContext } = await readPageContext();

        if (stopped) { thinkingEl.remove(); break; }

        // 2. THINK — query the AI
        thinkingEl.querySelector('span').textContent = isFollowUp
          ? `Step ${currentStep}: Planning next action...`
          : 'Thinking...';

        const response = await chrome.runtime.sendMessage({
          action: 'agentQuery',
          provider: config.provider,
          apiKey: config.apiKey,
          model: config.model,
          endpoint: config.endpoint,
          pageContext,
          previousMessages: chatMessages.slice(-8).map(m => ({ ...m, content: sanitizeDisplayText(m.content) })),
          userText: feedbackText
        });

        thinkingEl.remove();

        if (stopped) break;
        if (response?.error) throw new Error(response.error);

        const result = response.result || {};
        const message = result.message || 'No response.';
        const actions = (result.actions || []).filter(a => a && a.type);

        // Show warning if provider fell back
        if (result.warning) addMessage('system', result.warning);
        if (result.providerUsed && result.providerUsed !== config.provider) {
          addMessage('system', `Used ${result.providerUsed} as fallback.`);
        }

        // Display assistant message
        const msgExtra = actions.length
          ? { step: currentStep, actions: actions.length, actionText: `${actions.length} action(s) pending` }
          : (currentStep > 1 ? { step: currentStep } : {});
        const msgEl = addMessage('assistant', message, msgExtra);

        chatMessages.push({ role: 'assistant', content: sanitizeDisplayText(message) });
        chatMessages = chatMessages.slice(-20);
        storageSet('local', { agentHistory: chatMessages }).catch(() => {});

        // 3. ACT — execute actions or stop
        if (!actions.length) {
          continueLoop = false;
          break;
        }

        // Check for 'done' action
        const doneAction = actions.find(a => a.type === 'done');
        if (doneAction) {
          // Update badge to done
          const badge = msgEl.querySelector('.action-badge');
          if (badge) { badge.className = 'action-badge done'; badge.textContent = '✓ Task complete'; }
          continueLoop = false;
          break;
        }

        // Approval check
        if (!shouldAutoApprove(actions, config)) {
          // Show approval UI and wait
          await new Promise((resolve, reject) => {
            renderApproval(actions);
            pendingApproval = { resolve, reject, actions, tab };
          });

          if (stopped) break;
        }

        // Execute each action
        const actionResults = [];
        for (const action of actions) {
          if (stopped) break;

          try {
            setStatus(`Running: ${action.type}${action.targetId ? ` on ${action.targetId}` : ''}...`, 'acting');
            const result = await executeAction(tab, action);
            actionResults.push({ action: action.type, success: true, ...result });

            if (action.type === 'done') {
              continueLoop = false;
              break;
            }
          } catch (err) {
            actionResults.push({ action: action.type, success: false, error: err.message });
            addMessage('error', `Action failed: ${action.type} — ${err.message}`);
            // Don't break — let the AI decide what to do next
          }

          // Brief pause between actions
          await new Promise(r => setTimeout(r, 300));
        }

        // Update the message badge
        const badge = msgEl.querySelector('.action-badge');
        const allOk = actionResults.every(r => r.success);
        if (badge) {
          badge.className = `action-badge ${allOk ? 'done' : 'failed'}`;
          badge.textContent = allOk ? `✓ ${actionResults.length} action(s) done` : `⚠ Some actions failed`;
        }

        // Prepare feedback for next iteration
        feedbackText = `Action results from step ${currentStep}:\n${JSON.stringify(actionResults, null, 2)}\n\nContinue the task. If the task is complete, respond with a "done" action. If not, plan the next steps.`;

      } catch (err) {
        thinkingEl?.remove?.();
        addMessage('error', err.message);
        continueLoop = false;
      }
    }

    if (stopped) {
      setStatus('Stopped', '');
      addMessage('system', 'Agent stopped.');
    } else if (currentStep >= maxSteps) {
      setStatus(`Reached ${maxSteps} step limit`, '');
      addMessage('system', `Reached the maximum of ${maxSteps} steps. You can increase this in settings.`);
    } else {
      setStatus('Ready', 'success');
    }

  } finally {
    setBusy(false);
    pendingApproval = null;
    els.approval.classList.add('hidden');
  }
}

// ─── Event Listeners ────────────────────────────────────────────────────────

// Settings toggle
els.settingsToggle.addEventListener('click', () => {
  els.settings.classList.toggle('hidden');
});

// Provider change
els.provider.addEventListener('change', async () => {
  updateProviderUI();
  const data = await storageGet('local', ['agentApiKeys']);
  els.apiKey.value = (data.agentApiKeys || {})[els.provider.value] || '';
  els.model.value = '';
});

// Save settings
els.saveSettings.addEventListener('click', () => saveSettings());

// New chat
els.newChat.addEventListener('click', () => {
  chatMessages = [];
  els.messages.innerHTML = '';
  storageSet('local', { agentHistory: [] }).catch(() => {});
  showWelcome();
  setStatus('Ready', '');
});

// Refresh page
els.refreshPage.addEventListener('click', async () => {
  try {
    setStatus('Reading page...', 'thinking');
    const { pageContext } = await readPageContext();
    addMessage('system', `Read page: ${pageContext.elements.length} elements, ${pageContext.forms.length} forms.`);
    setStatus('Ready', 'success');
  } catch (err) {
    addMessage('error', err.message);
    setStatus('Error', 'error');
  }
});

// Submit prompt
els.composer.addEventListener('submit', async event => {
  event.preventDefault();
  const text = els.prompt.value.trim();
  if (!text || isRunning) return;

  els.prompt.value = '';
  els.approval.classList.add('hidden');

  // Remove welcome if present
  const welcome = els.messages.querySelector('.msg.welcome');
  if (welcome) welcome.remove();

  await saveSettings(true);
  await runAgentLoop(text);
});

// Enter to send (shift+enter for newline)
els.prompt.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.composer.dispatchEvent(new Event('submit'));
  }
});

// Auto-resize textarea
els.prompt.addEventListener('input', () => {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = Math.min(els.prompt.scrollHeight, 120) + 'px';
});

// Approve actions
els.approveBtn.addEventListener('click', () => {
  if (pendingApproval) {
    els.approval.classList.add('hidden');
    pendingApproval.resolve();
    pendingApproval = null;
  }
});

// Decline actions
els.declineBtn.addEventListener('click', () => {
  if (pendingApproval) {
    stopped = true;
    els.approval.classList.add('hidden');
    pendingApproval.resolve(); // Resolve (stopped flag will break the loop)
    pendingApproval = null;
    addMessage('system', 'Actions declined.');
  }
});

// Stop button
els.stop.addEventListener('click', () => {
  stopped = true;
  if (pendingApproval) {
    els.approval.classList.add('hidden');
    pendingApproval.resolve();
    pendingApproval = null;
  }
  setBusy(false);
  setStatus('Stopped', '');
});

// ─── Initialize ─────────────────────────────────────────────────────────────

loadSettings().then(() => {
  readPageContext().catch(() => {
    setStatus('Open a webpage to get started', '');
  });
});
