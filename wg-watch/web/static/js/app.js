// Файл: /opt/wg-watch/web/static/js/app.js
// Логика дашборда wg-watch: тема (авто/светлая/тёмная с реакцией на системную),
// рендер статистики, баннера демона, карточек пиров и ленты событий, спарклайны
// и большой график трафика (кусочно-линейная ось времени со сжатием простоев,
// масштаб Y по видимой части, подсказки, прокрутка/драг/тач), поллинг с фоновой
// проверкой истории, кастомные тултипы, копирование в буфер, модалки (создание,
// удаление, очистка журнала), фильтры и сортировка, переключение языка.
// Зависит от ./i18n-index.js, ./utils.js и ./api.js; точка входа — init() в конце
// файла, тултипы инициализируются на уровне модуля.

import {
  t, tFormat, translateError, applyStaticI18n,
  detectLang, setLang, safeGetItem, safeSetItem,
  currentLang
} from './i18n-index.js';

import {
  humanBytes, humanDuration, fmtTime, fmtDateTime,
  escapeHtml, niceCeil, setHtml
} from './utils.js';

import {
  fetchState, fetchEvents, fetchTrafficHistory,
  createClient, deleteClient, clearEvents,
  downloadEvents, downloadClientConfig, logout
} from './api.js';

// ═══════════════════════════════════════════════════════════════════════
// 1. НАСТРОЙКИ
// ═══════════════════════════════════════════════════════════════════════

// ─── Интервалы и таймауты ────────────────────────────────────────────
const CLOCK_MS    = 1000;
const TIMEOUT_SEC = 180;
const PEER_STALE_SEC = 3600;   // Если последнее рукопожатие было дольше этого срока назад (сек), адрес и активность показываются прочерками.

// ═══════════════════════════════════════════════════════════════════════
// 2. ТЕМА
// ═══════════════════════════════════════════════════════════════════════

// ─── Системная тема ──────────────────────────────────────────────────
const mq = window.matchMedia("(prefers-color-scheme: light)");
let themePref = "auto";

// ─── Вычисление эффективной темы ─────────────────────────────────────
function effectiveTheme(pref) {
  return pref === "auto" ? (mq.matches ? "light" : "dark") : pref;
}

// ─── Применение темы ─────────────────────────────────────────────────
function applyTheme(pref) {
  if (pref !== "light" && pref !== "dark") pref = "auto";
  themePref = pref;

  const root = document.documentElement;
  const next = effectiveTheme(pref);
  if (root.getAttribute("data-theme") !== next) {
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", next);
    void root.offsetWidth;
    requestAnimationFrame(() => root.classList.remove("theme-switching"));
  }

  document.querySelectorAll("#themeToggle button").forEach(b => {
    const on = b.dataset.theme === pref;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });

  safeSetItem("wgwatch.theme", pref);
}

// ─── Реакция на смену системной темы ─────────────────────────────────
function onSystemThemeChange() {
  if (themePref === "auto") applyTheme("auto");
}
if (mq.addEventListener) mq.addEventListener("change", onSystemThemeChange);
else if (mq.addListener) mq.addListener(onSystemThemeChange);

// ═══════════════════════════════════════════════════════════════════════
// 3. TOAST
// ═══════════════════════════════════════════════════════════════════════

// ─── Показ всплывающего уведомления ──────────────────────────────────
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  if (container.children.length >= 3) {
    container.children[0].remove();
  }

  const el = document.createElement('div');
  el.className = `toast ${type}`;

  const icon = type === 'success'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';

  el.innerHTML = icon + `<span>${escapeHtml(message)}</span>`;
  container.appendChild(el);

  setTimeout(() => {
    if (!el.parentNode) return;
    el.classList.add('hiding');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
  }, 4000);
}

// ═══════════════════════════════════════════════════════════════════════
// 4. БУФЕР ОБМЕНА
// ═══════════════════════════════════════════════════════════════════════

// ─── Копирование в буфер обмена ──────────────────────────────────────
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* Молча игнорируем. */ }
    document.body.removeChild(ta);
    ok ? resolve() : reject(new Error('copy failed'));
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 5. СОСТОЯНИЕ
// ═══════════════════════════════════════════════════════════════════════

// ─── Состояние интерфейса ────────────────────────────────────────────
let filter           = 'all';
let lastState        = null;
let lastEvents       = [];
let selectedPeer     = null;
let eventsSort       = 'new';
let selectedPk       = null;
let clientToDelete   = null;
let modalReturnFocus = null;
let pollIntervalId   = null;

// ─── Состояние большого графика ──────────────────────────────────────
// Переменные для большого графика
let clockOffsetMs           = 0; // Поправка: время сервера минус время браузера (мс). Защита от неверных часов клиента.
let lastDaemonUptime        = null; // Предыдущее значение uptime демона (для обнаружения перезапуска).
let HISTORY_PROBE_MS        = 10 * 1000; // Как часто перепроверять историю на сервере для пиров без неё (зависит от частоты обновления, см. startPolling).
const historyProbe          = new Map(); // Когда последний раз спрашивали историю у сервера (pubkey → мс).
let bigChartOpening         = false; // Защита от повторных кликов, пока грузится история.
let bigChartPk              = null;
let bigChartIsRx            = null;
let chartMetrics            = { h: 0, padLeft: 92, padBottom: 40, padTop: 20, padL: 30, padR: 36, chartW: 0, chartH: 0, plotW: 0 };
const BIG_CHART_Y_VISIBLE   = false; // Масштаб оси Y по видимой части графика (false — по всей истории).
const BIG_CHART_SMOOTH_PX   = 4; // Ширина полосы усреднения линии в пикселях (0 — без сглаживания, больше — плавнее).
const BIG_CHART_PX_PER_MIN  = 20; // Минимальный масштаб большого графика: пикселей на минуту (должен быть меньше PX_MAX).
const BIG_CHART_PX_MAX      = 120; // Максимальный масштаб (для коротких периодов).
const BIG_CHART_TARGET_W    = 12000; // К этой общей ширине (px) подгоняется масштаб, чтобы длинный период не становился огромным.
const BIG_CHART_BREAK_MS    = 5 * 60 * 1000; // Пауза без трафика дольше этого срока сжимается в пометку «Простой».
const BIG_CHART_BREAK_PX    = 110; // Ширина пометки простоя на оси, пикселей.
const BIG_CHART_PAD_MS      = 60 * 1000; // Сколько тишины показывать вокруг активного участка (до и после трафика).
const BIG_CHART_ACTIVE_BPS  = 512; // Скорость (Б/с), с которой трафик считается заметным (мелкий keepalive не в счёт).
const BIG_CHART_BIN_JUMP_PX = 15; // Перепад высоты в одной полосе, при котором обрыв сохраняется, а не усредняется.
let bigChartModel           = null; // Модель оси времени и ряда после расчёта размеров (участки, координаты точек).
let bigChartScroll          = null; // Прокручиваемая область графика.
let bigChartInner           = null; // Блок, ширина которого растёт вместе с периодом.
let bigChartSvg             = null; // SVG с линией, сеткой и подписями времени.
let bigChartPxLast          = 0; // Масштаб (px/мин) у «живого» края; замораживается, пока пользователь смотрит историю.
let bigChartStickEnd        = false; // Прокрутить к правому краю (свежим данным) при следующем обновлении.
let bigChartDrawQueued      = false; // Перерисовка при прокрутке уже запланирована.
let bigChartTouching        = false; // Палец на графике или идёт инерция прокрутки: не «выдёргиваем» к правому краю.
let bigChartDrag            = null; // Состояние перетаскивания мышью.

// ─── Недавно удалённые клиенты ───────────────────────────────────────
let deletedPeers = new Set();

// ─── Типы событий ────────────────────────────────────────────────────
const EVENT_TYPES = ['online', 'offline', 'roam', 'error', 'client_created', 'client_deleted'];

// ─── Параметры спарклайнов и история трафика ─────────────────────────
let SPARK_WINDOW_MS          = 120000;
const SPARK_MIN_SCALE        = 2000;
const SPARK_W                = 100;
const SPARK_H                = 24;
const SPARK_PAD              = 2;
const SPARK_NOISE_BPS        = 1024;
let SPARK_NO_DATA_TIMEOUT_MS = 60000;
const trafficHistory         = new Map();
// Сколько истории держим в памяти: пока открыт большой график этого пира, храним вдвое больше окна,
// чтобы левый край не «уезжал» на глазах у пользователя (лишнее удаляется, когда график закрыт).
function bigKeepMs(pk) {
  return pk === bigChartPk ? BIG_CHART_MAX_MS * 2 : BIG_CHART_MAX_MS;
}

let BIG_CHART_MAX_MS         = 6 * 60 * 60 * 1000; // Сколько истории хранить для большого графика (TRAFFIC_HISTORY с сервера).

// ═══════════════════════════════════════════════════════════════════════
// 6. ТРАФИК
// ═══════════════════════════════════════════════════════════════════════

