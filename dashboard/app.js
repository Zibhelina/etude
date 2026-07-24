'use strict';

let DB = null;
let TAGSEL = new Set();
let AND = false;
let SORT = null;
let SHOWALLTAGS = false;
let QUEUE = null;
let SHOWARCH = false;
let ORPHANS = false;
let RNDSEED = Math.random();

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
}[char]));
const attemptsOf = atom => Array.isArray(atom.attempts) ? atom.attempts : [];

/* Tiny markdown renderer retained from the v2 dashboard: fences, inline code,
   bold, images, links, and paragraphs. */
function md(source) {
  if (!source) return '<span class="empty">—</span>';
  const parts = String(source).split(/```/);
  let out = '';
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2) {
      const body = parts[i].replace(/^[a-z]*\n?/, '');
      out += `<pre><code>${esc(body)}</code></pre>`;
    } else {
      let text = esc(parts[i]);
      text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
      text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
      text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      out += text.split(/\n{2,}/).map(paragraph => (
        paragraph.trim() ? `<p>${paragraph.replace(/\n/g, '<br>')}</p>` : ''
      )).join('');
    }
  }
  return out;
}

function fmtTs(ts) {
  return ts ? String(ts).slice(5, 16).replace('T', ' ') : '—';
}

function mastery1(atom) {
  return Math.min(atom.streak || 0, 3) / 3;
}

function atomsArr() {
  return Object.entries(DB.atoms || {}).map(([id, atom]) => ({ id, ...atom }));
}

function queueOf(id) {
  return Object.entries(DB.queues || {})
    .filter(([, queue]) => (queue.members || []).includes(id))
    .map(([queueId]) => queueId);
}

/* Resolve the v3 deterministic flag in the visible context. An explicit atom
   value wins. In queue scope, that queue supplies the inherited value. In the
   all-atoms view, any containing deterministic queue makes the badge useful. */
function isDeterministic(atom, id) {
  if (atom.agent_assisted === false) return true;
  if (atom.agent_assisted === true) return false;
  if (QUEUE && (DB.queues[QUEUE]?.members || []).includes(id)) {
    return DB.queues[QUEUE].agent_assisted === false;
  }
  return queueOf(id).some(queueId => DB.queues[queueId]?.agent_assisted === false);
}

function detBadge(atom, id) {
  return isDeterministic(atom, id)
    ? '<span class="detbadge" title="deterministic practice">det</span>'
    : '';
}

/* Queue algorithm evaluation, retained client-side from v2. */
function mulberry(seed) {
  let value = seed * 2654435769 >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = Math.imul(value ^ value >>> 15, 1 | value);
    result ^= result + Math.imul(result ^ result >>> 7, 61 | result);
    return ((result ^ result >>> 14) >>> 0) / 4294967296;
  };
}

function algoValue(atom, key) {
  switch (key) {
    case 'attempts': return attemptsOf(atom).length;
    case 'mastery': return mastery1(atom);
    case 'last_rating': return atom.last_rating ?? -1;
    case 'id': {
      const match = atom.id.match(/^([A-Z0-9]+)-(\d+)$/);
      return match ? match[1] + match[2].padStart(4, '0') : atom.id;
    }
    default: return atom[key] ?? '';
  }
}

function orderByAlgorithm(atoms, queueId) {
  const queue = DB.queues[queueId];
  const algorithm = (DB.meta.queue_algorithms || {})[queue.algorithm] || {};
  if (queue.algorithm === 'manual') {
    const positions = {};
    (queue.order || []).forEach((id, index) => { positions[id] = index; });
    return atoms.slice().sort((left, right) =>
      (positions[left.id] ?? 1e9) - (positions[right.id] ?? 1e9)
      || (left.id < right.id ? -1 : 1));
  }
  if (queue.algorithm === 'random') {
    const random = mulberry(Math.floor(RNDSEED * 1e9));
    return atoms.map(atom => [random(), atom])
      .sort((left, right) => left[0] - right[0]).map(pair => pair[1]);
  }
  if (queue.algorithm === 'fsrs') {
    const now = new Date().toISOString();
    const due = atoms.filter(atom => atom.due && atom.due <= now && atom.state !== 'new')
      .sort((left, right) => left.due < right.due ? -1 : 1);
    const fresh = atoms.filter(atom => atom.state === 'new')
      .sort((left, right) => algoValue(left, 'id') < algoValue(right, 'id') ? -1 : 1);
    const rest = atoms.filter(atom => !due.includes(atom) && !fresh.includes(atom))
      .sort((left, right) => (left.streak || 0) - (right.streak || 0)
        || ((left.last_seen || '') < (right.last_seen || '') ? -1 : 1));
    return [...due, ...fresh, ...rest];
  }
  const order = algorithm.order || [{ key: 'id', dir: 'asc' }];
  return atoms.slice().sort((left, right) => {
    for (const criterion of order) {
      const a = algoValue(left, criterion.key);
      const b = algoValue(right, criterion.key);
      if (a !== b) return (a < b ? -1 : 1) * (criterion.dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

function filtered() {
  const query = $('#q').value.toLowerCase().trim();
  const state = $('#state').value;
  const queueMembers = QUEUE ? new Set(DB.queues[QUEUE].members || []) : null;
  return atomsArr().filter(atom => {
    if (atom.archived && !SHOWARCH) return false;
    if (queueMembers && !queueMembers.has(atom.id)) return false;
    if (ORPHANS && ((atom.tags || []).length || queueOf(atom.id).length)) return false;
    if (state && atom.state !== state) return false;
    if (TAGSEL.size) {
      const has = tag => (atom.tags || []).includes(tag);
      if (AND && ![...TAGSEL].every(has)) return false;
      if (!AND && ![...TAGSEL].some(has)) return false;
    }
    if (query) {
      const haystack = `${atom.id} ${atom.user_prompt || ''} ${atom.topic || ''} ${(atom.tags || []).join(' ')}`.toLowerCase();
      if (!query.split(/\s+/).every(word => haystack.includes(word))) return false;
    }
    return true;
  });
}

function sortArr(atoms) {
  if (SORT) {
    const { k, dir } = SORT;
    return atoms.slice().sort((left, right) => {
      const a = algoValue(left, k);
      const b = algoValue(right, k);
      return (a < b ? -1 : a > b ? 1 : 0) * dir;
    });
  }
  if (QUEUE) return orderByAlgorithm(atoms, QUEUE);
  return atoms.slice().sort((left, right) => algoValue(left, 'id') < algoValue(right, 'id') ? -1 : 1);
}

function render() {
  const atoms = sortArr(filtered());
  const seen = atoms.filter(atom => attemptsOf(atom).length);
  const distribution = [0, 0, 0, 0];
  atoms.forEach(atom => attemptsOf(atom).forEach(attempt => {
    if (attempt.rating >= 0 && attempt.rating <= 3) distribution[attempt.rating] += 1;
  }));
  const mastery = atoms.length ? atoms.reduce((sum, atom) => sum + mastery1(atom), 0) / atoms.length : 0;
  const coverage = atoms.length ? seen.length / atoms.length : 0;
  $('#stats').innerHTML = `
    <div class="stat"><div class="v">${atoms.length}</div><div class="l">atoms in scope</div></div>
    <div class="stat"><div class="v">${seen.length}</div><div class="l">seen</div>
      <div class="bar"><div style="width:${(coverage * 100).toFixed(0)}%"></div></div></div>
    <div class="stat"><div class="v">${(coverage * 100).toFixed(0)}%</div><div class="l">coverage</div></div>
    <div class="stat" title="mean of min(streak,3)/3 over scoped atoms; unseen count as 0"><div class="v">${(mastery * 100).toFixed(0)}%</div><div class="l">mastery</div>
      <div class="bar"><div style="width:${(mastery * 100).toFixed(0)}%"></div></div></div>
    <div class="stat"><div class="v">${distribution.reduce((a, b) => a + b, 0)}</div><div class="l">attempts</div>
      <div class="dist"><span class="r0">0×${distribution[0]}</span><span class="r1">1×${distribution[1]}</span><span class="r2">2×${distribution[2]}</span><span class="r3">3×${distribution[3]}</span></div></div>`;

  const now = new Date().toISOString();
  $('#posth').style.display = QUEUE && !SORT ? '' : 'none';
  $('#rows').innerHTML = atoms.map((atom, index) => {
    const duePast = atom.due && atom.due <= now && atom.state !== 'new';
    const prompt = atom.topic || String(atom.user_prompt || '').slice(0, 120);
    return `<tr data-id="${esc(atom.id)}" class="${atom.archived ? 'archived' : ''}">
      ${QUEUE && !SORT ? `<td class="pos">${index + 1}</td>` : ''}
      <td class="id">${esc(atom.id)}${detBadge(atom, atom.id)}${atom.archived ? ' <span class="archflag">arch</span>' : ''}</td>
      <td class="prompt">${esc(prompt)}</td>
      <td><span class="pill st-${esc(atom.state || 'new')}">${esc(atom.state || 'new')}</span></td>
      <td class="num">${atom.streak || 0}</td>
      <td class="num">${atom.lapses || ''}</td>
      <td class="num">${attemptsOf(atom).length || ''}</td>
      <td class="num ${atom.last_rating != null ? `r${atom.last_rating}` : ''}">${atom.last_rating ?? ''}</td>
      <td class="num">${fmtTs(atom.last_seen)}</td>
      <td class="num ${duePast ? 'due-past' : ''}">${fmtTs(atom.due)}</td>
    </tr>`;
  }).join('');

  const orderDescription = SORT
    ? `sorted by ${SORT.k} ${SORT.dir > 0 ? '↑' : '↓'}`
    : (QUEUE ? `queue order: ${DB.queues[QUEUE].algorithm}` : 'sorted by id');
  $('#count').textContent = `${atoms.length} atoms · ${orderDescription}`;
  document.querySelectorAll('#rows tr').forEach(row => {
    row.onclick = () => openDetail(row.dataset.id);
  });
  renderChips();
  renderQueues();
  renderRecent();
  renderHeat();
}

function renderChips() {
  const counts = {};
  atomsArr().forEach(atom => {
    if (atom.archived && !SHOWARCH) return;
    (atom.tags || []).forEach(tag => { counts[tag] = (counts[tag] || 0) + 1; });
  });
  const tags = Object.entries(counts).sort((left, right) => right[1] - left[1]);
  const cut = SHOWALLTAGS ? tags.length : 24;
  $('#chips').innerHTML = tags.slice(0, cut).map(([tag, count]) =>
    `<span class="chip ${TAGSEL.has(tag) ? 'on' : ''}" data-t="${esc(tag)}">${esc(tag)}<span class="n">${count}</span></span>`
  ).join('');
  $('#showall').textContent = tags.length > 24
    ? (SHOWALLTAGS ? 'less ▲' : `+${tags.length - 24} tags ▼`) : '';
  document.querySelectorAll('.chip').forEach(chip => {
    chip.onclick = () => {
      const tag = chip.dataset.t;
      if (TAGSEL.has(tag)) TAGSEL.delete(tag); else TAGSEL.add(tag);
      render();
    };
  });
}

function renderQueues() {
  const queues = Object.entries(DB.queues || {});
  if (!queues.length) {
    $('#queues').innerHTML = '<div class="empty">no queues yet</div>';
    return;
  }
  queues.sort((left, right) =>
    (left[1].status === 'active' ? 0 : 1) - (right[1].status === 'active' ? 0 : 1));
  $('#queues').innerHTML = queues.map(([queueId, queue]) => {
    const members = (queue.members || []).map(id => DB.atoms[id]).filter(Boolean);
    const mastery = members.length
      ? members.reduce((sum, atom) => sum + mastery1(atom), 0) / members.length : 0;
    const seen = members.filter(atom => attemptsOf(atom).length).length;
    return `<div class="qcard ${QUEUE === queueId ? 'sel' : ''}" data-q="${esc(queueId)}">
      <div class="qn">${esc(queue.label || queueId)}
        <span class="alg">${esc(queue.algorithm || 'id')}</span>
        ${queue.status === 'archived' ? '<span class="arch">archived</span>' : ''}</div>
      <div class="qm">${members.length} atoms · ${seen} seen · mastery ${(mastery * 100).toFixed(0)}%${queue.deadline ? ` · due ${fmtTs(queue.deadline)}` : ''}</div>
      <div class="bar"><div style="width:${(mastery * 100).toFixed(0)}%"></div></div>
    </div>`;
  }).join('');
  document.querySelectorAll('.qcard').forEach(card => {
    card.onclick = () => {
      QUEUE = QUEUE === card.dataset.q ? null : card.dataset.q;
      SORT = null;
      RNDSEED = Math.random();
      clearSortArrows();
      render();
    };
  });
}

function renderRecent() {
  const events = [];
  atomsArr().forEach(atom => attemptsOf(atom).forEach(attempt => {
    if (attempt.ts) events.push({ id: atom.id, ts: attempt.ts, rating: attempt.rating });
  }));
  events.sort((left, right) => left.ts < right.ts ? 1 : -1);
  $('#recent').innerHTML = events.slice(0, 10).map(event =>
    `<div class="ritem" data-id="${esc(event.id)}"><span class="rid">${esc(event.id)}</span>
      <span class="r${event.rating}">${event.rating}</span><span class="rts">${fmtTs(event.ts)}</span></div>`
  ).join('') || '<div class="empty">no attempts yet</div>';
  document.querySelectorAll('.ritem').forEach(item => {
    item.onclick = () => openDetail(item.dataset.id);
  });
}

function renderHeat() {
  const perDay = {};
  atomsArr().forEach(atom => attemptsOf(atom).forEach(attempt => {
    if (attempt.ts) {
      const day = attempt.ts.slice(0, 10);
      perDay[day] = (perDay[day] || 0) + 1;
    }
  }));
  const days = [];
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 25 * 7 - today.getDay());
  for (let day = new Date(start); day <= today; day.setDate(day.getDate() + 1)) {
    days.push(day.toISOString().slice(0, 10));
  }
  $('#heat').innerHTML = days.map(day => {
    const count = perDay[day] || 0;
    const heatClass = count === 0 ? '' : count < 3 ? 'h1' : count < 8 ? 'h2' : count < 15 ? 'h3' : 'h4';
    return `<div class="hm ${heatClass}" ${count ? 'data-n="1"' : ''} title="${day} · ${count} attempt${count === 1 ? '' : 's'}"></div>`;
  }).join('');
  const total = Object.values(perDay).reduce((sum, count) => sum + count, 0);
  $('#heatsum').textContent = ` — ${total} attempts on ${Object.keys(perDay).length} days`;
}

function expectedDisplay(expected) {
  if (expected == null || expected === '') return '';
  if (Array.isArray(expected)) return expected.map(value => String(value)).join('\n');
  if (typeof expected === 'object') return JSON.stringify(expected, null, 2);
  return String(expected);
}

function renderCascade(atom, atomId, queueIds) {
  const layers = [];
  if (atom.agent_prompt) {
    layers.push(`<div class="cascade-layer">
      <div class="cascade-head"><b>Card</b> highest priority</div>
      <div class="cascade-body cascade-indicator">agent_prompt defined · reveal above</div>
    </div>`);
  }
  const tagInstructions = DB.meta.tag_instructions || {};
  (atom.tags || []).forEach(tag => {
    if (tagInstructions[tag]) {
      layers.push(`<div class="cascade-layer">
        <div class="cascade-head"><b>Tag</b> ${esc(tag)}</div>
        <div class="cascade-body md">${md(tagInstructions[tag])}</div>
      </div>`);
    }
  });
  queueIds.forEach(queueId => {
    const queue = DB.queues[queueId];
    if (queue?.agent_instructions) {
      layers.push(`<div class="cascade-layer">
        <div class="cascade-head"><b>Queue</b> ${esc(queue.label || queueId)}</div>
        <div class="cascade-body md">${md(queue.agent_instructions)}</div>
      </div>`);
    }
  });
  return layers.length
    ? `<div class="sec"><h3>Cascade</h3><div class="cascade">${layers.join('')}</div></div>`
    : '';
}

function openDetail(id) {
  const atom = DB.atoms[id];
  if (!atom) return;
  const queueIds = queueOf(id);
  const attempts = attemptsOf(atom);
  const scheduler = `<div class="sched">
    <span>state <b>${esc(atom.state || 'new')}</b></span><span>streak <b>${atom.streak || 0}</b></span>
    <span>lapses <b>${atom.lapses || 0}</b></span><span>last rating <b>${atom.last_rating ?? '—'}</b></span>
    <span>last seen <b>${fmtTs(atom.last_seen)}</b></span><span>due <b>${fmtTs(atom.due)}</b></span>
    <span>attempts <b>${attempts.length}</b></span></div>`;
  const attemptHistory = [...attempts].reverse().map((attempt, reverseIndex) => {
    const number = attempts.length - reverseIndex;
    return `<div class="attempt">
      <div class="head"><span class="rt r${attempt.rating}">${attempt.rating}</span>
        <span>#${number}</span><span>${esc(attempt.ts || '')}</span><span>${esc(attempt.mode || '')}</span>
        ${attempt.via ? `<span class="via">${esc(attempt.via)}</span>` : ''}
        ${attempt.variant ? `<span class="variant">${esc(attempt.variant)}</span>` : ''}</div>
      <div class="body">
        ${attempt.variant_prompt ? `<div class="lbl">variant question</div><div class="md vp">${md(attempt.variant_prompt)}</div>` : ''}
        <div class="lbl">answer (verbatim)</div><div class="md">${md(attempt.answer)}</div>
        <div class="lbl">feedback</div><div class="md">${md(attempt.feedback)}</div>
      </div>
    </div>`;
  }).join('') || '<div class="empty">no attempts yet</div>';

  const expected = expectedDisplay(atom.expected);
  const agentContent = atom.agent_prompt || expected
    ? `<div class="sec"><h3>Agent prompt <span class="reveal" id="rv">· reveal</span></h3>
        <div class="hidden-ans" id="ans">
          <div class="md">${md(atom.agent_prompt)}</div>
          ${expected ? `<div class="expected"><h3>Expected</h3><div class="md">${md(expected)}</div></div>` : ''}
        </div>
      </div>` : '';

  $('#detail').innerHTML = `
    <button class="close" id="detailclose">✕ esc</button>
    <h2>${esc(id)}${detBadge(atom, id)}${atom.archived ? ' <span class="archflag">archived</span>' : ''}</h2>
    <div class="topic">${esc(atom.topic || '')}</div>
    <div class="tags">${(atom.tags || []).map(tag => `<span class="tag" data-t="${esc(tag)}">${esc(tag)}</span>`).join('') || '<span class="empty">orphan — no tags</span>'}</div>
    <div class="queues">${queueIds.map(queueId => `<span class="qref" data-q="${esc(queueId)}">⊟ ${esc(DB.queues[queueId].label || queueId)}</span>`).join('') || '<span class="empty">in no queue</span>'}</div>
    ${scheduler}
    <div class="sec"><h3>User prompt</h3><div class="md">${md(atom.user_prompt)}</div></div>
    ${agentContent}
    ${renderCascade(atom, id, queueIds)}
    ${atom.notes ? `<div class="sec"><h3>Notes</h3><div class="md">${md(atom.notes)}</div></div>` : ''}
    <div class="sec"><h3>Attempt history (${attempts.length})</h3>${attemptHistory}</div>`;

  $('#detailclose').onclick = closeDetail;
  if ($('#rv')) {
    $('#rv').onclick = () => {
      const answer = $('#ans');
      answer.classList.toggle('hidden-ans');
      $('#rv').textContent = answer.classList.contains('hidden-ans') ? '· reveal' : '· hide';
    };
  }
  document.querySelectorAll('#detail .tag').forEach(tag => {
    tag.onclick = () => {
      closeDetail();
      TAGSEL = new Set([tag.dataset.t]);
      render();
    };
  });
  document.querySelectorAll('#detail .qref').forEach(queueRef => {
    queueRef.onclick = () => {
      closeDetail();
      QUEUE = queueRef.dataset.q;
      SORT = null;
      clearSortArrows();
      render();
    };
  });
  $('#overlay').classList.add('show');
  $('#detail').classList.add('show');
  history.replaceState(null, '', `#${encodeURIComponent(id)}`);
}

function closeDetail() {
  $('#overlay').classList.remove('show');
  $('#detail').classList.remove('show');
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

function clearSortArrows() {
  document.querySelectorAll('thead .arr').forEach(arrow => { arrow.textContent = ''; });
}

async function load() {
  try {
    const response = await fetch('/api/db', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    DB = await response.json();
    DB.atoms = DB.atoms || {};
    DB.queues = DB.queues || {};
    DB.meta = DB.meta || {};
    $('#dbinfo').textContent = `${Object.keys(DB.atoms).length} atoms · ${Object.keys(DB.queues).length} queues · schema v${DB.meta.schema_version ?? '—'}`;
    if (QUEUE && !DB.queues[QUEUE]) QUEUE = null;
    render();
    if (location.hash.length > 1) {
      const atomId = decodeURIComponent(location.hash.slice(1));
      if (DB.atoms[atomId]) openDetail(atomId);
    }
  } catch (error) {
    document.body.innerHTML = `<div class="loaderror"><b>Could not load Etude data.</b><br>${esc(error.message)}</div>`;
  }
}

$('#overlay').onclick = closeDetail;
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeDetail();
});
['#q', '#state'].forEach(selector => $(selector).addEventListener('input', render));
$('#andmode').onclick = () => {
  AND = !AND;
  $('#andmode').textContent = `tags: ${AND ? 'AND' : 'OR'}`;
  $('#andmode').classList.toggle('on', AND);
  render();
};
$('#archmode').onclick = () => {
  SHOWARCH = !SHOWARCH;
  $('#archmode').textContent = `archived: ${SHOWARCH ? 'shown' : 'hidden'}`;
  $('#archmode').classList.toggle('on', SHOWARCH);
  render();
};
$('#orphanmode').onclick = () => {
  ORPHANS = !ORPHANS;
  $('#orphanmode').classList.toggle('on', ORPHANS);
  render();
};
$('#showall').onclick = () => {
  SHOWALLTAGS = !SHOWALLTAGS;
  renderChips();
};
document.querySelectorAll('thead th').forEach(header => {
  header.onclick = () => {
    const key = header.dataset.k;
    if (key === '__pos') {
      SORT = null;
      clearSortArrows();
      render();
      return;
    }
    if (SORT && SORT.k === key) SORT.dir *= -1;
    else SORT = { k: key, dir: 1 };
    clearSortArrows();
    const arrow = header.querySelector('.arr');
    if (arrow) arrow.textContent = SORT.dir > 0 ? '▲' : '▼';
    render();
  };
});

function sse() {
  const events = new EventSource('/api/events');
  events.onopen = () => $('#live').classList.add('on');
  events.onerror = () => {
    $('#live').classList.remove('on');
    events.close();
    setTimeout(sse, 3000);
  };
  events.onmessage = event => {
    if (event.data === 'reload') load();
  };
  events.addEventListener('reload', load);
}

load();
sse();
