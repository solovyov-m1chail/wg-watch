// Файл: /opt/wg-watch/web/static/js/api.js
// Сетевой слой дашборда wg-watch: все адреса API, GET/POST с таймаутами и CSRF-токеном
// (X-CSRF-Token, автоматическое извлечение из ответов), обработка 401 с перенаправлением
// на вход (с пометкой «сессия истекла») и подавлением этого редиректа при намеренном
// выходе. Отдаёт state, события (чтение, очистка, скачивание), длинную историю трафика,
// создание/удаление клиентов и скачивание их .conf, logout. app.js не знает ни одного
// адреса — только эти функции. Экспорт: apiFetch, fetchState, fetchEvents,
// fetchTrafficHistory, createClient, deleteClient, clearEvents, downloadEvents,
// downloadClientConfig, logout, getCsrfToken, setCsrfToken.

// ═══════════════════════════════════════════════════════════════════════
// 1. НАСТРОЙКИ И АДРЕСА
// ═══════════════════════════════════════════════════════════════════════

// ─── Таймауты ─────────────────────────────────────────────────────────
// GET — быстрые запросы состояния; POST — управление клиентами (агент может отвечать долго).
const FETCH_TIMEOUT_MS = 8000;
const POST_TIMEOUT_MS  = 40000;

// ─── Адреса API ───────────────────────────────────────────────────────
// Все пути относительные: страница открыта с <base href="/wg-watch/">.
const URL_STATE           = 'api/state';
const URL_EVENTS          = 'api/events';
const URL_EVENTS_DOWNLOAD = 'api/events/download';
const URL_EVENTS_CLEAR    = 'api/events/clear';
const URL_TRAFFIC         = 'api/traffic';
const URL_CLIENTS_CREATE  = 'api/clients/create';
const URL_CLIENTS_DELETE  = 'api/clients/delete';
const URL_LOGIN           = 'login';
const URL_LOGOUT          = 'logout';
// Адрес входа с пометкой «сессия истекла»: страница входа покажет сообщение.
const URL_LOGIN_EXPIRED   = 'login?expired=1';

// Признак намеренного выхода: чтобы 401 от запроса, летевшего в момент выхода, не показал «сессия истекла».
let loggingOut = false;

// ─── Перенаправление на вход ──────────────────────────────────────────
function redirectToLogin() {
  if (loggingOut) return;
  location.replace(URL_LOGIN_EXPIRED);
}

// ─── Адрес конфига клиента ────────────────────────────────────────────
function urlClientConfig(name) {
  return `api/clients/${encodeURIComponent(name)}/config`;
}

// ═══════════════════════════════════════════════════════════════════════
// 2. CSRF-ТОКЕН
// ═══════════════════════════════════════════════════════════════════════

// ─── Текущий токен ────────────────────────────────────────────────────
let csrfToken = null;

// ─── Чтение токена ────────────────────────────────────────────────────
export function getCsrfToken() {
  return csrfToken;
}

// ─── Установка токена ─────────────────────────────────────────────────
export function setCsrfToken(tok) {
  csrfToken = tok;
}

// ─── Гарантия наличия токена ──────────────────────────────────────────
// Токен приходит в заголовке X-CSRF-Token любого ответа сервера; если его ещё нет,
// делаем лёгкий GET и забираем токен оттуда.
async function ensureCsrf() {
  if (csrfToken) return;
  try { await apiFetch(URL_STATE); } catch (e) { /* Бэкенд сообщит ошибкой при самом POST. */ }
}

// ═══════════════════════════════════════════════════════════════════════
// 3. БАЗОВЫЕ ЗАПРОСЫ
// ═══════════════════════════════════════════════════════════════════════

