#!/usr/bin/env python3
# Файл: /opt/wg-watch/web/app.py
# Бэкенд веб-дашборда wg-watch: API состояния и истории трафика,
# управление клиентами через Go-агент wg-watch-manager (список, создание,
# удаление, скачивание .conf), журнал событий (чтение, скачивание, очистка),
# healthcheck, аутентификация по сессии с per-session TTL («запомнить меня»),
# CSRF-токен и проверка Origin/Referer, rate-limit логина и действий
# (в памяти процесса или в Redis при заданном REDIS_URL), проверка Host
# по ALLOWED_HOSTS, заголовки безопасности и отдача статики с белым списком
# расширений для неавторизованных (PUBLIC_STATIC_EXT).
# Конфиг-ошибки (отсутствие обязательной переменной, невалидное значение)
# завершают процесс с кодом 78 (EX_CONFIG), чтобы systemd не рестартовал
# сервис в цикле благодаря RestartPreventExitStatus=78 в unit-файле.

# ─── Библиотеки ────────────────────────────────────────────────────────
import atexit
import hmac
import json
import logging
import math
import os
import re
import secrets
import signal
import sys
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from functools import wraps
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.parse import urlencode, urlsplit
import requests
from flask import (Flask, Response, abort, jsonify, make_response, redirect,
                   request, render_template, send_from_directory, session)
from flask.sessions import SecureCookieSessionInterface
from werkzeug.middleware.proxy_fix import ProxyFix

# ═══════════════════════════════════════════════════════════════════════
# 1. ЛОГИРОВАНИЕ
# ═══════════════════════════════════════════════════════════════════════

# ─── Логгер ───────────────────────────────────────────────────────────
logger                = logging.getLogger("wg-watch-web")
logger.setLevel(logging.INFO)
_log_fmt              = logging.Formatter("%(asctime)s %(levelname)s %(message)s")

# ─── Сырые значения из env ────────────────────────────────────────────
_LOG_FILE_RAW         = os.environ.get("LOG_FILE", "/opt/wg-watch/logs/wg-watch-web.log")
_LOG_MAX_BYTES_RAW    = os.environ.get("LOG_MAX_BYTES", "5000000")
_LOG_BACKUP_COUNT_RAW = os.environ.get("LOG_BACKUP_COUNT", "3")

# ─── Валидация ────────────────────────────────────────────────────────
try:
    _LOG_MAX_BYTES    = int(_LOG_MAX_BYTES_RAW)
except ValueError:
    raise SystemExit(f"LOG_MAX_BYTES must be an integer, got {_LOG_MAX_BYTES_RAW!r}")
try:
    _LOG_BACKUP_COUNT = int(_LOG_BACKUP_COUNT_RAW)
except ValueError:
    raise SystemExit(f"LOG_BACKUP_COUNT must be an integer, got {_LOG_BACKUP_COUNT_RAW!r}")
if _LOG_MAX_BYTES < 1024:
    raise SystemExit(f"LOG_MAX_BYTES must be >= 1024, got {_LOG_MAX_BYTES}")
if _LOG_BACKUP_COUNT < 0:
    raise SystemExit(f"LOG_BACKUP_COUNT must be >= 0, got {_LOG_BACKUP_COUNT}")

# ─── Обработчик ───────────────────────────────────────────────────────
try:
    Path(_LOG_FILE_RAW).parent.mkdir(parents=True, exist_ok=True)
    handler           = RotatingFileHandler(
        _LOG_FILE_RAW, maxBytes=_LOG_MAX_BYTES, backupCount=_LOG_BACKUP_COUNT,
    )
    handler.setFormatter(_log_fmt)
    logger.addHandler(handler)
except OSError as _e:
    _h                = logging.StreamHandler()
    _h.setFormatter(_log_fmt)
    logger.addHandler(_h)
    logger.warning("cannot use log file %s (%s), logging to stderr", _LOG_FILE_RAW, _e)

# ─── Экспорт ──────────────────────────────────────────────────────────
LOG_FILE              = _LOG_FILE_RAW
LOG_MAX_BYTES         = _LOG_MAX_BYTES
LOG_BACKUP_COUNT      = _LOG_BACKUP_COUNT

# ═══════════════════════════════════════════════════════════════════════
# 2. ХЕЛПЕРЫ ЧТЕНИЯ ENV
# ═══════════════════════════════════════════════════════════════════════

# ─── Общие ────────────────────────────────────────────────────────────
_DEFAULTS_USED        = []

def _env_missing(name: str, default: object) -> None:
    _DEFAULTS_USED.append((name, default))
    logger.warning("env %s is not set, using default %r", name, default)

# ─── Числа ────────────────────────────────────────────────────────────
def _env_int(name: str, default: int, minimum: int = 0) -> int:
    raw = os.environ.get(name)
    if raw is None:
        _env_missing(name, default)
        raw = str(default)
    try:
        val = int(raw)
    except ValueError:
        raise SystemExit(f"{name} must be an integer, got {raw!r}")
    if val < minimum:
        raise SystemExit(f"{name} must be >= {minimum}, got {val}")
    return val

def _env_float(name: str, default: float, minimum: float = 0.0) -> float:
    raw = os.environ.get(name)
    if raw is None:
        _env_missing(name, default)
        raw = str(default)
    try:
        val = float(raw)
    except ValueError:
        raise SystemExit(f"{name} must be a number, got {raw!r}")
    if val < minimum:
        raise SystemExit(f"{name} must be >= {minimum}, got {val}")
    return val

# ─── Bool и список ────────────────────────────────────────────────────
def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        _env_missing(name, default)
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off", "")

def _env_list(name: str, default: str) -> list:
    raw = os.environ.get(name)
    if raw is None:
        _env_missing(name, default)
        raw = default
    return [x.strip() for x in raw.split(",") if x.strip()]

# ─── Строки ───────────────────────────────────────────────────────────
def _env_str(name: str, default: str) -> str:
    raw = os.environ.get(name)
    if raw is None:
        _env_missing(name, default)
        return default
    return raw

# ─── Обязательные ─────────────────────────────────────────────────────
def _require_env(name: str) -> str:
    raw = os.environ.get(name)
    if raw is None:
        logger.critical("startup refused: env %s is required but not set", name)
        print(f"env {name} is required but not set", file=sys.stderr)
        raise SystemExit(78)
    return raw

# ═══════════════════════════════════════════════════════════════════════
# 3. КОНФИГУРАЦИЯ
# ═══════════════════════════════════════════════════════════════════════

