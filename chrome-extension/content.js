// ─── Browser Agent — Content Script ─────────────────────────────────────────
// Runs on every page. Provides page context extraction and action execution
// for the browser agent. No quiz/study code — pure browser automation.

// ─── Constants ──────────────────────────────────────────────────────────────

const AGENT_HIGHLIGHT_CLASS = 'browser-agent-highlight';
const AGENT_ACTING_CLASS = 'browser-agent-acting';

// ─── Utility Helpers ────────────────────────────────────────────────────────

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && parseFloat(style.opacity) > 0;
}

function getCleanText(el, maxLen = 1200) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll('img').forEach(img => {
    const alt = img.getAttribute('alt') || '';
    if (alt) img.replaceWith(document.createTextNode(`[Image: ${alt}]`));
    else img.remove();
  });
  clone.querySelectorAll('script, style, noscript, svg, iframe, link, meta').forEach(n => n.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function getVisibleText(el, maxLen = 1200) {
  if (!el) return '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script, style, noscript, svg, iframe, link, meta, [aria-hidden="true"]')) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return isVisible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const parts = [];
  let total = 0;
  let node;
  while ((node = walker.nextNode()) && total < maxLen) {
    const text = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    parts.push(text);
    total += text.length + 1;
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Element Registry ───────────────────────────────────────────────────────
// Maps stable IDs to DOM elements. IDs are generated per scan and remain
// valid until the next scan.

let elementSeq = 0;
const elementMap = new Map();

function registerElement(el) {
  const id = `e${++elementSeq}`;
  elementMap.set(id, el);
  el.setAttribute('data-agent-id', id);
  return id;
}

function getElement(targetId) {
  if (!targetId) return null;
  const mapped = elementMap.get(targetId);
  if (mapped && document.contains(mapped)) return mapped;
  return document.querySelector(`[data-agent-id="${CSS.escape(targetId)}"]`);
}

function getElementLabel(el) {
  if (!el) return '';
  // aria-label, title, alt
  const aria = el.getAttribute('aria-label')
    || el.getAttribute('title')
    || el.getAttribute('alt')
    || '';
  if (aria) return aria.trim().slice(0, 160);

  // Associated <label>
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return getVisibleText(label, 160) || getCleanText(label, 160);
  }

  // Wrapping <label>
  const wrapping = el.closest('label');
  if (wrapping) return getVisibleText(wrapping, 160) || getCleanText(wrapping, 160);

  return '';
}

