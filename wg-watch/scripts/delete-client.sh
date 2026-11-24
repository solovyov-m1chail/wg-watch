#!/bin/bash
# Файл: /opt/wg-watch/scripts/delete-client.sh
# CLI-обёртка удаления клиента WireGuard с выводом результата в формате JSON.
# Подключает lib/wg-clients.sh (путь через WG_WATCH_LIB, по умолчанию /opt/wg-watch/lib/wg-clients.sh), разбирает --name/--list/--json/--help.
# Вызывает wgcfg_init/wgcfg_lock/wgcfg_delete с освобождением блокировки по trap EXIT; коды wgcfg_delete мапятся в error-коды (invalid_name, client_not_found, reload_failed, internal).
# При ошибке аргументов (не-JSON режим) печатает причину и подсказку по использованию; --help/-h — справка, --list/-l — список существующих клиентов.
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
LIST=0

usage() {
    local me
    me=$(basename "$0")
    cat <<EOF
Удаление клиента WireGuard.

Использование:
  $me --name ИМЯ [--json]
  $me --list [--json]
  $me --help

Параметры:
  --name ИМЯ   имя удаляемого клиента
  --list, -l   показать список существующих клиентов и выйти
  --json       вывод в формате JSON
  --help, -h   эта справка

Примеры:
  $me --list
  $me --name ivanov
  $me --name ivanov --json

Коды возврата:
  0 успех | 2 invalid_name | 3 client_not_found | 5 reload_failed
  64 invalid_args | 1 прочие ошибки
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
        --list|-l) LIST=1; shift ;;
        --json) JSON=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) fail 64 "invalid_args" "неизвестный аргумент: $1" ;;
    esac
done

if [[ "$LIST" == "1" ]]; then
    if [[ -n "$NAME" ]]; then
        fail 64 "invalid_args" "--list нельзя сочетать с --name"
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

wgcfg_delete "$NAME"
RC=$?

if [[ "$RC" -ne 0 ]]; then
    case "$RC" in
        2) fail 2 "invalid_name" "недопустимое имя (допустимо: [A-Za-z0-9._-], 1..64, не с '.')" ;;
        3) fail 3 "client_not_found" "клиент '$NAME' не найден (список: --list)" ;;
        5) fail 5 "reload_failed" "клиент удалён, но перезагрузка WireGuard не удалась" ;;
        *) fail 1 "internal" ;;
    esac
fi

if [[ "$JSON" == "1" ]]; then
    printf '{"ok":true,"name":"%s"}\n' "$(_json_escape "$NAME")"
else
    echo "OK: Deleted $NAME"
fi
exit 0