// ─── Безопасное значение скорости ────────────────────────────────────
// NaN, Infinity и отрицательные числа превращаются в 0.
function safeRate(v) {
  v = Number(v);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// ─── Разбор трафика, пришедшего с сервера ────────────────────────────
function applyServerTraffic(state) {
  const now = nowMs();
  const cutoff = now - SPARK_WINDOW_MS;
  const incoming = (state && state.traffic) || {};
  const alive = new Set(Object.keys(incoming));

  for (const [pk, samples] of Object.entries(incoming)) {
    if (!Array.isArray(samples)) continue;
    const h = trafficHistory.get(pk) || { samples: [], all: [] };
    const parsed = samples
      .map(s => Array.isArray(s) && s.length >= 3 ? { t: Number(s[0]) * 1000, rx: safeRate(s[1]), tx: safeRate(s[2]) } : null)
      .filter(s => s && Number.isFinite(s.t))
      .sort((a, b) => a.t - b.t);

    // Короткое окно — для спарклайнов в карточках.
    h.samples = parsed.filter(s => s.t >= cutoff);

    // Длинная история — для большого графика: дописываем только новые точки.
    const all = h.all || [];
    let lastT = all.length ? all[all.length - 1].t : 0;
    for (const s of parsed) {
      if (s.t > lastT) { all.push(s); lastT = s.t; }
    }
    const bigCutoff = now - bigKeepMs(pk);
    let drop = 0;
    while (drop < all.length && all[drop].t < bigCutoff) drop++;
    if (drop) all.splice(0, drop);
    h.all = all;

    trafficHistory.set(pk, h);
  }

  // Пиры без свежих точек: короткий ряд усыхает, длинную историю храним, пока она не устарела.
  const existing = new Set(((state && state.peers) || []).map(p => p.pubkey));
  for (const pk of Array.from(trafficHistory.keys())) {
    if (alive.has(pk)) continue;
    const h = trafficHistory.get(pk);
    if (!h || !existing.has(pk)) {
      trafficHistory.delete(pk);   // клиента удалили
      continue;
    }
    h.samples = (h.samples || []).filter(s => s.t >= cutoff);
    const keepCutoff = now - bigKeepMs(pk);
    h.all = (h.all || []).filter(s => s.t >= keepCutoff);
    if (!h.all.length) trafficHistory.delete(pk);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 7. РЕНДЕР: СТАТИСТИКА
// ═══════════════════════════════════════════════════════════════════════

// ─── Отрисовка статистики ────────────────────────────────────────────
function renderStats(state) {
  const peers = state?.peers || [];
  const online = peers.filter(isPeerOnline).length;
  const offline = peers.length - online;
  const totalRx = peers.reduce((s, p) => s + (Number(p.rx) || 0), 0);
  const totalTx = peers.reduce((s, p) => s + (Number(p.tx) || 0), 0);
  const up = state?.uptime;

  const statsEl = document.getElementById('stats');
  if (!statsEl) return;

  if (!statsEl.querySelector('.stat')) {
    setHtml(statsEl, `
      <div class="stat"><div class="label">${t('peers')}</div><div class="value" id="stat-peers">0</div></div>
      <div class="stat"><div class="label">${t('online')}</div><div class="value green" id="stat-online">0</div></div>
      <div class="stat"><div class="label">${t('offline')}</div><div class="value red" id="stat-offline">0</div></div>
      <div class="stat"><div class="label">${t('totalRxTx')}</div><div class="value blue" id="stat-traffic" style="font-size:16px;">0 / 0</div></div>
      <div class="stat"><div class="label">${t('uptime')}</div><div class="value" id="stat-uptime" style="font-size:16px;">-</div></div>
    `);
  }

  document.getElementById('stat-peers').textContent = peers.length;
  document.getElementById('stat-online').textContent = online;
  document.getElementById('stat-offline').textContent = offline;
  document.getElementById('stat-traffic').textContent = `${humanBytes(totalRx)} / ${humanBytes(totalTx)}`;
  document.getElementById('stat-uptime').textContent = up != null ? humanDuration(up) : t('dash');
}

// ═══════════════════════════════════════════════════════════════════════
// 8. РЕНДЕР: БАННЕР ДЕМОНА
// ═══════════════════════════════════════════════════════════════════════

// ─── Состояние баннера демона ────────────────────────────────────────
let daemonBannerDown = null;

// ─── Показ и скрытие баннера демона ──────────────────────────────────
function renderDaemonBanner(state) {
  const el = document.getElementById('daemonBanner');
  if (!el) return;

  const down = !state || state.uptime === null || state.uptime === undefined;

  if (daemonBannerDown === down) return;
  daemonBannerDown = down;

  el.classList.toggle('visible', down);
  document.body.classList.toggle('daemon-down', down);
}

// ═══════════════════════════════════════════════════════════════════════
// 9. РЕНДЕР: СПАРКЛАЙНЫ
// ═══════════════════════════════════════════════════════════════════════

// ─── Заглушка мини-графика ───────────────────────────────────────────
// Если живого трафика нет, но в истории есть данные — предлагаем открыть историю,
// иначе пишем «нет данных».
function emptySparkHtml(pk) {
  const h = trafficHistory.get(pk);
  const hasHistory = !!h && (h.all || []).length >= 2;
  const cls = hasHistory ? 'sparkline-container sparkline-empty has-history' : 'sparkline-container sparkline-empty';
  const text = hasHistory ? t('showHistory') : t('noData');
  return `<div class="${cls}"><span>${escapeHtml(text)}</span></div>`;
}

// ─── Фоновая проверка истории на сервере ─────────────────────────────
// Для пиров без истории в браузере раз в минуту (HISTORY_PROBE_MS) тихо спрашиваем сервер,
// чтобы вместо «нет данных» показать «Показать историю», если она есть.
function probeHistory(state) {
  const now = Date.now();
  const present = new Set(((state && state.peers) || []).map(p => p.pubkey));
  for (const pk of Array.from(historyProbe.keys())) if (!present.has(pk)) historyProbe.delete(pk);
  for (const p of ((state && state.peers) || [])) {
    const h = trafficHistory.get(p.pubkey);
    if (h && (h.all || []).length >= 2) continue;
    const last = historyProbe.get(p.pubkey) || 0;
    if (now - last < HISTORY_PROBE_MS) continue;
    historyProbe.set(p.pubkey, now);
    loadBigChartHistory(p.pubkey);
  }
}

// ─── Ряд для спарклайна ──────────────────────────────────────────────
// Демон не пишет точки, когда трафика нет, поэтому пауза между точками — это НОЛЬ.
// Без этого линия тянулась бы наклонно от одного всплеска к другому через всю паузу.
// Добавляем нули по краям пауз, в начале окна и после последней точки (до «сейчас»).
function sparkSeries(s, key, end) {
  const dts = [];
  for (let i = 0; i < s.length - 1; i++) {
    const dt = s[i + 1].t - s[i].t;
    if (dt > 0 && dt <= 10000) dts.push(dt);
  }
  dts.sort((a, b) => a - b);
  const med = dts.length ? dts[dts.length >> 1] : 2000;
  const step = Math.min(Math.max(med, 1000), 5000);
  const gap = step * 3;
  const t0 = end - SPARK_WINDOW_MS;
  const val = (x) => (x[key] >= SPARK_NOISE_BPS ? x[key] : 0);

  const out = [];
  if (s[0].t - t0 > gap) {
    out.push({ t: t0, v: 0 });
    out.push({ t: s[0].t - step, v: 0 });
  }
  for (let i = 0; i < s.length; i++) {
    out.push({ t: s[i].t, v: val(s[i]) });
    const next = s[i + 1];
    if (next && next.t - s[i].t > gap) {
      out.push({ t: s[i].t + step, v: 0 });
      out.push({ t: next.t - step, v: 0 });
    }
  }
  const last = s[s.length - 1];
  if (end - last.t > gap) {
    out.push({ t: last.t + step, v: 0 });
    out.push({ t: end, v: 0 });
  }
  return out;
}

// ─── Мини-график в карточке пира ─────────────────────────────────────
function renderSparkline(pk, isRx, isOnline) {
  const key = isRx ? 'rx' : 'tx';
  const h = trafficHistory.get(pk);
  const s = h ? h.samples : [];

  const significant = s.filter(x => x[key] >= SPARK_NOISE_BPS);
  let peak = 0;
  for (const x of significant) if (x[key] > peak) peak = x[key];

  const lastSignificantT = significant.length ? significant[significant.length - 1].t : 0;
  const now = nowMs();

  if (s.length < 2 || peak === 0 || (now - lastSignificantT) > SPARK_NO_DATA_TIMEOUT_MS) {
    return '';
  }

  const base = SPARK_H - SPARK_PAD;
  const end = now;
  const scale = niceCeil(Math.max(peak, SPARK_MIN_SCALE));

  const pts = sparkSeries(s, key, end).map(x => {
    const px = Math.min(Math.max(SPARK_W - ((end - x.t) / SPARK_WINDOW_MS) * SPARK_W, 0), SPARK_W);
    const py = base - (x.v / scale) * (SPARK_H - 2 * SPARK_PAD);
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  }).join(' ');

  const cls = isRx
    ? (isOnline ? 'rx-line' : 'rx-line spark-stale')
    : (isOnline ? 'tx-line' : 'tx-line spark-stale');
  const line = `<polyline class="${cls}" points="${pts}"/>`;

  const tip = `${isRx ? t('rxTitle') : t('txTitle')} · ` +
    tFormat('sparkTitle', { SEC: SPARK_WINDOW_MS / 1000, PEAK: humanBytes(peak) });

  const sparkHash = cls + '|' + pts;

  return `<div class="sparkline-container" title="${escapeHtml(tip)}" data-spark-hash="${sparkHash}">
    <svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true">
      <line class="spark-base" x1="0" y1="${base}" x2="${SPARK_W}" y2="${base}"/>
      ${line}
    </svg>
  </div>`;
}

// ─── Обновление контейнера спарклайна ────────────────────────────────
// Если «форма» мини-графика не изменилась (тот же класс линии), меняем только атрибуты in-place:
// DOM не пересоздаётся каждый опрос, подсказка под курсором не мигает.
function setSparkHtml(container, html) {
  if (container.__sparkHtml === html) return;
  container.__sparkHtml = html;

  const oldPoly = container.querySelector('polyline');
  if (oldPoly && html.includes('<polyline')) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    const newBox  = tpl.content.firstElementChild;
    const newPoly = tpl.content.querySelector('polyline');
    const oldBox  = container.firstElementChild;
    if (newBox && newPoly && oldBox &&
        oldBox.className === newBox.className &&
        oldPoly.getAttribute('class') === newPoly.getAttribute('class')) {
      oldPoly.setAttribute('points', newPoly.getAttribute('points') || '');
      const tip = newBox.getAttribute('title');
      if (tip) oldBox.setAttribute('data-title', tip);
      return;
    }
  }
  container.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════
// 10. РЕНДЕР: КАРТОЧКИ ПИРОВ
// ═══════════════════════════════════════════════════════════════════════

// ─── Отрисовка карточек пиров ────────────────────────────────────────
function renderPeers(state) {
  let peers = state?.peers || [];

  if (deletedPeers.size > 0) {
    peers = peers.filter(p => {
      const key = String(p.name || p.pubkey || '');
      return !deletedPeers.has(key);
    });
  }

  const sortedPeers = [...peers].sort((a, b) => {
    const aOnline = isPeerOnline(a);
    const bOnline = isPeerOnline(b);
    if (aOnline && !bOnline) return -1;
    if (!aOnline && bOnline) return 1;
    return (a.name || "").localeCompare(b.name || "");
  });

  const enriched = sortedPeers.map(p => {
    return { ...p, online: isPeerOnline(p) };
  });

  if (selectedPeer !== null) {
    const stillExists = enriched.some(p => String(p.name || p.pubkey || '') === selectedPeer);
    if (!stillExists) {
      selectedPeer = null;
      selectedPk = null;
    }
  }

  const filtered = filter === 'all' ? enriched
    : filter === 'online' ? enriched.filter(p => p.online)
    : enriched.filter(p => !p.online);

  const container = document.getElementById('peers');
  if (!container) return;

  if (filtered.length === 0) {
    const emptyHtml = `<div class="empty">${t('noPeers')}</div>`;
    if (container.innerHTML !== emptyHtml) {
      container.innerHTML = emptyHtml;
      container.__html = emptyHtml;
    }
    return;
  } else {
    const emptyEl = container.querySelector('.empty');
    if (emptyEl) emptyEl.remove();
  }

  const existingCards = new Map();
  container.querySelectorAll('.peer').forEach(card => {
    existingCards.set(card.dataset.peerKey, card);
  });

  const newOrderKeys = [];

  filtered.forEach(p => {
    const peerKey = String(p.name || p.pubkey || '');
    newOrderKeys.push(peerKey);

    const rxv = Number(p.rx) || 0;
    const txv = Number(p.tx) || 0;
    const total = (rxv + txv) || 1;
    const rxPct = (rxv / total * 100).toFixed(1);
    const txPct = (txv / total * 100).toFixed(1);

    // Слишком давняя активность (или её не было): данные устарели, вместо них прочерки.
    const stale = p.handshake_age == null || p.handshake_age > staleTimeoutSec();
    const hs = stale
      ? t('dash')
      : `${humanDuration(p.handshake_age)} ${t('agoSuffix')}`;

    const known = p.name && p.name !== p.pubkey;
    const displayName = known ? String(p.name) : (p.pubkey || '').slice(0, 12) + '…';
    const isSelected = (selectedPeer !== null && peerKey === selectedPeer);

    let card = existingCards.get(peerKey);

    if (!card) {
      card = document.createElement('div');
      card.className = `peer ${p.online ? '' : 'offline'} ${isSelected ? 'selected' : ''}`;
      card.dataset.peerKey = peerKey;
      card.dataset.peerPk = p.pubkey || '';
      card.setAttribute('role', 'group');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-pressed', String(isSelected));

      card.innerHTML = `
        <div class="top">
          <span class="name"><span class="name-text">${escapeHtml(displayName)}</span><span class="hint" data-pubkey="${escapeHtml(p.pubkey || '')}" title="${t('copyPubkey')}" aria-label="${t('copyPubkey')}"><svg class="icon"><use href="icons/sprite.svg#icon-copy"></use></svg></span></span>
          <button class="btn-icon btn-download" type="button" title="${t('downloadConfig')}"><svg class="icon"><use href="icons/sprite.svg#icon-download"></use></svg></button>
          <button class="btn-icon btn-delete" type="button" title="${t('delete')}"><svg class="icon"><use href="icons/sprite.svg#icon-trash"></use></svg></button>
          <span class="status ${p.online ? 'online' : 'offline'}"></span>
        </div>
        <div class="row"><span>${t('endpoint')}</span><span class="val-endpoint"></span></div>
        <div class="row"><span>${t('allowedIPs')}</span><span class="val-allowedips"></span></div>
        <div class="row"><span>${t('handshake')}</span><span class="val-handshake"></span></div>
        <div class="bar-row">
          <span class="val-rx" title="${t('rxTitle')}">
            <svg class="icon-arrow down" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
            <span class="rx-text"></span>
          </span>
          <span class="label">${t('rxTx')}</span>
          <span class="val-tx" title="${t('txTitle')}">
            <svg class="icon-arrow up" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
            <span class="tx-text"></span>
          </span>
        </div>
        <div class="bar"><div class="rx"></div><div class="tx"></div></div>
        <div style="display:flex; gap:10px; margin-top:8px;">
          <div style="flex:1" class="spark-rx"></div>
          <div style="flex:1" class="spark-tx"></div>
        </div>
      `;
      container.appendChild(card);
    }

    const isOffline = !p.online;
    if (card.classList.contains('offline') !== isOffline) {
      card.classList.toggle('offline', isOffline);
    }
    if (card.classList.contains('selected') !== isSelected) {
      card.classList.toggle('selected', isSelected);
    }
    card.setAttribute('aria-pressed', String(isSelected));

    const statusEl = card.querySelector('.status');
    statusEl.className = `status ${p.online ? 'online' : 'offline'}`;
    statusEl.textContent = p.online ? t('statusOnline') : t('statusOffline');

    const dash = t('dash');
    card.querySelector('.val-endpoint').textContent = (stale ? '' : p.endpoint) || dash;
    card.querySelector('.val-endpoint').removeAttribute('title');
    card.querySelector('.val-allowedips').textContent = p.allowed_ips || '';
    card.querySelector('.val-allowedips').removeAttribute('title');

    const handshakeEl = card.querySelector('.val-handshake');
    if (handshakeEl) {
      handshakeEl.textContent = hs;
    }

    card.querySelector('.rx-text').textContent = humanBytes(rxv);
    card.querySelector('.tx-text').textContent = humanBytes(txv);

    const barEl = card.querySelector('.bar');
    const barTitle = tFormat('barTitle', { RX: humanBytes(rxv), TX: humanBytes(txv) });
    barEl.title = barTitle;
    barEl.querySelector('.rx').style.width = `${rxPct}%`;
    barEl.querySelector('.tx').style.width = `${txPct}%`;

    const sparkRxContainer = card.querySelector('.spark-rx');
    const sparkTxContainer = card.querySelector('.spark-tx');

    // Большой график открываем всегда: история может быть и когда живого трафика сейчас нет.
    // Если данных нет совсем, openBigChart покажет сообщение.
    const onSparkClick = (isRx) => (e) => {
      e.stopPropagation();
      openBigChart(p.pubkey, isRx);
    };
    sparkRxContainer.onclick = onSparkClick(true);
    sparkTxContainer.onclick = onSparkClick(false);

    const newSparkRx = renderSparkline(p.pubkey, true, p.online);
    const newSparkTx = renderSparkline(p.pubkey, false, p.online);

    const rxHtml = newSparkRx || emptySparkHtml(p.pubkey);
    const txHtml = newSparkTx || emptySparkHtml(p.pubkey);

    // Перерисовываем контейнер, только если его HTML изменился (заодно подхватывается смена языка).
    setSparkHtml(sparkRxContainer, rxHtml);
    setSparkHtml(sparkTxContainer, txHtml);
  });

  existingCards.forEach((card, key) => {
    if (!newOrderKeys.includes(key)) {
      card.remove();
    }
  });

  let cursor = container.firstElementChild;
  newOrderKeys.forEach(key => {
    const card = container.querySelector(`.peer[data-peer-key="${CSS.escape(key)}"]`);
    if (!card) return;
    if (card === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      container.insertBefore(card, cursor);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 11. РЕНДЕР: ЛЕНТА СОБЫТИЙ
// ═══════════════════════════════════════════════════════════════════════

// ─── Локализация текста события ──────────────────────────────────────
function localizeEventMessage(e) {
  const kind = e.kind || '';

  if (kind === 'connected') return tFormat('evConnected', { EP: e.endpoint || '' });
  if (kind === 'session') {
    const dur = humanDuration(Number(e.extra) || 0);
    if (e.srx !== undefined || e.stx !== undefined) {
      return tFormat('evSessionTraffic', { DUR: dur, RX: humanBytes(Number(e.srx) || 0), TX: humanBytes(Number(e.stx) || 0) });
    }
    return tFormat('evSession', { DUR: dur });
  }
  if (kind === 'roam')      return tFormat('evRoam',      { FROM: e.extra || '', TO: e.endpoint || '' });
  if (kind === 'wg_failed') return tFormat('evWgFailed',  { TEXT: e.extra || '' });
  if (kind === 'wg_recovered') return t('evWgRecovered');
  if (kind === 'client_created') return t('evClientCreated');
  if (kind === 'client_deleted') return t('evClientDeleted');
  if (kind === 'silent')    return t('evSilentOffline');

  const msg = e.msg || '';
  let m;
  if ((m = msg.match(/^connected from (.+)$/))) return tFormat('evConnected', { EP: m[1] });
  if ((m = msg.match(/^session (.+?)(?: rx .+)?$/))) return tFormat('evSession', { DUR: m[1] });
  if ((m = msg.match(/^(\S+) -> (\S+)$/)))      return tFormat('evRoam',      { FROM: m[1], TO: m[2] });
  if ((m = msg.match(/^wg show failed: (.+)$/))) return tFormat('evWgFailed', { TEXT: m[1] });
  if (msg === 'wg_show_recovered') return t('evWgRecovered');
  return tFormat('evUnknown', { MSG: msg });
}

// ─── Отрисовка ленты событий ─────────────────────────────────────────
function renderEventsFeed() {
  const el = document.getElementById('events');
  const title = document.getElementById('eventsTitle');
  const clear = document.getElementById('eventsClear');
  const count = document.getElementById('eventsCount');
  if (!el || !title || !clear || !count) return;

  if (selectedPeer) {
    const label = selectedPeer.length > 30 ? selectedPeer.slice(0, 12) + '…' : selectedPeer;
    title.textContent = `${t('events')} — ${label}`;
    title.classList.add('filtered');
    clear.classList.add('visible');
  } else {
    title.textContent = t('events');
    title.classList.remove('filtered');
    clear.classList.remove('visible');
  }

  let list = lastEvents;
  if (selectedPeer) {
    list = list.filter(e =>
      (selectedPk && e.pk === selectedPk) ||
      String(e.name || e.pk || '') === selectedPeer);
  }

  const sorted = (() => {
    const copy = [...list];
    switch (eventsSort) {
      case 'old':  return copy.reverse();
      case 'type': return copy.sort((a, b) => (a.type || '').localeCompare(b.type || ''));
      case 'name': return copy.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      case 'new':
      default:     return copy;
    }
  })();

  count.textContent = `${sorted.length}`;

  if (!sorted.length) {
    const emptyHtml = `<div class="empty">${selectedPeer ? t('noEventsForPeer') : t('noEvents')}</div>`;
    if (el.dataset.lastHash !== emptyHtml) {
      el.dataset.lastHash = emptyHtml;
      setHtml(el, emptyHtml);
    }
    return;
  }

  const icons = {
    online:         '<svg class="icon"><use href="icons/sprite.svg#icon-online"></use></svg>',
    offline:        '<svg class="icon"><use href="icons/sprite.svg#icon-offline"></use></svg>',
    roam:           '<svg class="icon"><use href="icons/sprite.svg#icon-roam"></use></svg>',
    error:          '<svg class="icon"><use href="icons/sprite.svg#icon-error"></use></svg>',
    client_created: '<svg class="icon"><use href="icons/sprite.svg#icon-created"></use></svg>',
    client_deleted: '<svg class="icon"><use href="icons/sprite.svg#icon-trash"></use></svg>'
  };
  const iconFallback = '<span style="color:var(--muted)">•</span>';

  const html = sorted.map(e => {
    let cls = '';
    if (e.kind === 'client_created') cls = 'client_created';
    else if (e.kind === 'client_deleted') cls = 'client_deleted';
    else if (e.kind === 'silent') cls = 'error';
    else if (EVENT_TYPES.includes(e.type)) cls = e.type;

    const icon = icons[cls] || (e.kind && icons[e.kind]) || iconFallback;
    let typeText = e.type || '';
    if (typeText === 'online') typeText = t('evTypeOnline');
    else if (typeText === 'offline') typeText = t('evTypeOffline');
    else if (typeText === 'roam') typeText = t('evTypeRoam');
    else if (typeText === 'client') typeText = t('evTypeClient');
    else if (typeText === 'error') typeText = t('evTypeError');

    return `
    <div class="event ${cls}">
      <span class="ts">${escapeHtml(fmtDateTime(e.ts))}</span>
      <span class="icon">${icon}</span>
      <span class="type">${escapeHtml(typeText)}</span>
      <span class="msg">
          <b>${escapeHtml(e.name || e.pk || '')}</b> — ${escapeHtml(localizeEventMessage(e))}
      </span>
    </div>`;
  }).join('');

  if (el.dataset.lastHash !== html) {
    el.dataset.lastHash = html;
    setHtml(el, html);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 12. ПОЛЛИНГ
// ═══════════════════════════════════════════════════════════════════════

// ─── Один цикл опроса сервера ────────────────────────────────────────
async function tickOnce() {
  // Размер ленты задаётся на сервере (EVENTS_LIMIT / EVENTS_LIMIT_PEER в wg-watch-web.env).
  const [state, events] = await Promise.all([fetchState(), fetchEvents(!!selectedPeer)]);

  const isDaemonDown = !state || state.uptime === null || state.uptime === undefined || !!state.error;

  if (!isDaemonDown) {
    lastState = state;
    updateClockOffset(state.server_time);

    // Перезапуск демона: uptime стал меньше прошлого. Его история пропала, поэтому сбрасываем свою,
    // иначе в карточках осталась бы кнопка «Показать историю» без данных.
    const upNow = Number(state.uptime);
    if (Number.isFinite(upNow)) {
      if (lastDaemonUptime !== null && upNow < lastDaemonUptime) {
        trafficHistory.clear();
        historyProbe.clear();
      }
      lastDaemonUptime = upNow;
    }

    // Сначала читаем настройки графиков с сервера (TRAFFIC_WINDOW / TRAFFIC_TIMEOUT), потом применяем трафик.
    // Принимаем только положительные числа; иначе остаются прежние значения.
    const win = Number(state.traffic_window);
    if (Number.isFinite(win) && win > 0) SPARK_WINDOW_MS = win * 1000;
    const tmo = Number(state.traffic_timeout);
    if (Number.isFinite(tmo) && tmo > 0) SPARK_NO_DATA_TIMEOUT_MS = tmo * 1000;

    const hist = Number(state.traffic_history);
    if (Number.isFinite(hist) && hist > 0) BIG_CHART_MAX_MS = hist * 1000;

    applyServerTraffic(state);
    probeHistory(state);
    renderStats(state);
    renderPeers(state);
    renderDaemonBanner(state);

    if (bigChartPk && bigChartModal.classList.contains('visible')) {
      updateBigChart();
    }

    const dot = document.getElementById('dot');
    if (dot) {
      dot.classList.remove('err');
      dot.setAttribute('data-title', t('daemonUpShort'));
    }

    const pubkey = (state.iface && state.iface.public_key) || '';
    const port = (state.iface && state.iface.listen_port) || '?';
    const hostEl = document.getElementById('hostInfo');
    if (hostEl) {
      hostEl.textContent = pubkey ? `pubkey: ${pubkey} · port ${port}` : `port ${port}`;
    }
  } else {
    const dot = document.getElementById('dot');
    if (dot) {
      dot.classList.add('err');
      dot.setAttribute('data-title', t('daemonDownShort'));
    }

    const hostEl = document.getElementById('hostInfo');
    if (hostEl) {
      hostEl.textContent = '—';
      hostEl.removeAttribute('data-title');
      hostEl.removeAttribute('title');
    }

    renderDaemonBanner({ uptime: null });
    renderStats({ peers: [] });

    const container = document.getElementById('peers');
    if (container) {
      container.innerHTML = '';
    }

    lastEvents = [];
    renderEventsFeed();
  }

  if (events !== null && !isDaemonDown) {
    lastEvents = events;
    renderEventsFeed();
  }
}

// ─── Защита от параллельных опросов ──────────────────────────────────
let tickBusy = false;
async function tick() {
  if (tickBusy) return;
  tickBusy = true;
  try { await tickOnce(); }
  catch (e) { console.error(e); }
  finally { tickBusy = false; }
}

// ─── Часы в шапке ────────────────────────────────────────────────────
function tickClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = fmtTime(new Date());
}

// ═══════════════════════════════════════════════════════════════════════
// 13. ЯЗЫК
// ═══════════════════════════════════════════════════════════════════════

// ─── Применение языка ────────────────────────────────────────────────
function applyLang(lang) {
  setLang(lang);

  document.querySelectorAll("#langToggle button").forEach(b => {
    const on = b.dataset.lang === lang;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });

  document.title = t('title');
  applyStaticI18n();

  if (lastState) {
    const statsEl = document.getElementById('stats');
    if (statsEl) {
      statsEl.innerHTML = '';
      statsEl.__html = '';
    }
    renderStats(lastState);

    const peersContainer = document.getElementById('peers');
    if (peersContainer) {
      peersContainer.innerHTML = '';
      peersContainer.__html = '';
    }
    renderPeers(lastState);
  }

  renderEventsFeed();

  if (bigChartPk && bigChartModal.classList.contains('visible')) {
    const peer = lastState?.peers?.find(p => p.pubkey === bigChartPk);
    const peerName = peer ? (peer.name || bigChartPk.slice(0, 8)) : bigChartPk.slice(0, 8);
    bigChartTitle.textContent = `${bigChartIsRx ? t('bigChartRxTitle') : t('bigChartTxTitle')} (${peerName})`;
    createBigChartSkeleton();
    updateBigChart();
  }

  const refreshSelect = document.getElementById('refreshRate');
  if (refreshSelect) {
    refreshSelect.querySelectorAll('option').forEach(opt => {
      const val = opt.value / 1000;
      opt.textContent = `${val} ${t('sec')}`;
    });
  }
  tick();
}

// ═══════════════════════════════════════════════════════════════════════
// 14. МОДАЛКИ
// ═══════════════════════════════════════════════════════════════════════

// ─── Элементы модальных окон ─────────────────────────────────────────
const createModal       = document.getElementById('createModal');
const deleteModal       = document.getElementById('deleteModal');
const clearEventsModal  = document.getElementById('clearEventsModal');
const bigChartModal     = document.getElementById('bigChartModal');
const bigChartContainer = document.getElementById('bigChartContainer');
const bigChartTitle     = document.getElementById('bigChartTitle');
const newClientName     = document.getElementById('newClientName');
const btnConfirmCreate  = document.getElementById('btnConfirmCreate');
const btnConfirmDelete  = document.getElementById('btnConfirmDelete');
const deleteClientName  = document.getElementById('deleteClientName');

// ─── Открытие модального окна ────────────────────────────────────────
function openModal(el) {
  if (!el) return;
  modalReturnFocus = document.activeElement;
  el.classList.add('visible');
}

// ─── Закрытие модального окна ────────────────────────────────────────
function closeModal(el) {
  if (!el || !el.classList.contains('visible')) return;
  el.classList.remove('visible');

  if (el === bigChartModal) {
    bigChartPk = null;
    bigChartIsRx = null;
  }

  if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') {
    modalReturnFocus.focus();
  }
  modalReturnFocus = null;
}

// ─── Открытие окна создания клиента ──────────────────────────────────
document.getElementById('btnCreateClient').addEventListener('click', () => {
  newClientName.value = '';
  openModal(createModal);
  setTimeout(() => newClientName.focus(), 50);
});

// ─── Кнопки «Отмена» в модальных окнах ───────────────────────────────
document.querySelectorAll('.modal-btn.cancel').forEach(btn => {
  btn.addEventListener('click', () => {
    closeModal(btn.closest('.modal-overlay'));
  });
});

// ─── Закрытие модальных окон по клику на фон ─────────────────────────
[createModal, deleteModal, clearEventsModal, bigChartModal].forEach(modal => {
  if (!modal) return;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal(modal);
  });
});

// ─── Снятие фокуса с select после выбора ─────────────────────────────
document.querySelectorAll('select').forEach(select => {
  select.addEventListener('change', function() {
    this.blur();
  });
});

// ─── Закрытие модальных окон по Escape ───────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal(createModal);
    closeModal(deleteModal);
    closeModal(clearEventsModal);
    closeModal(bigChartModal);
  }
});

// ─── Создание клиента ────────────────────────────────────────────────
btnConfirmCreate.addEventListener('click', async () => {
  const name = newClientName.value.trim();
  if (!name) {
    showToast(t('errEmptyName'), 'error');
    return;
  }

  btnConfirmCreate.disabled = true;
  btnConfirmCreate.textContent = '...';

  try {
    const { ok, data } = await createClient(name);

    if (ok && data && data.ok) {
      closeModal(createModal);
      showToast(tFormat('clientCreated', { NAME: name }), 'success');
      setTimeout(() => { tick(); }, 300);
    } else {
      const d = data || {};
      const localized = translateError(d.error);
      const msg = (localized !== d.error) ? localized : (d.message || localized);
      showToast(msg, 'error');
    }
  } catch (err) {
    showToast(t('createError') + ': ' + err.message, 'error');
  } finally {
    btnConfirmCreate.disabled = false;
    btnConfirmCreate.textContent = t('create');
  }
});

// ─── Удаление клиента ────────────────────────────────────────────────
btnConfirmDelete.addEventListener('click', async () => {
  if (!clientToDelete) return;
  const nameToDelete = clientToDelete;

  btnConfirmDelete.disabled = true;
  btnConfirmDelete.textContent = '...';

  try {
    const { ok, data } = await deleteClient(nameToDelete);

    if (ok && data && data.ok) {
      closeModal(deleteModal);
      showToast(tFormat('clientDeleted', { NAME: nameToDelete }), 'success');

      deletedPeers.add(nameToDelete);
      if (lastState && lastState.peers) {
        const peer = lastState.peers.find(p => p.name === nameToDelete || p.pubkey === nameToDelete);
        if (peer && peer.pubkey) {
          deletedPeers.add(peer.pubkey);
        }
      }

      if (lastState && lastState.peers) {
        lastState.peers = lastState.peers.filter(p =>
          p.name !== nameToDelete && p.pubkey !== nameToDelete
        );
        renderStats(lastState);
        renderPeers(lastState);
      }

      setTimeout(() => { tick(); }, 500);

      setTimeout(() => {
        deletedPeers.delete(nameToDelete);
        if (lastState && lastState.peers) {
          const peer = lastState.peers.find(p => p.name === nameToDelete || p.pubkey === nameToDelete);
          if (peer && peer.pubkey) deletedPeers.delete(peer.pubkey);
        }
      }, 5000);

    } else {
      const d = data || {};
      const localized = translateError(d.error);
      const msg = (localized !== d.error) ? localized : (d.message || localized);
      showToast(msg, 'error');
    }
  } catch (err) {
    showToast(t('deleteError') + ': ' + err.message, 'error');
  } finally {
    btnConfirmDelete.disabled = false;
    btnConfirmDelete.textContent = t('delete');
  }
});

// ─── Enter в поле имени клиента ──────────────────────────────────────
newClientName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnConfirmCreate.click();
});