function describeElement(el) {
  const rect = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const text = getVisibleText(el, 180) || getCleanText(el, 180);
  return {
    id: registerElement(el),
    tag,
    role: el.getAttribute('role') || '',
    type: el.getAttribute('type') || '',
    name: el.getAttribute('name') || '',
    label: getElementLabel(el),
    placeholder: el.getAttribute('placeholder') || '',
    text,
    href: tag === 'a' ? (el.getAttribute('href') || '') : '',
    value: ['input', 'textarea', 'select'].includes(tag)
      ? String(el.value || '').slice(0, 120) : '',
    visible: isVisible(el),
    disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

// ─── Page Context Extraction ────────────────────────────────────────────────

function getInteractiveElements(limit = 200) {
  elementMap.clear();
  elementSeq = 0;

  // Standard interactive elements
  const selector = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
    '[contenteditable="true"]',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[role="checkbox"]', '[role="radio"]', '[role="combobox"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]',
    '[role="switch"]',
    '[tabindex]:not([tabindex="-1"])',
    // Quiz/assessment option patterns
    '[onclick]',
    'label[for]',
    // IndiaBix specific
    '.bix-td-option', '[id^="tdOptionNo_"]', '[id^="lnkOptionLink_"]',
    '[class*="option-svg-letter"]',
    '.bix-opt-row',
    // General quiz patterns  
    'span[id*="Option"]', 'span[id*="option"]',
    'div[id*="Option"]', 'div[id*="option"]',
    '[class*="option"]', '[class*="Option"]',
    '[class*="answer"]', '[class*="Answer"]',
    '[class*="choice"]', '[class*="Choice"]',
    '[data-value]', '[data-answer]',
    'li[class*="opt"]', 'div[class*="opt"]'
  ].join(',');

  const seen = new Set();
  const elements = [];

  // Helper: is this element a quiz option? (relaxed visibility check)
  function isQuizOption(el) {
    const id = el.id || '';
    const cls = el.className || '';
    return /tdOptionNo_|lnkOptionLink_|option-svg-letter/i.test(id + ' ' + cls)
      || /bix-td-option/.test(cls);
  }

  // Helper: get option text from sibling value div (IndiaBix-specific)
  function getOptionContext(el) {
    // For bix-td-option or its children, get the text from the sibling bix-td-option-val
    const optionRow = el.closest('.bix-opt-row') || el.closest('[class*="bix"]')?.parentElement;
    if (optionRow) {
      const valDiv = optionRow.querySelector('.bix-td-option-val');
      if (valDiv) return getCleanText(valDiv, 200);
    }
    // For the option letter span, check parent's next sibling
    const parent = el.closest('.bix-td-option');
    if (parent?.nextElementSibling) {
      return getCleanText(parent.nextElementSibling, 200);
    }
    return '';
  }

  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= limit) break;
    if (seen.has(el)) continue;

    // For quiz options, use relaxed visibility (they might be CSS-styled with no natural size)
    const quizOpt = isQuizOption(el);
    if (!quizOpt && !isVisible(el)) continue;
    if (quizOpt) {
      // At minimum check it's in the DOM and not display:none on a parent
      const style = getComputedStyle(el);
      if (style.display === 'none') continue;
    }

    const rect = el.getBoundingClientRect();
    if (!quizOpt && (rect.width < 2 || rect.height < 2)) continue;
    // Skip huge container elements
    if (rect.width > window.innerWidth * 0.9 && rect.height > 200) continue;

    seen.add(el);

    const desc = describeElement(el);
    // Enrich quiz option descriptions with the option value text
    if (quizOpt && !desc.text) {
      desc.text = getOptionContext(el);
      // Add option letter to label
      const letter = (el.id || el.className || '').match(/[_-]([ABCD])(?:[_-]|$)/i);
      if (letter) desc.label = `Option ${letter[1].toUpperCase()}: ${desc.text}`;
    }
    elements.push(desc);
  }

  // Second pass: scan for quiz option elements by ID pattern that CSS selectors missed
  if (elements.length < limit) {
    const optionEls = document.querySelectorAll('[id^="tdOptionNo_"], [id^="lnkOptionLink_"]');
    for (const el of optionEls) {
      if (elements.length >= limit) break;
      if (seen.has(el)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none') continue;
      seen.add(el);

      const desc = describeElement(el);
      if (!desc.text) {
        desc.text = getOptionContext(el);
        const letter = el.id.match(/[_-]([ABCD])[_-]/i);
        if (letter) desc.label = `Option ${letter[1].toUpperCase()}: ${desc.text}`;
      }
      elements.push(desc);
    }
  }

  return elements;
}

function getPageForms() {
  const forms = [];
  document.querySelectorAll('form, fieldset, [role="form"]').forEach((form, i) => {
    if (!isVisible(form)) return;
    const fields = [];
    form.querySelectorAll('input, textarea, select, [contenteditable="true"]').forEach(field => {
      if (!isVisible(field)) return;
      const id = field.getAttribute('data-agent-id') || registerElement(field);
      fields.push({
        id,
        tag: field.tagName.toLowerCase(),
        type: field.getAttribute('type') || '',
        name: field.getAttribute('name') || '',
        label: getElementLabel(field),
        placeholder: field.getAttribute('placeholder') || '',
        value: String(field.value || field.textContent || '').slice(0, 120)
      });
    });
    if (fields.length) forms.push({ id: `form${i + 1}`, fields });
  });
  return forms.slice(0, 20);
}

function getPageContext() {
  const main = document.querySelector('main, article, [role="main"]') || document.body;
  const elements = getInteractiveElements();
  return {
    title: document.title,
    url: location.href,
    text: getVisibleText(main, 12000),
    elements,
    forms: getPageForms(),
    scroll: {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      height: Math.round(document.documentElement.scrollHeight),
      viewportHeight: Math.round(window.innerHeight)
    }
  };
}

// ─── Visual Feedback ────────────────────────────────────────────────────────

