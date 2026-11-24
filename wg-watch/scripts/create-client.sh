#!/bin/bash
# Файл: /opt/wg-watch/scripts/create-client.sh
# CLI-обёртка создания клиента WireGuard через lib/wg-clients.sh: разбор --name/--ip/--list/--json/--help, проверка аргументов, вызов wgcfg_init/wgcfg_lock/wgcfg_create с освобождением блокировки по trap EXIT.
# Коды возврата wgcfg_create мапятся в error-коды (invalid_name, client_exists, no_free_ip, reload_failed, internal); при --json печатает JSON, иначе строку OK.
# При ошибке аргументов (не-JSON режим) печатает причину и подсказку по использованию; --help/-h — справка, --list/-l — список существующих клиентов.
# Формат успеха: {"ok":true,"name":"...","ip":"...","config":"<путь к .conf>"}.
set -u
set -o pipefail

LIB="${WG_WATCH_LIB:-/opt/wg-watch/lib/wg-clients.sh}"
if [[ ! -f "$LIB" ]]; then
    printf '{"ok":false,"error":"internal","message":"Library not found"}\n'
    exit 1
fi
# shellcheck source=/dev/null
source "$LIB"

NAME=""
IP=""
JSON=0
LIST=0

usage() {
    local me
    me=$(basename "$0")
    cat <<EOF
Создание клиента WireGuard.

Использование:
  $me --name ИМЯ [--ip ${CLIENT_SUBNET_PREFIX}.N] [--json]
  $me --list [--json]
  $me --help

Параметры:
  --name ИМЯ   имя клиента: буквы, цифры, '.', '_', '-' (1..64), не начинается с '.'
  --ip АДРЕС   IP клиента (необязательно); по умолчанию берётся первый свободный
               из ${CLIENT_SUBNET_PREFIX}.${CLIENT_IP_MIN}..${CLIENT_SUBNET_PREFIX}.${CLIENT_IP_MAX}
  --list, -l   показать список существующих клиентов и выйти
  --json       вывод в формате JSON
  --help, -h   эта справка

Примеры:
  $me --name ivanov
  $me --name ivanov --ip ${CLIENT_SUBNET_PREFIX}.50 --json
  $me --list

Коды возврата:
  0 успех | 2 invalid_name | 3 client_exists | 4 no_free_ip / IP занят
  5 reload_failed | 64 invalid_args | 1 прочие ошибки
EOF
}

# fail КОД ОШИБКА [СООБЩЕНИЕ]
fail() {
    local code="$1" err="$2" msg="${3:-}"
    if [[ "$JSON" == "1" ]]; then
        if [[ -n "$msg" ]]; then
            printf '{"ok":false,"error":"%s","message":"%s"}\n' "$(_json_escape "$err")" "$(_json_escape "$msg")"
        else
            printf '{"ok":false,"error":"%s"}\n' "$(_json_escape "$err")"
        fi
    else
        echo "ERROR: $err${msg:+: $msg}" >&2
        if [[ "$code" == "64" ]]; then
            echo >&2
            usage >&2
        fi
    fi
    exit "$code"
}

# --json учитываем заранее, чтобы ошибки разбора аргументов тоже выводились в JSON.
for _a in "$@"; do [[ "$_a" == "--json" ]] && JSON=1; done

while (($#)); do
    case "$1" in
        --name)
            if (($# < 2)) || [[ "${2-}" == -* ]]; then
                fail 64 "invalid_args" "--name требует значение"
            fi
            NAME="$2"; shift 2 ;;
        --ip)
            if (($# < 2)) || [[ "${2-}" == -* ]]; then
                fail 64 "invalid_args" "--ip требует значение"
            fi
            IP="$2"; shift 2 ;;
        --list|-l) LIST=1; shift ;;
        --json) JSON=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) fail 64 "invalid_args" "неизвестный аргумент: $1" ;;
    esac
done

if [[ "$LIST" == "1" ]]; then
    if [[ -n "$NAME" || -n "$IP" ]]; then
        fail 64 "invalid_args" "--list нельзя сочетать с --name/--ip"
    fi
    wgcfg_print_list "$JSON" || fail 1 "config_not_readable" "не удаётся прочитать $SERVER_CONFIG (нужен root?)"
    exit 0
fi

if [[ -z "$NAME" ]]; then
    fail 64 "invalid_args" "не указан --name"
fi

wgcfg_init || fail 1 "init"
wgcfg_lock || fail 1 "lock"
trap 'wgcfg_unlock' EXIT

OUT=$(wgcfg_create "$NAME" "$IP")
RC=$?

if [[ "$RC" -ne 0 ]]; then
    case "$RC" in
        2) fail 2 "invalid_name" "недопустимое имя или IP (имя: [A-Za-z0-9._-], 1..64, не с '.')" ;;
        3) fail 3 "client_exists" "клиент '$NAME' уже существует (список: --list)" ;;
        4) fail 4 "no_free_ip" "нет свободного IP или указанный IP занят (список: --list)" ;;
        5) fail 5 "reload_failed" "клиент создан, но перезагрузка WireGuard не удалась" ;;
        *) fail 1 "internal" ;;
    esac
fi

# Разбор "key=value" из stdout wgcfg_create, поле config — путь к файлу.
# Многострочное значение обрабатывается sed'ом (берём всё после 'config=').
C_NAME=$(printf '%s\n' "$OUT" | grep '^name='   | head -n1 | cut -d= -f2-)
C_IP=$(printf '%s\n'   "$OUT" | grep '^ip='     | head -n1 | cut -d= -f2-)
C_CONF=$(printf '%s\n' "$OUT" | sed -n 's/^config=//p')

if [[ -z "$C_NAME" || -z "$C_IP" || -z "$C_CONF" ]]; then
    fail 1 "internal"
fi

if [[ "$JSON" == "1" ]]; then
    printf '{"ok":true,"name":"%s","ip":"%s","config":"%s"}\n' \
        "$(_json_escape "$C_NAME")" \
        "$(_json_escape "$C_IP")" \
        "$(_json_escape "$C_CONF")"
else
    echo "OK: Created $C_NAME ($C_IP)"
    echo "Config: $C_CONF"
fi
exit 0
