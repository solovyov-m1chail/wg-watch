#!/bin/bash
# Файл: /opt/wg-watch/scripts/download-client-config.sh
# CLI-обёртка выдачи готового .conf-файла клиента WireGuard в виде текста или JSON.
# Подключает lib/wg-clients.sh (путь через WG_WATCH_LIB, по умолчанию /opt/wg-watch/lib/wg-clients.sh).
# Разбор --name/--list/--json/--help; значения, начинающиеся с '-', запрещены (иначе '--name --json' сломал бы разбор).
# При ошибке аргументов (не-JSON режим) печатает причину и подсказку по использованию; --help/-h — справка, --list/-l — список существующих клиентов.
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
LIST=0

usage() {
    local me
    me=$(basename "$0")
    cat <<EOF
Выдача .conf-файла клиента WireGuard.

Использование:
  $me --name ИМЯ [--json]
  $me --list [--json]
  $me --help

Параметры:
  --name ИМЯ   имя клиента, чей конфиг нужно вывести
  --list, -l   показать список существующих клиентов и выйти
  --json       вывод в формате JSON: {"ok":true,"content":"..."}
  --help, -h   эта справка

Примеры:
  $me --list
  $me --name ivanov
  $me --name ivanov > ivanov.conf

Коды возврата:
  0 успех | 2 invalid_name | 3 client_not_found / not_found
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

# Разбор аргументов: значения, начинающиеся с '-', запрещены, иначе '--name --json' присвоил бы NAME="--json" и сломал разбор.
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

wgcfg_validate_name "$NAME" || fail 2 "invalid_name" "недопустимое имя (допустимо: [A-Za-z0-9._-], 1..64, не с '.')"
wgcfg_client_exists "$NAME" || fail 3 "client_not_found" "клиент '$NAME' не найден (список: --list)"

CONFIG_PATH="$CLIENTS_DIR/$NAME/wg-$NAME.conf"

if [[ ! -f "$CONFIG_PATH" ]]; then
    fail 3 "not_found" "файл конфигурации не найден: $CONFIG_PATH"
fi

if [[ "$JSON" == "1" ]]; then
    # Читаем файл целиком; _json_escape безопасно преобразует \n, \r, \t, ", \. Хвостовой перевод строки из $(...) срезается — для wg-quick это допустимо.
    CONTENT=$(< "$CONFIG_PATH")
    printf '{"ok":true,"content":"%s"}\n' "$(_json_escape "$CONTENT")"
else
    cat "$CONFIG_PATH"
fi
exit 0