// ═══════════════════════════════════════════════════════════════════════
// 15. ОБРАБОТЧИКИ UI
// ═══════════════════════════════════════════════════════════════════════

// ─── Фильтр пиров по вкладкам ────────────────────────────────────────
document.getElementById('tabs').addEventListener('click', e => {
  const tb = e.target.closest('.tab');
  if (!tb) return;

  document.querySelectorAll('.tab').forEach(x => {
    x.classList.toggle('active', x === tb);
    x.setAttribute('aria-pressed', String(x === tb));
  });

  filter = tb.dataset.filter;
  if (lastState) renderPeers(lastState);
});

// ─── Переключатель темы ──────────────────────────────────────────────
document.getElementById('themeToggle').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  applyTheme(b.dataset.theme);
});

// ─── Переключатель языка ─────────────────────────────────────────────
document.getElementById('langToggle').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  applyLang(b.dataset.lang);
});

// ─── Кнопка обновления данных ────────────────────────────────────────
const refreshBtn = document.getElementById('refreshBtn');
if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    tick();
    showToast(t('eventsRefreshed') || 'Данные успешно обновлены', 'success');
  });
  refreshBtn.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      tick();
      showToast(t('eventsRefreshed') || 'Данные успешно обновлены', 'success');
    }
  });
}

