#!/bin/bash
# Файл: /opt/wg-watch/scripts/create-client.sh
# CLI-обёртка создания клиента WireGuard через lib/wg-clients.sh: разбор --name/--ip/--json, проверка аргументов, вызов wgcfg_init/wgcfg_lock/wgcfg_create с освобождением блокировки по trap EXIT.
# Коды возврата wgcfg_create мапятся в error-коды (invalid_name, client_exists, no_free_ip, reload_failed, internal); при --json печатает JSON, иначе строку OK.
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

fail() {
    local code="$1" err="$2"
    if [[ "$JSON" == "1" ]]; then
        printf '{"ok":false,"error":"%s"}\n' "$(_json_escape "$err")"
    else
        echo "ERROR: $err" >&2
    fi
    exit "$code"
}

while (($#)); do
    case "$1" in
        --name)
            if (($# < 2)) || [[ "${2-}" == -* ]]; then
                fail 64 "invalid_args"
            fi
            NAME="$2"; shift 2 ;;
        --ip)
            if (($# < 2)) || [[ "${2-}" == -* ]]; then
                fail 64 "invalid_args"
            fi
            IP="$2"; shift 2 ;;
        --json) JSON=1; shift ;;
        *) fail 64 "invalid_args" ;;
    esac
done

if [[ -z "$NAME" ]]; then
    fail 64 "invalid_args"
fi

wgcfg_init || fail 1 "init"
wgcfg_lock || fail 1 "lock"
trap 'wgcfg_unlock' EXIT

OUT=$(wgcfg_create "$NAME" "$IP")
RC=$?

if [[ "$RC" -ne 0 ]]; then
    case "$RC" in
        2) fail 2 "invalid_name" ;;
        3) fail 3 "client_exists" ;;
        4) fail 4 "no_free_ip" ;;
        5) fail 5 "reload_failed" ;;
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
fi
exit 0
