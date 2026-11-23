// Файл: /opt/wg-watch/web/static/js/i18n-index.js
// Интернационализация дашборда wg-watch: словари ru/en (все ключи UI, событий,
// модалок, ошибок и большого графика), функции перевода t/tFormat с подстановкой
// %PLACEHOLDER%, карта ERROR_MAP и translateError для кодов ошибок бэкенда,
// безопасные обёртки над localStorage (safeGetItem/safeSetItem), применение
// переводов к статике через data-i18n / data-i18n-title / data-i18n-aria
// (applyStaticI18n) и определение/установка языка (detectLang/setLang с
// сохранением в wgwatch.lang и фолбэком на navigator.language → ru). Модуль
// без DOM-состояния; currentLang — общий для всех импортёров (utils, app).
// Экспорт: I18N, currentLang, t, tFormat, translateError, applyStaticI18n,
// detectLang, setLang, safeGetItem, safeSetItem.

// ═══════════════════════════════════════════════════════════════════════
// 1. СЛОВАРИ
// ═══════════════════════════════════════════════════════════════════════

// ─── I18N ─────────────────────────────────────────────────────────────
export const I18N = {
ru: {
  title:                 "Wg-watch — панель управления",
  loading:               "Загрузка…",
  events:                "Лента событий",
  noEvents:              "Событий пока нет",
  noEventsForPeer:       "Для этого пира событий пока нет",
  noPeers:               "В этой категории нет пиров",
  noData:                "нет данных",
  tabAll:                "Все",
  tabOnline:             "Онлайн",
  tabOffline:            "Оффлайн",
  peers:                 "Пиров",
  online:                "Онлайн",
  offline:               "Оффлайн",
  evTypeOnline:          "ОНЛАЙН",
  evTypeOffline:         "ОФФЛАЙН",
  evTypeRoam:            "РОУМИНГ",
  evTypeClient:          "КЛИЕНТ",
  evTypeError:           "ОШИБКА",
  totalRxTx:             "Всего принято / отправлено",
  uptime:                "Время работы",
  endpoint:              "Адрес подключения",
  allowedIPs:            "Разрешённые IP",
  handshake:             "Последняя активность",
  rxTx:                  "RX / TX",
  logout:                "Выйти",
  statusOnline:          "онлайн",
  statusOffline:         "оффлайн",
  agoSuffix:             "назад",
  dash:                  "—",
  themeLight:            "Светлая",
  themeDark:             "Тёмная",
  themeAuto:             "Авто",
  refreshRate:           "Частота обновления",
  sec:                   "сек",
  ariaLanguage:          "Язык",
  ariaTheme:             "Тема",
  barTitle:              "↓ Входящий: %RX%\n↑ Исходящий: %TX%",
  refreshTitle:          "Обновить сейчас",
  downloadTitle:         "Скачать журнал событий",
  sortNew:               "Сначала новые",
  sortOld:               "Сначала старые",
  sortType:              "По типу",
  sortName:              "По имени",
  sortLabel:             "Сортировка",
  rxTitle:               "Входящий трафик (от клиента)",
  txTitle:               "Исходящий трафик (клиенту)",
  sparkTitle:            "Скорость за последние %SEC% сек. Пик: %PEAK%/с",
  clearFilter:           "Сбросить фильтр",
  daemonDownTitle:       "Мониторинг не работает",
  daemonDownShort:       "Мониторинг недоступен",
  daemonUpShort:         "Мониторинг работает",
  daemonDownBody:        "Служба мониторинга не запущена. Панель не видит статус онлайн/оффлайн, а уведомления не отправляются",
  daemonDownHint:        "Обратитесь к администратору или проверьте статус службы в системе",
  evConnected:           "подключён с %EP%",
  evSession:             "сессия %DUR%",
  evSessionTraffic:      "сессия %DUR% · ↓ %RX% ↑ %TX%",
  evRoam:                "%FROM% → %TO%",
  evWgFailed:            "ошибка получения статуса: %TEXT%",
  evWgRecovered:         "связь восстановлена",
  evClientCreated:       "добавлен в конфигурацию",
  evClientDeleted:       "удалён из конфигурации",
  evUnknown:             "%MSG%",
  evSilentOffline:       "ушёл в оффлайн (без уведомления)",
  createClient:          "Создать клиента",
  createClientTitle:     "Новый клиент",
  deleteClientTitle:     "Удалить клиента?",
  delete:                "Удалить",
  downloadConfig:        "Скачать конфиг клиента",
  cancel:                "Отмена",
  create:                "Создать",
  clientCreated:         "Клиент «%NAME%» успешно создан!",
  clientDeleted:         "Клиент «%NAME%» успешно удалён",
  createError:           "Не удалось создать клиента",
  deleteError:           "Не удалось удалить клиента",
  errEmptyName:          "Введите имя клиента",
  errExists:             "Устройство с таким именем уже существует. Выберите другое имя или удалите старое",
  errInvalidName:        "Недопустимое имя клиента. Используйте только латиницу (A–Z, a–z), цифры, точку, тире и подчёркивание",
  errInternal:           "Внутренняя ошибка сервера. Обновите страницу или проверьте логи",
  errNotFound:           "Клиент не найден",
  errNoFreeIp:           "Свободные IP-адреса закончились",
  errReload:             "Не удалось применить настройки WireGuard",
  errTooManyRequests:    "Слишком много попыток. Подождите минуту и попробуйте снова",
  errCsrf:               "Сессия истекла. Обновите страницу",
  errUnauthorized:       "Требуется авторизация",
  errSessionExpired:     "Сессия истекла. Войдите заново",
  errBadOutput:          "Сервер вернул некорректный ответ",
  errExecFailed:         "Не удалось выполнить операцию на сервере",
  errTimeout:            "Превышено время ожидания. Сервер не ответил вовремя. Попробуйте позже",
  errInvalidArgs:        "Некорректные параметры запроса",
  errManagerUnreachable: "Служба управления клиентами недоступна. Попробуйте позже",
  pubkeyCopied:          "Публичный ключ клиента «%NAME%» скопирован в буфер обмена",
  copyPubkey:            "Скопировать публичный ключ",
  configDownloaded:      "Загрузка конфигурации «%NAME%» началась",
  eventsRefreshed:       "Данные панели успешно обновлены",
  logsDownloading:       "Скачивание журнала событий…",
  clearEventsTitle:      "Очистить журнал событий?",
  clearEventsHint:       "Очистить журнал событий",
  clearEventsBody:       "Все записи журнала будут безвозвратно удалены",
  clearEventsBtn:        "Очистить",
  eventsCleared:         "Журнал событий успешно очищен",
  clearEventsError:      "Ошибка очистки журнала",
  copyError:             "Не удалось скопировать",
  bigChartRxTitle:       "Входящий трафик",
  bigChartTxTitle:       "Исходящий трафик",
  bigChartHint:          "Наведите мышь на график, чтобы увидеть точные значения. Колесо мыши или перетаскивание листают график",
  noChartData:           "Нет данных для графика: трафика сейчас нет",
  noChartDataFor:        "Нет данных для графика клиента «%NAME%»",
  showHistory:           "Показать историю",
  chartIdle:             "Простой",
},
en: {
  title:                 "Wg-watch — dashboard",
  loading:               "Loading…",
  events:                "Events feed",
  noEvents:              "No events yet",
  noEventsForPeer:       "No events for this peer yet",
  noPeers:               "No peers in this category",
  noData:                "no data",
  tabAll:                "All",
  tabOnline:             "Online",
  tabOffline:            "Offline",
  peers:                 "Peers",
  online:                "Online",
  offline:               "Offline",
  evTypeOnline:          "ONLINE",
  evTypeOffline:         "OFFLINE",
  evTypeRoam:            "ROAM",
  evTypeClient:          "CLIENT",
  evTypeError:           "ERROR",
  totalRxTx:             "Total received / sent",
  uptime:                "Uptime",
  endpoint:              "Endpoint address",
  allowedIPs:            "Allowed IPs",
  handshake:             "Last activity",
  rxTx:                  "RX / TX",
  logout:                "Log out",
  statusOnline:          "online",
  statusOffline:         "offline",
  agoSuffix:             "ago",
  dash:                  "—",
  themeLight:            "Light",
  themeDark:             "Dark",
  themeAuto:             "Auto",
  refreshRate:           "Refresh rate",
  sec:                   "sec",
  ariaLanguage:          "Language",
  ariaTheme:             "Theme",
  barTitle:              "↓ Download: %RX%\n↑ Upload: %TX%",
  refreshTitle:          "Refresh now",
  downloadTitle:         "Download event log",
  sortNew:               "Newest first",
  sortOld:               "Oldest first",
  sortType:              "By type",
  sortName:              "By name",
  sortLabel:             "Sort order",
  rxTitle:               "Download traffic (from client)",
  txTitle:               "Upload traffic (to client)",
  sparkTitle:            "Speed over the last %SEC% sec. Peak: %PEAK%/s",
  clearFilter:           "Clear filter",
  daemonDownTitle:       "Monitoring is offline",
  daemonDownShort:       "Monitoring is offline",
  daemonUpShort:         "Monitoring is active",
  daemonDownBody:        "The monitoring service is not running. The dashboard cannot see online/offline status, and notifications are not sent",
  daemonDownHint:        "Contact the administrator or check the service status",
  evConnected:           "connected from %EP%",
  evSession:             "session %DUR%",
  evSessionTraffic:      "session %DUR% · ↓ %RX% ↑ %TX%",
  evRoam:                "%FROM% → %TO%",
  evWgFailed:            "status update failed: %TEXT%",
  evWgRecovered:         "connection restored",
  evClientCreated:       "added to configuration",
  evClientDeleted:       "removed from configuration",
  evUnknown:             "%MSG%",
  evSilentOffline:       "went offline (no notification sent)",
  createClient:          "Create client",
  createClientTitle:     "New client",
  deleteClientTitle:     "Delete client?",
  delete:                "Remove",
  downloadConfig:        "Download client config",
  cancel:                "Cancel",
  create:                "Create",
  clientCreated:         "Client \"%NAME%\" was successfully created!",
  clientDeleted:         "Client \"%NAME%\" successfully deleted",
  createError:           "Failed to create client",
  deleteError:           "Failed to delete client",
  errEmptyName:          "Please enter a client name",
  errExists:             "A device with this name already exists. Choose another name or delete the old one",
  errInvalidName:        "Invalid client name. Use only Latin letters (A–Z, a–z), digits, dot, dash, and underscore",
  errInternal:           "Internal server error. Try reloading the page or check the logs",
  errNotFound:           "Client not found",
  errNoFreeIp:           "No free IP addresses left",
  errReload:             "Failed to apply WireGuard settings",
  errTooManyRequests:    "Too many attempts. Please wait a minute and try again",
  errCsrf:               "Session expired. Please reload the page",
  errUnauthorized:       "Authorization required",
  errSessionExpired:     "Session expired. Please log in again",
  errBadOutput:          "The server returned an invalid response",
  errExecFailed:         "Failed to perform the operation on the server",
  errTimeout:            "Request timed out. The server did not respond in time. Please try again later",
  errInvalidArgs:        "Invalid request parameters",
  errManagerUnreachable: "Client management service is unreachable. Try again later",
  pubkeyCopied:          "Public key for client \"%NAME%\" copied to clipboard",
  copyPubkey:            "Copy public key",
  configDownloaded:      "Download of configuration \"%NAME%\" started",
  eventsRefreshed:       "Dashboard data successfully updated",
  logsDownloading:       "Downloading event log…",
  clearEventsTitle:      "Clear event log?",
  clearEventsHint:       "Clear the event log",
  clearEventsBody:       "All records in the log will be permanently deleted",
  clearEventsBtn:        "Clear",
  eventsCleared:         "Event log successfully cleared",
  clearEventsError:      "Failed to clear event log",
  copyError:             "Failed to copy",
  bigChartRxTitle:       "Incoming traffic",
  bigChartTxTitle:       "Outgoing traffic",
  bigChartHint:          "Hover over the chart to see exact values. Mouse wheel or drag to scroll",
  noChartData:           "No chart data: there is no traffic right now",
  noChartDataFor:        "No data for client \"%NAME%\" chart",
  showHistory:           "Show history",
  chartIdle:             "Idle",
}
};