function highlightElement(el) {
  if (!el) return;
  el.classList.add(AGENT_HIGHLIGHT_CLASS);
  setTimeout(() => el.classList.remove(AGENT_HIGHLIGHT_CLASS), 2000);
}

function showActingOverlay() {
  document.documentElement.classList.add(AGENT_ACTING_CLASS);
}

function hideActingOverlay() {
  document.documentElement.classList.remove(AGENT_ACTING_CLASS);
}

// ─── Animated Cursor (Claude-style) ─────────────────────────────────────────
// A smooth pointer cursor that glides to elements before the agent acts on them.

const CURSOR_ID = 'browser-agent-cursor';

function getCursor() {
  let cursor = document.getElementById(CURSOR_ID);
  if (cursor) return cursor;

  cursor = document.createElement('div');
  cursor.id = CURSOR_ID;
  cursor.innerHTML = `
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g filter="url(#shadow)">
        <path d="M6 3L22 14L14 15.5L10.5 23L6 3Z" fill="#f97316" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>
      </g>
      <defs>
        <filter id="shadow" x="0" y="0" width="28" height="28" filterUnits="userSpaceOnUse">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.4"/>
        </filter>
      </defs>
    </svg>
    <div class="agent-cursor-ring"></div>
    <div class="agent-cursor-label"></div>
  `;
  document.body.appendChild(cursor);
  // Start off-screen
  cursor.style.left = '-50px';
  cursor.style.top = '-50px';
  return cursor;
}

function showCursor() {
  const cursor = getCursor();
  cursor.classList.add('visible');
  return cursor;
}

function hideCursor() {
  const cursor = document.getElementById(CURSOR_ID);
  if (!cursor) return;
  cursor.classList.remove('visible');
  cursor.classList.add('fading');
  setTimeout(() => {
    cursor.classList.remove('fading');
    cursor.remove();
  }, 500);
}

function setCursorLabel(text) {
  const cursor = document.getElementById(CURSOR_ID);
  if (!cursor) return;
  const label = cursor.querySelector('.agent-cursor-label');
  if (label) {
    label.textContent = text || '';
    label.classList.toggle('visible', !!text);
  }
}