// ─── Кнопка скачивания журнала событий ───────────────────────────────
const downloadBtn = document.getElementById('downloadBtn');
if (downloadBtn) {
  const downloadLogs = () => {
    showToast(t('logsDownloading') || 'Скачивание логов...', 'success');
    downloadEvents();
  };

  downloadBtn.addEventListener('click', downloadLogs);
  downloadBtn.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      downloadLogs();
    }
  });
}

// ─── Кнопка выхода ───────────────────────────────────────────────────
const logoutBtn = document.getElementById('logoutLink');
if (logoutBtn) {
  logoutBtn.addEventListener('click', () => { logout(); });
  logoutBtn.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); logout(); }
  });
}

// ─── Клики по карточкам пиров ────────────────────────────────────────
document.getElementById('peers').addEventListener('click', e => {
  const btnHint = e.target.closest('.hint');
  if (btnHint) {
    e.stopPropagation();
    const pubkey = btnHint.dataset.pubkey;
    if (pubkey) {
      copyText(pubkey).then(() => {
        const card = btnHint.closest('.peer');
        const peerName = card ? card.dataset.peerKey : 'client';

        showToast(tFormat('pubkeyCopied', { NAME: peerName }), 'success');

        if (btnHint._hideTimer) {
          clearTimeout(btnHint._hideTimer);
        }

        if (!btnHint.dataset.originalHtml) {
          btnHint.dataset.originalHtml = btnHint.innerHTML;
        }

        btnHint.innerHTML = '<svg class="icon"><use href="icons/sprite.svg#icon-created"></use></svg>';

        btnHint._hideTimer = setTimeout(() => {
          if (btnHint.isConnected && btnHint.dataset.originalHtml) {
            btnHint.innerHTML = btnHint.dataset.originalHtml;
            delete btnHint.dataset.originalHtml;
          }
          btnHint._hideTimer = null;
        }, 2000);
      }).catch(err => {
        const m = t('copyError');
        showToast(m && m !== 'copyError' ? m : 'Copy failed', 'error');
      });
    }
    return;
  }

  const btnDl = e.target.closest('.btn-download');
  if (btnDl) {
  e.stopPropagation();
  const card = btnDl.closest('.peer');
  if (!card) return;
  const name = card.dataset.peerKey;

  if (name) {
    (async () => {
      try {
        const { ok, data } = await downloadClientConfig(name);

        if (ok) {
          showToast(tFormat('configDownloaded', { NAME: name }), 'success');
          return;
        }

        const d = data || {};
        const localized = translateError(d.error);
        const msg = (localized !== d.error) ? localized : (d.message || localized);
        showToast(msg, 'error');
      } catch (err) {
        showToast(t('errManagerUnreachable'), 'error');
      }
    })();
  }
  return;
}

  const btnDel = e.target.closest('.btn-delete');
  if (btnDel) {
    e.stopPropagation();
    const card = btnDel.closest('.peer');
    if (!card) return;

    clientToDelete = card.dataset.peerKey;
    const nameEl = card.querySelector('.name');
    const displayName = nameEl ? nameEl.textContent : (clientToDelete || '');
    if (deleteClientName) deleteClientName.textContent = displayName;
    openModal(deleteModal);
    return;
  }

  const card = e.target.closest('.peer');
  if (!card) return;

  const key = card.dataset.peerKey || '';
  if (!key) return;

  selectedPeer = (selectedPeer === key) ? null : key;
  selectedPk = selectedPeer === null ? null : (card.dataset.peerPk || null);

  if (lastState) renderPeers(lastState);
  renderEventsFeed();
  tick();
});

