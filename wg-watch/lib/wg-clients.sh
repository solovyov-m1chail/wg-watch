#!/bin/bash
# Файл: /opt/wg-watch/lib/wg-clients.sh
# Общая библиотека управления клиентами WireGuard.
# Подсеть клиентов настраивается через env: CLIENT_SUBNET_PREFIX, CLIENT_IP_MIN,
# CLIENT_IP_MAX, SERVER_IP_LAST_OCTET.
# Не использует set -e: решение об обработке ошибок остаётся за вызывающим кодом.
set -u
set -o pipefail
umask 027

CONF_FILE="${WG_CLIENTS_ENV:-/opt/wg-watch/conf/wg-clients.env}"
if [[ -f "$CONF_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$CONF_FILE"
fi

export SERVER_CONFIG="${SERVER_CONFIG:-/etc/wireguard/wg0.conf}"
export CLIENTS_DIR="${CLIENTS_DIR:-/etc/wireguard/clients}"
export SERVER_PUBLIC_KEY_FILE="${SERVER_PUBLIC_KEY_FILE:-/etc/wireguard/SRV-Depo-public.key}"
export WG_IFACE="${WG_IFACE:-wg0}"
export LOCK_FILE="${LOCK_FILE:-/run/wg-watch/clients.lock}"
export EVENTS_FILE="${EVENTS_FILE:-/opt/wg-watch/logs/events.log}"
export DNS="${DNS:-10.10.10.1}"
export ALLOWED_IPS="${ALLOWED_IPS:-10.10.10.0/24, 192.168.0.200/32}"
export SERVER_ENDPOINT="${SERVER_ENDPOINT:-}"
export CLIENT_SUBNET_PREFIX="${CLIENT_SUBNET_PREFIX:-10.10.10}"
export CLIENT_IP_MIN="${CLIENT_IP_MIN:-2}"
export CLIENT_IP_MAX="${CLIENT_IP_MAX:-254}"
export SERVER_IP_LAST_OCTET="${SERVER_IP_LAST_OCTET:-1}"
export CLIENT_MAIL_ENABLED="${CLIENT_MAIL_ENABLED:-NO}"
export CLIENT_MAIL_TO="${CLIENT_MAIL_TO:-}"
export CLIENT_MAIL_FROM="${CLIENT_MAIL_FROM:-root}"
export CLIENT_MAIL_SMTP_HOST="${CLIENT_MAIL_SMTP_HOST:-}"
export CLIENT_MAIL_SMTP_PORT="${CLIENT_MAIL_SMTP_PORT:-25}"

log_err() {
    echo "ERROR: $*" >&2
}

# Экранирует строку для безопасной вставки в JSON-строку.
_json_escape() {
    local s="$1"
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//$'\n'/\\n}
    s=${s//$'\r'/\\r}
    s=${s//$'\t'/\\t}
    printf '%s' "$s"
}

# Записывает JSON-событие в events.log под flock.
wgcfg_log_event() {
    local type="$1" name="$2" kind="$3" extra="${4:-}"

    mkdir -p "$(dirname "$EVENTS_FILE")"

    local ts safe_name safe_extra json
    ts=$(date -Iseconds)
    safe_name=$(_json_escape "$name")
    safe_extra=$(_json_escape "$extra")

    json=$(printf '{"ts":"%s","type":"%s","pk":"","name":"%s","endpoint":"","rx":0,"tx":0,"kind":"%s","extra":"%s","msg":""}' \
        "$ts" "$type" "$safe_name" "$kind" "$safe_extra")

    (
        flock -x 200
        echo "$json" >> "$EVENTS_FILE"
    ) 200>"${EVENTS_FILE}.lock" 2>/dev/null || true
}

# Проверяет корректность CLIENT_SUBNET_PREFIX: три октета 0..255, без завершающей точки.
_wgcfg_validate_subnet_prefix() {
    local p="$1"
    [[ "$p" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
    local a=$((10#${BASH_REMATCH[1]}))
    local b=$((10#${BASH_REMATCH[2]}))
    local c=$((10#${BASH_REMATCH[3]}))
    (( a <= 255 && b <= 255 && c <= 255 )) || return 1
    return 0
}

# Проверяет окружение и базовые требования.
wgcfg_init() {
    [[ $EUID -eq 0 ]] || { log_err "must be run as root"; return 1; }
    command -v wg >/dev/null 2>&1 || { log_err "wg not found"; return 1; }
    [[ -f "$SERVER_CONFIG" ]] || { log_err "missing $SERVER_CONFIG"; return 1; }
    [[ -f "$SERVER_PUBLIC_KEY_FILE" ]] || { log_err "missing $SERVER_PUBLIC_KEY_FILE"; return 1; }
    [[ -n "$SERVER_ENDPOINT" ]] || { log_err "SERVER_ENDPOINT is not set"; return 1; }

    _wgcfg_validate_subnet_prefix "$CLIENT_SUBNET_PREFIX" \
        || { log_err "invalid CLIENT_SUBNET_PREFIX: $CLIENT_SUBNET_PREFIX"; return 1; }

    [[ "$CLIENT_IP_MIN" =~ ^[0-9]+$ && "$CLIENT_IP_MAX" =~ ^[0-9]+$ ]] \
        || { log_err "CLIENT_IP_MIN/MAX must be numeric"; return 1; }
    (( CLIENT_IP_MIN >= 1 && CLIENT_IP_MAX <= 254 && CLIENT_IP_MIN <= CLIENT_IP_MAX )) \
        || { log_err "invalid CLIENT_IP_MIN/MAX range: $CLIENT_IP_MIN..$CLIENT_IP_MAX"; return 1; }
    [[ "$SERVER_IP_LAST_OCTET" =~ ^[0-9]+$ ]] \
        || { log_err "SERVER_IP_LAST_OCTET must be numeric"; return 1; }

    mkdir -p "$CLIENTS_DIR"
    mkdir -p "$(dirname "$LOCK_FILE")"
    return 0
}

# Захватывает эксклюзивную блокировку на LOCK_FILE (FD 9).
wgcfg_lock() {
    exec 9>"$LOCK_FILE" || return 1
    if ! flock -w 20 9; then
        log_err "lock timeout"
        return 1
    fi
    return 0
}

wgcfg_unlock() {
    flock -u 9 2>/dev/null || true
    exec 9>&- 2>/dev/null || true
}

wgcfg_validate_name() {
    [[ "$1" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || return 2
    [[ "$1" == "." || "$1" == ".." ]] && return 2
    [[ "$1" == .* ]] && return 2
    return 0
}

# Проверяет IP клиента: должен быть внутри CLIENT_SUBNET_PREFIX, октет в [MIN..MAX]
# и не совпадать с адресом сервера.
wgcfg_validate_ip() {
    local ip="$1" last
    local pfx_re="${CLIENT_SUBNET_PREFIX//./\\.}"
    [[ "$ip" =~ ^${pfx_re}\.([0-9]{1,3})$ ]] || return 1
    last=$((10#${BASH_REMATCH[1]}))
    (( last >= CLIENT_IP_MIN && last <= CLIENT_IP_MAX )) || return 1
    (( last != SERVER_IP_LAST_OCTET )) || return 1
    return 0
}

wgcfg_client_exists() {
    grep -qxF "# Client $1" "$SERVER_CONFIG"
}

# Находит свободный IP в подсети CLIENT_SUBNET_PREFIX.
wgcfg_find_free_ip() {
    local used next line
    local -A taken=()
    local pfx_re="${CLIENT_SUBNET_PREFIX//./\\.}"

    while IFS= read -r line; do
        if [[ "$line" =~ ^AllowedIPs[[:space:]]*=[[:space:]]*${pfx_re}\.([0-9]{1,3})/32 ]]; then
            used=$((10#${BASH_REMATCH[1]}))
            taken[$used]=1
        fi
    done < "$SERVER_CONFIG"

    for (( next=CLIENT_IP_MIN; next<=CLIENT_IP_MAX; next++ )); do
        [[ -n "${taken[$next]:-}" ]] && continue
        [[ "$next" -eq "$SERVER_IP_LAST_OCTET" ]] && continue
        echo "${CLIENT_SUBNET_PREFIX}.$next"
        return 0
    done
    return 4
}

# Перезагружает WireGuard с приоритетом: wg syncconf → systemctl → wg-quick.
wgcfg_reload() {
    local strip_tmp rc=0
    strip_tmp=$(mktemp /tmp/wg-strip.XXXXXX) || return 5

    if ! wg-quick strip "$SERVER_CONFIG" > "$strip_tmp" 2>/dev/null; then
        rm -f "$strip_tmp"
        log_err "wg-quick strip failed for $SERVER_CONFIG"
        return 5
    fi

    if systemctl is-active --quiet "wg-quick@$WG_IFACE" 2>/dev/null; then
        if wg syncconf "$WG_IFACE" "$strip_tmp" >/dev/null 2>&1; then
            rm -f "$strip_tmp"
            return 0
        fi
        if systemctl restart "wg-quick@$WG_IFACE" >/dev/null 2>&1; then
            rm -f "$strip_tmp"
            return 0
        fi
    else
        if systemctl start "wg-quick@$WG_IFACE" >/dev/null 2>&1; then
            rm -f "$strip_tmp"
            return 0
        fi
    fi

    if ip link show "$WG_IFACE" >/dev/null 2>&1; then
        wg syncconf "$WG_IFACE" "$strip_tmp" >/dev/null 2>&1 && rc=0 || rc=5
    else
        wg-quick up "$WG_IFACE" >/dev/null 2>&1 && rc=0 || rc=5
    fi

    rm -f "$strip_tmp"
    if [[ "$rc" -ne 0 ]]; then
        log_err "wg reload failed for interface $WG_IFACE"
    fi
    return "$rc"
}

wgcfg_send_email() {
    local subject="$1" body="$2" attach_file="${3:-}"

    if [[ "${CLIENT_MAIL_ENABLED:-NO}" != "YES" ]]; then
        return 0
    fi

    local target_email="${CLIENT_MAIL_TO:-}"
    if [[ -z "$target_email" ]]; then
        log_err "mail enabled, but CLIENT_MAIL_TO is empty; skipping"
        return 0
    fi

    local -a mail_cmd=(timeout 30 mail)
    if [[ -n "${CLIENT_MAIL_SMTP_HOST:-}" ]]; then
        mail_cmd+=(-E "set sendmail=smtp://${CLIENT_MAIL_SMTP_HOST}:${CLIENT_MAIL_SMTP_PORT:-25}")
    fi

    local -a attach_arg=()
    if [[ -n "$attach_file" && -f "$attach_file" ]]; then
        attach_arg=(-A "$attach_file")
    fi

    (
        if printf '%s\n' "$body" | "${mail_cmd[@]}" \
                -a "From: ${CLIENT_MAIL_FROM:-root}" \
                -a "Content-Type: text/plain; charset=utf-8" \
                -a "Content-Transfer-Encoding: 8bit" \
                "${attach_arg[@]}" \
                -s "$subject" \
                "$target_email" >/dev/null 2>&1; then
            logger -t wg-watch -- "email sent: $subject" 2>/dev/null || true
        else
            logger -t wg-watch -- "failed to send email: $subject" 2>/dev/null || true
        fi
    ) >/dev/null 2>&1 </dev/null &
}

# Создаёт клиента: ключи, блок пира в конфиге сервера, .conf, письмо и событие.
wgcfg_create() {
    local name="$1" ip="${2:-}" dir tmp conf
    wgcfg_validate_name "$name" || return 2
    wgcfg_client_exists "$name" && return 3

    if [[ -n "$ip" ]]; then
        wgcfg_validate_ip "$ip" || { log_err "invalid ip: $ip"; return 2; }
        local ip_re="${ip//./\\.}"
        if grep -qE "^AllowedIPs[[:space:]]*=[[:space:]]*${ip_re}/32" "$SERVER_CONFIG"; then
            log_err "IP $ip is already in use"
            return 4
        fi
    else
        ip=$(wgcfg_find_free_ip) || {
            log_err "no free IP in ${CLIENT_SUBNET_PREFIX}.0/24 (range ${CLIENT_IP_MIN}..${CLIENT_IP_MAX})"
            return 4
        }
    fi

    dir="$CLIENTS_DIR/$name"
    mkdir -p "$dir" || return 1

    ( umask 077; wg genkey > "$dir/private.key" ) 2>/dev/null || return 1
    chmod 600 "$dir/private.key"
    ( umask 077; wg pubkey < "$dir/private.key" > "$dir/public.key" ) 2>/dev/null || return 1
    chmod 600 "$dir/public.key"
    ( umask 077; wg genpsk > "$dir/preshared.key" ) 2>/dev/null || return 1
    chmod 600 "$dir/preshared.key"

    local pub psk priv srv
    pub=$(cat "$dir/public.key")
    psk=$(cat "$dir/preshared.key")
    priv=$(cat "$dir/private.key")
    srv=$(cat "$SERVER_PUBLIC_KEY_FILE")

    tmp=$(mktemp "$SERVER_CONFIG.XXXXXX") || return 1

    cat -s "$SERVER_CONFIG" | awk '
        { lines[NR] = $0 }
        END {
            last = NR
            while (last > 0 && lines[last] ~ /^[[:space:]]*$/) last--
            for (i = 1; i <= last; i++) print lines[i]
        }
    ' > "$tmp" || { rm -f "$tmp"; log_err "failed to normalize $SERVER_CONFIG"; return 1; }

    if ! grep -q '^\[Interface\]' "$tmp"; then
        rm -f "$tmp"
        log_err "source config has no [Interface], refusing to overwrite"
        return 1
    fi

    if [[ -s "$tmp" && "$(tail -c 1 "$tmp")" != $'\n' ]]; then
        echo "" >> "$tmp"
    fi

    cat >> "$tmp" <<EOF
# Client $name
[Peer]
PublicKey = $pub
PresharedKey = $psk
AllowedIPs = $ip/32
EOF

    chown --reference="$SERVER_CONFIG" "$tmp" 2>/dev/null || true
    chmod --reference="$SERVER_CONFIG" "$tmp" 2>/dev/null || true

    if ! mv "$tmp" "$SERVER_CONFIG"; then
        rm -f "$tmp"
        return 1
    fi

    conf="$dir/wg-$name.conf"
    ( umask 077; cat > "$conf" ) <<EOF
[Interface]
Address = $ip/32
DNS = $DNS
PrivateKey = $priv

[Peer]
AllowedIPs = $ALLOWED_IPS
Endpoint = $SERVER_ENDPOINT
PublicKey = $srv
PresharedKey = $psk
PersistentKeepalive = 20
EOF
    chmod 600 "$conf"

    wgcfg_reload || return 5

    local email_body="Hello,

The WireGuard configuration for client \"$name\" has been successfully created.

Client name: $name
Internal IP: $ip

The ready-to-use configuration file is attached to this email.
You can import it into the WireGuard app or copy it to /etc/wireguard/.

--
Automated message from wg-watch."

    wgcfg_send_email "[WG] Client created: $name" "$email_body" "$conf"

    wgcfg_log_event "client" "$name" "client_created" "IP: $ip"

    printf 'name=%s\nip=%s\nconfig=%s\n' "$name" "$ip" "$conf"
    return 0
}

# Удаляет клиента: блок в конфиге сервера, каталог, письмо и событие.
wgcfg_delete() {
    local name="$1" dir tmp step1
    wgcfg_validate_name "$name" || return 2
    wgcfg_client_exists "$name" || return 3

    tmp=$(mktemp "$SERVER_CONFIG.XXXXXX") || return 1
    step1="${tmp}.step1"

    if ! awk -v name="$name" '
            BEGIN { skip = 0 }
            $0 == "# Client " name { skip = 1; next }
            skip && /^# Client / { skip = 0 }
            skip && /^$/ { skip = 0; next }
            !skip { print }
        ' "$SERVER_CONFIG" > "$step1"; then
        rm -f "$tmp" "$step1"
        log_err "awk failed while stripping peer block"
        return 1
    fi

    if ! awk '
            { lines[NR] = $0 }
            END {
                last = NR
                while (last > 0 && lines[last] ~ /^[[:space:]]*$/) last--
                for (i = 1; i <= last; i++) {
                    if (i > 1 && lines[i] ~ /^[[:space:]]*$/ && lines[i-1] ~ /^[[:space:]]*$/) continue
                    print lines[i]
                }
            }
        ' "$step1" > "$tmp"; then
        rm -f "$tmp" "$step1"
        log_err "awk failed while normalizing config"
        return 1
    fi
    rm -f "$step1"

    if ! grep -q '^\[Interface\]' "$tmp"; then
        rm -f "$tmp"
        log_err "post-edit config has no [Interface], refusing to overwrite"
        return 1
    fi

    chown --reference="$SERVER_CONFIG" "$tmp" 2>/dev/null || true
    chmod --reference="$SERVER_CONFIG" "$tmp" 2>/dev/null || true

    if ! mv "$tmp" "$SERVER_CONFIG"; then
        rm -f "$tmp"
        return 1
    fi

    dir="$CLIENTS_DIR/$name"
    if [[ -n "$CLIENTS_DIR" && "$dir" == "$CLIENTS_DIR"/* && -d "$dir" ]]; then
        rm -rf -- "$dir"
    fi

    wgcfg_reload || return 5

    local email_body="Hello,

The WireGuard client \"$name\" has been successfully deleted.

--
Automated message from wg-watch."

    wgcfg_send_email "[WG] Client deleted: $name" "$email_body"

    wgcfg_log_event "client" "$name" "client_deleted" ""

    return 0
}