# ─── Сеть и интерфейс ─────────────────────────────────────────────────
WG_IFACE             = _env_str("WG_IFACE", "wg0")
HOST                 = _env_str("HOST", "127.0.0.1")
PORT                 = _env_int("PORT", 8080, 1)
if PORT > 65535:
    raise SystemExit(f"PORT out of range: {PORT}")

# ─── Файлы ────────────────────────────────────────────────────────────
CLIENTS_DIR          = _env_str("CLIENTS_DIR", "/etc/wireguard/clients")

# ─── События ──────────────────────────────────────────────────────────
EVENTS_LIMIT         = _env_int("EVENTS_LIMIT", 200, 1)
EVENTS_LIMIT_PEER    = _env_int("EVENTS_LIMIT_PEER", 500, 1)
EVENTS_LIMIT_MAX     = _env_int("EVENTS_LIMIT_MAX", 2000, 1)

# ─── Аутентификация ───────────────────────────────────────────────────
WEB_USER             = _require_env("WEB_USER")
WEB_PASSWORD         = _require_env("WEB_PASSWORD")
WEB_SECRET_KEY       = _require_env("WEB_SECRET_KEY")
WEB_PASSWORD_MIN_LEN = _env_int("WEB_PASSWORD_MIN_LEN", 0, 0)
WEB_SESSION_TTL      = _env_int("WEB_SESSION_TTL", 43200, 1)
WEB_REMEMBER_TTL     = _env_int("WEB_REMEMBER_TTL", 604800, 1)
SECRET_KEY_WARN_LEN  = _env_int("SECRET_KEY_WARN_LEN", 32, 1)
SECRET_KEY_MIN_LEN   = _env_int("SECRET_KEY_MIN_LEN", 16, 1)
TOKEN_MIN_LEN        = _env_int("TOKEN_MIN_LEN", 32, 16)

# ─── Cookies и CSRF ───────────────────────────────────────────────────
CSRF_COOKIE_SECURE   = _env_bool("CSRF_COOKIE_SECURE", True)
CSRF_COOKIE_SAMESITE = _env_str("CSRF_COOKIE_SAMESITE", "Strict")
if CSRF_COOKIE_SAMESITE not in ("Strict", "Lax", "None"):
    raise SystemExit(
        f"CSRF_COOKIE_SAMESITE must be Strict/Lax/None, got {CSRF_COOKIE_SAMESITE!r}")
if CSRF_COOKIE_SAMESITE == "None" and not CSRF_COOKIE_SECURE:
    raise SystemExit("CSRF_COOKIE_SAMESITE=None requires CSRF_COOKIE_SECURE=True")

SESSION_COOKIE_HTTPONLY = _env_bool("SESSION_COOKIE_HTTPONLY", True)

# ─── Host и Origin ────────────────────────────────────────────────────
ALLOWED_HOSTS        = {h.lower() for h in _env_list("ALLOWED_HOSTS", "")}
CSRF_TRUSTED_ORIGINS = {o.rstrip("/").lower()
                        for o in _env_list("CSRF_TRUSTED_ORIGINS", "")}

X_FRAME_OPTIONS      = _env_str("X_FRAME_OPTIONS", "SAMEORIGIN").strip().upper()
if X_FRAME_OPTIONS not in ("DENY", "SAMEORIGIN"):
    raise SystemExit(
        f"X_FRAME_OPTIONS must be DENY or SAMEORIGIN, got {X_FRAME_OPTIONS!r}")

# ─── Лимиты запросов ──────────────────────────────────────────────────
MAX_CONTENT_LENGTH   = _env_int("MAX_CONTENT_LENGTH", 16 * 1024, 1)
NEXT_MAX_LEN         = _env_int("NEXT_MAX_LEN", 512, 16)

# ─── Rate-limit: логин ────────────────────────────────────────────────
LOGIN_MAX_FAILS      = _env_int("LOGIN_MAX_FAILS", 3, 1)
LOGIN_FAIL_WINDOW    = _env_int("LOGIN_FAIL_WINDOW", 300, 1)
LOGIN_BAN_SECONDS    = _env_int("LOGIN_BAN_SECONDS", 180, 1)
LOGIN_MAX_TRACKED    = _env_int("LOGIN_MAX_TRACKED", 10000, 100)

# ─── Rate-limit: create/delete ────────────────────────────────────────
ACTION_MAX_REQUESTS  = _env_int("ACTION_MAX_REQUESTS", 5, 1)
ACTION_WINDOW        = _env_int("ACTION_WINDOW", 60, 1)

# ─── Redis (необязательно): общие счётчики rate-limit для нескольких воркеров ──
# REDIS_URL пуст — счётчики в памяти процесса (как раньше). Примеры:
# redis://127.0.0.1:6379/0,redis://:пароль@127.0.0.1:6379/0,unix:///var/run/redis/redis.sock?db=0
REDIS_URL            = _env_str("REDIS_URL", "").strip()
REDIS_PREFIX         = _env_str("REDIS_PREFIX", "wg-watch:")
REDIS_TIMEOUT        = _env_float("REDIS_TIMEOUT", 1.0, 0.1)
if REDIS_URL and not REDIS_URL.startswith(("redis://", "rediss://", "unix://")):
    logger.error("REDIS_URL must start with redis://, rediss:// or unix://")
    raise SystemExit(78)

# ─── URL_PREFIX ───────────────────────────────────────────────────────
URL_PREFIX           = _env_str("URL_PREFIX", "").rstrip("/")
if URL_PREFIX and not URL_PREFIX.startswith("/"):
    URL_PREFIX = "/" + URL_PREFIX

# ─── Upstream: Go-демон статистики ────────────────────────────────────
DAEMON_HOST          = _env_str("DAEMON_HOST", "127.0.0.1")
DAEMON_PORT          = _env_int("DAEMON_PORT", 18082, 1)
DAEMON_TIMEOUT       = _env_float("DAEMON_TIMEOUT", 2.0, 0.1)
DAEMON_TOKEN         = _require_env("DAEMON_TOKEN")

# ─── Upstream: Go-агент управления клиентами ──────────────────────────
MANAGER_HOST         = _env_str("MANAGER_HOST", "127.0.0.1")
MANAGER_PORT         = _env_int("MANAGER_PORT", 18083, 1)
MANAGER_TIMEOUT      = _env_float("MANAGER_TIMEOUT", 35.0, 0.1)
MANAGER_TOKEN        = _require_env("MANAGER_TOKEN")

# ─── Клиенты ──────────────────────────────────────────────────────────
CLIENTS_CACHE_TTL    = _env_float("CLIENTS_CACHE_TTL", 10.0, 0.0)
CLIENT_NAME_MAX      = _env_int("CLIENT_NAME_MAX", 64, 1)
CLIENT_NAME_RE       = re.compile(rf"[A-Za-z0-9._-]{{1,{CLIENT_NAME_MAX}}}")