// ─── Сброс фильтра событий ───────────────────────────────────────────
document.getElementById('eventsClear').addEventListener('click', () => {
  selectedPeer = null;
  selectedPk = null;
  if (lastState) renderPeers(lastState);
  renderEventsFeed();
});

// ─── Сортировка событий ──────────────────────────────────────────────
document.getElementById('eventsSort').addEventListener('change', e => {
  eventsSort = e.target.value;
  renderEventsFeed();
  e.target.blur();
});

// ─── Enter и пробел на карточках и вкладках ──────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target;
  if (!el || !el.classList || !(el.classList.contains('peer') || el.classList.contains('tab'))) return;
  e.preventDefault();
  el.click();
});

// ─── Очистка журнала событий ─────────────────────────────────────────
const eventsTruncate        = document.getElementById('eventsTruncate');
const btnConfirmClearEvents = document.getElementById('btnConfirmClearEvents');

if (eventsTruncate) {
  eventsTruncate.addEventListener('click', (e) => {
    openModal(clearEventsModal);
    e.currentTarget.blur();
  });
}

if (btnConfirmClearEvents) {
  btnConfirmClearEvents.addEventListener('click', async () => {
    btnConfirmClearEvents.disabled = true;
    btnConfirmClearEvents.textContent = '...';

    try {
      const { ok } = await clearEvents();

      if (ok) {
        closeModal(clearEventsModal);
        showToast(t('eventsCleared'), 'success');
        tick();
      } else {
        showToast(t('clearEventsError'), 'error');
      }
    } catch (err) {
      showToast(t('clearEventsError'), 'error');
    } finally {
      btnConfirmClearEvents.disabled = false;
      btnConfirmClearEvents.textContent = t('clearEventsBtn');
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 16. ИНИЦИАЛИЗАЦИЯ
// ═══════════════════════════════════════════════════════════════════════

// ─── Запуск опроса по таймеру ────────────────────────────────────────
function startPolling(ms) {
  // Фоновая проверка истории подстраивается под частоту обновления: каждые 5 опросов, но не чаще, чем раз в 10 секунд.
  HISTORY_PROBE_MS = Math.max(10000, ms * 5);
  if (pollIntervalId) clearInterval(pollIntervalId);
  pollIntervalId = setInterval(() => {
    if (!document.hidden) tick();
  }, ms);
}

// ═══════════════════════════════════════════════════════════════════════
// 17. БОЛЬШОЙ ГРАФИК
// ═══════════════════════════════════════════════════════════════════════

// ─── Формат скорости для осей графика ────────────────────────────────
// Формат скорости для осей: «12.3 KB/s».
function fmtRate(v) {
  v = Number(v) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  const num = (i === 0 || v >= 100) ? Math.round(v) : v.toFixed(1);
  return `${num} ${u[i]}/s`;
}

// ─── Формат времени для оси X ────────────────────────────────────────
// Формат времени для оси X: ЧЧ:ММ или ЧЧ:ММ:СС (без «24:xx»).
function fmtClock(ms, withSeconds) {
  const opts = { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' };
  if (withSeconds) opts.second = '2-digit';
  return new Date(ms).toLocaleTimeString(currentLang === 'ru' ? 'ru-RU' : 'en-GB', opts);
}

// ─── Данные большого графика ─────────────────────────────────────────
// Данные большого графика: длинная история, сегменты оси времени и ряд для рисования.
function getBigChartData() {
  const h = trafficHistory.get(bigChartPk);
  const samples = h ? (h.all && h.all.length ? h.all : h.samples) : [];
  if (!samples || samples.length < 2) return null;
  const key = bigChartIsRx ? 'rx' : 'tx';
  const axis = buildBigAxis(samples, key, serverNowMs());
  return { samples, key, ...axis };
}

// ─── Текущее время сервера ───────────────────────────────────────────
// Берётся из последнего ответа api/state (server_time); запасной вариант — часы браузера.
// ─── Параметры и статус пира, которые задаёт сервер ──────────────────
// Сервер (демон) сам решает, кто онлайн (PEER_TIMEOUT + OBSERVE_WINDOW + OFFLINE_CONFIRM), и отдаёт это в api/state.
// Константы TIMEOUT_SEC и PEER_STALE_SEC — запасные значения для старого демона без этих полей.
function peerTimeoutSec() {
  const v = Number(lastState && lastState.peer_timeout);
  return Number.isFinite(v) && v > 0 ? v : TIMEOUT_SEC;
}
function staleTimeoutSec() {
  const v = Number(lastState && lastState.stale_timeout);
  return Number.isFinite(v) && v > 0 ? v : PEER_STALE_SEC;
}
function isPeerOnline(p) {
  if (p && typeof p.online === 'boolean') return p.online;
  return !!p && p.handshake_age != null && p.handshake_age <= peerTimeoutSec();
}

function serverNowMs() {
  return nowMs();
}

// Текущее время по часам сервера (часы браузера + поправка).
function nowMs() {
  return Date.now() + clockOffsetMs;
}

// Обновляет поправку по server_time. server_time приходит с точностью до секунды, поэтому сглаживаем,
// чтобы правый край графика не «дрожал»; при большом скачке (смена часов) берём новое значение сразу.
function updateClockOffset(serverTime) {
  const st = serverTime ? Date.parse(serverTime) : NaN;
  if (!Number.isFinite(st)) return;
  const off = st + 500 - Date.now();   // +500 мс: server_time обрезан до секунды.
  if (!clockOffsetMs || Math.abs(off - clockOffsetMs) > 5000) clockOffsetMs = off;
  else clockOffsetMs += (off - clockOffsetMs) * 0.2;
}

// ─── Ось времени и ряд для рисования ─────────────────────────────────
// Демон не записывает точки, когда трафика нет, поэтому пауза между точками — это НОЛЬ.
// Что делает эта функция:
//  1) делит время на участки: «активные» (идёт трафик) и «простои» (пауза дольше BIG_CHART_BREAK_MS).
//     Простой на оси сжимается в узкую пометку фиксированной ширины, а не растягивается на часы;
//  2) тянет график до «сейчас»: после последнего трафика линия уходит в ноль, а не обрывается в воздухе;
//  3) дополняет ряд нулями у краёв пауз, чтобы не было ложных наклонных линий.
// Мелкий служебный трафик (keepalive) активностью не считается.
function buildBigAxis(samples, key, nowMs) {
  // Типичный интервал между соседними точками при идущем трафике — от 1 до 5 секунд.
  const dts = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const dt = samples[i + 1].t - samples[i].t;
    if (dt > 0 && dt <= 10000) dts.push(dt);
  }
  dts.sort((a, b) => a - b);
  const med = dts.length ? dts[dts.length >> 1] : 2000;
  const step = Math.min(Math.max(med, 1000), 5000);
  const gap = step * 3;

  const endT = Math.max(samples[samples.length - 1].t, nowMs);
  const PAD = BIG_CHART_PAD_MS;

  // Точки с заметным трафиком.
  const act = [];
  for (const s of samples) {
    if (s[key] >= BIG_CHART_ACTIVE_BPS) act.push(s);
  }

  const segs = [];
  if (!act.length) {
    // Заметного трафика не было вообще: показываем последние 30 минут (плоская линия).
    segs.push({ type: 'active', t0: Math.max(samples[0].t, endT - 30 * 60000), t1: endT });
  } else {
    let segStart = Math.max(samples[0].t, act[0].t - PAD);
    let prev = act[0];
    for (let i = 1; i < act.length; i++) {
      const b = act[i];
      if (b.t - prev.t > BIG_CHART_BREAK_MS) {
        segs.push({ type: 'active', t0: segStart, t1: prev.t + PAD });
        segs.push({ type: 'break',  t0: prev.t + PAD, t1: b.t - PAD });
        segStart = b.t - PAD;
      }
      prev = b;
    }
    if (endT - prev.t > BIG_CHART_BREAK_MS) {
      segs.push({ type: 'active', t0: segStart, t1: prev.t + PAD });
      segs.push({ type: 'break',  t0: prev.t + PAD, t1: endT });
    } else {
      segs.push({ type: 'active', t0: segStart, t1: endT });
    }
  }

  // Ряд: точки внутри активных участков + нули у краёв пауз. Точки внутри простоев отбрасываются.
  const series = [];
  let si = 0;
  for (const seg of segs) {
    if (seg.type !== 'active') continue;
    while (si < samples.length && samples[si].t < seg.t0) si++;
    const pts = [];
    while (si < samples.length && samples[si].t <= seg.t1) { pts.push(samples[si]); si++; }

    if (!pts.length || pts[0].t - seg.t0 > step) series.push({ t: seg.t0, v: 0 });
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      series.push({ t: p.t, v: p[key] });
      const next = pts[k + 1];
      if (next && next.t - p.t > gap) {
        series.push({ t: p.t + step, v: 0 });
        series.push({ t: next.t - step, v: 0 });
      }
    }
    // Хвост: ноль в конце участка ставим, только если точек нет заметно дольше обычного интервала (gap).
    // Иначе запоздавшая точка вызывала бы «падение в ноль» и возврат на следующем опросе (мерцание).
    if (!pts.length || seg.t1 - pts[pts.length - 1].t > gap) series.push({ t: seg.t1, v: 0 });
  }

  return { segs, series, step, minTime: segs[0].t0, maxTime: segs[segs.length - 1].t1 };
}

// ─── Время → координата X ────────────────────────────────────────────
// Ось кусочно-линейная: активные участки растянуты по масштабу, простои сжаты.
function bigChartTToX(t, segs) {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (t <= s.t1 || i === segs.length - 1) {
      const tt = Math.min(Math.max(t, s.t0), s.t1);
      const span = s.t1 - s.t0;
      return span > 0 ? s.x0 + ((tt - s.t0) / span) * (s.x1 - s.x0) : s.x0;
    }
  }
  return 0;
}

// ─── Открытие большого графика ───────────────────────────────────────
async function openBigChart(pubkey, isRx) {
  if (bigChartOpening) return;
  bigChartOpening = true;
  try {
    const peer = lastState?.peers?.find(p => p.pubkey === pubkey);
    const displayName = peer ? (peer.name || pubkey.slice(0, 8)) : pubkey.slice(0, 8);

    const countPoints = () => {
      const h = trafficHistory.get(pubkey);
      return h ? Math.max((h.all || []).length, (h.samples || []).length) : 0;
    };

    // Сервер — источник правды: сначала спрашиваем его. Если демон перезапускали и данных нет,
    // локальная история будет сброшена, и вместо графика покажется сообщение.
    await loadBigChartHistory(pubkey);

    if (countPoints() < 2) {
      showToast(tFormat('noChartDataFor', { NAME: displayName }), 'error');
      return;
    }

    bigChartPk = pubkey;
    bigChartIsRx = isRx;

    bigChartTitle.textContent = `${isRx ? t('bigChartRxTitle') : t('bigChartTxTitle')} (${displayName})`;

    openModal(bigChartModal);

    createBigChartSkeleton();
    updateBigChart();

  } finally {
    bigChartOpening = false;
  }
}

// ─── Загрузка длинной истории с сервера ──────────────────────────────
// Подтягивает длинную историю трафика пира: GET api/traffic?pk=... → { samples: [[t, rx, tx], ...] }.
// Если эндпоинта нет или он вернул ошибку — молча остаёмся на данных из api/state.
async function loadBigChartHistory(pubkey) {
  try {
    const raw = await fetchTrafficHistory(pubkey);
    if (raw === null) return false;   // Сеть или ошибка: оставляем то, что накопили.

    // Сервер — источник правды. Пустой ответ означает «данных нет» (например, демон перезапускали).
    const server = [];
    for (const r of raw) {
      if (!Array.isArray(r) || r.length < 3) continue;
      const tt = Number(r[0]) * 1000;
      if (!Number.isFinite(tt)) continue;
      server.push({ t: tt, rx: safeRate(r[1]), tx: safeRate(r[2]) });
    }
    server.sort((a, b) => a.t - b.t);

    const cutoff = nowMs() - BIG_CHART_MAX_MS;
    const fresh = server.filter(s => s.t >= cutoff);

    let h = trafficHistory.get(pubkey);

    if (!fresh.length) {
      // У сервера данных нет: убираем свою историю, чтобы вместо «Показать историю» было «нет данных».
      if (h) trafficHistory.delete(pubkey);
      return true;
    }

    if (!h) {
      h = { samples: [], all: [] };
      trafficHistory.set(pubkey, h);
    }

    // Локальные точки новее последней серверной (пришли между запросами) сохраняем.
    const lastServerT = fresh[fresh.length - 1].t;
    const newer = (h.all || []).filter(s => s.t > lastServerT);
    h.all = fresh.concat(newer);

    if (bigChartPk === pubkey) updateBigChart();
    return true;
  } catch (e) {
    return false;
  }
}

// ─── Каркас большого графика ─────────────────────────────────────────
function createBigChartSkeleton() {
  // Слева неподвижная ось Y; справа прокручиваемая область с графиком, сеткой и подписями времени.
  const padLeft   = (bigChartContainer.clientWidth || window.innerWidth) < 520 ? 72 : 92;   // Ширина оси Y (уже на телефоне).
  const padTop    = 20;
  const padBottom = 40;
  const padL      = 30;   // Отступ слева внутри прокручиваемой области (чтобы поместилась первая метка).
  const padR      = 36;   // Отступ справа (чтобы поместилась последняя метка).

  bigChartContainer.innerHTML = `
    <svg class="chart-yaxis" id="chartYAxis" width="${padLeft}"><g id="chartYLabels"></g></svg>
    <div class="chart-scroll" id="bigChartScroll">
      <div class="chart-inner" id="bigChartInner">
        <svg id="bigChartSvg">
          <g id="chartGrid"></g>
          <g id="chartXLabels"></g>
          <path id="bigChartArea" class="chart-area ${bigChartIsRx ? 'rx' : 'tx'}" />
          <path id="bigChartLine" class="chart-line ${bigChartIsRx ? 'rx' : 'tx'}" fill="none" />
          <rect id="bigChartHover" fill="transparent" />
        </svg>
        <div class="chart-tooltip" id="bigChartTooltip"></div>
      </div>
    </div>
  `;

  bigChartScroll = document.getElementById('bigChartScroll');
  bigChartInner  = document.getElementById('bigChartInner');
  bigChartSvg    = document.getElementById('bigChartSvg');
  const yAxis    = document.getElementById('chartYAxis');
  const hoverRect = document.getElementById('bigChartHover');
  const tooltip   = document.getElementById('bigChartTooltip');

  bigChartScroll.style.left = `${padLeft}px`;

  // Высота прокручиваемой области без горизонтального скроллбара.
  const h = bigChartScroll.clientHeight || 360;
  yAxis.setAttribute('height', h);
  bigChartSvg.setAttribute('height', h);
  bigChartInner.style.height = `${h}px`;

  chartMetrics = {
    h, padLeft, padTop, padBottom, padL, padR,
    chartH: h - padTop - padBottom,
    plotW: 0, chartW: 0
  };

  // Первый показ и пересоздание: прокручиваем к самым свежим данным.
  bigChartStickEnd = true;
  bigChartPxLast = 0;
  bigChartModel = null;

  // Подсказка под графиком (см. #bigChartHint в index.html).
  const hint = t('bigChartHint');
  const hintEl = document.getElementById('bigChartHint');
  if (hintEl) hintEl.textContent = (hint && hint !== 'bigChartHint') ? hint : '';

  // Наведение: ближайшая точка, подсказка рядом с ней. В простое показывает его длительность.
  const showTip = (clientX) => {
    const M = bigChartModel;
    if (!bigChartPk || bigChartDrag || !M) return;

    const m = chartMetrics;
    const rect = bigChartSvg.getBoundingClientRect();
    const mouseX = clientX - rect.left;          // Координата внутри всей ширины графика.
    const seg = M.segs.find(sg => mouseX >= sg.x0 && mouseX <= sg.x1);
    if (!seg) {
      tooltip.classList.remove('visible');
      return;
    }

    const bottom = m.padTop + m.chartH;
    let px = mouseX;
    let py;

    if (seg.type === 'break') {
      const dur = humanDuration(Math.round((seg.t1 - seg.t0) / 1000));
      tooltip.innerHTML = `
        <div class="time">${escapeHtml(t('chartIdle'))}</div>
        <span>${escapeHtml(dur)}</span>
      `;
      py = bottom - 8;
    } else {
      const d = M.d;
      const span = seg.x1 - seg.x0;
      const targetTime = seg.t0 + (span > 0 ? ((mouseX - seg.x0) / span) : 0) * (seg.t1 - seg.t0);

      // Бинарный поиск ближайшей точки (истории может быть много).
      let lo = 0, hi = d.series.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (d.series[mid].t < targetTime) lo = mid; else hi = mid;
      }
      const closest = Math.abs(d.series[lo].t - targetTime) <= Math.abs(d.series[hi].t - targetTime)
        ? d.series[lo] : d.series[hi];

      // Если данных рядом нет, трафик нулевой: показываем время под курсором и 0.
      let shownT = closest.t;
      let shownV = closest.v;
      if (Math.abs(closest.t - targetTime) > d.step * 3) {
        shownT = targetTime;
        shownV = 0;
      }

      tooltip.innerHTML = `
        <div class="time">${fmtClock(shownT, true)}</div>
        <span class="${bigChartIsRx ? 'rx-val' : 'tx-val'}">${fmtRate(shownV)}</span>
      `;

      px = bigChartTToX(shownT, M.segs);
      py = bottom - Math.min(shownV / (m.maxVal || 1), 1.5) * m.chartH;
    }

    // Если подсказка не помещается над точкой (пик у верхнего края) — показываем её под точкой.
    const tipH = tooltip.offsetHeight || 56;
    const tipW = tooltip.offsetWidth || 90;
    tooltip.classList.toggle('below', py - tipH - 14 < 0);

    // Не даём подсказке вылезать за видимую часть графика.
    const half = tipW / 2 + 4;
    const vis0 = bigChartScroll.scrollLeft;
    const vis1 = vis0 + bigChartScroll.clientWidth;
    const left = Math.min(Math.max(px, vis0 + half), vis1 - half);

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${py}px`;
    tooltip.classList.add('visible');
  };

  hoverRect.addEventListener('mousemove', (e) => showTip(e.clientX));

  // Сенсорный экран: тап показывает ближайшую точку, свайп листает график без подсказки.
  let tipTimer = null, touchX0 = 0, touchMoved = false, touchEndTimer = null;
  hoverRect.addEventListener('touchstart', (e) => {
    const t0 = e.touches[0];
    if (!t0) return;
    clearTimeout(tipTimer); clearTimeout(touchEndTimer);
    bigChartTouching = true;
    touchX0 = t0.clientX; touchMoved = false;
    showTip(t0.clientX);
  }, { passive: true });
  hoverRect.addEventListener('touchmove', (e) => {
    const t0 = e.touches[0];
    if (t0 && Math.abs(t0.clientX - touchX0) > 6) {
      touchMoved = true;
      tooltip.classList.remove('visible');
    }
  }, { passive: true });
  const onTouchEnd = () => {
    clearTimeout(tipTimer);
    if (touchMoved) tooltip.classList.remove('visible');
    else tipTimer = setTimeout(() => tooltip.classList.remove('visible'), 2500);
    touchEndTimer = setTimeout(() => { bigChartTouching = false; }, 1000);   // Даём доиграть инерции прокрутки.
  };
  hoverRect.addEventListener('touchend', onTouchEnd, { passive: true });
  hoverRect.addEventListener('touchcancel', onTouchEnd, { passive: true });

  hoverRect.addEventListener('mouseleave', () => {
    tooltip.classList.remove('visible');
  });

  // Перетаскивание мышью: движение записывается в общих обработчиках окна (см. ниже).
  hoverRect.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    bigChartDrag = { x: e.clientX, left: bigChartScroll.scrollLeft };
    bigChartScroll.classList.add('dragging');
    tooltip.classList.remove('visible');
    e.preventDefault();
  });

  // При прокрутке пересчитываем масштаб оси Y по видимой части (не чаще одного раза за кадр).
  bigChartScroll.addEventListener('scroll', () => {
    if (!BIG_CHART_Y_VISIBLE || bigChartDrawQueued) return;   // Масштаб Y от прокрутки не зависит — перерисовка не нужна.
    bigChartDrawQueued = true;
    requestAnimationFrame(() => {
      bigChartDrawQueued = false;
      drawBigChart();
    });
  });

  // Колесо мыши листает график по горизонтали.
  bigChartScroll.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      bigChartScroll.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
}

// ─── Усреднение точек по полосам ─────────────────────────────────────
// Точки, попавшие в одну вертикальную полосу шириной binPx пикселей, заменяются одной (средней).
// Это убирает «шерсть» на плотных участках, а редкие точки (паузы между всплесками) остаются как есть.
// binPx = 0 отключает усреднение.
function binPoints(pts, binPx) {
  if (!binPx || pts.length < 3) return pts;
  const out = [];
  let idx = null, n = 0, sx = 0, sy = 0, minY = Infinity, maxY = -Infinity, first = null, last = null;

  const flush = () => {
    if (n === 0) return;
    if (maxY - minY > BIG_CHART_BIN_JUMP_PX) {
      // Крутой перепад (например, падение в ноль): сохраняем первую и последнюю точки полосы в порядке времени,
      // иначе усреднение превратило бы обрыв в наклонную «ступеньку».
      out.push(first, last);
    } else {
      out.push([sx / n, sy / n]);
    }
  };

  for (const p of pts) {
    const b = Math.floor(p[0] / binPx);
    if (b !== idx) {
      flush();
      idx = b; n = 0; sx = sy = 0; minY = Infinity; maxY = -Infinity; first = p;
    }
    sx += p[0]; sy += p[1]; n++;
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    last = p;
  }
  flush();
  return out;
}

// ─── Плавная кривая через точки ──────────────────────────────────────
// Монотонная кубическая интерполяция (Fritsch–Carlson): линия гладкая и не «перелетает» через пики,
// поэтому не уходит ниже нуля и не рисует лишних горбов.
function smoothPath(pts) {
  const n = pts.length;
  if (n < 2) return '';
  const f = (v) => v.toFixed(1);
  if (n === 2) return `M${f(pts[0][0])},${f(pts[0][1])}L${f(pts[1][0])},${f(pts[1][1])}`;

  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    m[i] = dx[i] > 0 ? (pts[i + 1][1] - pts[i][1]) / dx[i] : 0;
  }
  const tg = new Array(n);
  tg[0] = m[0];
  tg[n - 1] = 0;
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      tg[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tg[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
    }
  }

  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${f(pts[i][0] + h)},${f(pts[i][1] + tg[i] * h)} ` +
         `${f(pts[i + 1][0] - h)},${f(pts[i + 1][1] - tg[i + 1] * h)} ` +
         `${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
  }
  return d;
}

// ─── Шаг сетки по времени ────────────────────────────────────────────
// Выбирает «круглый» шаг подписей так, чтобы между ними было не меньше ~80 пикселей.
// pxPerMin — реальный масштаб графика (у короткого периода он больше минимального, потому что график растянут на окно).
function pickTimeStepMs(pxPerMin) {
  const steps = [5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
  for (const s of steps) {
    if ((s / 60) * pxPerMin >= 80) return s * 1000;
  }
  return 86400 * 1000;
}

// ─── Обновление размеров большого графика ────────────────────────────
// Строит модель оси времени, подгоняет ширину, прокручивает к свежим данным и вызывает перерисовку.
// ─── Масштаб и ширина большого графика (чистая функция) ──────────────
// lockedPx > 0 — масштаб (px/мин) зафиксирован; 0 — подбирается под объём активных данных.
function computeBigLayout(segs, visibleW, padL, padR, lockedPx) {
  let activeMs = 0, breaks = 0;
  for (const sg of segs) {
    if (sg.type === 'break') breaks++;
    else activeMs += sg.t1 - sg.t0;
  }
  const minutes = Math.max(activeMs / 60000, 1 / 60);
  const breaksW = breaks * BIG_CHART_BREAK_PX;
  // Подробный масштаб для коротких периодов, но общая ширина не больше ~BIG_CHART_TARGET_W пикселей.
  const wantPx = lockedPx > 0
    ? lockedPx
    : Math.min(Math.max(BIG_CHART_TARGET_W / minutes, BIG_CHART_PX_PER_MIN), BIG_CHART_PX_MAX);
  const contentW = Math.max(breaksW + minutes * wantPx, visibleW - padL - padR);
  return { minutes, breaksW, contentW, pxPerMin: (contentW - breaksW) / minutes };
}

function updateBigChart() {
  if (!bigChartPk || !bigChartScroll || !bigChartSvg) return;
  const d = getBigChartData();
  if (!d || d.series.length < 2) return;

  const m = chartMetrics;

  // Если пользователь был у правого края (смотрит свежие данные), после обновления остаёмся там.
  const wasAtEnd = bigChartScroll.scrollLeft + bigChartScroll.clientWidth >= bigChartScroll.scrollWidth - 8;

  // Участки оси: активные растягиваются по масштабу, простои занимают фиксированную ширину.
  const segs = d.segs.map(sg => Object.assign({}, sg));

  // «Живой» режим: пользователь у правого края (или график только открыт): масштаб подстраивается под объём данных.
  // Если он пролистал в историю, масштаб замораживается: иначе каждая новая точка трафика пересчитывала бы ось,
  // и всё, что на экране, медленно «уезжало» бы влево.
  const live = bigChartStickEnd || wasAtEnd;
  const L = computeBigLayout(segs, bigChartScroll.clientWidth, m.padL, m.padR, live ? 0 : bigChartPxLast);
  if (live) bigChartPxLast = L.pxPerMin;
  const { contentW, pxPerMin } = L;
  const plotW = Math.ceil(contentW + m.padL + m.padR);

  let x = m.padL;
  for (const sg of segs) {
    const w = sg.type === 'break' ? BIG_CHART_BREAK_PX : ((sg.t1 - sg.t0) / 60000) * pxPerMin;
    sg.x0 = x;
    sg.x1 = x + w;
    x += w;
  }

  // Координата X каждой точки ряда (ряд отсортирован по времени, поэтому участок ищем по ходу).
  const sx = new Float64Array(d.series.length);
  let gi = 0;
  for (let i = 0; i < d.series.length; i++) {
    const t = d.series[i].t;
    while (gi < segs.length - 1 && t > segs[gi].t1) gi++;
    const sg = segs[gi];
    const tt = Math.min(Math.max(t, sg.t0), sg.t1);
    const span = sg.t1 - sg.t0;
    sx[i] = span > 0 ? sg.x0 + ((tt - sg.t0) / span) * (sg.x1 - sg.x0) : sg.x0;
  }

  let peakAll = 0;
  for (const s of d.series) if (s.v > peakAll) peakAll = s.v;

  bigChartModel = { d, segs, sx, plotW, contentW, pxPerMin, peakAll };
  m.plotW = plotW;
  m.chartW = contentW;

  bigChartInner.style.width = `${plotW}px`;
  bigChartSvg.setAttribute('width', plotW);
  bigChartSvg.setAttribute('viewBox', `0 0 ${plotW} ${m.h}`);

  const hoverRect = document.getElementById('bigChartHover');
  hoverRect.setAttribute('x', m.padL);
  hoverRect.setAttribute('y', m.padTop);
  hoverRect.setAttribute('width', contentW);
  hoverRect.setAttribute('height', m.chartH);

  // Прокрутка к свежим данным: при первом показе или если пользователь был у правого края.
  if (bigChartStickEnd || (wasAtEnd && !bigChartDrag && !bigChartTouching)) {
    bigChartScroll.scrollLeft = bigChartScroll.scrollWidth;
    bigChartStickEnd = false;
  }

  drawBigChart();
}

// ─── Отрисовка большого графика ──────────────────────────────────────
// Рисует линию, заливку, сетку, пометки простоев и подписи. Масштаб по вертикали считается по ВИДИМОЙ части,
// поэтому старый высокий пик где-то далеко в истории не «сплющивает» то, что вы смотрите сейчас.
// Вызывается при обновлении данных и при прокрутке.
function drawBigChart() {
  const M = bigChartModel;
  if (!bigChartPk || !bigChartScroll || !bigChartSvg || !M) return;
  const m = chartMetrics;
  const { d, segs, sx, plotW, contentW, pxPerMin } = M;
  const bottom = m.padTop + m.chartH;

  // Масштаб оси Y.
  let maxVal = niceCeil(Math.max(M.peakAll * 1.05, 1024));
  if (BIG_CHART_Y_VISIBLE) {
    const x0 = bigChartScroll.scrollLeft - 40;
    const x1 = bigChartScroll.scrollLeft + bigChartScroll.clientWidth + 40;
    let peak = 0;
    for (let i = 0; i < sx.length; i++) {
      if (sx[i] < x0) continue;
      if (sx[i] > x1) break;
      if (d.series[i].v > peak) peak = d.series[i].v;
    }
    // Не меньше 1 КБ/с, чтобы шум в несколько байт не растягивался на всю высоту.
    maxVal = niceCeil(Math.max(peak * 1.05, 1024));
  }
  if (!Number.isFinite(maxVal) || maxVal <= 0) maxVal = 1024;
  m.maxVal = maxVal;

  // Линия: точки в пикселях → усреднение по узким полосам → плавная кривая.
  const pxPts = [];
  for (let i = 0; i < sx.length; i++) {
    const py = bottom - Math.min(d.series[i].v / maxVal, 1.5) * m.chartH;
    if (Number.isFinite(sx[i]) && Number.isFinite(py)) pxPts.push([sx[i], py]);
  }
  const lineEl = document.getElementById('bigChartLine');
  const areaEl = document.getElementById('bigChartArea');
  if (lineEl) {
    const binned = binPoints(pxPts, BIG_CHART_SMOOTH_PX);
    const path = smoothPath(binned);
    if (!path) {
      // Меньше двух точек: убираем прежнюю линию и заливку, чтобы не оставались «призраки».
      lineEl.setAttribute('d', '');
      if (areaEl) areaEl.setAttribute('d', '');
    } else {
      lineEl.setAttribute('d', path);
      // Заливка под линией: всплески читаются как «объём» трафика.
      if (areaEl) {
        const xa = binned[0][0].toFixed(1);
        const xb = binned[binned.length - 1][0].toFixed(1);
        areaEl.setAttribute('d', `${path}L${xb},${bottom}L${xa},${bottom}Z`);
      }
    }
  }

  // Сетка: горизонтальные линии на всю ширину.
  let gridHtml = '';
  for (let i = 0; i <= 4; i++) {
    const y = m.padTop + (i / 4) * m.chartH;
    gridHtml += `<line class="chart-grid-line" x1="${m.padL}" y1="${y}" x2="${m.padL + contentW}" y2="${y}" />`;
  }

  // Подписи и вертикальная сетка: «круглые» моменты времени внутри активных участков; простои — пометкой.
  const stepMs = pickTimeStepMs(pxPerMin);
  const withSec = stepMs < 60000;
  const tzShift = -new Date(d.minTime).getTimezoneOffset() * 60000;
  let xHtml = '';
  for (const sg of segs) {
    const w = sg.x1 - sg.x0;
    if (sg.type === 'break') {
      const cx = (sg.x0 + sg.x1) / 2;
      const dur = humanDuration(Math.round((sg.t1 - sg.t0) / 1000));
      gridHtml += `<rect class="chart-break-bg" x="${sg.x0}" y="${m.padTop}" width="${w}" height="${m.chartH}" />`;
      gridHtml += `<line class="chart-break-line" x1="${sg.x0}" y1="${m.padTop}" x2="${sg.x0}" y2="${bottom}" />`;
      gridHtml += `<line class="chart-break-line" x1="${sg.x1}" y1="${m.padTop}" x2="${sg.x1}" y2="${bottom}" />`;
      xHtml += `<text class="chart-break-text" x="${cx}" y="${m.padTop + m.chartH * 0.35}" text-anchor="middle">${escapeHtml(t('chartIdle'))}</text>`;
      xHtml += `<text class="chart-break-text" x="${cx}" y="${m.padTop + m.chartH * 0.35 + 16}" text-anchor="middle">${escapeHtml(dur)}</text>`;
      continue;
    }
    const span = sg.t1 - sg.t0;
    if (span <= 0) continue;
    const first = Math.ceil((sg.t0 + tzShift) / stepMs) * stepMs - tzShift;
    for (let tk = first; tk <= sg.t1; tk += stepMs) {
      const x = sg.x0 + ((tk - sg.t0) / span) * w;
      gridHtml += `<line class="chart-grid-line" x1="${x}" y1="${m.padTop}" x2="${x}" y2="${bottom}" />`;
      xHtml += `<text class="chart-axis-text" x="${x}" y="${m.h - m.padBottom + 22}" text-anchor="middle">${fmtClock(tk, withSec)}</text>`;
    }
  }

  document.getElementById('chartGrid').innerHTML = gridHtml;
  document.getElementById('chartXLabels').innerHTML = xHtml;

  // Ось Y (неподвижная).
  let yHtml = '';
  for (let i = 0; i <= 4; i++) {
    const y = m.padTop + (i / 4) * m.chartH;
    const val = maxVal - (i / 4) * maxVal;
    yHtml += `<text class="chart-axis-text" x="${m.padLeft - 10}" y="${y + 4}" text-anchor="end">${fmtRate(val)}</text>`;
  }
  document.getElementById('chartYLabels').innerHTML = yHtml;
}

// ─── Закрытие и перерисовка большого графика ─────────────────────────
// Закрытие по кнопке × и перерисовка при изменении размера окна.
const bigChartClose = document.getElementById('bigChartClose');
if (bigChartClose) bigChartClose.addEventListener('click', () => closeModal(bigChartModal));

// Перетаскивание графика мышью: движение и отпускание кнопки ловим на всём окне.
window.addEventListener('mousemove', (e) => {
  if (!bigChartDrag || !bigChartScroll) return;
  bigChartScroll.scrollLeft = bigChartDrag.left - (e.clientX - bigChartDrag.x);
});
window.addEventListener('mouseup', () => {
  if (!bigChartDrag) return;
  bigChartDrag = null;
  if (bigChartScroll) bigChartScroll.classList.remove('dragging');
});

// Перерисовка при изменении размера: с задержкой и только если реально изменилась ширина (или высота заметно).
// Адресная строка мобильного браузера меняет высоту при каждой прокрутке — это не повод сбрасывать позицию графика.
let resizeTimer = null, lastResizeW = window.innerWidth, lastResizeH = window.innerHeight;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = window.innerWidth, h = window.innerHeight;
    const changed = w !== lastResizeW || Math.abs(h - lastResizeH) > 120;
    if (!changed) return;
    lastResizeW = w; lastResizeH = h;
    if (bigChartPk && bigChartModal && bigChartModal.classList.contains('visible')) {
      createBigChartSkeleton();
      updateBigChart();
    }
  }, 150);
});

// ═══════════════════════════════════════════════════════════════════════
// 18. ТУЛТИПЫ
// ═══════════════════════════════════════════════════════════════════════

// ─── Кастомные тултипы ───────────────────────────────────────────────
(function initTooltips() {
  const tooltip = document.createElement('div');
  tooltip.className = 'custom-tooltip';
  document.body.appendChild(tooltip);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.attributeName === 'title') {
        const el = mutation.target;
        if (el.hasAttribute('title')) {
          const text = el.getAttribute('title');
          if (text) el.setAttribute('data-title', text);
          el.removeAttribute('title');
        }
      } else if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) {
            if (node.hasAttribute('title')) {
              const text = node.getAttribute('title');
              if (text) node.setAttribute('data-title', text);
              node.removeAttribute('title');
            }
            node.querySelectorAll('[title]').forEach(child => {
              const text = child.getAttribute('title');
              if (text) child.setAttribute('data-title', text);
              child.removeAttribute('title');
            });
          }
        }
      }
    }
  });

  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['title'],
    childList: true,
    subtree: true
  });

  function show(e) {
    const el = e.target.closest('[title], [data-title]');
    if (!el) {
      tooltip.classList.remove('visible');
      return;
    }

    let text = el.getAttribute('title') || el.getAttribute('data-title');
    if (!text) {
      tooltip.classList.remove('visible');
      return;
    }

    if (el.hasAttribute('title')) {
      el.setAttribute('data-title', text);
      el.removeAttribute('title');
    }

    // Тултип в одну строку: переводы строк заменяем разделителем.
    tooltip.textContent = text.replace(/\s*\n\s*/g, '  ·  ');

    const rect = el.getBoundingClientRect();
    tooltip.style.opacity = '0';
    tooltip.classList.add('visible');

    const tRect = tooltip.getBoundingClientRect();
    let top = rect.top - tRect.height - 8;
    let left = rect.left + (rect.width / 2) - (tRect.width / 2);

    if (top < 8) top = rect.bottom + 8;
    if (top + tRect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - tRect.height - 8);
    if (left < 8) left = 8;
    if (left + tRect.width > window.innerWidth - 8) {
      left = window.innerWidth - tRect.width - 8;
    }

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    tooltip.style.opacity = '';
  }

  function hide() {
    tooltip.classList.remove('visible');
  }

  document.addEventListener('mouseover', show);
  document.addEventListener('mouseout', hide);
  document.addEventListener('scroll', hide, { passive: true });
  document.addEventListener('mousedown', hide);

  document.addEventListener('touchstart', (e) => {
    show(e);
    setTimeout(hide, 1500);
  }, { passive: true });
})();

// ═══════════════════════════════════════════════════════════════════════
// 19. ТОЧКА ВХОДА
// ═══════════════════════════════════════════════════════════════════════

// ─── Запуск приложения ───────────────────────────────────────────────
(function init() {
  applyTheme(safeGetItem("wgwatch.theme") || "auto");
  applyLang(detectLang());

  tickClock();
  setInterval(tickClock, CLOCK_MS);

  const refreshSelect = document.getElementById('refreshRate');
  const savedRate = safeGetItem("wgwatch.refreshRate");
  let currentRate = savedRate ? parseInt(savedRate, 10) : 2000;
  if (![1000, 2000, 5000, 10000].includes(currentRate)) currentRate = 2000;

  if (refreshSelect) {
    refreshSelect.value = currentRate;

    refreshSelect.addEventListener('change', (e) => {
      currentRate = parseInt(e.target.value, 10);
      safeSetItem("wgwatch.refreshRate", currentRate);
      startPolling(currentRate);
      tick();
      e.target.blur();
    });
  }

  tick();
  startPolling(currentRate);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
})();