// ─── apiFetch (GET) ───────────────────────────────────────────────────
// Базовый GET с таймаутом, обработкой 401 и извлечением CSRF-токена. Возвращает разобранный JSON.
export async function apiFetch(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      cache: 'no-store', credentials: 'same-origin', signal: ctrl.signal
    });

    const token = r.headers.get('X-CSRF-Token');
    if (token) csrfToken = token;

    if (r.status === 401) {
      redirectToLogin();
      throw new Error('unauthorized');
    }

    if (!r.ok) throw new Error(url + ' ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── apiPost ──────────────────────────────────────────────────────────
// POST с JSON-телом и CSRF-токеном. Возвращает { ok, status, data }, где data — JSON ответа или null.
// Сетевые ошибки и таймаут пробрасываются исключением (их показывает вызывающий код).
async function apiPost(url, body) {
  await ensureCsrf();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const init = {
      method: 'POST',
      credentials: 'same-origin',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken || ''
      }
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch(url, init);

    const token = res.headers.get('X-CSRF-Token');
    if (token) csrfToken = token;

    if (res.status === 401) redirectToLogin();

    let data = null;
    try { data = await res.json(); } catch (e) { /* Ответ не JSON. */ }

    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 4. СОСТОЯНИЕ
// ═══════════════════════════════════════════════════════════════════════

// ─── fetchState ───────────────────────────────────────────────────────
// Получает состояние (пиры, iface, uptime, traffic, user). При ошибке возвращает null.
// Индикатором (точкой в шапке) управляет app.js.
export async function fetchState() {
  try {
    const data = await apiFetch(URL_STATE);

    const userEl = document.getElementById('userInfo');
    if (userEl) userEl.textContent = data.user || '—';
    return data;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 5. СОБЫТИЯ
// ═══════════════════════════════════════════════════════════════════════

// ─── fetchEvents ──────────────────────────────────────────────────────
// Размер ленты определяет сервер (EVENTS_LIMIT / EVENTS_LIMIT_PEER): peerScope=true — лента выбранного клиента.
// При ошибке возвращает null.
export async function fetchEvents(peerScope) {
  try {
    const data = await apiFetch(URL_EVENTS + (peerScope ? '?scope=peer' : ''));
    return (data && data.events) || [];
  } catch (e) {
    return null;
  }
}

// ─── clearEvents ──────────────────────────────────────────────────────
// Очищает журнал событий. Возвращает { ok, status, data }.
export function clearEvents() {
  return apiPost(URL_EVENTS_CLEAR);
}

// ─── downloadEvents ───────────────────────────────────────────────────
// Скачивание журнала: браузер сам обработает заголовок Content-Disposition.
export function downloadEvents() {
  window.location.href = URL_EVENTS_DOWNLOAD;
}

// ═══════════════════════════════════════════════════════════════════════
// 6. ТРАФИК
// ═══════════════════════════════════════════════════════════════════════

// ─── fetchTrafficHistory ──────────────────────────────────────────────
// Длинная история трафика пира: массив точек [время_в_секундах, rx, tx].
// Если эндпоинта нет или он вернул ошибку — возвращает null (фронт остаётся на данных из api/state).
export async function fetchTrafficHistory(pubkey) {
  try {
    const data = await apiFetch(URL_TRAFFIC + '?pk=' + encodeURIComponent(pubkey));
    const raw = Array.isArray(data) ? data : (data && data.samples);
    return Array.isArray(raw) ? raw : null;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 7. КЛИЕНТЫ
// ═══════════════════════════════════════════════════════════════════════

// ─── createClient ─────────────────────────────────────────────────────
// Создаёт клиента. Возвращает { ok, status, data }.
export function createClient(name) {
  return apiPost(URL_CLIENTS_CREATE, { name });
}

// ─── deleteClient ─────────────────────────────────────────────────────
// Удаляет клиента. Возвращает { ok, status, data }.
export function deleteClient(name) {
  return apiPost(URL_CLIENTS_DELETE, { name });
}

// ─── downloadClientConfig ─────────────────────────────────────────────
// Скачивает конфиг клиента через временную ссылку.
export async function downloadClientConfig(name) {
  const url = urlClientConfig(name);
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
    });

    if (res.status === 401) {
      redirectToLogin();
      return { ok: false, status: 401, data: { error: 'unauthorized' } };
    }

    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch (e) { /* не JSON */ }
      return { ok: false, status: res.status, data };
    }

    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    let filename = `${name}.conf`;
    const m = cd.match(/filename="?([^";]+)"?/i);
    if (m) filename = m[1];

    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

    return { ok: true, status: res.status, data: null };
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'manager_unreachable' } };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 8. СЕССИЯ
// ═══════════════════════════════════════════════════════════════════════

// ─── logout ───────────────────────────────────────────────────────────
// Выход: сервер очищает сессию и перенаправляет на страницу входа.
export function logout() {
  loggingOut = true;
  window.location.href = URL_LOGOUT;
}