# ─── Прочее ───────────────────────────────────────────────────────────
PROXY_FIX_COUNT      = _env_int("PROXY_FIX_COUNT", 1, 0)
FLASK_DEBUG          = _env_bool("FLASK_DEBUG", False)

# .json намеренно НЕ включён: static/config.json не должен отдаваться без логина.
PUBLIC_STATIC_EXT    = {
    e.lower() for e in _env_list(
        "PUBLIC_STATIC_EXT",
        ".css,.js,.png,.jpg,.jpeg,.gif,.svg,.webp,.ico,"
        ".woff,.woff2,.ttf,.webmanifest",
    )
}

# ─── Пост-проверки ────────────────────────────────────────────────────
if len(WEB_SECRET_KEY) < SECRET_KEY_WARN_LEN:
    logger.warning("WEB_SECRET_KEY is shorter than %d characters", SECRET_KEY_WARN_LEN)
if HOST not in ("127.0.0.1", "localhost", "::1"):
    logger.warning(
        "HOST=%s is not loopback: ProxyFix trusts X-Forwarded-* headers, "
        "so the app must only be reachable through the reverse proxy", HOST)
if not ALLOWED_HOSTS:
    logger.warning("ALLOWED_HOSTS is empty: Host header check is disabled")
if not CSRF_TRUSTED_ORIGINS:
    logger.warning(
        "CSRF_TRUSTED_ORIGINS is empty: Origin/Referer check for "
        "state-changing requests is disabled (only the CSRF token is checked)")
if not PUBLIC_STATIC_EXT:
    logger.warning(
        "PUBLIC_STATIC_EXT is empty: no static files will be public — "
        "the login page CSS/JS will not load without authentication")

def _fatal(msg: str):
    logger.critical("startup refused: %s", msg)
    print(msg, file=sys.stderr)
    raise SystemExit(78)

if len(DAEMON_TOKEN) < TOKEN_MIN_LEN:
    _fatal(f"DAEMON_TOKEN is too short (min {TOKEN_MIN_LEN} chars)")
if len(MANAGER_TOKEN) < TOKEN_MIN_LEN:
    _fatal(f"MANAGER_TOKEN is too short (min {TOKEN_MIN_LEN} chars)")
if len(WEB_SECRET_KEY) < SECRET_KEY_MIN_LEN:
    _fatal(f"WEB_SECRET_KEY is too short (min {SECRET_KEY_MIN_LEN} chars)")
if WEB_PASSWORD_MIN_LEN > 0 and len(WEB_PASSWORD) < WEB_PASSWORD_MIN_LEN:
    _fatal(f"WEB_PASSWORD must be at least {WEB_PASSWORD_MIN_LEN} characters")

STATIC_DIR            = Path(__file__).parent / "static"

# ═══════════════════════════════════════════════════════════════════════
# 4. НАСТРОЙКА FLASK-ПРИЛОЖЕНИЯ
# ═══════════════════════════════════════════════════════════════════════

# ─── Приложение и конфиг ──────────────────────────────────────────────
app                   = Flask(__name__, static_folder=None)
app.secret_key        = WEB_SECRET_KEY

app.config.update(
    SESSION_COOKIE_NAME="wg_watch_session",
    SESSION_COOKIE_SECURE=CSRF_COOKIE_SECURE,
    SESSION_COOKIE_HTTPONLY=SESSION_COOKIE_HTTPONLY,
    SESSION_COOKIE_SAMESITE=CSRF_COOKIE_SAMESITE,
    # Cookie живёт максимум из двух сроков; реальный срок сессии проверяется на сервере (session["ttl"]).
    PERMANENT_SESSION_LIFETIME=timedelta(seconds=max(WEB_SESSION_TTL, WEB_REMEMBER_TTL)),
    MAX_CONTENT_LENGTH=MAX_CONTENT_LENGTH,
)

# ─── Срок cookie берётся из самой сессии ──────────────────────────────
# Без галочки cookie живёт WEB_SESSION_TTL, с галочкой «запомнить меня» WEB_REMEMBER_TTL.
# Стандартный Flask ставит всем permanent-сессиям один общий срок, поэтому переопределяем расчёт Expires.
class _TtlSessionInterface(SecureCookieSessionInterface):
    def get_expiration_time(self, app, session):
        if session.permanent:
            ttl = session.get("ttl")
            if isinstance(ttl, (int, float)) and not isinstance(ttl, bool) and ttl > 0:
                ttl = min(ttl, max(WEB_SESSION_TTL, WEB_REMEMBER_TTL))
                return datetime.now(timezone.utc) + timedelta(seconds=ttl)
        return super().get_expiration_time(app, session)

app.session_interface = _TtlSessionInterface()

# ─── ProxyFix ─────────────────────────────────────────────────────────
if PROXY_FIX_COUNT > 0:
    app.wsgi_app = ProxyFix(
        app.wsgi_app,
        x_for=PROXY_FIX_COUNT,
        x_proto=PROXY_FIX_COUNT,
        x_host=PROXY_FIX_COUNT,
        x_prefix=PROXY_FIX_COUNT,
    )

app.config["APPLICATION_ROOT"] = URL_PREFIX or "/"
app.config["SESSION_COOKIE_PATH"] = URL_PREFIX or "/"

# ─── Хелперы ──────────────────────────────────────────────────────────
_AUTH_FP              = hmac.new(
                            WEB_SECRET_KEY.encode(),
                            (WEB_USER + "\0" + WEB_PASSWORD).encode(),
                            "sha256",
                        ).hexdigest()[:32]

def _s(value, limit: int = 64) -> str:
    return ascii(str(value)[:limit])

def _app_url(path: str = "/") -> str:
    return f"{URL_PREFIX}{path}"

# ═══════════════════════════════════════════════════════════════════════
# 5. ПРОВЕРКА HOST
# ═══════════════════════════════════════════════════════════════════════

@app.before_request
def _enforce_allowed_host():
    if not ALLOWED_HOSTS:
        return
    host = (request.host or "").split(":", 1)[0].strip().lower()
    if host and host not in ALLOWED_HOSTS:
        logger.warning(
            "rejected host=%r path=%s ip=%s",
            _s(host, 128), _s(request.path), _s(request.remote_addr),
        )
        abort(400, description="Bad Host header")

# ═══════════════════════════════════════════════════════════════════════
# 6. АУТЕНТИФИКАЦИЯ И CSRF
# ═══════════════════════════════════════════════════════════════════════

