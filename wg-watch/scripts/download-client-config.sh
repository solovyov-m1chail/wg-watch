#!/bin/bash
# Файл: /opt/wg-watch/scripts/download-client-config.sh
# CLI-обёртка выдачи готового .conf-файла клиента WireGuard в виде текста или JSON.
# Подключает lib/wg-clients.sh (путь через WG_WATCH_LIB, по умолчанию /opt/wg-watch/lib/wg-clients.sh).
# Разбор --name/--json; значения, начинающиеся с '-', запрещены (иначе '--name --json' сломал бы разбор).
# Проверяет имя (wgcfg_validate_name) и наличие клиента в конфиге (wgcfg_client_exists), затем читает $CLIENTS_DIR/$NAME/wg-$NAME.conf.
# Формат успеха в JSON-режиме (--json): {"ok":true,"content":"<содержимое>"}; без --json — отдаёт файл как есть (cat).
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

# Разбор аргументов: значения, начинающиеся с '-', запрещены, иначе '--name --json' присвоил бы NAME="--json" и сломал разбор.
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

wgcfg_validate_name "$NAME" || fail 2 "invalid_name"
wgcfg_client_exists "$NAME" || fail 3 "client_not_found"

CONFIG_PATH="$CLIENTS_DIR/$NAME/wg-$NAME.conf"

if [[ ! -f "$CONFIG_PATH" ]]; then
    fail 3 "not_found"
fi

if [[ "$JSON" == "1" ]]; then
    # Читаем файл целиком; _json_escape безопасно преобразует \n, \r, \t, ", \. Хвостовой перевод строки из $(...) срезается — для wg-quick это допустимо.
    CONTENT=$(< "$CONFIG_PATH")
    printf '{"ok":true,"content":"%s"}\n' "$(_json_escape "$CONTENT")"
else
    cat "$CONFIG_PATH"
fi
exit 0