// ═══════════════════════════════════════════════════════════════════════
// 2. ПЕРЕВОД
// ═══════════════════════════════════════════════════════════════════════

// ─── currentLang ──────────────────────────────────────────────────────
// Текущий активный код языка.
export let currentLang = "ru";

// ─── t ────────────────────────────────────────────────────────────────
// Переводит ключ с использованием текущего языка.
export function t(key) {
return (I18N[currentLang] && I18N[currentLang][key]) || key;
}

// ─── tFormat ──────────────────────────────────────────────────────────
// Перевод с простой подстановкой %PLACEHOLDER%.
export function tFormat(key, vars) {
return t(key).replace(/%([A-Z]+)%/g, (m, k) =>
  Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
}

// ═══════════════════════════════════════════════════════════════════════
// 3. ОШИБКИ
// ═══════════════════════════════════════════════════════════════════════

// ─── ERROR_MAP ────────────────────────────────────────────────────────
// Соответствие кодов ошибок бэкенда ключам словаря.
const ERROR_MAP = {
'client_exists':       'errExists',
'invalid_name':        'errInvalidName',
'no_free_ip':          'errNoFreeIp',
'reload_failed':       'errReload',
'client_not_found':    'errNotFound',
'too_many_requests':   'errTooManyRequests',
'internal':            'errInternal',
'csrf_failed':         'errCsrf',
'unauthorized':        'errUnauthorized',
'session expired':     'errSessionExpired',
'bad_output':          'errBadOutput',
'exec_failed':         'errExecFailed',
'timeout':             'errTimeout',
'invalid_args':        'errInvalidArgs',
'manager_unreachable': 'errManagerUnreachable'
};

// ─── translateError ───────────────────────────────────────────────────
// Переводит коды ошибок бэкенда в понятные локализованные сообщения.
export function translateError(code) {
const key = ERROR_MAP[code];
if (key) return t(key);
if (typeof code === 'string' && code.length > 0) return code;
return t('errInternal');
}

// ═══════════════════════════════════════════════════════════════════════
// 4. ХРАНИЛИЩЕ
// ═══════════════════════════════════════════════════════════════════════

// ─── safeGetItem ──────────────────────────────────────────────────────
// Безопасно читает значение из localStorage (работает и при отключённом хранилище).
export function safeGetItem(key) {
try { return localStorage.getItem(key); }
catch (e) { return null; }
}

// ─── safeSetItem ──────────────────────────────────────────────────────
// Безопасно записывает значение в localStorage.
export function safeSetItem(key, value) {
try { localStorage.setItem(key, value); }
catch (e) { /* Молча игнорируем. */ }
}

// ═══════════════════════════════════════════════════════════════════════
// 5. СТАТИЧЕСКИЙ ПЕРЕВОД
// ═══════════════════════════════════════════════════════════════════════

// ─── applyStaticI18n ──────────────────────────────────────────────────
// Применяет переводы ко всем статическим элементам: data-i18n → textContent, data-i18n-title → title, data-i18n-aria → aria-label.
export function applyStaticI18n() {
document.querySelectorAll("[data-i18n]").forEach(el => {
  el.textContent = t(el.getAttribute("data-i18n"));
});

document.querySelectorAll("[data-i18n-title]").forEach(el => {
  el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
});

document.querySelectorAll("[data-i18n-aria]").forEach(el => {
  el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
});

const clr = document.getElementById("eventsClear");
if (clr) {
  clr.title = t("clearFilter");
  clr.setAttribute("aria-label", t("clearFilter"));
}

document.documentElement.lang = currentLang;
}

// ═══════════════════════════════════════════════════════════════════════
// 6. ЯЗЫК
// ═══════════════════════════════════════════════════════════════════════

// ─── detectLang ───────────────────────────────────────────────────────
// Определяет язык: сохранённый → язык браузера → ru.
export function detectLang() {
const saved = safeGetItem("wgwatch.lang");
if (saved === "ru" || saved === "en") return saved;
const nav = (navigator.language || "ru").toLowerCase();
return nav.startsWith("ru") ? "ru" : "en";
}

// ─── setLang ──────────────────────────────────────────────────────────
// Устанавливает текущий язык и сохраняет выбор.
export function setLang(lang) {
currentLang = (lang === "en") ? "en" : "ru";
safeSetItem("wgwatch.lang", currentLang);
}