# ─── Проверка логина и пароля ─────────────────────────────────────────
def check_credentials(user: str, password: str) -> bool:
    u_ok = hmac.compare_digest(user.encode(), WEB_USER.encode())
    p_ok = hmac.compare_digest(password.encode(), WEB_PASSWORD.encode())
    return u_ok and p_ok

# ─── Состояние сессии ─────────────────────────────────────────────────
def _session_state() -> str:
    if not session.get("authenticated"):
        return "none"
    fp = session.get("fp", "")
    if not isinstance(fp, str) or not hmac.compare_digest(fp.encode(), _AUTH_FP.encode()):
        return "none"
    ts = session.get("login_ts", 0)
    ttl = session.get("ttl", WEB_SESSION_TTL)
    if (not isinstance(ts, (int, float)) or isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))):
        return "expired"
    ttl = min(max(ttl, 1), max(WEB_SESSION_TTL, WEB_REMEMBER_TTL))
    if time.time() - ts > ttl:
        return "expired"
    return "ok"

# ─── Безопасный ?next= ────────────────────────────────────────────────
def _safe_next(raw) -> str:
    if not raw or len(raw) > NEXT_MAX_LEN:
        return "/"
    if any(ord(c) < 32 or ord(c) == 127 or c == "\\" for c in raw):
        return "/"
    if URL_PREFIX and (raw == URL_PREFIX or raw.startswith(URL_PREFIX + "/")):
        raw = raw[len(URL_PREFIX):] or "/"
    parts = urlsplit(raw)
    if parts.scheme or parts.netloc:
        return "/"
    if not raw.startswith("/") or raw.startswith("//"):
        return "/"
    return raw

# ─── CSRF-токен ───────────────────────────────────────────────────────
def _ensure_csrf() -> str:
    tok = session.get("csrf")
    if not tok:
        tok = secrets.token_urlsafe(32)
        session["csrf"] = tok
    return tok

@app.after_request
def _expose_csrf(resp):
    if _session_state() == "ok":
        resp.headers["X-CSRF-Token"] = _ensure_csrf()
    return resp

# ─── Проверка Origin/Referer ──────────────────────────────────────────
def _origin_of(url: str) -> str:
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return ""
    return f"{parts.scheme}://{parts.netloc}".lower()

def _check_trusted_origin() -> bool:
    if not CSRF_TRUSTED_ORIGINS:
        return True

    origin = request.headers.get("Origin")
    if origin:
        return _origin_of(origin) in CSRF_TRUSTED_ORIGINS

    referer = request.headers.get("Referer")
    if referer:
        ref_origin = _origin_of(referer)
        if ref_origin:
            return ref_origin in CSRF_TRUSTED_ORIGINS

    return True

