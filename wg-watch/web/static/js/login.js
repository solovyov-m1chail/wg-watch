// Файл: /opt/wg-watch/web/static/js/login.js
// Логика страницы входа wg-watch (ES-модуль, зависит от ./i18n-login.js):
// тема (авто/светлая/тёмная с реакцией на системную и сохранением в localStorage),
// i18n через data-i18n / data-i18n-title / data-i18n-error (включая живой обратный
// отсчёт бана с русскими формами множественного числа), переключатели темы и языка,
// показ/скрытие пароля с сохранением фокуса и позиции каретки, клиентская валидация
// полей (пустые логин/пароль) с анимацией shake, защита от двойной отправки
// (блокировка кнопки и спиннер на время POST), восстановление состояния по pageshow
// из кэша back/forward, кастомные тултипы (в т.ч. на touch). Всё обёрнуто в IIFE.

import { I18N_LOGIN, detectLang, setLang } from './i18n-login.js';

// Страница входа: i18n, тема, валидация и тултипы.
(function () {

// ═══════════════════════════════════════════════════════════════════════
// 1. ТЕМА
// ═══════════════════════════════════════════════════════════════════════

// ─── Системная тема ───────────────────────────────────────────────────
const mq = window.matchMedia("(prefers-color-scheme: light)");

// ─── Текущее предпочтение ─────────────────────────────────────────────
// Хранится и в памяти, чтобы auto продолжало следовать за системой при недоступном localStorage.
let currentThemePref = "auto";

// ─── Фактическая тема ─────────────────────────────────────────────────
// Возвращает фактическую тему с учётом системной настройки для pref=auto.
function effectiveTheme(pref) {
if (pref === "auto") return mq.matches ? "light" : "dark";
return pref;
}

// ─── Применение темы ──────────────────────────────────────────────────
// Атрибут data-theme, классы на кнопках, сохранение в localStorage.
function applyTheme(pref) {
if (pref !== "light" && pref !== "dark") pref = "auto";
currentThemePref = pref;

const root = document.documentElement;
const next = effectiveTheme(pref);
if (root.getAttribute("data-theme") !== next) {

// Мгновенное переключение: отключает transition, применяет тему, принудительно пересчитывает стили и включает transition обратно на следующем кадре.
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
try { localStorage.setItem("wgwatch.theme", pref); } catch (e) { /* Молча игнорируем. */ }
}


// ═══════════════════════════════════════════════════════════════════════
// 2. ПЕРЕВОД КЛЮЧЕЙ
// ═══════════════════════════════════════════════════════════════════════

// ─── translate ────────────────────────────────────────────────────────
// Переводит один ключ с использованием заданного словаря.
function translate(dict, key) {
return dict[key] || key;
}


// ═══════════════════════════════════════════════════════════════════════
// 3. SUBMIT-КНОПКА
// ═══════════════════════════════════════════════════════════════════════

// ─── Элемент кнопки ───────────────────────────────────────────────────
// Блокируется на время бана и пока запрос в полёте.
const submitBtn = document.querySelector("button.submit");

// ─── Блокировка/разблокировка ─────────────────────────────────────────
// Блокирует или разблокирует кнопку отправки.
function setSubmitBlocked(blocked) {
if (submitBtn) submitBtn.disabled = !!blocked;
}


// ═══════════════════════════════════════════════════════════════════════
// 4. ЯЗЫК
// ═══════════════════════════════════════════════════════════════════════

// ─── applyLang ────────────────────────────────────────────────────────
// Применяет язык и обновляет все элементы [data-i18n] / [data-i18n-title] / [data-i18n-error].
function applyLang(lang) {
const dict = I18N_LOGIN[lang] || I18N_LOGIN.ru;
document.documentElement.lang = lang;
document.title = dict.title;

// Текстовое содержимое.
document.querySelectorAll("[data-i18n]").forEach(el => {
  const k = el.getAttribute("data-i18n");
  let text = dict[k];
  if (!text) return;
  if (k === "rememberMe") {
        const days = el.getAttribute("data-days") || "7";
        text = text.replace("{days}", days);
  }
  el.textContent = text;
});

// Подсказки title и aria-label.
document.querySelectorAll("[data-i18n-title]").forEach(el => {
  const k = el.getAttribute("data-i18n-title");
  if (!dict[k]) return;
  el.setAttribute("title", dict[k]);
  if (el.hasAttribute("aria-label")) {
        el.setAttribute("aria-label", dict[k]);
  }
});

// Переключатель видимости пароля: обновляет подсказку и aria-label.
const pwdBtn = document.getElementById("pwdToggle");
const pwdInput = document.getElementById("password");
if (pwdBtn && pwdInput) {
  const revealed = pwdInput.type === "text";
  const label = revealed ? dict.hidePassword : dict.showPassword;
  pwdBtn.setAttribute("aria-label", label);
  pwdBtn.setAttribute("title", label);
  pwdBtn.setAttribute("aria-pressed", String(revealed));
}

// Сообщение об ошибке: сервер кладёт сюда ключ, который мы переводим.
document.querySelectorAll("[data-i18n-error]").forEach(el => {
  const key = el.getAttribute("data-i18n-error");
  if (!key) {
        el.textContent = "";
        el.classList.remove("ban");
        if (el._banTimer) { clearInterval(el._banTimer); el._banTimer = null; }
        delete el._banUntil;
        delete el._banMax;
        return;
  }

  // Сообщение о бане: подстановка плюс живой обратный отсчёт.
  if (key === "error_too_many_attempts") {
        el.classList.add("ban");
        // Дедлайн фиксируется при первом рендере, чтобы переключение RU/EN не перезапускало отсчёт с полного значения.
        if (el._banUntil === undefined) {
          let s0 = parseInt(el.getAttribute("data-ban-seconds") || "0", 10);
          if (!s0 || s0 < 0) s0 = 0;
          el._banMax = s0;
          el._banUntil = Date.now() + s0 * 1000;
        }
        const remaining = () => Math.max(0, Math.min(
          el._banMax, Math.ceil((el._banUntil - Date.now()) / 1000)));
        let sec = remaining();
        if (sec <= 0) {
          el.classList.remove("ban");
          el.textContent = "";
          setSubmitBlocked(false);
          delete el._banUntil;
          delete el._banMax;
          return;
        }
        setSubmitBlocked(true);

        // Выбирает ключ множественного числа по правилам русского (1, 2-4, 5+).
        function pluralKey(n) {
          if (lang === "ru") {
                const m10 = n % 10, m100 = n % 100;
                if (m10 === 1 && m100 !== 11) return "error_banned_one";
                if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return "error_banned_few";
          }
          return "error_banned";
        }

        // Отрисовывает текущее значение обратного отсчёта с правильной формой слова.
        function render() {
          const k = pluralKey(sec);
          const tpl = dict[k] || dict.error_banned;
          el.textContent = tpl.replace("{sec}", String(sec));
        }

        render();

        // Живой обратный отсчёт.
        if (el._banTimer) clearInterval(el._banTimer);
        el._banTimer = setInterval(() => {
          sec = remaining();
          if (sec <= 0) {
                clearInterval(el._banTimer);
                el._banTimer = null;
                el.classList.remove("ban");
                el.textContent = "";
                setSubmitBlocked(false);
                delete el._banUntil;
                delete el._banMax;
                return;
          }
          render();
        }, 1000);

        return;
  }

  // Обычный ключ ошибки.
  setSubmitBlocked(false);
  el.classList.remove("ban");
  if (el._banTimer) { clearInterval(el._banTimer); el._banTimer = null; }
  delete el._banUntil;
  delete el._banMax;
  el.textContent = translate(dict, key);
});

document.querySelectorAll("#langToggle button").forEach(b => {
  const on = b.dataset.lang === lang;
  b.classList.toggle("active", on);
  b.setAttribute("aria-pressed", String(on));
});

setLang(lang);

// Скрывает кастомный тултип при смене языка, чтобы он не остался с прошлым переводом.
const tooltip = document.querySelector('.custom-tooltip');
if (tooltip) tooltip.classList.remove('visible');
}


// ═══════════════════════════════════════════════════════════════════════
// 5. ПЕРВИЧНАЯ ИНИЦИАЛИЗАЦИЯ
// ═══════════════════════════════════════════════════════════════════════

// ─── Сохранённая тема ─────────────────────────────────────────────────
// Первичное применение сохранённой темы и языка браузера.
const themePref = (function () {
try { return localStorage.getItem("wgwatch.theme") || "auto"; }
catch (e) { return "auto"; }
})();
applyTheme(themePref);
applyLang(detectLang());


// ═══════════════════════════════════════════════════════════════════════
// 6. ОБРАБОТЧИКИ ТЕМЫ И ЯЗЫКА
// ═══════════════════════════════════════════════════════════════════════

// ─── Реакция на смену системной темы ──────────────────────────────────
// Перерисовывает только при выбранном auto.
function onSystemThemeChange() {
if (currentThemePref === "auto") applyTheme("auto");
}

// Фолбэк addListener для Safari < 14.
if (mq.addEventListener) mq.addEventListener("change", onSystemThemeChange);
else if (mq.addListener) mq.addListener(onSystemThemeChange);

// ─── Переключатель темы ───────────────────────────────────────────────
document.getElementById("themeToggle").addEventListener("click", e => {
const b = e.target.closest("button");
if (!b) return;
applyTheme(b.dataset.theme);
});

// ─── Переключатель языка ──────────────────────────────────────────────
document.getElementById("langToggle").addEventListener("click", e => {
const b = e.target.closest("button");
if (!b) return;
applyLang(b.dataset.lang);
});


// ═══════════════════════════════════════════════════════════════════════
// 7. ПЕРЕКЛЮЧАТЕЛЬ ПАРОЛЯ
// ═══════════════════════════════════════════════════════════════════════

// ─── Элементы ─────────────────────────────────────────────────────────
const pwdToggle = document.getElementById("pwdToggle");
const pwdInput  = document.getElementById("password");

// ─── Показ/скрытие ────────────────────────────────────────────────────
// Переключатель показа и скрытия пароля (иконка-глаз).
if (pwdToggle && pwdInput) {
pwdToggle.addEventListener("click", () => {
  const reveal = pwdInput.type === "password";
  pwdInput.type = reveal ? "text" : "password";
  pwdToggle.classList.toggle("visible", reveal);
  pwdToggle.setAttribute("aria-pressed", String(reveal));
  // Оставляет фокус в поле пароля, чтобы ввод продолжался без разрыва.
  pwdInput.focus();
  try {
        const pos = pwdInput.value.length;
        pwdInput.setSelectionRange(pos, pos);
  } catch (e) { /* setSelectionRange может бросать исключение в некоторых браузерах или типах. */ }
  // Обновляет локализованную подсказку и aria-label.
  const dict = I18N_LOGIN[document.documentElement.lang] || I18N_LOGIN.ru;
  const label = reveal ? dict.hidePassword : dict.showPassword;
  pwdToggle.setAttribute("aria-label", label);
  pwdToggle.setAttribute("title", label);
});
}


// ═══════════════════════════════════════════════════════════════════════
// 8. ВАЛИДАЦИЯ ФОРМЫ
// ═══════════════════════════════════════════════════════════════════════

// ─── Элементы ─────────────────────────────────────────────────────────
// Валидация полей и анимация загрузки.
const loginForm = document.getElementById("loginForm");
const userInput = document.getElementById("user");
const errorUser = document.getElementById("error-user");
const errorPass = document.getElementById("error-password");

// ─── Показ ошибки поля ────────────────────────────────────────────────
// Показывает ошибку у конкретного поля.
function showFieldError(input, errorEl, messageKey) {
const dict = I18N_LOGIN[document.documentElement.lang] || I18N_LOGIN.ru;
errorEl.textContent = dict[messageKey] || messageKey;
errorEl.classList.add("show");
input.classList.add("has-error", "shake");
setTimeout(() => input.classList.remove("shake"), 400);
}

// ─── Скрытие ошибки поля ──────────────────────────────────────────────
// Скрывает ошибку у поля.
function hideFieldError(input, errorEl) {
errorEl.classList.remove("show");
input.classList.remove("has-error");
}

// ─── Очистка ошибки при вводе ─────────────────────────────────────────
// Очищает ошибку при вводе.
if (userInput) userInput.addEventListener("input", () => hideFieldError(userInput, errorUser));
if (pwdInput) pwdInput.addEventListener("input", () => hideFieldError(pwdInput, errorPass));

// ─── Отправка формы ───────────────────────────────────────────────────
// Один обработчик submit: валидация, анимация загрузки и защита от повторной отправки.
// Если валидация не прошла, кнопка не блокируется, иначе пользователь не сможет отправить форму после исправления полей в течение 3 секунд.
if (loginForm) {
loginForm.addEventListener("submit", (e) => {
  let isValid = true;

  hideFieldError(userInput, errorUser);
  hideFieldError(pwdInput, errorPass);

  if (!userInput.value.trim()) {
        showFieldError(userInput, errorUser, "error_empty_username");
        isValid = false;
  }
  if (!pwdInput.value) {
        showFieldError(pwdInput, errorPass, "error_empty_password");
        isValid = false;
  }

  if (!isValid) {
        e.preventDefault();
        return;
  }

// Блокирует кнопку, чтобы двойной клик не породил два POST (два неудачных логина засчитывались в 3-попыточный бан).
  let spinnerEl = null;
  if (submitBtn) {
        submitBtn.classList.add("loading");
        spinnerEl = document.createElement("span");
        spinnerEl.className = "spinner";
        submitBtn.insertBefore(spinnerEl, submitBtn.firstChild);
  }
  setSubmitBlocked(true);
// Сетевой сбой: возвращает кнопку в исходное состояние, если только не показывается бан.
  setTimeout(() => {
        if (spinnerEl && spinnerEl.parentNode) spinnerEl.remove();
        if (submitBtn) submitBtn.classList.remove("loading");
        if (!document.querySelector(".err.ban")) setSubmitBlocked(false);
  }, 3000);
});
}


// ═══════════════════════════════════════════════════════════════════════
// 9. PAGESHOW
// ═══════════════════════════════════════════════════════════════════════

// ─── Восстановление из кэша back/forward ──────────────────────────────
// Кэш back/forward восстанавливает страницу с заблокированной кнопкой, поэтому состояние переоценивается.
window.addEventListener("pageshow", e => {
if (e.persisted) {
  if (submitBtn) {
        submitBtn.classList.remove("loading");
        submitBtn.querySelectorAll(".spinner").forEach(s => s.remove());
  }
  setSubmitBlocked(false);
  applyLang(detectLang());
}
});


// ═══════════════════════════════════════════════════════════════════════
// 10. ТУЛТИПЫ
// ═══════════════════════════════════════════════════════════════════════

// ─── Инициализация кастомных подсказок ────────────────────────────────
// Инициализирует кастомные тултипы вместо браузерных: они работают на touch-устройствах и не конфликтуют с атрибутом title.
(function initTooltips() {
const tooltip = document.createElement('div');
tooltip.className = 'custom-tooltip';
document.body.appendChild(tooltip);

// ─── Показ подсказки ──────────────────────────────────────────────────
// Показывает подсказку у элемента под курсором.
function show(e) {
  const el = e.target.closest('[title], [data-title]');
  if (!el) {
        tooltip.classList.remove('visible');
        return;
  }

// Сначала читает title (он обновляется при смене языка), если его нет — data-title (старый перевод).
  let text = el.getAttribute('title') || el.getAttribute('data-title');
  if (!text) {
        tooltip.classList.remove('visible');
        return;
  }

// Переносит title в data-title и удаляет атрибут, чтобы браузер не показывал свой пузырь.
  if (el.hasAttribute('title')) {
        el.setAttribute('data-title', text);
        el.removeAttribute('title');
  }

  tooltip.textContent = text;

// Позиционирует над элементом, при нехватке места — под ним.
  const rect = el.getBoundingClientRect();
  tooltip.style.opacity = '0';
  tooltip.classList.add('visible');

  const tRect = tooltip.getBoundingClientRect();
  let top = rect.top - tRect.height - 8;
  let left = rect.left + (rect.width / 2) - (tRect.width / 2);

  if (top < 8) top = rect.bottom + 8;
  if (left < 8) left = 8;
  if (left + tRect.width > window.innerWidth - 8) {
        left = window.innerWidth - tRect.width - 8;
  }

  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
  tooltip.style.opacity = '';
}

// ─── Скрытие ──────────────────────────────────────────────────────────
// Скрывает подсказку.
function hide() {
  tooltip.classList.remove('visible');
}

document.addEventListener('mouseover', show);
document.addEventListener('mouseout', hide);
document.addEventListener('scroll', hide, { passive: true });
document.addEventListener('mousedown', hide);

// На touch-устройствах показывает подсказку по тапу и автоматически скрывает через 1.5 секунды.
document.addEventListener('touchstart', (e) => {
  show(e);
  setTimeout(hide, 1500);
}, { passive: true });
})();

})();