async function moveCursorTo(x, y, duration = 500) {
  const cursor = showCursor();
  const startX = parseFloat(cursor.style.left) || -50;
  const startY = parseFloat(cursor.style.top) || -50;
  const startTime = performance.now();

  return new Promise(resolve => {
    function frame(now) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      // easeInOutCubic for smooth, natural motion
      const ease = t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;

      cursor.style.left = (startX + (x - startX) * ease) + 'px';
      cursor.style.top = (startY + (y - startY) * ease) + 'px';

      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

function cursorClickEffect() {
  const cursor = document.getElementById(CURSOR_ID);
  if (!cursor) return;
  const ring = cursor.querySelector('.agent-cursor-ring');
  if (!ring) return;
  ring.classList.add('clicking');
  setTimeout(() => ring.classList.remove('clicking'), 500);
}

function cursorTypeEffect() {
  const cursor = document.getElementById(CURSOR_ID);
  if (!cursor) return;
  cursor.classList.add('typing');
  setTimeout(() => cursor.classList.remove('typing'), 800);
}

async function animateCursorToElement(el, label) {
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  await sleep(250);

  const rect = el.getBoundingClientRect();
  const targetX = rect.left + rect.width / 2 - 4; // Offset for cursor tip
  const targetY = rect.top + rect.height / 2 - 2;

  setCursorLabel(label || '');
  await moveCursorTo(targetX, targetY, 500);
  await sleep(80);
}

// ─── Action Execution ───────────────────────────────────────────────────────

async function actionClick(targetId) {
  const el = getElement(targetId);
  if (!el) throw new Error(`Element ${targetId} not found on page.`);

  // Animate cursor to element
  const label = getCleanText(el, 30) || targetId;
  await animateCursorToElement(el, `Click: ${label}`);
  cursorClickEffect();
  highlightElement(el);

  // Dispatch realistic event sequence
  const rect = el.getBoundingClientRect();
  const opts = {
    bubbles: true, cancelable: true, view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0, buttons: 1
  };

  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));

  // Fallback native click
  try { el.click(); } catch {}

  // Handle checkbox/radio toggle
  if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
    if (el.type === 'radio') el.checked = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  await sleep(200);
  return { ok: true, targetId, text: getCleanText(el, 100) };
}

async function actionType(targetId, text, clear = true) {
  const el = getElement(targetId);
  if (!el) throw new Error(`Element ${targetId} not found on page.`);

  // Animate cursor to element
  const label = getElementLabel(el) || getCleanText(el, 20) || targetId;
  await animateCursorToElement(el, `Type: ${label}`);
  cursorClickEffect();
  highlightElement(el);
  el.focus();
  await sleep(150);
  cursorTypeEffect();

  const value = String(text ?? '');

  if (el.isContentEditable) {
    if (clear) el.textContent = '';
    el.textContent += value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  } else {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    const newValue = clear ? value : (el.value + value);
    if (setter) setter.call(el, newValue);
    else el.value = newValue;

    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  await sleep(200);
  return { ok: true, targetId, typedLength: value.length };
}

async function actionSelect(targetId, optionValue) {
  const el = getElement(targetId);
  if (!el) throw new Error(`Element ${targetId} not found on page.`);

  // Animate cursor to element
  await animateCursorToElement(el, `Select: ${optionValue}`);
  cursorClickEffect();
  highlightElement(el);

  if (el.tagName === 'SELECT') {
    const option = Array.from(el.options).find(
      opt => opt.value === optionValue || opt.textContent.trim().toLowerCase() === optionValue.toLowerCase()
    );
    if (option) {
      el.value = option.value;
    } else {
      el.value = optionValue;
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    return { ok: true, targetId, selected: el.value };
  }

  return actionClick(targetId);
}

async function actionSubmit(targetId) {
  const el = getElement(targetId);
  if (!el) throw new Error(`Element ${targetId} not found on page.`);

  // Animate cursor to submit button
  await animateCursorToElement(el, 'Submit');
  cursorClickEffect();
  highlightElement(el);

  const form = el.closest('form');
  if (form?.requestSubmit) {
    form.requestSubmit(
      (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) ? el : undefined
    );
    await sleep(200);
    return { ok: true, submitted: 'form' };
  }

  return actionClick(targetId);
}

async function actionScroll(direction, amount) {
  const scrollAmount = Number(amount || 500);
  const dir = String(direction || 'down').toLowerCase();

  let top = 0;
  if (dir === 'down') top = scrollAmount;
  else if (dir === 'up') top = -scrollAmount;
  else if (dir === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); await sleep(400); return { ok: true, scrollY: 0 }; }
  else if (dir === 'bottom') {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    await sleep(400);
    return { ok: true, scrollY: Math.round(window.scrollY) };
  }

  window.scrollBy({ top, left: 0, behavior: 'smooth' });
  await sleep(400);
  return { ok: true, scrollY: Math.round(window.scrollY) };
}

// ─── Action Dispatcher ──────────────────────────────────────────────────────

async function executeAction(action) {
  const type = action?.type;

  switch (type) {
    case 'click':
      return actionClick(action.targetId);

    case 'type':
      return actionType(action.targetId, action.text, action.clear !== false);

    case 'select':
      return actionSelect(action.targetId, action.value);

    case 'submit':
      return actionSubmit(action.targetId);

    case 'scroll':
      return actionScroll(action.direction, action.amount);

    case 'wait':
      await sleep(Math.min(Math.max(Number(action.ms || 1000), 100), 10000));
      return { ok: true, waited: action.ms };

    case 'read_page':
      return { ok: true, pageContext: getPageContext() };

    case 'done':
      return { ok: true, done: true, reason: action.reason || 'Task complete' };

    default:
      throw new Error(`Unknown action type: ${type}`);
  }
}

// ─── Dedicated Quiz Solver ──────────────────────────────────────────────────
// Extracts quiz questions directly from the DOM (IndiaBix and generic MCQ sites).
// The AI only needs to tell us the correct letter — we handle the clicking.

function scanQuizQuestions() {
  const questions = [];

  // ── IndiaBix format ──
  // Questions: div.bix-div-container with qno + qtxt
  // Options: div.bix-td-option with lnkOptionLink_X_NNN spans
  document.querySelectorAll('.bix-div-container').forEach((container, idx) => {
    const qnoEl = container.querySelector('.bix-td-qno, [id^="qno"]');
    const qtxtEl = container.querySelector('.bix-td-qtxt');
    if (!qtxtEl) return;

    const qText = getCleanText(qtxtEl, 500);
    if (!qText) return;

    const qNum = qnoEl ? qnoEl.textContent.trim().replace(/\.$/, '') : String(idx + 1);
    const optionTable = container.querySelector('.bix-tbl-options, [id^="tblOption_"]');
    if (!optionTable) return;

    const options = {};
    ['A', 'B', 'C', 'D', 'E'].forEach(letter => {
      // The clickable element: div.bix-td-option with id tdOptionNo_X_NNN
      const optDiv = optionTable.querySelector(`[id^="tdOptionNo_${letter}_"]`);
      const valDiv = optionTable.querySelector(`[id^="tdOptionDt_${letter}_"]`);
      if (optDiv) {
        options[letter] = {
          text: valDiv ? getCleanText(valDiv, 200) : '',
          clickId: optDiv.id,
          element: optDiv
        };
      }
    });

    if (Object.keys(options).length >= 2) {
      questions.push({ num: qNum, text: qText, options, container });
    }
  });

  // ── Generic MCQ format (radio buttons with labels) ──
  if (questions.length === 0) {
    const radioGroups = {};
    document.querySelectorAll('input[type="radio"]').forEach(radio => {
      const name = radio.name;
      if (!name) return;
      if (!radioGroups[name]) radioGroups[name] = [];
      const label = (radio.id ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`) : null)
        || radio.closest('label')
        || radio.parentElement;
      let labelText = label ? getVisibleText(label, 200) || getCleanText(label, 200) : '';
      labelText = labelText.replace(/^\s*[A-Fa-f][\).:-]\s*/, '').trim();
      radioGroups[name].push({
        radio,
        label: labelText,
        value: radio.value
      });
    });

    Object.entries(radioGroups).forEach(([name, radios], idx) => {
      if (radios.length < 2) return;
      // Try to find the question text near this group
      const firstRadio = radios[0].radio;
      const groupInputs = radios.map(r => r.radio);
      const questionContainer = findQuestionContainerForRadios(groupInputs)
        || firstRadio.parentElement?.parentElement;
      let qText = questionContainer ? getVisibleText(questionContainer, 700) || getCleanText(questionContainer, 700) : '';
      radios.forEach(r => {
        if (r.label) qText = qText.replace(r.label, ' ');
      });
      qText = qText.replace(/\s+/g, ' ').trim();
      if (!qText || qText.length < 8 || qText.length > 650) {
        qText = findQuestionTextNear(firstRadio) || `Question ${idx + 1}`;
      }

      const options = {};
      const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
      radios.forEach((r, i) => {
        if (i < letters.length) {
          options[letters[i]] = {
            text: r.label || r.value,
            clickId: r.radio.id,
            element: r.radio
          };
        }
      });

      questions.push({ num: String(idx + 1), text: qText, options });
    });
  }

  return questions;
}

function findQuestionContainerForRadios(radios) {
  if (!radios.length) return null;
  let node = radios[0].closest('fieldset, .question, [class*="question"], [data-question], li')
    || radios[0].parentElement;
  while (node && node !== document.body) {
    const contained = radios.filter(r => node.contains(r)).length;
    const allRadios = node.querySelectorAll('input[type="radio"]').length;
    const textLen = (getVisibleText(node, 1200) || getCleanText(node, 1200)).length;
    if (contained === radios.length && allRadios <= radios.length + 1 && textLen < 1000) return node;
    node = node.parentElement;
  }
  return null;
}

function findQuestionTextNear(firstRadio) {
  const blocks = [];
  let node = firstRadio;
  for (let i = 0; i < 8 && node; i++) {
    let prev = node.previousElementSibling;
    while (prev) {
      const text = getVisibleText(prev, 500) || getCleanText(prev, 500);
      if (text && text.length > 8 && !prev.querySelector('input[type="radio"]')) blocks.unshift(text);
      if (blocks.join(' ').length > 500) break;
      prev = prev.previousElementSibling;
    }
    if (blocks.length) break;
    node = node.parentElement;
  }
  return blocks.join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

function clickQuizAnswer(questionIdx, letter, questions) {
  if (!questions || !questions[questionIdx]) {
    return { ok: false, error: `Question ${questionIdx + 1} not found` };
  }

  const q = questions[questionIdx];
  const option = q.options[letter.toUpperCase()];
  if (!option) {
    return { ok: false, error: `Option ${letter} not found for question ${q.num}` };
  }

  // Find the element to click
  let el = option.element;
  if (!el && option.clickId) {
    el = document.getElementById(option.clickId);
  }
  if (!el) {
    return { ok: false, error: `Cannot find element for option ${letter}` };
  }

  // Scroll into view
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Animate cursor
  const rect = el.getBoundingClientRect();
  const cursor = showCursor();

  return new Promise(resolve => {
    setTimeout(async () => {
      await animateCursorToElement(el, `Q${q.num}: ${letter}`);
      cursorClickEffect();
      highlightElement(el);

      // Click it
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      try { el.click(); } catch {}

      // If it's a radio button, check it
      if (el instanceof HTMLInputElement && el.type === 'radio') {
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // For IndiaBix, also try clicking the span inside
      const innerSpan = el.querySelector('span[id^="lnkOptionLink_"]');
      if (innerSpan) {
        try { innerSpan.click(); } catch {}
      }

      await sleep(300);
      resolve({ ok: true, question: q.num, selected: letter, optionText: option.text });
    }, 100);
  });
}

// ─── Message Listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Read page context
  if (request.action === 'getPageContext') {
    try {
      sendResponse({ pageContext: getPageContext() });
    } catch (error) {
      sendResponse({ error: error.message });
    }
    return true;
  }

  // ── Quiz Scanner ──
  // Returns structured quiz data so the AI just needs to answer A/B/C/D
  if (request.action === 'scanQuiz') {
    try {
      const questions = scanQuizQuestions();
      const data = questions.map(q => ({
        num: q.num,
        text: q.text,
        options: Object.fromEntries(
          Object.entries(q.options).map(([letter, opt]) => [letter, opt.text])
        )
      }));
      sendResponse({ questions: data, count: data.length });
    } catch (error) {
      sendResponse({ error: error.message });
    }
    return true;
  }

  // ── Quiz Answer Clicker ──
  // Clicks answers based on AI-provided answer map: { "1": "A", "2": "C", ... }
  if (request.action === 'clickQuizAnswers') {
    const answerMap = request.answers || {};
    showActingOverlay();
    showCursor();

    (async () => {
      const questions = scanQuizQuestions();
      const results = [];

      for (const [qNumStr, letter] of Object.entries(answerMap)) {
        const qIdx = questions.findIndex(q => q.num === qNumStr || q.num === String(parseInt(qNumStr)));
        if (qIdx === -1) {
          results.push({ question: qNumStr, ok: false, error: 'Question not found on page' });
          continue;
        }

        try {
          const result = await clickQuizAnswer(qIdx, letter, questions);
          results.push(result);
          await sleep(400); // Visible pause between clicks
        } catch (err) {
          results.push({ question: qNumStr, ok: false, error: err.message });
        }
      }

      hideCursor();
      hideActingOverlay();
      sendResponse({ results, totalClicked: results.filter(r => r.ok).length });
    })();

    return true;
  }

  // Execute a single agent action
  if (request.action === 'executeAction') {
    showActingOverlay();
    showCursor();
    executeAction(request.agentAction)
      .then(result => {
        hideCursor();
        hideActingOverlay();
        sendResponse({ result });
      })
      .catch(error => {
        hideCursor();
        hideActingOverlay();
        sendResponse({ error: error.message });
      });
    return true;
  }

  // Execute multiple actions sequentially
  if (request.action === 'executeActions') {
    const actions = Array.isArray(request.actions) ? request.actions : [];
    showActingOverlay();
    showCursor();

    (async () => {
      const results = [];
      for (const act of actions) {
        try {
          const result = await executeAction(act);
          results.push({ action: act.type, ...result });
          await sleep(200);
        } catch (error) {
          results.push({ action: act.type, ok: false, error: error.message });
          break;
        }
      }
      hideCursor();
      hideActingOverlay();
      sendResponse({ results });
    })();

    return true;
  }

  // Ping - check if content script is loaded
  if (request.action === 'ping') {
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