# ─── Декоратор csrf_protect ───────────────────────────────────────────
def csrf_protect(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            tok = session.get("csrf", "")
            got = request.headers.get("X-CSRF-Token", "")
            if not tok or not hmac.compare_digest(tok.encode(), got.encode()):
                logger.warning("csrf failed path=%s ip=%s",
                               _s(request.path), _s(request.remote_addr))
                return jsonify({"ok": False, "error": "csrf_failed",
                                "message": "Invalid CSRF token"}), 403
            if not _check_trusted_origin():
                logger.warning(
                    "rejected origin path=%s ip=%s origin=%r referer=%r",
                    _s(request.path), _s(request.remote_addr),
                    _s(request.headers.get("Origin", ""), 128),
                    _s(request.headers.get("Referer", ""), 128),
                )
                return jsonify({
                    "ok": False, "error": "origin_not_allowed",
                    "message": "Origin not trusted",
                }), 403
        return f(*args, **kwargs)
    return wrapper

# ─── Декоратор login_required ─────────────────────────────────────────
def _login_redirect(expired: bool = False):
    target = _app_url("/login")
    query = {}
    if request.path not in ("/", ""):
        query["next"] = request.path
    if expired:
        # Страница входа покажет «Сессия истекла».
        query["expired"] = "1"
    if query:
        target += "?" + urlencode(query)
    return redirect(target)

def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        is_api = request.path.startswith("/api/")
        state = _session_state()
        if state != "ok":
            if state == "expired":
                session.clear()
            if is_api:
                if state == "expired":
                    logger.warning("expired session path=%s ip=%s",
                                   _s(request.path), _s(request.remote_addr))
                    return jsonify({"error": "session expired"}), 401
                logger.warning("unauthorized api access path=%s ip=%s",
                               _s(request.path), _s(request.remote_addr))
                return jsonify({"error": "unauthorized"}), 401
            return _login_redirect(expired=(state == "expired"))
        return f(*args, **kwargs)
    return wrapper

# ─── Логин и логаут ───────────────────────────────────────────────────
@app.route("/login", methods=["GET", "POST"])
def login():
    error = ""

    if request.method == "GET" and _session_state() == "ok":
        return redirect(_app_url("/"))

    # Сюда присылают, когда сессия истекла (сервер или фронт добавляют ?expired=1).
    if request.method == "GET" and request.args.get("expired") == "1":
        error = "error_session_expired"

    if request.method == "POST":
        ban_left = _login_ban_left()
        if ban_left > 0:
            logger.warning("login banned ip=%s seconds_left=%d", _client_ip(), ban_left)
            return _too_many(ban_left)

        user = request.form.get("user", "")
        password = request.form.get("password", "")

        if check_credentials(user, password):
            _reset_login_fails()
            session.clear()
            session["authenticated"] = True
            session["user"] = user
            session["fp"] = _AUTH_FP
            session["login_ts"] = time.time()

            remember = request.form.get("remember") == "1"
            # Срок жизни именно этой сессии: 12 часов или «запомнить меня» (7 дней).
            session["ttl"] = WEB_REMEMBER_TTL if remember else WEB_SESSION_TTL
            session.permanent = True
            logger.info("login ok user=%s ip=%s remember=%s", _s(user), _s(request.remote_addr), remember)
            return redirect(_app_url(_safe_next(request.args.get("next"))))

        ban_left = _register_login_fail()
        logger.warning("login failed user=%s ip=%s ban_left=%d", _s(user), _client_ip(), ban_left)
        if ban_left > 0:
            return _too_many(ban_left)
        error = "error_invalid_credentials"

    remember_days = WEB_REMEMBER_TTL // 86400
    return render_template("login.html", error=error, ban_seconds=0, remember_days=remember_days)

@app.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    return redirect(_app_url("/login"))

# ─── Заголовки безопасности ───────────────────────────────────────────
@app.after_request
def _security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("X-Frame-Options", X_FRAME_OPTIONS)
    resp.headers.setdefault(
        "Content-Security-Policy",
        "frame-ancestors 'self'" if X_FRAME_OPTIONS == "SAMEORIGIN"
        else "frame-ancestors 'none'",
    )
    if request.path.startswith("/api/") or request.path in ("/", "/login", "/logout"):
        resp.headers["Cache-Control"] = "no-store"
    return resp

# ═══════════════════════════════════════════════════════════════════════
# 7. ОГРАНИЧЕНИЕ ЧАСТОТЫ
# ═══════════════════════════════════════════════════════════════════════

# ─── Структуры ────────────────────────────────────────────────────────
_login_failures       = defaultdict(deque)
_login_bans           = {}
_action_reqs          = defaultdict(deque)
_rate_lock            = threading.Lock()
_last_gc              = 0.0

# ─── IP клиента ───────────────────────────────────────────────────────
def _client_ip() -> str:
    return request.remote_addr or "unknown"

# ─── Очистка окон ─────────────────────────────────────────────────────
def _prune_old(ip: str, now: float) -> None:
    cutoff = now - LOGIN_FAIL_WINDOW
    dq = _login_failures[ip]
    while dq and dq[0] < cutoff:
        dq.popleft()

def _prune_actions(ip: str, now: float) -> None:
    cutoff = now - ACTION_WINDOW
    dq = _action_reqs[ip]
    while dq and dq[0] < cutoff:
        dq.popleft()

def _evict_lru(now: float) -> None:
    global _last_gc
    over = len(_login_failures) > LOGIN_MAX_TRACKED or len(_action_reqs) > LOGIN_MAX_TRACKED
    if not over and now - _last_gc < 60:
        return
    _last_gc = now

    for ip in [ip for ip, until in _login_bans.items() if until <= now]:
        _login_bans.pop(ip, None)

    max_window = max(LOGIN_FAIL_WINDOW, ACTION_WINDOW)
    for d in (_login_failures, _action_reqs):
        for ip in [k for k in d if k not in _login_bans and (not d[k] or d[k][-1] < now - max_window)]:
            d.pop(ip, None)

# ─── Проверка лимита действий ─────────────────────────────────────────
def _mem_check_rate_limit() -> bool:
    ip = _client_ip()
    now = time.time()
    with _rate_lock:
        _prune_actions(ip, now)
        _evict_lru(now)

        dq = _action_reqs[ip]
        if len(dq) >= ACTION_MAX_REQUESTS:
            return False

        dq.append(now)
        return True

# ─── Бан и неудачные логины ───────────────────────────────────────────
def _mem_login_ban_left() -> int:
    ip = _client_ip()
    now = time.time()
    with _rate_lock:
        until = _login_bans.get(ip)
        if until is None:
            return 0
        left = int(until - now)
        if left <= 0:
            _login_bans.pop(ip, None)
            _login_failures.pop(ip, None)
            return 0
        return left

def _mem_register_login_fail() -> int:
    ip = _client_ip()
    now = time.time()
    with _rate_lock:
        dq = _login_failures[ip]
        dq.append(now)
        _prune_old(ip, now)
        _evict_lru(now)

        if len(dq) >= LOGIN_MAX_FAILS:
            _login_bans[ip] = now + LOGIN_BAN_SECONDS
            dq.clear()
            return LOGIN_BAN_SECONDS
        return 0

def _mem_reset_login_fails() -> None:
    ip = _client_ip()
    with _rate_lock:
        _login_failures.pop(ip, None)
        _login_bans.pop(ip, None)

# ─── Redis-бэкенд ─────────────────────────────────────────────────────
# Все воркеры видят одни и те же счётчики. Если Redis недоступен, лимиты временно считаются в памяти
# процесса (запросы не блокируются и не пропускаются без ограничений), а в лог раз в минуту пишется предупреждение.
_redis = None
_redis_scripts = {}
_redis_warned_at = 0.0

# Скрипты выполняются в Redis атомарно: проверка и запись счётчика не могут перемешаться между воркерами.
_LUA_ACTION = """
local key, now, window, max, member = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
if redis.call('ZCARD', key) >= max then return 0 end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, window + 5)
return 1
"""
_LUA_FAIL = """
local fkey, bkey = KEYS[1], KEYS[2]
local now, window, max, ban, member = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), ARGV[5]
redis.call('ZREMRANGEBYSCORE', fkey, 0, now - window)
redis.call('ZADD', fkey, now, member)
redis.call('EXPIRE', fkey, window + 5)
if redis.call('ZCARD', fkey) >= max then
  redis.call('SET', bkey, '1', 'EX', ban)
  redis.call('DEL', fkey)
  return ban
end
return 0
"""

def _redis_target() -> str:
    # Адрес без пароля — для лога.
    u = urlsplit(REDIS_URL)
    if u.scheme == "unix":
        return "unix:" + u.path
    return f"{u.scheme}://{u.hostname}:{u.port or 6379}{u.path or ''}"

def _redis_init() -> None:
    global _redis
    if not REDIS_URL:
        return
    try:
        import redis
    except ImportError:
        logger.error("REDIS_URL is set but the 'redis' package is not installed: pip install redis")
        raise SystemExit(78)
    try:
        _redis = redis.Redis.from_url(
            REDIS_URL, socket_timeout=REDIS_TIMEOUT, socket_connect_timeout=REDIS_TIMEOUT,
            decode_responses=True, health_check_interval=30)
    except ValueError as e:
        logger.error("invalid REDIS_URL: %s", e)
        raise SystemExit(78)
    _redis_scripts["action"] = _redis.register_script(_LUA_ACTION)
    _redis_scripts["fail"] = _redis.register_script(_LUA_FAIL)
    try:
        _redis.ping()
        logger.info("rate-limit backend: redis %s", _redis_target())
    except Exception as e:
        logger.warning("Redis is unavailable at start (%s); in-memory rate-limit is used until it is back",
                       e.__class__.__name__)

def _redis_failed(exc: Exception) -> None:
    global _redis_warned_at
    now = time.time()
    if now - _redis_warned_at >= 60:
        _redis_warned_at = now
        logger.warning("Redis error (%s: %s): in-memory rate-limit is used", exc.__class__.__name__, exc)

def _rk(kind: str, ip: str) -> str:
    return f"{REDIS_PREFIX}{kind}:{ip}"

# ─── Публичные функции лимитов ────────────────────────────────────────
def _check_rate_limit() -> bool:
    if _redis is not None:
        try:
            now = time.time()
            ok = _redis_scripts["action"](
                keys=[_rk("act", _client_ip())],
                args=[now, ACTION_WINDOW, ACTION_MAX_REQUESTS, f"{now}:{secrets.token_hex(4)}"])
            return bool(ok)
        except Exception as e:
            _redis_failed(e)
    return _mem_check_rate_limit()

def _login_ban_left() -> int:
    if _redis is not None:
        try:
            pttl = _redis.pttl(_rk("ban", _client_ip()))
            return int(math.ceil(pttl / 1000)) if pttl and pttl > 0 else 0
        except Exception as e:
            _redis_failed(e)
    return _mem_login_ban_left()

def _register_login_fail() -> int:
    if _redis is not None:
        try:
            ip, now = _client_ip(), time.time()
            return int(_redis_scripts["fail"](
                keys=[_rk("fail", ip), _rk("ban", ip)],
                args=[now, LOGIN_FAIL_WINDOW, LOGIN_MAX_FAILS, LOGIN_BAN_SECONDS,
                      f"{now}:{secrets.token_hex(4)}"]))
        except Exception as e:
            _redis_failed(e)
    return _mem_register_login_fail()

def _reset_login_fails() -> None:
    if _redis is not None:
        try:
            ip = _client_ip()
            _redis.delete(_rk("fail", ip), _rk("ban", ip))
        except Exception as e:
            _redis_failed(e)
    _mem_reset_login_fails()

_redis_init()

# ─── Слишком много запросов ───────────────────────────────────────────
def _too_many(ban_left: int):
    resp = make_response(render_template(
        "login.html",
        error="error_too_many_attempts",
        ban_seconds=ban_left,
    ), 429)
    resp.headers["Retry-After"] = str(ban_left)
    return resp

# ═══════════════════════════════════════════════════════════════════════
# 8. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (КЛИЕНТЫ)
# ═══════════════════════════════════════════════════════════════════════

# ─── Кэш ──────────────────────────────────────────────────────────────
_clients_lock         = threading.Lock()
_clients_cache        = {"ts": float("-inf"), "items": [], "by_pk": {}}

def _invalidate_clients_cache() -> None:
    with _clients_lock:
        _clients_cache["ts"] = float("-inf")
        _clients_cache["items"] = []
        _clients_cache["by_pk"] = {}

# ─── Снимок клиентов ──────────────────────────────────────────────────
def _clients_snapshot():
    now = time.monotonic()
    with _clients_lock:
        if now - _clients_cache["ts"] < CLIENTS_CACHE_TTL:
            return _clients_cache["items"], _clients_cache["by_pk"]

        items = []
        by_pk = {}
        root = Path(CLIENTS_DIR)
        try:
            dirs = sorted(d for d in root.iterdir() if d.is_dir())
        except OSError:
            dirs = []

        for d in dirs:
            try:
                with (d / "public.key").open() as fh:
                    val = fh.read(256).strip()
            except OSError:
                val = ""
            name = re.sub(r"[^A-Za-z0-9._-]", "_", d.name)
            items.append((name, val))
            if val:
                by_pk.setdefault(val, name)

        _clients_cache.update(ts=now, items=items, by_pk=by_pk)
        return items, by_pk

# ─── Имя по публичному ключу ──────────────────────────────────────────
def client_name_by_pubkey(pk: str) -> str:
    if not pk:
        return ""
    _items, by_pk = _clients_snapshot()
    return by_pk.get(pk, pk)

# ═══════════════════════════════════════════════════════════════════════
# 9. ЧТЕНИЕ ЛОГОВ (ЧЕРЕЗ API ДЕМОНА)
# ═══════════════════════════════════════════════════════════════════════

# events.log Flask не читает: журнал принадлежит root и отдаётся демоном через /api/events.

# ═══════════════════════════════════════════════════════════════════════
# 10. УПРАВЛЕНИЕ КЛИЕНТАМИ (ЧЕРЕЗ GO-АГЕНТ WG-WATCH-MANAGER)
# ═══════════════════════════════════════════════════════════════════════

# ─── Заголовки к Go-сервисам ──────────────────────────────────────────
def _daemon_headers() -> dict:
    return {"X-Daemon-Token": DAEMON_TOKEN}

def _manager_headers() -> dict:
    return {"X-Manager-Token": MANAGER_TOKEN}

# ─── Валидация имени клиента ──────────────────────────────────────────
def _valid_client_name(name) -> bool:
    if not isinstance(name, str):
        return False
    if not CLIENT_NAME_RE.fullmatch(name):
        return False
    if name in (".", ".."):
        return False
    if name.startswith(".") or name.startswith("-"):
        return False
    return True

# ─── Ответ для браузера ───────────────────────────────────────────────
# Из ответа менеджера отдаём только безопасные поля (без путей к файлам и сырого текста).
_PUBLIC_RESULT_KEYS = ("ok", "error", "message", "name", "ip")

def _public_result(result: dict) -> dict:
    return {k: result[k] for k in _PUBLIC_RESULT_KEYS if k in result}

# ─── Вызов Go-агента ──────────────────────────────────────────────────
def _run_client_script(script_name: str, name: str, ip: str | None = None,
                       client_ip: str = "unknown") -> tuple[int, dict]:
    if "create" in script_name:
        endpoint = "/api/create"
    elif "delete" in script_name:
        endpoint = "/api/delete"
    elif "download" in script_name:
        endpoint = "/api/config"
    else:
        logger.error("unknown client script requested: %s", script_name)
        return 500, {"ok": False, "error": "unknown_script"}

    url = f"http://{MANAGER_HOST}:{MANAGER_PORT}{endpoint}"

    try:
        if "download" in script_name:
            r = requests.get(url, params={"name": name},
                             headers=_manager_headers(), timeout=MANAGER_TIMEOUT)
        else:
            payload = {"name": name}
            if ip:
                payload["ip"] = ip
            r = requests.post(url, json=payload,
                              headers=_manager_headers(), timeout=MANAGER_TIMEOUT)

        if r.status_code == 401:
            logger.error(
                "CRITICAL: Manager rejected token! Check MANAGER_TOKEN in env files. (endpoint=%s ip=%s)",
                _s(endpoint), _s(client_ip),
            )
            return 500, {"ok": False, "error": "manager_unreachable"}

        try:
            result = r.json()
        except ValueError:
            logger.error("manager returned non-JSON: %s", _s(r.text[:200]))
            result = {
                "ok": False,
                "error": "bad_response",
                "raw": r.text[:200],
            }

        return r.status_code, result

    except requests.RequestException as e:
        logger.error("manager API unreachable: %s", e)
        return 500, {"ok": False, "error": "manager_unreachable"}

# ═══════════════════════════════════════════════════════════════════════
# 11. МАРШРУТЫ API
# ═══════════════════════════════════════════════════════════════════════

# ─── Состояние ────────────────────────────────────────────────────────
@app.get("/api/state")
@login_required
def api_state():
    try:
        r = requests.get(f"http://{DAEMON_HOST}:{DAEMON_PORT}/api/state",
                         headers=_daemon_headers(), timeout=DAEMON_TIMEOUT)
        if r.status_code == 401:
            logger.error("CRITICAL: Daemon rejected token! Check DAEMON_TOKEN in env files.")
            raise ValueError("unauthorized")

        r.raise_for_status()
        data = r.json()
        data["user"] = session.get("user")
        return jsonify(data)
    except Exception as e:
        logger.error("failed to reach stats daemon: %s", e)
        return jsonify({
            "error": "stats daemon unreachable",
            "peers": [],
            "iface": {},
            "traffic": {},
            "uptime": None,
            "user": session.get("user")
        }), 200

# ─── События ──────────────────────────────────────────────────────────
# Журнал читает только демон (events.log принадлежит root:root); Flask получает события по его API.
@app.get("/api/events")
@login_required
def api_events():
    # Размер ленты задаёт сервер: EVENTS_LIMIT — общая лента, EVENTS_LIMIT_PEER (scope=peer) — лента выбранного клиента.
    # Явный ?limit= по-прежнему принимается; в любом случае потолок — EVENTS_LIMIT_MAX.
    default = EVENTS_LIMIT_PEER if request.args.get("scope") == "peer" else EVENTS_LIMIT
    try:
        limit = int(request.args.get("limit", default))
    except (ValueError, TypeError):
        limit = default
    limit = max(1, min(limit, EVENTS_LIMIT_MAX))
    try:
        r = requests.get(f"http://{DAEMON_HOST}:{DAEMON_PORT}/api/events",
                         params={"limit": limit}, headers=_daemon_headers(),
                         timeout=DAEMON_TIMEOUT)
        if r.status_code == 401:
            logger.error("CRITICAL: Daemon rejected token on /api/events! Check DAEMON_TOKEN in env files.")
            return jsonify({"error": "daemon_unauthorized"}), 500
        r.raise_for_status()
        events = r.json().get("events", [])
        return jsonify({"events": events if isinstance(events, list) else []})
    except Exception as e:
        logger.error("failed to get events from daemon: %s", e)
        return jsonify({"error": "stats daemon unreachable"}), 502

# ─── Скачивание событий ───────────────────────────────────────────────
@app.get("/api/events/download")
@login_required
def api_events_download():
    try:
        r = requests.get(f"http://{DAEMON_HOST}:{DAEMON_PORT}/api/events/download",
                         headers=_daemon_headers(), timeout=(DAEMON_TIMEOUT, 15))
        if r.status_code == 401:
            logger.error("CRITICAL: Daemon rejected token on /api/events/download! Check DAEMON_TOKEN in env files.")
            return jsonify({"error": "daemon_unauthorized"}), 500
        if r.status_code == 404:
            return jsonify({"error": "no events file"}), 404
        r.raise_for_status()
    except requests.RequestException as e:
        logger.error("failed to download events from daemon: %s", e)
        return jsonify({"error": "stats daemon unreachable"}), 502

    logger.info("events log downloaded: ip=%s", _s(request.remote_addr))
    return Response(
        r.content,
        mimetype="application/x-ndjson",
        headers={"Content-Disposition": 'attachment; filename="wg-watch-events.log"'},
    )

# ─── Очистка событий ──────────────────────────────────────────────────
@app.post("/api/events/clear")
@login_required
@csrf_protect
def api_events_clear():
    try:
        r = requests.post(f"http://{DAEMON_HOST}:{DAEMON_PORT}/api/events/clear",
                          headers=_daemon_headers(), timeout=DAEMON_TIMEOUT)

        if r.status_code == 401:
            logger.error("CRITICAL: Daemon rejected token during clear events!")
            return jsonify({"ok": False, "error": "daemon_unauthorized"}), 500

        r.raise_for_status()

        logger.info("events log cleared by user=%s ip=%s",
                    _s(session.get("user")), _s(request.remote_addr))
        return jsonify({"ok": True})

    except requests.RequestException as e:
        logger.error("failed to reach daemon for clearing events: %s", e)
        return jsonify({"ok": False, "error": "daemon_unreachable"}), 500

# ─── История трафика пира ─────────────────────────────────────────────
@app.get("/api/traffic")
@login_required
def api_traffic():
    pk = request.args.get("pk", "")
    if not re.fullmatch(r"[A-Za-z0-9+/]{43}=", pk):
        return jsonify({"error": "invalid_pk"}), 400
    try:
        r = requests.get(f"http://{DAEMON_HOST}:{DAEMON_PORT}/api/traffic",
                         params={"pk": pk}, headers=_daemon_headers(),
                         timeout=DAEMON_TIMEOUT)
        if r.status_code == 401:
            logger.error("CRITICAL: Daemon rejected token on /api/traffic! Check DAEMON_TOKEN in env files.")
            return jsonify({"error": "daemon_unauthorized"}), 500
        if r.status_code == 404:
            return jsonify({"error": "not_found"}), 404
        r.raise_for_status()
        return jsonify(r.json())
    except Exception as e:
        logger.error("failed to get traffic history from daemon: %s", e)
        return jsonify({"error": "stats daemon unreachable"}), 502

# ─── Конфиг клиента ───────────────────────────────────────────────────
@app.get("/api/clients/<name>/config")
@login_required
def api_client_config(name):
    if not _valid_client_name(name):
        abort(400)

    status, result = _run_client_script(
        "download-client-config.sh", name,
        client_ip=request.remote_addr,
    )

    if status != 200 or not result.get("ok"):
        error_msg = result.get("error", "not_found")
        if error_msg == "client_not_found":
            return jsonify({"error": "config not found"}), 404
        return jsonify({"error": error_msg}), status

    content = result.get("content", "")

    if not content:
        return jsonify({"error": "empty config"}), 404

    logger.info("client config downloaded: name=%s ip=%s",
                _s(name), _s(request.remote_addr))

    return make_response(
        content,
        200,
        {
            "Content-Type": "text/plain",
            "Content-Disposition": f"attachment; filename=wg-{name}.conf",
        },
    )

# ─── Список клиентов ──────────────────────────────────────────────────
@app.get("/api/clients")
@login_required
def api_clients():
    items, _by_pk = _clients_snapshot()
    result = []
    for name, pk in items:
        if pk and not re.fullmatch(r"[A-Za-z0-9+/]{43}=", pk):
            pk = ""
        result.append({"name": name, "pubkey": pk})
    return jsonify({"clients": result})

# ─── Создание клиента ─────────────────────────────────────────────────
@app.post("/api/clients/create")
@login_required
@csrf_protect
def api_clients_create():
    if not _check_rate_limit():
        resp = jsonify({"ok": False, "error": "too_many_requests",
                        "message": "Rate limit exceeded"})
        resp.headers["Retry-After"] = str(ACTION_WINDOW)
        return resp, 429

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = {}
    raw_name = data.get("name", "")
    name = raw_name.strip() if isinstance(raw_name, str) else ""

    if not _valid_client_name(name):
        return jsonify({"ok": False, "error": "invalid_name",
                        "message": "Invalid client name"}), 400

    logger.info("api create client: name=%s ip=%s",
                _s(name), _s(request.remote_addr))
    status, result = _run_client_script(
        "create-client.sh", name,
        client_ip=request.remote_addr,
    )

    if status == 200 and result.get("ok"):
        _invalidate_clients_cache()
        logger.info("client created: %s", _s(name))
    else:
        logger.warning("client creation failed: %s status=%d err=%s",
                       _s(name), status, result.get("error"))

    return jsonify(_public_result(result)), status

# ─── Удаление клиента ─────────────────────────────────────────────────
@app.post("/api/clients/delete")
@login_required
@csrf_protect
def api_clients_delete():
    if not _check_rate_limit():
        resp = jsonify({"ok": False, "error": "too_many_requests",
                        "message": "Rate limit exceeded"})
        resp.headers["Retry-After"] = str(ACTION_WINDOW)
        return resp, 429

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = {}
    raw_name = data.get("name", "")
    name = raw_name.strip() if isinstance(raw_name, str) else ""

    if not _valid_client_name(name):
        return jsonify({"ok": False, "error": "invalid_name",
                        "message": "Invalid client name"}), 400

    logger.info("api delete client: name=%s ip=%s",
                _s(name), _s(request.remote_addr))
    status, result = _run_client_script(
        "delete-client.sh", name,
        client_ip=request.remote_addr,
    )

    if status == 200 and result.get("ok"):
        _invalidate_clients_cache()
        logger.info("client deleted: %s", _s(name))
    else:
        logger.warning("client deletion failed: %s status=%d err=%s",
                       _s(name), status, result.get("error"))

    return jsonify(_public_result(result)), status

# ─── Healthcheck ──────────────────────────────────────────────────────
@app.get("/check")
def healthz():
    problems = []

    try:
        r = requests.get(f"http://{DAEMON_HOST}:{DAEMON_PORT}/api/state",
                         headers=_daemon_headers(), timeout=DAEMON_TIMEOUT)
        if r.status_code == 401:
            problems.append({"service": "stats_daemon", "error": "Unauthorized (token mismatch)"})
        else:
            r.raise_for_status()
    except Exception as e:
        problems.append({"service": "stats_daemon", "error": str(e)})

    try:
        r = requests.get(f"http://{MANAGER_HOST}:{MANAGER_PORT}/api/config?name=ping",
                         headers=_manager_headers(), timeout=DAEMON_TIMEOUT)
        if r.status_code == 401:
            problems.append({"service": "manager", "error": "Unauthorized (token mismatch)"})
        elif r.status_code not in (200, 400, 404):
            problems.append({
                "service": "manager",
                "error": f"unexpected status {r.status_code}",
            })
    except Exception as e:
        problems.append({"service": "manager", "error": str(e)})

    if not problems:
        return jsonify({"status": "ok"})

    logger.warning("healthcheck problems: %s", problems)
    if _session_state() != "ok":
        # Без входа не раскрываем адреса и тексты внутренних ошибок.
        return jsonify({"status": "error"}), 503
    return jsonify({"status": "error", "problems": problems}), 503

# ═══════════════════════════════════════════════════════════════════════
# 12. СТАТИЧЕСКИЕ ФАЙЛЫ
# ═══════════════════════════════════════════════════════════════════════

# ─── Главная ──────────────────────────────────────────────────────────
@app.get("/")
@login_required
def index():
    return send_from_directory(STATIC_DIR, "index.html")

# ─── Статика ──────────────────────────────────────────────────────────
@app.get("/<path:path>")
def static_files(path):
    if any(part.startswith(".") for part in path.split("/")):
        abort(404)
    if (_session_state() != "ok"
            and Path(path).suffix.lower() not in PUBLIC_STATIC_EXT):
        abort(404)
    return send_from_directory(STATIC_DIR, path)

# ═══════════════════════════════════════════════════════════════════════
# 13. ЗАПУСК / ОСТАНОВКА
# ═══════════════════════════════════════════════════════════════════════

# ─── Старт ────────────────────────────────────────────────────────────
_START_TS             = time.time()
_start_logged         = False
_stop_logged          = False

def _log_startup_once():
    global _start_logged
    if _start_logged:
        return
    _start_logged = True
    logger.info(
        "wg-watch web started: pid=%d ppid=%d host=%s port=%s iface=%s prefix=%r "
        "frame_options=%s csrf_secure=%s csrf_samesite=%s proxy_fix=%d",
        os.getpid(), os.getppid(), HOST, PORT, WG_IFACE, URL_PREFIX,
        X_FRAME_OPTIONS, CSRF_COOKIE_SECURE, CSRF_COOKIE_SAMESITE, PROXY_FIX_COUNT,
    )
    if _DEFAULTS_USED:
        logger.warning(
            "env defaults used (%d): %s",
            len(_DEFAULTS_USED),
            ", ".join(f"{n}={v!r}" for n, v in _DEFAULTS_USED),
        )

# ─── Остановка ────────────────────────────────────────────────────────
def _log_shutdown(reason: str):
    global _stop_logged
    if _stop_logged:
        return
    _stop_logged = True
    logger.info(
        "wg-watch web stopping: reason=%s pid=%d uptime=%.1fs",
        reason, os.getpid(), time.time() - _START_TS,
    )

atexit.register(lambda: _log_shutdown("atexit"))

def _sig_handler(signum, _frame):
    _log_shutdown(f"signal {signal.Signals(signum).name}")
    raise SystemExit(0)

for _sig in (signal.SIGTERM, signal.SIGINT):
    try:
        signal.signal(_sig, _sig_handler)
    except (ValueError, OSError):
        pass

_log_startup_once()

# ─── Точка входа ──────────────────────────────────────────────────────
if __name__ == "__main__":
    app.run(host=HOST, port=PORT, debug=FLASK_DEBUG)
