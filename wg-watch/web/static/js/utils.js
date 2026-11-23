// Файл: /opt/wg-watch/web/static/js/utils.js
// Чистые функции без состояния и DOM-зависимостей (зависят только от текущего языка из ./i18n-index.js):
// форматирование байт (B/KB/MB/…), длительности (d/h/m/s — с суффиксами RU/EN по currentLang),
// времени и даты-времени в локали текущего языка, экранирование строки для innerHTML,
// «красивое» округление вверх (1/2/5 × 10^n) и точечная установка innerHTML
// (только при изменении, с сохранением фокуса на .peer по data-peer-key).
// Экспорт: humanBytes, humanDuration, fmtTime, fmtDateTime, escapeHtml, niceCeil, setHtml.

import { currentLang } from './i18n-index.js';

// ═══════════════════════════════════════════════════════════════════════
// 1. БАЙТЫ
// ═══════════════════════════════════════════════════════════════════════

// ─── humanBytes ───────────────────────────────────────────────────────
// Переводит байты в человекочитаемую строку (B, KB, MB, …).
export function humanBytes(b) {
b = Number(b) || 0;
const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
let i = 0;
while (b >= 1024 && i < u.length - 1) {
  b /= 1024;
  i++;
}
return i === 0 ? `${Math.round(b)} B` : `${b.toFixed(2)} ${u[i]}`;
}

// ═══════════════════════════════════════════════════════════════════════
// 2. ДЛИТЕЛЬНОСТЬ
// ═══════════════════════════════════════════════════════════════════════

// ─── humanDuration ────────────────────────────────────────────────────
// Секунды → «1d 2h 03m», «5m 12s» (или «1д 2ч 03м», «5м 12с» для RU).
export function humanDuration(s) {
s = Math.max(0, Math.floor(Number(s) || 0));
const d = Math.floor(s / 86400);
const h = Math.floor(s % 86400 / 3600);
const m = Math.floor(s % 3600 / 60);
const sec = s % 60;

// Определяем текущий язык для суффиксов
const isRu = currentLang === 'ru';
const _d = isRu ? 'д' : 'd';
const _h = isRu ? 'ч' : 'h';
const _m = isRu ? 'м' : 'm';
const _s = isRu ? 'с' : 's';

if (d > 0) return `${d}${_d} ${h}${_h} ${String(m).padStart(2, '0')}${_m}`;
if (h > 0) return `${h}${_h} ${String(m).padStart(2, '0')}${_m} ${String(sec).padStart(2, '0')}${_s}`;
if (m > 0) return `${m}${_m} ${String(sec).padStart(2, '0')}${_s}`;
return `${sec}${_s}`;
}

// ═══════════════════════════════════════════════════════════════════════
// 3. ВРЕМЯ
// ═══════════════════════════════════════════════════════════════════════

// ─── fmtTime ──────────────────────────────────────────────────────────
// Возвращает время в формате текущего языка (ЧЧ:ММ:СС).
export function fmtTime(d) {
return d.toLocaleTimeString(currentLang === 'ru' ? 'ru-RU' : 'en-GB', { hour12: false });
}

// ─── fmtDateTime ──────────────────────────────────────────────────────
// Возвращает дату и время в формате текущего языка.
export function fmtDateTime(iso) {
const d = new Date(iso);
if (!iso || isNaN(d.getTime())) return iso ? String(iso) : '—';
return d.toLocaleString(
  currentLang === 'ru' ? 'ru-RU' : 'en-GB',
  { hour12: false }
);
}

// ═══════════════════════════════════════════════════════════════════════
// 4. ЭКРАНИРОВАНИЕ
// ═══════════════════════════════════════════════════════════════════════

// ─── escapeHtml ───────────────────────────────────────────────────────
// Экранирует строку для безопасной вставки в HTML (innerHTML).
export function escapeHtml(s) {
return String(s).replace(/[&<>"'`\\]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
     "'": '&#39;', '`': '&#96;', '\\': '&#92;' }[c])
);
}

// ═══════════════════════════════════════════════════════════════════════
// 5. ОКРУГЛЕНИЕ
// ═══════════════════════════════════════════════════════════════════════

// ─── niceCeil ─────────────────────────────────────────────────────────
// Округляет вверх до «красивого» числа (1, 2, 5 × 10^n).
export function niceCeil(v) {
if (!(v > 0)) return 2000; // SPARK_MIN_SCALE.
const p = Math.pow(10, Math.floor(Math.log10(v)));
const m = v / p;
return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

// ═══════════════════════════════════════════════════════════════════════
// 6. ВСТАВКА HTML
// ═══════════════════════════════════════════════════════════════════════

// ─── setHtml ──────────────────────────────────────────────────────────
// Устанавливает innerHTML только если он изменился, и сохраняет фокус на .peer.
export function setHtml(el, html) {
if (!el) return;
if (el.__html === html) return;
el.__html = html;
const ae = document.activeElement;
const fk = (ae && ae !== document.body && el.contains(ae) && ae.dataset)
  ? ae.dataset.peerKey : null;
el.innerHTML = html;
if (fk) {
  const n = Array.from(el.querySelectorAll('.peer')).find(x => x.dataset.peerKey === fk);
  if (n) n.focus({ preventScroll: true });
}
}
