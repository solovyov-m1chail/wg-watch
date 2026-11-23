#!/bin/bash
# Файл: /opt/wg-watch/scripts/delete-client.sh
# CLI-обёртка удаления клиента WireGuard с выводом результата в формате JSON.
# Подключает lib/wg-clients.sh (путь через WG_WATCH_LIB, по умолчанию /opt/wg-watch/lib/wg-clients.sh), разбирает --name/--json.
# Вызывает wgcfg_init/wgcfg_lock/wgcfg_delete с освобождением блокировки по trap EXIT; коды wgcfg_delete мапятся в error-коды (invalid_name, client_not_found, reload_failed, internal).
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

wgcfg_delete "$NAME"
RC=$?

if [[ "$RC" -ne 0 ]]; then
    case "$RC" in
        2) fail 2 "invalid_name" ;;
        3) fail 3 "client_not_found" ;;
        5) fail 5 "reload_failed" ;;
        *) fail 1 "internal" ;;
    esac
fi

if [[ "$JSON" == "1" ]]; then
    printf '{"ok":true,"name":"%s"}\n' "$(_json_escape "$NAME")"
else
    echo "OK: Deleted $NAME"
fi
exit 0
