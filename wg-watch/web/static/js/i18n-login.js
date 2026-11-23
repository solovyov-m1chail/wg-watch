// Файл: /opt/wg-watch/web/static/js/i18n-login.js
// Интернационализация страницы входа wg-watch: словари ru/en со всеми строками
// формы (заголовок и подзаголовок, логин, пароль, «запомнить меня на {days} дней»,
// кнопка входа, подсказки показа/скрытия пароля, переключатели темы и языка,
// сообщения об ошибках валидации, неверных учётных данных, истёкшей сессии и бана
// с русскими формами множественного числа: error_banned_one/few/other),
// плюс определение языка (detectLang: сохранённый → navigator.language → ru) и
// сохранение выбора (setLang) в wgwatch.lang с безопасной обёрткой над localStorage.
// Экспорт: I18N_LOGIN, detectLang, setLang.

// ═══════════════════════════════════════════════════════════════════════
// 1. СЛОВАРИ
// ═══════════════════════════════════════════════════════════════════════

// ─── I18N_LOGIN ───────────────────────────────────────────────────────
export const I18N_LOGIN = {
ru: {
  title:                     "Wg-watch — вход",
  sub:                       "Мониторинг и управление WireGuard",
  username:                  "Логин",
  password:                  "Пароль",
  rememberMe:                "Запомнить меня на {days} дней",
  submit:                    "Войти в систему",
  showPassword:              "Показать пароль",
  hidePassword:              "Скрыть пароль",
  themeLight:                "Светлая",
  themeDark:                 "Тёмная",
  themeAuto:                 "Авто",
  ariaLanguage:              "Язык",
  ariaTheme:                 "Тема",
  error_empty_username:      "Логин не может быть пустым",
  error_empty_password:      "Пароль не может быть пустым",
  error_invalid_credentials: "Неверный логин или пароль",
  error_session_expired:     "Сессия истекла. Войдите снова.",
  error_too_many_attempts:   "Слишком много попыток. Попробуйте позже.",
  error_banned:              "Слишком много попыток. Повторите через {sec} сек.",
  error_banned_one:          "Слишком много попыток. Повторите через {sec} секунду.",
  error_banned_few:          "Слишком много попыток. Повторите через {sec} секунды."
},
en: {
  title:                     "Wg-watch — login",
  sub:                       "WireGuard monitoring & management",
  username:                  "Username",
  password:                  "Password",
  submit:                    "Log in",
  rememberMe:                "Remember me for {days} days",
  showPassword:              "Show password",
  hidePassword:              "Hide password",
  themeLight:                "Light",
  themeDark:                 "Dark",
  themeAuto:                 "Auto",
  ariaLanguage:              "Language",
  ariaTheme:                 "Theme",
  error_empty_username:      "Username cannot be empty",
  error_empty_password:      "Password cannot be empty",
  error_invalid_credentials: "Invalid username or password",
  error_session_expired:     "Session expired. Please log in again.",
  error_too_many_attempts:   "Too many attempts. Try again later.",
  error_banned:              "Too many attempts. Try again in {sec} s.",
  error_banned_one:          "Too many attempts. Try again in {sec} second.",
  error_banned_few:          "Too many attempts. Try again in {sec} seconds."
}
};

// ═══════════════════════════════════════════════════════════════════════
// 2. ЯЗЫК
// ═══════════════════════════════════════════════════════════════════════

// ─── detectLang ───────────────────────────────────────────────────────
// Определяет язык: сохранённый → язык браузера → ru.
export function detectLang() {
let saved = null;
try { saved = localStorage.getItem("wgwatch.lang"); } catch (e) { /* Молча игнорируем. */ }
if (saved === "ru" || saved === "en") return saved;
const nav = (navigator.language || "ru").toLowerCase();
return nav.startsWith("ru") ? "ru" : "en";
}

// ─── setLang ──────────────────────────────────────────────────────────
// Сохраняет выбор языка.
export function setLang(lang) {
const v = (lang === "en") ? "en" : "ru";
try { localStorage.setItem("wgwatch.lang", v); } catch (e) { /* Молча игнорируем. */ }
return v;
}
