// Файл: /opt/wg-watch/src/daemon/wg-watch-daemon.go
// Демон мониторинга wg-watch: опрос пиров WireGuard, ведение events.log, уведомления онлайн/оффлайн, /api/state, /api/traffic и /api/events/clear для веб-дашборда.
// Запускается от root и блокируется через flock и pid-файл в PID_DIR.
// /api/* защищены общим секретом DAEMON_TOKEN (заголовок X-Daemon-Token), сравнение constant-time; секрет общий с Flask.
// Длина DAEMON_TOKEN проверяется на старте (TOKEN_MIN_LEN, по умолчанию 32).
// Периодичность опроса задаётся INTERVAL (секунды); первый проход выполняется сразу при старте (не ждёт INTERVAL), чтобы дашборд получал данные без задержки.
// OFFLINE_CONFIRM тоже в секундах: сколько должно пройти с последнего онлайн-наблюдения, чтобы демон отправил OFFLINE.
// История трафика: короткое окно TRAFFIC_WINDOW для спарклайнов и длинная история TRAFFIC_HISTORY для большого графика; точки [время, rx, tx], шум < 1 КБ/с не пишется.
// Опционально история сохраняется в TRAFFIC_FILE (атомарная запись, период TRAFFIC_SAVE_INTERVAL) и восстанавливается при старте.
// events.log ротируется по размеру (EVENTS_MAX_LINES / EVENTS_KEEP_LINES) и по возрасту (EVENTS_RETENTION_DAYS, периодически раз в EVENTS_TRIM_INTERVAL).
// При отключении клиента событие session в events.log содержит длительность (extra) и трафик за сессию (srx/stx, байты); у старых записей этих полей нет.
// fsnotify на CLIENTS_DIR: при удалении клиента пир снимается из памяти, отправляется OFFLINE и сбрасывается кэш имён.
// Политики (необязательно, POLICY_FILE — абсолютный путь к policy.conf): при подключении первого и отключении последнего пира политики демон выполняет
// команды администратора (online_to_run_command / offline_to_run_command через sh -c, с таймаутом и переменными WG_POLICY, WG_EVENT, WG_PEER_NAME,
// WG_PEER_IP, WG_PEER_PUBKEY). Поддержаны offline_delay, online_skip_if, offline_only_if_online_ran, enabled; состояние хранится в LOG_DIR/policy.state.
// policy.conf должен принадлежать root и не быть доступным на запись группе/всем, иначе не загружается; перечитывается по SIGHUP.
// Политики — внутренний механизм: в /api/* и events.log не попадают. События политик пишутся в отдельный журнал POLICY_LOG_FILE (ротация — logrotate),
// а в общий лог демона — только служебные сообщения загрузки (префикс POLICY:). Без POLICY_FILE функция выключена.
// Коды выхода: 0 — норма, 1 — ошибка, 78 (EX_CONFIG) — ошибка конфигурации; systemd с RestartPreventExitStatus=78 не рестартит сервис в цикле.
// Опрос интерфейса идёт через generic netlink
// (golang.zx2c4.com/wireguard/wgctrl), без exec-вызова wg/awg и без парсинга
// текстового dump. Поведение при ошибках/восстановлении, формат /api/state и
// /api/traffic, логика уведомлений и событий — идентичны прежней exec-версии.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"github.com/fsnotify/fsnotify"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"
	"golang.zx2c4.com/wireguard/wgctrl"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// ═══════════════════════════════════════════════════════════════════════
// 1. КОНСТАНТЫ
// ═══════════════════════════════════════════════════════════════════════

// ─── Коды выхода ──────────────────────────────────────────────────────
// EX_CONFIG: systemd с RestartPreventExitStatus=78 не рестартит.
// eventsScanMax — 1 MiB (максимальный размер строки events.log при чтении).
const (
	exitOK         = 0
	exitErr        = 1
	exitConfig     = 78
	wgErrMsgMaxLen = 500
	eventsScanMax  = 1 << 20

	// Ограничения API чтения журнала: максимум строк за запрос и максимальная длина одной строки.
	eventsAPIMaxLimit = 5000
	eventsMaxLineBytes = 64 * 1024
)

// ─── daemonToken ──────────────────────────────────────────────────────
// Общий секрет с Flask, заполняется в loadConfig().
var daemonToken string

// ═══════════════════════════════════════════════════════════════════════
// 2. КОНФИГУРАЦИЯ
// ═══════════════════════════════════════════════════════════════════════

// ─── Структура Config ─────────────────────────────────────────────────
type Config struct {
	WgIface     string
	MailTo      string
	MailFrom    string
	MailEnabled string
	// Секунды между опросами wg show.
	Interval      int
	PeerTimeout   int
	ObserveWindow int
	// Секунды без рукопожатия, после которых фронт прячет адрес и активность пира (необязательная, по умолчанию 3600).
	StaleTimeout int
	// Файл для сохранения истории трафика между перезапусками (необязательный; пусто — история не сохраняется).
	TrafficFile string
	// Как часто (сек) сохранять историю на диск, если в ней были изменения (по умолчанию 300, минимум 30).
	TrafficSaveInterval int
	// Секунды с последнего online до отправки OFFLINE.
	OfflineConfirm       int
	Cooldown             int
	SameEndpointCooldown int
	PidDir               string
	ClientsDir           string
	LogDir               string
	LogFile              string
	EventsFile           string
	EventsRetentionDays  int
	EventsTrimInterval   int
	MailSMTPHost         string
	MailSMTPPort         int
	MailSMTPURL          string
	DaemonHost           string
	DaemonPort           string
	TrafficWindow        int
	TrafficTimeout       int
	TrafficHistory       int
	EventsMaxLines       int
	EventsKeepLines      int
	MailQueueSize        int
	// MAIL_RETRIES (необязательная, по умолчанию 10): число попыток отправки одного письма.
	MailRetries int
	// MAIL_RETRY_DELAY (необязательная, по умолчанию 5): базовая пауза между попытками, сек; растёт линейно (N×база).
	MailRetryDelay int
	// MAIL_RETRY_MAX_DELAY (необязательная, по умолчанию 60): верхняя граница паузы между попытками, сек.
	MailRetryMaxDelay int
	// POLICY_FILE (необязательная): абсолютный путь к policy.conf; не задана — политики выключены.
	PolicyFile string
	// POLICY_LOG_FILE (необязательная): отдельный журнал событий политик; ротацию делает logrotate. Не задана — события идут в общий лог демона.
	PolicyLogFile string
}

// ─── Обязательные переменные ──────────────────────────────────────────
var requiredVars = []string{
	"WG_IFACE", "MAIL_TO", "MAIL_FROM", "MAIL_ENABLED", "INTERVAL", "PEER_TIMEOUT",
	"OBSERVE_WINDOW", "OFFLINE_CONFIRM", "COOLDOWN", "SAME_ENDPOINT_COOLDOWN",
	"PID_DIR", "CLIENTS_DIR", "LOG_DIR", "LOG_FILE", "EVENTS_FILE",
	"EVENTS_RETENTION_DAYS", "EVENTS_TRIM_INTERVAL",
	"TRAFFIC_WINDOW", "TRAFFIC_TIMEOUT", "EVENTS_MAX_LINES", "EVENTS_KEEP_LINES", "MAIL_QUEUE_SIZE",
	"DAEMON_TOKEN",
}

// ─── Валидация чисел ──────────────────────────────────────────────────
func mustInt(name string) int {
	v := os.Getenv(name)
	if v == "" {
		fmt.Fprintf(os.Stderr, "err: %s\n", name)
		os.Exit(exitConfig)
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		fmt.Fprintf(os.Stderr, "err: %s\n", name)
		os.Exit(exitConfig)
	}
	return n
}

// ─── optIntMin ────────────────────────────────────────────────────────
// Необязательная числовая переменная: не задана — def; задана — должна быть >= min.
func optIntMin(name string, def, min int) int {
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < min {
		fmt.Fprintf(os.Stderr, "err: %s (min %d)\n", name, min)
		os.Exit(exitConfig)
	}
	return n
}

func mustIntMin(name string, min int) int {
	n := mustInt(name)
	if n < min {
		fmt.Fprintf(os.Stderr, "err: %s (min %d)\n", name, min)
		os.Exit(exitConfig)
	}
	return n
}

// ─── Вспомогательные функции ──────────────────────────────────────────
func sanitizeHeader(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\n", "")
	return s
}

// truncateUTF8 обрезает строку до max байт по границе руны.
func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// ─── Загрузка конфигурации ────────────────────────────────────────────
func loadConfig() *Config {
	var missing []string
	for _, v := range requiredVars {
		if os.Getenv(v) == "" {
			missing = append(missing, v)
		}
	}
	if len(missing) > 0 {
		fmt.Fprintf(os.Stderr, "missing: %s\n", strings.Join(missing, " "))
		os.Exit(exitConfig)
	}

	pidDir := filepath.Clean(os.Getenv("PID_DIR"))
	if pidDir == "/" || pidDir == "." {
		fmt.Fprintln(os.Stderr, "err: PID_DIR")
		os.Exit(exitConfig)
	}

	cfg := &Config{
		WgIface:              os.Getenv("WG_IFACE"),
		MailTo:               sanitizeHeader(os.Getenv("MAIL_TO")),
		MailFrom:             sanitizeHeader(os.Getenv("MAIL_FROM")),
		MailEnabled:          strings.ToUpper(os.Getenv("MAIL_ENABLED")),
		Interval:             mustIntMin("INTERVAL", 1),
		PeerTimeout:          mustIntMin("PEER_TIMEOUT", 1),
		ObserveWindow:        mustInt("OBSERVE_WINDOW"),
		OfflineConfirm:       mustIntMin("OFFLINE_CONFIRM", 1),
		Cooldown:             mustInt("COOLDOWN"),
		SameEndpointCooldown: mustInt("SAME_ENDPOINT_COOLDOWN"),
		PidDir:               pidDir,
		ClientsDir:           os.Getenv("CLIENTS_DIR"),
		LogDir:               os.Getenv("LOG_DIR"),
		LogFile:              os.Getenv("LOG_FILE"),
		EventsFile:           os.Getenv("EVENTS_FILE"),
		EventsRetentionDays:  mustInt("EVENTS_RETENTION_DAYS"),
		EventsTrimInterval:   mustInt("EVENTS_TRIM_INTERVAL"),
		TrafficWindow:        mustIntMin("TRAFFIC_WINDOW", 10),
		TrafficTimeout:       mustIntMin("TRAFFIC_TIMEOUT", 10),
		EventsMaxLines:       mustIntMin("EVENTS_MAX_LINES", 100),
		EventsKeepLines:      mustIntMin("EVENTS_KEEP_LINES", 50),
		MailQueueSize:        mustIntMin("MAIL_QUEUE_SIZE", 1),
		MailRetries:          optIntMin("MAIL_RETRIES", 10, 1),
		MailRetryDelay:       optIntMin("MAIL_RETRY_DELAY", 5, 1),
		MailRetryMaxDelay:    optIntMin("MAIL_RETRY_MAX_DELAY", 60, 1),
	}

	// Согласованность: KEEP должен быть меньше MAX, иначе файл будет перезаписываться на каждое новое событие после достижения лимита.
	if cfg.EventsKeepLines >= cfg.EventsMaxLines {
		fmt.Fprintf(os.Stderr, "err: EVENTS_KEEP_LINES must be < EVENTS_MAX_LINES\n")
		os.Exit(exitConfig)
	}

	// TRAFFIC_HISTORY (необязательная): сколько секунд истории хранить для большого графика.
	// По умолчанию равна TRAFFIC_WINDOW, не может быть меньше окна и больше 7 суток.
	cfg.TrafficHistory = cfg.TrafficWindow
	if os.Getenv("TRAFFIC_HISTORY") != "" {
		cfg.TrafficHistory = mustIntMin("TRAFFIC_HISTORY", cfg.TrafficWindow)
		if cfg.TrafficHistory > 7*24*3600 {
			fmt.Fprintln(os.Stderr, "err: TRAFFIC_HISTORY (max 604800)")
			os.Exit(exitConfig)
		}
	}

	// STALE_TIMEOUT (необязательная): через сколько секунд без рукопожатия дашборд показывает прочерки
	// вместо адреса и времени активности. По умолчанию 3600 (1 час), минимум 60.
	cfg.StaleTimeout = 3600
	if os.Getenv("STALE_TIMEOUT") != "" {
		cfg.StaleTimeout = mustIntMin("STALE_TIMEOUT", 60)
	}

	// TRAFFIC_FILE (необязательная): абсолютный путь к файлу истории трафика. Не задана — сохранение выключено.
	// TRAFFIC_SAVE_INTERVAL (необязательная): период сохранения в секундах, по умолчанию 300, минимум 30.
	cfg.TrafficFile = strings.TrimSpace(os.Getenv("TRAFFIC_FILE"))
	if cfg.TrafficFile != "" && !filepath.IsAbs(cfg.TrafficFile) {
		fmt.Fprintf(os.Stderr, "err: TRAFFIC_FILE must be an absolute path\n")
		os.Exit(exitConfig)
	}
	cfg.PolicyFile = strings.TrimSpace(os.Getenv("POLICY_FILE"))
	if cfg.PolicyFile != "" && !filepath.IsAbs(cfg.PolicyFile) {
		fmt.Fprintf(os.Stderr, "err: POLICY_FILE must be an absolute path\n")
		os.Exit(exitConfig)
	}
	cfg.PolicyLogFile = strings.TrimSpace(os.Getenv("POLICY_LOG_FILE"))
	if cfg.PolicyLogFile != "" {
		if !filepath.IsAbs(cfg.PolicyLogFile) {
			fmt.Fprintf(os.Stderr, "err: POLICY_LOG_FILE must be an absolute path\n")
			os.Exit(exitConfig)
		}
		// Журнал только дописывается и перезаписывается при чистке, поэтому он не должен совпадать с другими файлами демона (особенно с policy.conf).
		lp := filepath.Clean(cfg.PolicyLogFile)
		for _, other := range []string{cfg.PolicyFile, cfg.EventsFile, cfg.LogFile, os.Getenv("TRAFFIC_FILE")} {
			if other != "" && filepath.Clean(other) == lp {
				fmt.Fprintf(os.Stderr, "err: POLICY_LOG_FILE must not be the same file as POLICY_FILE/EVENTS_FILE/LOG_FILE/TRAFFIC_FILE (%s)\n", other)
				os.Exit(exitConfig)
			}
		}
	}
	cfg.TrafficSaveInterval = 300
	if os.Getenv("TRAFFIC_SAVE_INTERVAL") != "" {
		cfg.TrafficSaveInterval = mustIntMin("TRAFFIC_SAVE_INTERVAL", 30)
	}

	daemonToken = os.Getenv("DAEMON_TOKEN")

	// Слишком короткий секрет легко подобрать, поэтому в работу не пускаем.
	// Порог задаётся через TOKEN_MIN_LEN (по умолчанию 32); ниже 16 не имеет смысла.
	tokenMinLen := 32
	if v := os.Getenv("TOKEN_MIN_LEN"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 16 {
			tokenMinLen = n
		}
	}
	if len(daemonToken) < tokenMinLen {
		fmt.Fprintf(os.Stderr, "err: DAEMON_TOKEN is too short (min %d chars)\n", tokenMinLen)
		os.Exit(exitConfig)
	}

	cfg.DaemonHost = os.Getenv("DAEMON_HOST")
	if cfg.DaemonHost == "" {
		cfg.DaemonHost = "127.0.0.1"
	}
	cfg.DaemonPort = os.Getenv("DAEMON_PORT")
	if cfg.DaemonPort == "" {
		cfg.DaemonPort = "18082"
	} else if p, err := strconv.Atoi(cfg.DaemonPort); err != nil || p < 1 || p > 65535 {
		fmt.Fprintln(os.Stderr, "err: DAEMON_PORT")
		os.Exit(exitConfig)
	}

	host := os.Getenv("MAIL_SMTP_HOST")
	port := os.Getenv("MAIL_SMTP_PORT")
	if port == "" {
		port = "25"
	}
	if host != "" {
		valid := true
		for _, c := range host {
			if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' ||
				c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-') {
				valid = false
				break
			}
		}
		if !valid {
			fmt.Fprintln(os.Stderr, "err: MAIL_SMTP_HOST")
			os.Exit(exitConfig)
		}
		p, err := strconv.Atoi(port)
		if err != nil || p < 1 || p > 65535 {
			fmt.Fprintln(os.Stderr, "err: MAIL_SMTP_PORT")
			os.Exit(exitConfig)
		}
		cfg.MailSMTPHost = host
		cfg.MailSMTPPort = p
		cfg.MailSMTPURL = fmt.Sprintf("smtp://%s:%d", host, p)
	}

	switch cfg.MailEnabled {
	case "YES", "NO":
	case "1", "TRUE":
		cfg.MailEnabled = "YES"
	case "0", "FALSE":
		cfg.MailEnabled = "NO"
	default:
		fmt.Fprintf(os.Stderr, "err: MAIL_ENABLED=%s\n", cfg.MailEnabled)
		os.Exit(exitConfig)
	}

	// wg/awg больше не нужны демону для опроса — состояние читается напрямую
	// через netlink (wgctrl). Скрипты управления клиентами (create-client.sh и
	// др.) по-прежнему вызывают wg — их наличие проверяют сами скрипты.
	for _, cmd := range []string{"logger", "hostname", "date", "timeout"} {
		if _, err := exec.LookPath(cmd); err != nil {
			fmt.Fprintf(os.Stderr, "err: %s\n", cmd)
			os.Exit(exitConfig)
		}
	}
	if cfg.MailEnabled == "YES" {
		if _, err := exec.LookPath("mail"); err != nil {
			fmt.Fprintln(os.Stderr, "err: mail")
			os.Exit(exitConfig)
		}
	}
	return cfg
}

// ═══════════════════════════════════════════════════════════════════════
// 3. СОСТОЯНИЕ ПИРА
// ═══════════════════════════════════════════════════════════════════════

// ─── PeerState ────────────────────────────────────────────────────────
type PeerState struct {
	LastRx         int64
	LastTx         int64
	LastRxChange   int64
	LastTxChange   int64
	LastHandshake  int64
	WasOnline      bool
	NotifiedOnline bool
	LastOffline    int64
	// Unix-время последнего тика, когда пир был онлайн.
	LastSeenOnline int64
	LastEndpoint   string
	LastIPs        string
	SessionStart   int64
	SessionRx0     int64
	SessionTx0     int64
}

// ─── IfaceState ───────────────────────────────────────────────────────
type IfaceState struct {
	PublicKey  string `json:"public_key"`
	ListenPort string `json:"listen_port"`
}

// ─── Event ────────────────────────────────────────────────────────────
type Event struct {
	Ts       string `json:"ts"`
	Type     string `json:"type"`
	Pk       string `json:"pk"`
	Name     string `json:"name"`
	Endpoint string `json:"endpoint"`
	Rx       int64  `json:"rx"`
	Tx       int64  `json:"tx"`
	Kind     string `json:"kind"`
	Extra    string `json:"extra"`
	Msg      string `json:"msg"`
	// Трафик за сессию (только для kind=session). omitempty — старые события не меняются.
	SRx int64 `json:"srx,omitempty"`
	STx int64 `json:"stx,omitempty"`
}

// ─── TrafficHistory ───────────────────────────────────────────────────
type TrafficPoint [3]float64
type TrafficHistory struct {
	LastRx   int64
	LastTx   int64
	LastTime float64
	Samples  []TrafficPoint
	// Длинная история для большого графика (срок задаётся TRAFFIC_HISTORY).
	Long []TrafficPoint
}

// ─── Daemon ───────────────────────────────────────────────────────────
type Daemon struct {
	cfg       *Config
	hostnameS string
	hostnameF string
	pidFile   string
	wgErrFile string
	logToFile bool
	StartTime time.Time

	logFile *os.File
	logMu   sync.Mutex

	eventsCount int
	eventsMu    sync.Mutex

	peersMu   sync.Mutex
	peers     map[string]*PeerState
	iface     IfaceState
	firstPass bool
	wgFailed  bool

	// Клиент netlink создаётся один раз и переиспользуется между опросами (пересоздаётся после ошибки).
	// Трогается только из главной горутины (pollOnce, cleanup).
	wg wgSource
	// Состояние последнего опроса для /healthz (читается из HTTP-горутины).
	wgPolled atomic.Bool
	wgOK     atomic.Bool

	nameCacheMu sync.Mutex
	nameCache   map[string]string
	nameMtime   int64
	nameBuilt   int64

	mailSem      chan struct{}
	mailWG       sync.WaitGroup
	mailStop     chan struct{}
	mailStopOnce sync.Once

	trafficMu sync.Mutex
	traffic   map[string]*TrafficHistory
	// История, прочитанная с диска при старте: подхватывается, когда пир впервые появляется в опросе.
	trafficRestored map[string][]TrafficPoint
	// true, если после последнего сохранения в истории появились новые точки.
	trafficDirty bool

	// Движок политик (nil, если POLICY_FILE не задан).
	policy *policyEngine
	// true после первого успешного опроса: только с этого момента известно, кто онлайн, и можно восстанавливать отложенные offline-команды.
	policyReady atomic.Bool
	// Журнал политик (POLICY_LOG_FILE).
	policyLogMu sync.Mutex
}

// ═══════════════════════════════════════════════════════════════════════
// 4. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════════════════════

// ─── Hostname ─────────────────────────────────────────────────────────
func hostnameShort() string {
	out, err := exec.Command("hostname", "-s").Output()
	if err != nil || strings.TrimSpace(string(out)) == "" {
		if h, e := os.Hostname(); e == nil {
			if i := strings.IndexByte(h, '.'); i > 0 {
				return h[:i]
			}
			return h
		}
		return "localhost"
	}
	return strings.TrimSpace(string(out))
}

func hostnameFull() string {
	out, err := exec.Command("hostname").Output()
	if err != nil || strings.TrimSpace(string(out)) == "" {
		if h, e := os.Hostname(); e == nil {
			return h
		}
		return "localhost"
	}
	return strings.TrimSpace(string(out))
}

// ─── Файловая система ─────────────────────────────────────────────────
// ensureDir создаёт директорию с режимом 0750, идемпотентна.
func ensureDir(path string) error {
	if err := os.MkdirAll(path, 0750); err != nil {
		return err
	}
	return os.Chmod(path, 0750)
}

// ─── Форматирование ───────────────────────────────────────────────────
func humanBytes(b int64) string {
	units := []string{"B", "KB", "MB", "GB", "TB", "PB"}
	f := float64(b)
	i := 0
	for f >= 1024 && i < 5 {
		f /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d %s", int64(f), units[i])
	}
	return fmt.Sprintf("%.2f %s", f, units[i])
}

func humanDuration(s int64) string {
	if s < 0 {
		s = 0
	}
	d := s / 86400
	h := s % 86400 / 3600
	m := s % 3600 / 60
	sec := s % 60
	switch {
	case d > 0:
		return fmt.Sprintf("%dd %dh %02dm", d, h, m)
	case h > 0:
		return fmt.Sprintf("%dh %02dm %02ds", h, m, sec)
	case m > 0:
		return fmt.Sprintf("%dm %02ds", m, sec)
	default:
		return fmt.Sprintf("%ds", sec)
	}
}

// ─── Имена клиентов ───────────────────────────────────────────────────
func sanitizeName(s string) string {
	var b strings.Builder
	for _, c := range s {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' ||
			c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-' {
			b.WriteRune(c)
		} else {
			b.WriteRune('_')
		}
	}
	return b.String()
}

// ═══════════════════════════════════════════════════════════════════════
// 5. КОНСТРУКТОР ДЕМОНА
// ═══════════════════════════════════════════════════════════════════════

// ─── NewDaemon ────────────────────────────────────────────────────────
func NewDaemon(cfg *Config) *Daemon {
	return &Daemon{
		cfg:       cfg,
		hostnameS: hostnameShort(),
		hostnameF: hostnameFull(),
		pidFile:   filepath.Join(cfg.PidDir, "daemon.pid"),
		wgErrFile: filepath.Join(cfg.PidDir, "wg.err"),
		logToFile: true,
		peers:     make(map[string]*PeerState),
		firstPass: true,
		nameCache: make(map[string]string),
		mailSem:   make(chan struct{}, cfg.MailQueueSize),
		mailStop:  make(chan struct{}),
		traffic:   make(map[string]*TrafficHistory),
		StartTime: time.Now(),
	}
}

// ═══════════════════════════════════════════════════════════════════════
// 6. ИНИЦИАЛИЗАЦИЯ И ЛОГИРОВАНИЕ
// ═══════════════════════════════════════════════════════════════════════

// ─── initLog ──────────────────────────────────────────────────────────
func (d *Daemon) initLog() {
	if err := ensureDir(d.cfg.LogDir); err != nil {
		d.log("WARN: cannot create log dir: " + err.Error())
	}

	f, err := os.OpenFile(d.cfg.LogFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0640)
	if err != nil {
		d.logToFile = false
		d.log("WARN: cannot use " + d.cfg.LogFile)
	} else {
		os.Chmod(d.cfg.LogFile, 0640)
		d.logFile = f
	}

	dir := filepath.Dir(d.cfg.EventsFile)
	if dir != "." && dir != "/" {
		if err := ensureDir(dir); err != nil {
			d.log("WARN: cannot create events dir: " + err.Error())
		}
	}
	matches, _ := filepath.Glob(d.cfg.EventsFile + ".trim.*")
	for _, m := range matches {
		os.Remove(m)
	}
	os.Remove(d.cfg.EventsFile + ".tmp")

	ef, err := os.OpenFile(d.cfg.EventsFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		d.log("WARN: cannot use " + d.cfg.EventsFile)
	} else {
		ef.Close()
		os.Chmod(d.cfg.EventsFile, 0600)

		// Журнал читается только через API демона, поэтому файл принадлежит root:root (группа wg-watch больше не нужна).
		os.Chown(d.cfg.EventsFile, 0, 0)

		if content, err := os.ReadFile(d.cfg.EventsFile); err == nil {
			d.eventsCount = bytes.Count(content, []byte("\n"))
		}
	}
}

// ─── syslog ───────────────────────────────────────────────────────────
func (d *Daemon) syslog(msg string) {
	cmd := exec.Command("logger", "-t", "wg-watch", "--", msg)
	cmd.Run()
}

// ─── log ──────────────────────────────────────────────────────────────
func (d *Daemon) log(msg string) {
	d.logMu.Lock()
	defer d.logMu.Unlock()
	if d.logToFile && d.logFile != nil {
		line := fmt.Sprintf("%s %s wg-watch[%d]: %s\n",
			time.Now().Format("2006-01-02 15:04:05"), d.hostnameS, os.Getpid(), msg)
		if _, err := d.logFile.WriteString(line); err != nil {
			d.syslog(msg)
		}
	} else {
		d.syslog(msg)
	}
}

// ═══════════════════════════════════════════════════════════════════════
// 7. СОБЫТИЯ (EVENTS.LOG)
// ═══════════════════════════════════════════════════════════════════════

// ─── copyEventsOwner ──────────────────────────────────────────────────
// Переносит владельца и группу текущего events.log на временный файл ПЕРЕД rename.
// Если исходный файл недоступен для stat, владельцем становится root:root.
func (d *Daemon) copyEventsOwner(tmp string) {
	if fi, err := os.Stat(d.cfg.EventsFile); err == nil {
		if st, ok := fi.Sys().(*syscall.Stat_t); ok {
			if err := os.Chown(tmp, int(st.Uid), int(st.Gid)); err == nil {
				return
			}
		}
	}
	os.Chown(tmp, 0, 0)
}

// ─── lockEventsFlock ──────────────────────────────────────────────────
// Берёт тот же flock (events.log.lock), что и lib/wg-clients.sh при записи события, чтобы запись из скрипта не потерялась во время обрезки. Возвращает функцию освобождения.
func (d *Daemon) lockEventsFlock() func() {
	lf, err := os.OpenFile(d.cfg.EventsFile+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return func() {}
	}
	if err := syscall.Flock(int(lf.Fd()), syscall.LOCK_EX); err != nil {
		lf.Close()
		return func() {}
	}
	return func() {
		syscall.Flock(int(lf.Fd()), syscall.LOCK_UN)
		lf.Close()
	}
}

// ─── emitEvent ────────────────────────────────────────────────────────
func (d *Daemon) emitEvent(typ, pk, name, endpoint string, rx, tx int64, kind, extra, legacyMsg string) {
	d.emitEventEx(typ, pk, name, endpoint, rx, tx, kind, extra, legacyMsg, 0, 0)
}

// emitEventEx — то же, что emitEvent, но с трафиком за сессию (srx/stx).
func (d *Daemon) emitEventEx(typ, pk, name, endpoint string, rx, tx int64, kind, extra, legacyMsg string, srx, stx int64) {
	if d.cfg.EventsFile == "" {
		return
	}
	ev := Event{
		SRx:      srx,
		STx:      stx,
		Ts:       time.Now().Format(time.RFC3339),
		Type:     typ,
		Pk:       pk,
		Name:     name,
		Endpoint: endpoint,
		Rx:       rx,
		Tx:       tx,
		Kind:     kind,
		Extra:    extra,
		Msg:      legacyMsg,
	}
	data, err := json.Marshal(ev)
	if err != nil {
		return
	}
	data = append(data, '\n')

	d.eventsMu.Lock()
	defer d.eventsMu.Unlock()
	f, err := os.OpenFile(d.cfg.EventsFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return
	}
	f.Close()
	d.eventsCount++
	if d.eventsCount > d.cfg.EventsMaxLines {
		d.trimEventsBySizeLocked(d.cfg.EventsKeepLines)
	}
}

// ─── trimEventsBySizeLocked ───────────────────────────────────────────
func (d *Daemon) trimEventsBySizeLocked(keep int) {
	unlock := d.lockEventsFlock()
	defer unlock()
	content, err := os.ReadFile(d.cfg.EventsFile)
	if err != nil {
		return
	}
	lines := strings.Split(strings.TrimRight(string(content), "\n"), "\n")
	if len(lines) <= keep {
		if len(lines) == 1 && lines[0] == "" {
			d.eventsCount = 0
		} else {
			d.eventsCount = len(lines)
		}
		return
	}
	lines = lines[len(lines)-keep:]
	tmp := d.cfg.EventsFile + ".tmp"
	if err := os.WriteFile(tmp, []byte(strings.Join(lines, "\n")+"\n"), 0600); err != nil {
		return
	}
	os.Chmod(tmp, 0600)
	d.copyEventsOwner(tmp)
	if err := os.Rename(tmp, d.cfg.EventsFile); err != nil {
		os.Remove(tmp)
		return
	}
	d.eventsCount = keep
}

// ─── trimEventsByAge ──────────────────────────────────────────────────
func (d *Daemon) trimEventsByAge(days int) {
	if d.cfg.EventsFile == "" || days <= 0 {
		return
	}
	if _, err := os.Stat(d.cfg.EventsFile); err != nil {
		return
	}

	// Весь проход (чтение + rename) под мьютексом и flock: иначе события, записанные между чтением и rename, теряются.
	d.eventsMu.Lock()
	defer d.eventsMu.Unlock()
	unlock := d.lockEventsFlock()
	defer unlock()

	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour)

	f, err := os.Open(d.cfg.EventsFile)
	if err != nil {
		d.log("WARN: trim: cannot open file")
		return
	}
	defer f.Close()

	tmp := fmt.Sprintf("%s.trim.%d", d.cfg.EventsFile, os.Getpid())
	outF, err := os.Create(tmp)
	if err != nil {
		d.log("WARN: trim: cannot create " + tmp)
		return
	}

	bw := bufio.NewWriterSize(outF, 64*1024)

	var total, kept, removed int
	writeErr := false
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), eventsScanMax)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		total++
		var ev Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil || ev.Ts == "" {
			if _, err := bw.WriteString(line + "\n"); err != nil {
				writeErr = true
				break
			}
			kept++
			continue
		}
		ts, err := time.Parse(time.RFC3339, ev.Ts)
		if err != nil {
			if _, err := bw.WriteString(line + "\n"); err != nil {
				writeErr = true
				break
			}
			kept++
			continue
		}
		if ts.Before(cutoff) {
			removed++
		} else {
			if _, err := bw.WriteString(line + "\n"); err != nil {
				writeErr = true
				break
			}
			kept++
		}
	}
	scanErr := scanner.Err()
	flushErr := bw.Flush()
	closeErr := outF.Close()

	if scanErr != nil || writeErr || flushErr != nil || closeErr != nil {
		os.Remove(tmp)
		d.eventsCount = total
		d.log(fmt.Sprintf("WARN: trim: read/write error (scan=%v write=%v flush=%v close=%v), original preserved",
			scanErr, writeErr, flushErr, closeErr))
		return
	}

	if removed == 0 {
		os.Remove(tmp)
		d.eventsCount = total
		d.log("events.log checked: clean")
		return
	}
	os.Chmod(tmp, 0600)
	d.copyEventsOwner(tmp)
	if err := os.Rename(tmp, d.cfg.EventsFile); err != nil {
		os.Remove(tmp)
		d.eventsCount = total
		d.log("WARN: trim: mv failed")
		return
	}
	d.eventsCount = kept
	d.log(fmt.Sprintf("events.log trimmed: total=%d removed=%d kept=%d", total, removed, kept))
}

// ═══════════════════════════════════════════════════════════════════════
// 8. БЛОКИРОВКА (FLOCK + PID-ФАЙЛ)
// ═══════════════════════════════════════════════════════════════════════

// ─── pidIsOurs ────────────────────────────────────────────────────────
func (d *Daemon) pidIsOurs(p int) bool {
	if p == os.Getpid() || p <= 0 {
		return false
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", p))
	if err != nil {
		return false
	}
	cmd := strings.ReplaceAll(string(data), "\x00", " ")
	myName := filepath.Base(os.Args[0])
	for _, field := range strings.Fields(cmd) {
		base := filepath.Base(field)
		if base == myName {
			return true
		}
	}
	return false
}

// ─── acquireLock ──────────────────────────────────────────────────────
func (d *Daemon) acquireLock() *os.File {
	if err := ensureDir(d.cfg.PidDir); err != nil {
		d.log("ERROR: cannot create pid dir: " + err.Error())
		os.Exit(exitErr)
	}

	lockPath := filepath.Join(d.cfg.PidDir, "daemon.lock")
	lockFile, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0640)
	if err != nil {
		d.log("ERROR: cannot open lock file")
		os.Exit(exitErr)
	}
	if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		d.log("already running")
		lockFile.Close()
		os.Exit(exitOK)
	}

	if data, err := os.ReadFile(d.pidFile); err == nil {
		owner, _ := strconv.Atoi(strings.TrimSpace(string(data)))
		if d.pidIsOurs(owner) {
			d.log("already running")
			lockFile.Close()
			os.Exit(exitOK)
		}
		d.log("removing stale pid file")
		os.Remove(d.pidFile)
	}
	f, err := os.OpenFile(d.pidFile, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0640)
	if err != nil {
		d.log("ERROR: cannot create pid")
		lockFile.Close()
		os.Exit(exitErr)
	}
	fmt.Fprintf(f, "%d", os.Getpid())
	f.Close()
	os.Chmod(d.pidFile, 0640)
	return lockFile
}

// ─── cleanup ──────────────────────────────────────────────────────────
func (d *Daemon) cleanup() {
	if d.wg != nil {
		d.wg.Close()
		d.wg = nil
	}
	data, err := os.ReadFile(d.pidFile)
	if err == nil {
		owner, _ := strconv.Atoi(strings.TrimSpace(string(data)))
		if owner == os.Getpid() {
			os.Remove(d.pidFile)
			if d.wgErrFile != "/dev/null" {
				os.Remove(d.wgErrFile)
			}
		}
	}
	if d.logFile != nil {
		d.logFile.Close()
	}
}

// ─── writeWgErr ───────────────────────────────────────────────────────
// writeWgErr записывает текст последней ошибки опроса wg в файл-маркер.
// Пустая строка означает «wg работает»; файл читается внешним мониторингом.
func (d *Daemon) writeWgErr(msg string) {
	if d.wgErrFile == "" || d.wgErrFile == "/dev/null" {
		return
	}
	if err := os.WriteFile(d.wgErrFile, []byte(msg), 0640); err != nil {
		return
	}
	os.Chmod(d.wgErrFile, 0640)
}

// ═══════════════════════════════════════════════════════════════════════
// 9. КЭШ КЛИЕНТОВ
// ═══════════════════════════════════════════════════════════════════════

// ─── rebuildNameCache ─────────────────────────────────────────────────
func (d *Daemon) rebuildNameCache() {
	cache := make(map[string]string)
	dirs, _ := filepath.Glob(filepath.Join(d.cfg.ClientsDir, "*"))
	for _, dir := range dirs {
		st, err := os.Stat(dir)
		if err != nil || !st.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, "public.key"))
		if err != nil {
			continue
		}
		val := strings.TrimSpace(string(data))
		val = strings.ReplaceAll(val, " ", "")
		val = strings.ReplaceAll(val, "\t", "")
		if val == "" {
			continue
		}
		name := sanitizeName(filepath.Base(dir))
		if name == "" {
			continue
		}
		cache[val] = name
	}
	d.nameCache = cache
	d.nameBuilt = time.Now().Unix()
}

// ─── clientNameByPubkey ───────────────────────────────────────────────
func (d *Daemon) clientNameByPubkey(pk string) string {
	if pk == "" {
		return ""
	}
	d.nameCacheMu.Lock()
	defer d.nameCacheMu.Unlock()

	var mtime int64
	if st, err := os.Stat(d.cfg.ClientsDir); err == nil {
		mtime = st.ModTime().Unix()
	}
	needRebuild := false
	if d.nameBuilt == 0 || mtime != d.nameMtime {
		needRebuild = true
	} else if _, ok := d.nameCache[pk]; !ok && time.Now().Unix()-d.nameBuilt >= 30 {
		needRebuild = true
	}
	if needRebuild {
		d.rebuildNameCache()
		d.nameMtime = mtime
	}
	if name, ok := d.nameCache[pk]; ok && name != "" {
		return name
	}
	return pk
}

// ═══════════════════════════════════════════════════════════════════════
// 10. ПОЧТА
// ═══════════════════════════════════════════════════════════════════════

// ─── sendMessage ──────────────────────────────────────────────────────
func (d *Daemon) sendMessage(subject, body string) {
	if d.cfg.MailEnabled != "YES" {
		return
	}
	select {
	case d.mailSem <- struct{}{}:
	default:
		d.log("WARN: mail queue full, dropping message")
		return
	}
	d.mailWG.Add(1)
	go func() {
		defer func() { <-d.mailSem; d.mailWG.Done() }()

		// Слот очереди (mailSem) держится, пока письмо не доставлено или попытки не кончились.
		attempts := d.cfg.MailRetries
		var lastErr error
		for i := 1; i <= attempts; i++ {
			lastErr = d.sendMailOnce(subject, body)
			if lastErr == nil {
				if i > 1 {
					d.log(fmt.Sprintf("mail delivered on attempt %d/%d: %s", i, attempts, subject))
				}
				return
			}
			if i == attempts {
				break
			}
			delay := time.Duration(i*d.cfg.MailRetryDelay) * time.Second
			if maxDelay := time.Duration(d.cfg.MailRetryMaxDelay) * time.Second; delay > maxDelay {
				delay = maxDelay
			}
			d.log(fmt.Sprintf("WARN: mail attempt %d/%d failed (%v), retry in %s: %s",
				i, attempts, lastErr, delay, subject))
			select {
			case <-time.After(delay):
			case <-d.mailStop:
				d.log("WARN: mail not delivered, daemon is stopping: " + subject)
				return
			}
		}
		d.log(fmt.Sprintf("ERROR: mail NOT delivered after %d attempts (%v): %s", attempts, lastErr, subject))
		d.syslog("WARN: mail failed: " + lastErr.Error())
	}()
}

// ─── sendMailOnce ─────────────────────────────────────────────────────
// Одна попытка отправки через mail. Возвращает ошибку вместе с началом stderr команды.
func (d *Daemon) sendMailOnce(subject, body string) error {
	mailArgs := []string{}
	if d.cfg.MailSMTPURL != "" {
		mailArgs = append(mailArgs, "-E", "set sendmail="+d.cfg.MailSMTPURL)
	}
	mailArgs = append(mailArgs,
		"-a", "From: "+d.cfg.MailFrom,
		"-a", "Auto-Submitted: auto-generated",
		"-s", subject,
		d.cfg.MailTo,
	)
	args := append([]string{"30", "mail"}, mailArgs...)
	cmd := exec.Command("timeout", args...)
	cmd.Stdin = strings.NewReader(body + "\n")
	// GNU Mailutils при неудаче дописывает письмо в $HOME/dead.letter; чтобы повторные попытки
	// не плодили копии, домашний каталог подменяется (запись туда молча не удаётся).
	cmd.Env = append(os.Environ(), "HOME=/dev/null")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(truncateUTF8(stderr.String(), 200)); msg != "" {
			return fmt.Errorf("%w: %s", err, msg)
		}
		return err
	}
	return nil
}

// ─── stopMail ─────────────────────────────────────────────────────────
// Прерывает ожидание между попытками (вызывается при остановке демона).
func (d *Daemon) stopMail() {
	d.mailStopOnce.Do(func() { close(d.mailStop) })
}

// ─── waitMail ─────────────────────────────────────────────────────────
func (d *Daemon) waitMail(timeout time.Duration) {
	done := make(chan struct{})
	go func() { d.mailWG.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(timeout):
		d.log("WARN: shutdown: some mails still in flight")
	}
}

// ═══════════════════════════════════════════════════════════════════════
// 11. УВЕДОМЛЕНИЯ И ОЦЕНКА ПИРА
// ═══════════════════════════════════════════════════════════════════════

// ─── notifyOnline ─────────────────────────────────────────────────────
func (d *Daemon) notifyOnline(pk, ep, ips string, age, rx, tx int64) {
	name := d.clientNameByPubkey(pk)
	body := fmt.Sprintf("WireGuard connection on %s\n\nTime: %s\nClient: %s\nEndpoint: %s\nAllowed: %s\nHandshake: %ds ago\nTotal rx: %s\nTotal tx: %s\n\nPublic key: %s",
		d.hostnameF, time.Now().Format("2006-01-02 15:04:05"), name, ep, ips, age, humanBytes(rx), humanBytes(tx), pk)
	subj := sanitizeHeader(fmt.Sprintf("[WG] %s connected on %s", name, d.hostnameS))
	d.sendMessage(subj, body)
	d.log(fmt.Sprintf("ONLINE: %s (%s) from %s (rx=%d tx=%d)", name, pk, ep, rx, tx))
	d.emitEvent("online", pk, name, ep, rx, tx, "connected", "", "connected from "+ep)
}

// ─── notifyOffline ────────────────────────────────────────────────────
func (d *Daemon) notifyOffline(pk string, now int64) {
	st := d.peers[pk]
	if st == nil {
		return
	}
	name := d.clientNameByPubkey(pk)
	ep := st.LastEndpoint
	if ep == "" {
		ep = "unknown"
	}
	ips := st.LastIPs
	if ips == "" {
		ips = "unknown"
	}
	rx, tx := st.LastRx, st.LastTx
	start := st.SessionStart
	if start == 0 {
		start = now
	}
	act := st.LastRxChange
	if st.LastTxChange > act {
		act = st.LastTxChange
	}
	if act < start {
		act = start
	}
	dur := act - start
	dRx := rx - st.SessionRx0
	if dRx < 0 {
		dRx = rx
	}
	dTx := tx - st.SessionTx0
	if dTx < 0 {
		dTx = tx
	}
	body := fmt.Sprintf("WireGuard disconnection on %s\n\nConnected at: %s\nDisconnected: %s\nClient: %s\nEndpoint: %s\nAllowed: %s\nLast activity: %s\nSession: %s\nSession rx: %s\nSession tx: %s\nTotal rx/tx: %s / %s\n\nPublic key: %s",
		d.hostnameF,
		time.Unix(start, 0).Format("2006-01-02 15:04:05"),
		time.Now().Format("2006-01-02 15:04:05"),
		name, ep, ips,
		time.Unix(act, 0).Format("2006-01-02 15:04:05"),
		humanDuration(dur), humanBytes(dRx), humanBytes(dTx),
		humanBytes(rx), humanBytes(tx), pk)
	subj := sanitizeHeader(fmt.Sprintf("[WG] %s disconnected on %s", name, d.hostnameS))
	d.sendMessage(subj, body)
	d.log(fmt.Sprintf("OFFLINE: %s (%s) from %s (session=%ds rx=%d tx=%d)", name, pk, ep, dur, rx, tx))
	d.emitEventEx("offline", pk, name, ep, rx, tx, "session", strconv.FormatInt(dur, 10),
		fmt.Sprintf("session %s rx %s tx %s", humanDuration(dur), humanBytes(dRx), humanBytes(dTx)), dRx, dTx)
}

// ─── goOffline ────────────────────────────────────────────────────────
func (d *Daemon) goOffline(pk string, now int64) {
	st := d.peers[pk]
	if st == nil {
		return
	}
	st.WasOnline = false
	st.LastOffline = now
	if st.NotifiedOnline {
		st.NotifiedOnline = false
		d.notifyOffline(pk, now)
	} else {
		name := d.clientNameByPubkey(pk)
		d.log(fmt.Sprintf("offline (silent, no ONLINE was sent): %s (%s)", name, pk))
		d.emitEvent("offline", pk, name, st.LastEndpoint, st.LastRx, st.LastTx, "silent", "", "offline (silent, no ONLINE was sent)")
	}
	if d.policy != nil {
		d.policyPeerDown(pk, d.clientNameByPubkey(pk), st.LastIPs)
	}
}

// ─── handleOnline ─────────────────────────────────────────────────────
func (d *Daemon) handleOnline(pk, endpoint, ips string, age, rx, tx, now int64) {
	st := d.peers[pk]
	prevEp := st.LastEndpoint
	st.WasOnline = true
	st.NotifiedOnline = false

	if d.firstPass {
		st.NotifiedOnline = true
		st.SessionStart = now
		st.SessionRx0 = rx
		st.SessionTx0 = tx
		st.LastEndpoint = endpoint
		return
	}
	sinceOff := now - st.LastOffline

	switch {
	case sinceOff < int64(d.cfg.Cooldown):
		d.log(fmt.Sprintf("ONLINE suppressed (reconnect %ds after offline): %s", sinceOff, pk))
		st.NotifiedOnline = true
		st.LastEndpoint = endpoint
	case prevEp == endpoint && sinceOff < int64(d.cfg.SameEndpointCooldown):
		d.log("ONLINE suppressed (same endpoint): " + pk)
		st.NotifiedOnline = true
		st.LastEndpoint = endpoint
	default:
		st.NotifiedOnline = true
		st.SessionStart = now
		st.SessionRx0 = rx
		st.SessionTx0 = tx
		st.LastEndpoint = endpoint
		d.notifyOnline(pk, endpoint, ips, age, rx, tx)
	}
}

// ─── evaluatePeer ─────────────────────────────────────────────────────
func (d *Daemon) evaluatePeer(pk, endpoint, ips string, handshake, rx, tx, now int64) {
	st, ok := d.peers[pk]
	if !ok {
		st = &PeerState{
			LastRxChange: now,
			LastTxChange: now,
		}
		d.peers[pk] = st
	}
	age := int64(-1)
	isOnline := false
	prev := st.WasOnline

	st.LastHandshake = handshake

	// ВСЕГДА сохраняем AllowedIPs, даже если пир оффлайн (это статическая настройка)
	if ips != "" {
		st.LastIPs = ips
	}

	if handshake != 0 && endpoint != "(none)" {
		if rx != st.LastRx {
			st.LastRxChange = now
		}
		if tx != st.LastTx {
			st.LastTxChange = now
		}
		st.LastRx = rx
		st.LastTx = tx
		age = now - handshake
		rxAge := now - st.LastRxChange
		txAge := now - st.LastTxChange
		if age <= int64(d.cfg.PeerTimeout) && (rxAge <= int64(d.cfg.ObserveWindow) || txAge <= int64(d.cfg.ObserveWindow)) {
			isOnline = true
		}
	}

	if isOnline {
		st.LastSeenOnline = now
		if !prev {
			d.handleOnline(pk, endpoint, ips, age, rx, tx, now)
			if d.policy != nil {
				d.policyPeerUp(pk, d.clientNameByPubkey(pk), st.LastIPs)
			}
		} else if st.LastEndpoint != endpoint {
			oldEp := st.LastEndpoint
			d.log(fmt.Sprintf("ROAM: %s %s -> %s", pk, oldEp, endpoint))
			name := d.clientNameByPubkey(pk)
			d.emitEvent("roam", pk, name, endpoint, st.LastRx, st.LastTx, "roam", oldEp, oldEp+" -> "+endpoint)
			st.LastEndpoint = endpoint
			st.NotifiedOnline = true
		}
	} else if prev {
		// OFFLINE_CONFIRM — в секундах с последнего онлайн-наблюдения.
		if now-st.LastSeenOnline >= int64(d.cfg.OfflineConfirm) {
			d.goOffline(pk, now)
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════
// 12. СТАТИСТИКА И HTTP-СЕРВЕР
// ═══════════════════════════════════════════════════════════════════════

// ─── updateTraffic ────────────────────────────────────────────────────
func (d *Daemon) updateTraffic(pubkey string, rx, tx int64, now float64) {
	d.trafficMu.Lock()
	defer d.trafficMu.Unlock()

	h, ok := d.traffic[pubkey]
	if !ok {
		h = &TrafficHistory{LastRx: rx, LastTx: tx, LastTime: now}
		// Базовые счётчики (LastRx/LastTx) берём из текущего опроса, а старые точки — с диска:
		// так первая дельта после перезапуска не превращается в ложный всплеск.
		if pts, found := d.trafficRestored[pubkey]; found {
			longCutoff := now - float64(d.cfg.TrafficHistory)
			drop := 0
			for drop < len(pts) && pts[drop][0] < longCutoff {
				drop++
			}
			h.Long = pts[drop:]
			delete(d.trafficRestored, pubkey)
		}
		d.traffic[pubkey] = h
		return
	}

	dt := now - h.LastTime
	if dt < 0.5 {
		return
	}

	dRx := float64(rx - h.LastRx)
	dTx := float64(tx - h.LastTx)
	if dRx < 0 {
		dRx = 0
	}
	if dTx < 0 {
		dTx = 0
	}

	// Обновляем «последние известные» значения в любом случае,
	// чтобы следующая дельта считалась корректно.
	h.LastRx = rx
	h.LastTx = tx
	h.LastTime = now

	// Чистим старые точки по окну времени (делаем это всегда, даже если трафика нет)
	cutoff := now - float64(d.cfg.TrafficWindow)
	valid := h.Samples[:0]
	for _, s := range h.Samples {
		if s[0] >= cutoff {
			valid = append(valid, s)
		}
	}
	h.Samples = valid

	// Длинная история: чистим по TRAFFIC_HISTORY (тоже всегда, даже без трафика).
	longCutoff := now - float64(d.cfg.TrafficHistory)
	drop := 0
	for drop < len(h.Long) && h.Long[drop][0] < longCutoff {
		drop++
	}
	if drop > 0 {
		h.Long = h.Long[drop:]
	}

	// Если трафика нет (ни входящего, ни исходящего) — НЕ добавляем нулевую точку.
	// График просто соединит предыдущую точку с будущей, когда трафик появится.
	// Если прирост за интервал опроса меньше 1 КБ (1024 байта), считаем это шумом и не пишем точку.
	// (Сравниваются байты за интервал, а не скорость: при INTERVAL=2 это порядка 512 Б/с.)
	if dRx < 1024 && dTx < 1024 {
		return
	}

	// Добавляем точку только если есть реальный трафик.
	h.Samples = append(h.Samples, TrafficPoint{now, dRx / dt, dTx / dt})
	h.Long = append(h.Long, TrafficPoint{now, dRx / dt, dTx / dt})
	d.trafficDirty = true
}

// ─── handleStats ──────────────────────────────────────────────────────
func (d *Daemon) handleStats(w http.ResponseWriter, r *http.Request) {
	d.peersMu.Lock()
	peersCopy := make([]map[string]interface{}, 0, len(d.peers))
	for pk, st := range d.peers {
		peersCopy = append(peersCopy, map[string]interface{}{
			"pubkey":        pk,
			"name":          d.clientNameByPubkey(pk),
			"endpoint":      st.LastEndpoint,
			"allowed_ips":   st.LastIPs,
			"handshake":     st.LastHandshake,
			"rx":            st.LastRx,
			"tx":            st.LastTx,
			"handshake_age": nil,
			"online":        st.WasOnline,
		})
	}
	ifaceCopy := d.iface
	d.peersMu.Unlock()

	nowInt := time.Now().Unix()
	for _, p := range peersCopy {
		hs := p["handshake"].(int64)
		if hs > 0 {
			age := nowInt - hs
			p["handshake_age"] = age
		}
	}

	d.trafficMu.Lock()
	trafficCopy := make(map[string][]TrafficPoint)
	for pk, h := range d.traffic {
		if len(h.Samples) > 0 {
			trafficCopy[pk] = append([]TrafficPoint(nil), h.Samples...)
		}
	}
	d.trafficMu.Unlock()

	resp := map[string]interface{}{
		"peers":           peersCopy,
		"iface":           ifaceCopy,
		"traffic":         trafficCopy,
		"traffic_window":  d.cfg.TrafficWindow,
		"traffic_timeout": d.cfg.TrafficTimeout,
		"traffic_history": d.cfg.TrafficHistory,
		"peer_timeout":    d.cfg.PeerTimeout,
		"stale_timeout":   d.cfg.StaleTimeout,
		"server_time":     time.Now().Format(time.RFC3339),
		"uptime":          int64(time.Since(d.StartTime).Seconds()),
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(resp)
}

// ─── handleTraffic ────────────────────────────────────────────────────
// handleTraffic отдаёт длинную историю трафика одного пира: GET /api/traffic?pk=<pubkey>.
// Формат точек такой же, как в /api/state: [время_в_секундах, rx_B/s, tx_B/s].
func (d *Daemon) handleTraffic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	pk := r.URL.Query().Get("pk")

	d.trafficMu.Lock()
	h, ok := d.traffic[pk]
	samples := []TrafficPoint{}
	if ok {
		samples = append(samples, h.Long...)
	}
	d.trafficMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"not_found"}`))
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"pk":      pk,
		"samples": samples,
		"history": d.cfg.TrafficHistory,
	})
}

// ─── handleClearEvents ────────────────────────────────────────────────
// handleClearEvents безопасно очищает events.log, обрезая файл до нуля байт.
func (d *Daemon) handleClearEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	d.eventsMu.Lock()
	defer d.eventsMu.Unlock()

	// Обрезает файл до нуля байт: inode и права файла сохраняются.
	err := os.Truncate(d.cfg.EventsFile, 0)
	if err != nil {
		d.log("ERROR: failed to truncate events.log: " + err.Error())
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"ok":false,"error":"truncate_failed"}`))
		return
	}

	d.eventsCount = 0
	d.log("events.log cleared by API request")

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

// ─── tailEventLines ───────────────────────────────────────────────────
// Читает файл с конца блоками и возвращает не более limit последних строк (в порядке файла).
// Нет файла — пустой результат без ошибки.
func tailEventLines(path string, limit int) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := fi.Size()
	const block = 64 * 1024
	var data []byte
	for size > 0 && bytes.Count(data, []byte{'\n'}) <= limit {
		rs := int64(block)
		if rs > size {
			rs = size
		}
		size -= rs
		buf := make([]byte, rs)
		if n, err := f.ReadAt(buf, size); err != nil || int64(n) != rs {
			return nil, fmt.Errorf("read events: %v", err)
		}
		data = append(buf, data...)
	}
	// Первая строка могла быть прочитана не с начала, но при limit+1 переводах строки она всегда оказывается за пределами среза.
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return lines, nil
}

// ─── handleEvents ─────────────────────────────────────────────────────
// GET /api/events?limit=N — последние N событий, новые первыми: {"events":[...]}.
// Строки, которые не являются JSON-объектом или длиннее eventsMaxLineBytes, пропускаются.
func (d *Daemon) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"invalid_limit"}`))
			return
		}
		limit = n
	}
	if limit > eventsAPIMaxLimit {
		limit = eventsAPIMaxLimit
	}

	d.eventsMu.Lock()
	lines, err := tailEventLines(d.cfg.EventsFile, limit)
	d.eventsMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		d.log("ERROR: read events.log: " + err.Error())
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"read_failed"}`))
		return
	}

	var out bytes.Buffer
	out.WriteString(`{"events":[`)
	first := true
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" || line[0] != '{' || len(line) > eventsMaxLineBytes || !json.Valid([]byte(line)) {
			continue
		}
		if !first {
			out.WriteByte(',')
		}
		first = false
		out.WriteString(line)
	}
	out.WriteString(`]}`)
	w.Write(out.Bytes())
}

// ─── handleEventsDownload ─────────────────────────────────────────────
// GET /api/events/download — весь events.log как файл (NDJSON).
func (d *Daemon) handleEventsDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	d.eventsMu.Lock()
	data, err := os.ReadFile(d.cfg.EventsFile)
	d.eventsMu.Unlock()
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		if os.IsNotExist(err) {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"error":"no_events_file"}`))
			return
		}
		d.log("ERROR: read events.log for download: " + err.Error())
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"read_failed"}`))
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", `attachment; filename="wg-watch-events.log"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}

// ─── requireToken ─────────────────────────────────────────────────────
// requireToken проверяет заголовок X-Daemon-Token за постоянное время.
// Сравнение constant-time защищает от timing-атак на секрет.
func (d *Daemon) requireToken(next http.HandlerFunc) http.HandlerFunc {
	want := []byte(daemonToken)
	return func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get("X-Daemon-Token"))
		// Ранний выход по длине: сама длина токена — не секрет, а ConstantTimeCompare требует одинаковых длин.
		if len(got) != len(want) || subtle.ConstantTimeCompare(got, want) != 1 {
			// Пишет в лог демона (wg-watch-daemon.log).
			d.log(fmt.Sprintf("AUTH: rejected %s from %s", r.URL.Path, r.RemoteAddr))
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		next(w, r)
	}
}

// ─── startStatsServer ─────────────────────────────────────────────────
func (d *Daemon) startStatsServer() {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/state", d.requireToken(d.handleStats))
	mux.HandleFunc("/api/traffic", d.requireToken(d.handleTraffic))
	mux.HandleFunc("/api/events", d.requireToken(d.handleEvents))
	mux.HandleFunc("/api/events/download", d.requireToken(d.handleEventsDownload))
	mux.HandleFunc("/api/events/clear", d.requireToken(d.handleClearEvents))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		// Опрос WireGuard уже выполнялся и последний раз закончился ошибкой: сообщаем об этом кодом 503.
		if d.wgPolled.Load() && !d.wgOK.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`{"status":"degraded","error":"wg_poll_failed"}`))
			return
		}
		w.Write([]byte(`{"status":"ok"}`))
	})

	addr := fmt.Sprintf("%s:%s", d.cfg.DaemonHost, d.cfg.DaemonPort)

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		d.log("ERROR: stats server listen failed: " + err.Error())
		return
	}
	d.log("Stats server listening on " + ln.Addr().String())

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		if err := srv.Serve(ln); err != nil {
			d.log("ERROR: stats server failed: " + err.Error())
		}
	}()
}

// ═══════════════════════════════════════════════════════════════════════
// 13. ОПРОС WG ЧЕРЕЗ NETLINK (WGCTRL)
// ═══════════════════════════════════════════════════════════════════════

// ─── wgSource ─────────────────────────────────────────────────────────
// Источник состояния интерфейса WireGuard. В работе это клиент wgctrl (generic netlink),
// в тестах подменяется заглушкой через newWgSource.
type wgSource interface {
	Device(name string) (*wgtypes.Device, error)
	Close() error
}

var newWgSource = func() (wgSource, error) { return wgctrl.New() }

// ─── wgFail ───────────────────────────────────────────────────────────
// Фиксирует сбой опроса: событие, строка в журнале и маркер wg.err пишутся один раз на серию сбоев.
func (d *Daemon) wgFail(what, msg string) {
	d.wgPolled.Store(true)
	d.wgOK.Store(false)
	if d.wgFailed {
		return
	}
	d.log("ERROR: " + what + " failed: " + msg)
	d.emitEvent("error", "", "wg-watch", "", 0, 0, "wg_failed", msg, "wgctrl failed: "+msg)
	d.writeWgErr(msg)
	d.wgFailed = true
}

// ─── pollOnce ─────────────────────────────────────────────────────────
// Читает состояние интерфейса и пиров напрямую через generic netlink (wgctrl),
// без exec-вызова wg/awg и без парсинга текстового dump.
// Поведение при ошибках и восстановлении идентично прежней exec-версии:
// один раз пишем событие wg_failed / wg_recovered и маркер в pids/wg.err.
// Клиент netlink переиспользуется между опросами; после любой ошибки он закрывается и создаётся заново
// (если модуль или интерфейс были пересозданы, семейство netlink могло смениться).
func (d *Daemon) pollOnce() bool {
	now := time.Now().Unix()
	nowFloat := float64(time.Now().UnixNano()) / 1e9

	if d.wg == nil {
		c, err := newWgSource()
		if err != nil {
			d.wgFail("wgctrl.New", truncateUTF8("wgctrl.New: "+err.Error(), wgErrMsgMaxLen))
			return false
		}
		d.wg = c
	}

	dev, err := d.wg.Device(d.cfg.WgIface)
	if err == nil && dev == nil {
		err = fmt.Errorf("empty response")
	}
	if err != nil {
		d.wg.Close()
		d.wg = nil
		d.wgFail("wgctrl Device("+d.cfg.WgIface+")", truncateUTF8("Device("+d.cfg.WgIface+"): "+err.Error(), wgErrMsgMaxLen))
		return false
	}
	d.wgPolled.Store(true)
	d.wgOK.Store(true)

	if d.wgFailed {
		d.log("wg show recovered")
		d.emitEvent("online", "", "wg-watch", "", 0, 0, "wg_recovered", "", "wg_show_recovered")
		d.writeWgErr("")
		d.wgFailed = false
	}

	// Заголовок интерфейса (public key, listen port) — раньше брался из первой строки dump.
	d.peersMu.Lock()
	d.iface.PublicKey = dev.PublicKey.String()
	d.iface.ListenPort = strconv.Itoa(dev.ListenPort)
	d.peersMu.Unlock()

	seen := make(map[string]bool)

	// Держим peersMu на всё время обхода: evaluatePeer/goOffline мутируют d.peers
	// и поля PeerState, а handleStats и watchClientsDir читают их параллельно.
	d.peersMu.Lock()
	for _, peer := range dev.Peers {
		pubkey := peer.PublicKey.String()

		endpoint := "(none)"
		if peer.Endpoint != nil {
			endpoint = peer.Endpoint.String()
		}

		// AllowedIPs: склеиваем в строку через ", " — как это делает wg show.
		// Если allowed ips нет (некорректная конфигурация) — пустая строка.
		allowedIPs := ""
		if len(peer.AllowedIPs) > 0 {
			parts := make([]string, 0, len(peer.AllowedIPs))
			for _, ipnet := range peer.AllowedIPs {
				parts = append(parts, ipnet.String())
			}
			allowedIPs = strings.Join(parts, ", ")
		}

		// LastHandshakeTime — zero time, если рукопожатия не было; в dump это поле 0.
		var handshake int64
		if !peer.LastHandshakeTime.IsZero() {
			handshake = peer.LastHandshakeTime.Unix()
		}

		rx := peer.ReceiveBytes
		tx := peer.TransmitBytes

		// Мониторим только управляемых клиентов: у них есть папка в CLIENTS_DIR.
		// Неизвестные пиры (pubkey без имени) и пиры с удалённой папкой пропускаем —
		// в финальном проходе такие записи будут корректно удалены и получат OFFLINE
		// через goOffline.
		clientName := d.clientNameByPubkey(pubkey)
		if clientName == pubkey {
			continue
		}
		clientDir := filepath.Join(d.cfg.ClientsDir, clientName)
		if _, err := os.Stat(clientDir); os.IsNotExist(err) {
			continue
		}

		seen[pubkey] = true
		d.evaluatePeer(pubkey, endpoint, allowedIPs, handshake, rx, tx, now)
		d.updateTraffic(pubkey, rx, tx, nowFloat)
	}
	// goOffline ДО delete, чтобы notifyOffline нашёл st в map.
	for pk, st := range d.peers {
		if !seen[pk] {
			if st.WasOnline {
				d.goOffline(pk, now)
			}
			delete(d.peers, pk)
		}
	}
	d.peersMu.Unlock()

	// Чистим traffic отдельно, без peersMu (ABBA не возникнет).
	d.trafficMu.Lock()
	for pk := range d.traffic {
		if !seen[pk] {
			delete(d.traffic, pk)
		}
	}
	for pk := range d.trafficRestored {
		if !seen[pk] {
			delete(d.trafficRestored, pk)
		}
	}
	d.trafficMu.Unlock()

	return true
}

// ═══════════════════════════════════════════════════════════════════════
// 14. FSNOTIFY (МГНОВЕННАЯ РЕАКЦИЯ)
// ═══════════════════════════════════════════════════════════════════════

// ─── watchClientsDir ──────────────────────────────────────────────────
func (d *Daemon) watchClientsDir(done <-chan struct{}) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		d.log("ERROR: fsnotify: " + err.Error())
		return
	}
	defer watcher.Close()

	err = watcher.Add(d.cfg.ClientsDir)
	if err != nil {
		d.log("ERROR: fsnotify add: " + err.Error())
		return
	}

	for {
		select {
		case <-done:
			return
		case event, ok := <-watcher.Events:
			if !ok {
				return
			}
			if event.Op&fsnotify.Remove == fsnotify.Remove || event.Op&fsnotify.Rename == fsnotify.Rename {
				d.nameCacheMu.Lock()
				d.nameBuilt = 0
				d.nameCacheMu.Unlock()

				deletedName := filepath.Base(event.Name)

				// Под peersMu: goOffline ДО delete, чтобы OFFLINE-письмо ушло даже при удалении папки клиента.
				d.peersMu.Lock()
				for pk, st := range d.peers {
					if d.clientNameByPubkey(pk) == deletedName {
						if st.WasOnline {
							d.goOffline(pk, time.Now().Unix())
						}
						delete(d.peers, pk)
						d.log("fsnotify: client removed from memory: " + deletedName)
					}
				}
				d.peersMu.Unlock()
			}
		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			d.log("ERROR: fsnotify: " + err.Error())
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════
// 15. СОХРАНЕНИЕ ИСТОРИИ ТРАФИКА НА ДИСК
// ═══════════════════════════════════════════════════════════════════════

const trafficFileVersion = 1

// Ограничение на размер читаемого файла истории: защита от повреждённого или подменённого файла.
const trafficFileMaxBytes = 64 << 20

// trafficFile — формат файла истории: версия, время сохранения и точки [время, rx, tx] по каждому пиру.
type trafficFile struct {
	Version int                       `json:"version"`
	SavedAt int64                     `json:"saved_at"`
	Peers   map[string][]TrafficPoint `json:"peers"`
}

// ─── writeFileAtomic ──────────────────────────────────────────────────
// Пишет файл через временный файл и rename: при сбое остаётся либо старая, либо новая целая версия.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".traffic-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

// ─── roundPoint ───────────────────────────────────────────────────────
// Округляет точку для файла: время до миллисекунды, скорости до 0.1 Б/с (файл заметно компактнее).
func roundPoint(p TrafficPoint) TrafficPoint {
	return TrafficPoint{math.Round(p[0]*1000) / 1000, math.Round(p[1]*10) / 10, math.Round(p[2]*10) / 10}
}

// ─── saveTraffic ──────────────────────────────────────────────────────
// Сохраняет историю на диск, если она изменилась с прошлого сохранения. Вызывается периодически и при остановке.
func (d *Daemon) saveTraffic() {
	if d.cfg.TrafficFile == "" {
		return
	}

	d.trafficMu.Lock()
	if !d.trafficDirty {
		d.trafficMu.Unlock()
		return
	}
	cutoff := float64(time.Now().UnixNano())/1e9 - float64(d.cfg.TrafficHistory)
	snap := make(map[string][]TrafficPoint, len(d.traffic)+len(d.trafficRestored))
	for pk, h := range d.traffic {
		if len(h.Long) == 0 {
			continue
		}
		pts := make([]TrafficPoint, len(h.Long))
		for i, p := range h.Long {
			pts[i] = roundPoint(p)
		}
		snap[pk] = pts
	}
	// Пиры, чья история прочитана с диска, но которые ещё не успели появиться в опросе, не теряем.
	for pk, restored := range d.trafficRestored {
		if _, ok := snap[pk]; ok {
			continue
		}
		pts := make([]TrafficPoint, 0, len(restored))
		for _, p := range restored {
			if p[0] >= cutoff {
				pts = append(pts, roundPoint(p))
			}
		}
		if len(pts) > 0 {
			snap[pk] = pts
		}
	}
	d.trafficDirty = false
	d.trafficMu.Unlock()

	data, err := json.Marshal(trafficFile{Version: trafficFileVersion, SavedAt: time.Now().Unix(), Peers: snap})
	if err == nil {
		err = writeFileAtomic(d.cfg.TrafficFile, data, 0600)
	}
	if err != nil {
		d.log("ERROR: traffic history save: " + err.Error())
		// Не потеряли изменения: повторим при следующем цикле.
		d.trafficMu.Lock()
		d.trafficDirty = true
		d.trafficMu.Unlock()
	}
}

// ─── validTrafficPoint ────────────────────────────────────────────────
// Точка пригодна, если все числа конечные, а скорости неотрицательные.
func validTrafficPoint(p TrafficPoint) bool {
	for _, v := range p {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	return p[1] >= 0 && p[2] >= 0
}

// ─── loadTraffic ──────────────────────────────────────────────────────
// Читает историю с диска при старте. Отсутствие файла — нормальная ситуация; битый файл, чужая версия
// или некорректные точки игнорируются (график просто начнётся заново), демон не падает.
func (d *Daemon) loadTraffic() {
	if d.cfg.TrafficFile == "" {
		return
	}
	st, err := os.Stat(d.cfg.TrafficFile)
	if err != nil {
		if !os.IsNotExist(err) {
			d.log("WARN: traffic history: " + err.Error())
		}
		return
	}
	if st.Size() > trafficFileMaxBytes {
		d.log("WARN: traffic history file is too large, ignored")
		return
	}
	raw, err := os.ReadFile(d.cfg.TrafficFile)
	if err != nil {
		d.log("WARN: traffic history: " + err.Error())
		return
	}
	var tf trafficFile
	if err := json.Unmarshal(raw, &tf); err != nil || tf.Version != trafficFileVersion {
		d.log("WARN: traffic history file ignored (bad format or version)")
		return
	}

	now := float64(time.Now().UnixNano()) / 1e9
	cutoff := now - float64(d.cfg.TrafficHistory)
	restored := make(map[string][]TrafficPoint, len(tf.Peers))
	total := 0
	for pk, pts := range tf.Peers {
		clean := make([]TrafficPoint, 0, len(pts))
		last := cutoff
		for _, p := range pts {
			// Точки должны быть конечными числами, идти по возрастанию времени, внутри срока хранения и не из будущего.
			if !validTrafficPoint(p) || p[0] <= last || p[0] > now+5 {
				continue
			}
			clean = append(clean, p)
			last = p[0]
		}
		if len(clean) > 0 {
			restored[pk] = clean
			total += len(clean)
		}
	}

	d.trafficMu.Lock()
	d.trafficRestored = restored
	d.trafficMu.Unlock()
	d.log(fmt.Sprintf("traffic history restored: %d peers, %d points", len(restored), total))
}

// ═══════════════════════════════════════════════════════════════════════
// 16. MAIN
// ═══════════════════════════════════════════════════════════════════════

// ─── main ─────────────────────────────────────────────────────────────
func main() {
	syscall.Umask(0027)

	cfg := loadConfig()
	d := NewDaemon(cfg)
	d.initLog()

	if cfg.MailEnabled == "NO" {
		d.log("mail disabled")
	}

	lockFile := d.acquireLock()
	defer lockFile.Close()
	defer d.cleanup()

	if f, err := os.Create(d.wgErrFile); err == nil {
		f.Close()
		os.Chmod(d.wgErrFile, 0640)
	} else {
		d.wgErrFile = "/dev/null"
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	done := make(chan struct{})

	go func() {
		<-sigCh
		d.log("stopped service")
		close(done)
	}()

	d.log("started service")

	// Политики загружаются после строки "started service", чтобы в журнале она шла первой.
	d.initPolicy()
	hupCh := make(chan os.Signal, 1)
	signal.Notify(hupCh, syscall.SIGHUP)
	go func() {
		for range hupCh {
			d.log("SIGHUP: reloading policy")
			d.reloadPolicy()
		}
	}()

	d.loadTraffic()
	d.startStatsServer()
	go d.watchClientsDir(done)

	d.trimEventsByAge(cfg.EventsRetentionDays)
	lastTrim := time.Now().Unix()
	lastTrafficSave := time.Now().Unix()

	// Первый проход — сразу, не ждём INTERVAL, чтобы дашборд не был пустым.
	ok := d.pollOnce()
	if ok {
		d.firstPass = false
	}
	d.policyAfterPoll(ok)

	ticker := time.NewTicker(time.Duration(cfg.Interval) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			d.saveTraffic()
			d.stopMail()
			d.waitMail(10 * time.Second)
			return
		case <-ticker.C:
			ok := d.pollOnce()
			if ok {
				d.firstPass = false
			}
			d.policyAfterPoll(ok)

			if cfg.TrafficFile != "" {
				nowTs := time.Now().Unix()
				if nowTs-lastTrafficSave >= int64(cfg.TrafficSaveInterval) {
					d.saveTraffic()
					lastTrafficSave = nowTs
				}
			}

			if cfg.EventsTrimInterval > 0 {
				nowTs := time.Now().Unix()
				if nowTs-lastTrim >= int64(cfg.EventsTrimInterval) {
					d.trimEventsByAge(cfg.EventsRetentionDays)
					lastTrim = nowTs
				}
			}
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════
// 17. ПОЛИТИКИ
// ═══════════════════════════════════════════════════════════════════════
//
// Внутренний механизм демона: веб о нём ничего не знает, в /api/* и events.log политики
// не попадают. События политик (запуск/пропуск/ошибки команд) пишутся в POLICY_LOG_FILE строками "<время> [политика] событие" без дублирования
// в общий лог демона; если POLICY_LOG_FILE не задан, они идут в общий лог с префиксом "POLICY:". Сообщения о загрузке файла политик
// (loaded, ошибки чтения/прав, предупреждения разбора) всегда пишутся в общий лог. Файл журнала открывается на каждую запись, поэтому logrotate работает без copytruncate.
// Если POLICY_FILE не задан или файла нет — функция выключена.
// Формат файла (INI-подобный), несколько политик — несколько секций:
//
//	[name]                                      # имя политики (любое, уникальное)
//	peers = 10.10.10.2, 10.10.10.3              # IP клиентов из AllowedIPs (также можно имя клиента или публичный ключ)
//	online_to_run_command  = <shell-команда>    # выполняется при подключении ПЕРВОГО из пиров политики
//	offline_to_run_command = <shell-команда>    # выполняется при отключении ПОСЛЕДНЕГО из пиров политики
//	online_skip_if = <shell-команда>            # необязательно: если вернула 0, online-команда пропускается
//	offline_only_if_online_ran = yes            # по умолчанию yes: offline-команда только если online-команду выполнил сам демон
//	offline_delay = 0                           # секунд после ухода ПОСЛЕДНЕГО пира до offline-команды (по умолчанию 0)
//	command_timeout = 120                       # таймаут любой команды, секунд (по умолчанию 120)
//	enabled = yes                               # включена ли политика (yes/no)
//
// Хотя бы одна из команд (online/offline) должна быть задана, иначе политика пропускается.
// online-команда выполняется, когда подключается ПЕРВЫЙ из пиров политики, offline — когда уходит ПОСЛЕДНИЙ.
// Команды запускаются через "sh -c" от пользователя демона (root), поэтому файл политики должен принадлежать root
// и не быть доступным на запись группе/всем, иначе он не загружается.
// В окружение команды передаются: WG_POLICY, WG_EVENT (online|offline), WG_PEER_NAME, WG_PEER_IP, WG_PEER_PUBKEY.
// Перечитать файл без перезапуска демона: kill -HUP <pid демона>.
// Если демон перезапущен (или политики перезагружены) во время ожидания offline_delay, отложенная offline-команда восстанавливается:
// после первого успешного опроса, если сервис запускал демон, а пиров политики онлайн нет, таймер ставится заново.

// ─── Policy ───────────────────────────────────────────────────────────
type Policy struct {
	Name       string
	Peers      []string
	OnlineCmd  string
	OfflineCmd string
	SkipIf     string
	OnlyIfRan  bool
	Delay      time.Duration
	Timeout    time.Duration
	Enabled    bool

	online map[string]bool // pubkey пиров политики, которые сейчас онлайн (под policyEngine.mu)
	timer  *time.Timer
}

// ─── policyEngine ─────────────────────────────────────────────────────
type policyEngine struct {
	mu        sync.Mutex // policies, online, timers, ran
	actMu     sync.Mutex // сериализует выполнение команд
	policies  []*Policy
	ran       map[string]bool // имя политики -> online-команду выполнил демон (и offline ещё не выполнялась)
	statePath string
}

// ─── checkPolicyFileSafe ──────────────────────────────────────────────
// Команды выполняются от root, поэтому файл не должен быть изменяем посторонними.
func checkPolicyFileSafe(path string) error {
	fi, err := os.Stat(path)
	if err != nil {
		return err
	}
	if fi.Mode().Perm()&0022 != 0 {
		return fmt.Errorf("file is group/world-writable (chmod 600 or 640)")
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && os.Geteuid() == 0 && st.Uid != 0 {
		return fmt.Errorf("file must be owned by root")
	}
	return nil
}

// ─── parsePolicy ──────────────────────────────────────────────────────
func parsePolicy(path string) ([]*Policy, []string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	var (
		list  []*Policy
		warns []string
		cur   *Policy
	)
	flush := func() {
		if cur == nil {
			return
		}
		switch {
		case len(cur.Peers) == 0:
			warns = append(warns, fmt.Sprintf("policy [%s]: no peers, skipped", cur.Name))
		case cur.OnlineCmd == "" && cur.OfflineCmd == "":
			warns = append(warns, fmt.Sprintf("policy [%s]: no commands, skipped", cur.Name))
		default:
			list = append(list, cur)
		}
		cur = nil
	}

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" || line[0] == '#' || line[0] == ';' {
			continue
		}
		// Хвостовой комментарий — только " #" (пробел + решётка), чтобы не ломать команды с ';'.
		if i := strings.Index(line, " #"); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			flush()
			cur = &Policy{
				Name:      strings.TrimSpace(line[1 : len(line)-1]),
				OnlyIfRan: true,
				Timeout:   120 * time.Second,
				Enabled:   true,
				online:    make(map[string]bool),
			}
			for _, o := range list {
				if o.Name == cur.Name {
					warns = append(warns, fmt.Sprintf("policy [%s]: duplicate name", cur.Name))
				}
			}
			continue
		}
		kv := strings.SplitN(line, "=", 2)
		if len(kv) != 2 || cur == nil {
			warns = append(warns, fmt.Sprintf("line %d: ignored", lineNo))
			continue
		}
		key := strings.ToLower(strings.TrimSpace(kv[0]))
		val := strings.TrimSpace(kv[1])
		yes := func() bool {
			switch strings.ToLower(val) {
			case "no", "false", "0", "off":
				return false
			}
			return true
		}
		secs := func(def time.Duration, max int) time.Duration {
			n, err := strconv.Atoi(val)
			if err != nil || n < 0 || n > max {
				warns = append(warns, fmt.Sprintf("line %d: bad value for %s, default used", lineNo, key))
				return def
			}
			return time.Duration(n) * time.Second
		}
		switch key {
		case "peers":
			for _, p := range strings.Split(val, ",") {
				if p = strings.TrimSpace(p); p != "" {
					cur.Peers = append(cur.Peers, p)
				}
			}
		case "online_to_run_command":
			cur.OnlineCmd = val
		case "offline_to_run_command", "oflline_to_run_command":
			cur.OfflineCmd = val
		case "online_skip_if":
			cur.SkipIf = val
		case "offline_only_if_online_ran":
			cur.OnlyIfRan = yes()
		case "offline_delay":
			cur.Delay = secs(0, 86400)
		case "command_timeout":
			cur.Timeout = secs(120*time.Second, 3600)
			if cur.Timeout == 0 {
				cur.Timeout = 120 * time.Second
			}
		case "enabled":
			cur.Enabled = yes()
		default:
			warns = append(warns, fmt.Sprintf("line %d: unknown key %q", lineNo, key))
		}
	}
	flush()
	if err := sc.Err(); err != nil {
		return nil, warns, err
	}
	return list, warns, nil
}

// ─── matches ──────────────────────────────────────────────────────────
// Пир подходит под политику по IP из AllowedIPs, имени клиента (без учёта регистра) или публичному ключу.
func (p *Policy) matches(pk, name, ips string) bool {
	for _, want := range p.Peers {
		if want == pk || strings.EqualFold(want, name) {
			return true
		}
		for _, part := range strings.Split(ips, ",") {
			if firstIP(part) == want {
				return true
			}
		}
	}
	return false
}

// firstIP — "10.10.10.5/32" -> "10.10.10.5".
func firstIP(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	return s
}

// ─── состояние ────────────────────────────────────────────────────────
func (e *policyEngine) loadState() {
	e.ran = make(map[string]bool)
	if data, err := os.ReadFile(e.statePath); err == nil {
		json.Unmarshal(data, &e.ran)
		if e.ran == nil {
			e.ran = make(map[string]bool)
		}
	}
}

// saveStateLocked вызывается под e.mu.
func (e *policyEngine) saveStateLocked() {
	data, err := json.Marshal(e.ran)
	if err != nil {
		return
	}
	tmp := e.statePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0640); err != nil {
		return
	}
	os.Rename(tmp, e.statePath)
}

// ─── initPolicy ───────────────────────────────────────────────────────
func (d *Daemon) initPolicy() {
	if d.cfg.PolicyFile == "" {
		return
	}
	d.policy = &policyEngine{statePath: filepath.Join(d.cfg.LogDir, "policy.state")}
	d.policy.loadState()
	d.reloadPolicy()
}

// ─── reloadPolicy ─────────────────────────────────────────────────────
// Вызывается при старте и по SIGHUP. При ошибке разбора/прав остаются прежние политики.
func (d *Daemon) reloadPolicy() {
	e := d.policy
	if e == nil {
		return
	}
	if err := checkPolicyFileSafe(d.cfg.PolicyFile); err != nil {
		d.log("POLICY: WARN: " + d.cfg.PolicyFile + ": " + err.Error() + " (policy unchanged)")
		return
	}
	list, warns, err := parsePolicy(d.cfg.PolicyFile)
	if err != nil {
		d.log("POLICY: cannot read " + d.cfg.PolicyFile + ": " + err.Error() + " (policy unchanged)")
		return
	}
	for _, w := range warns {
		d.log("POLICY: WARN: " + w)
	}

	// Кто сейчас онлайн — под peersMu (порядок блокировок: peersMu -> e.mu, как в основном цикле).
	d.peersMu.Lock()
	e.mu.Lock()
	for _, old := range e.policies {
		if old.timer != nil {
			old.timer.Stop()
		}
	}
	for _, p := range list {
		for pk, st := range d.peers {
			if st.WasOnline && p.matches(pk, d.clientNameByPubkey(pk), st.LastIPs) {
				p.online[pk] = true
			}
		}
	}
	e.policies = list
	e.mu.Unlock()
	d.peersMu.Unlock()

	active := 0
	for _, p := range list {
		if p.Enabled {
			active++
		}
	}
	d.log(fmt.Sprintf("POLICY: loaded %d policy(ies), %d enabled from %s", len(list), active, d.cfg.PolicyFile))
	if d.policyReady.Load() {
		d.policyReconcile()
	}
}

// ─── policyReconcile ──────────────────────────────────────────────────
// Восстанавливает отложенные offline-команды, потерянные при перезапуске демона или перезагрузке политик:
// если демон ранее запустил online-команду (ran=true), а подключённых пиров политики сейчас нет и таймера нет,
// ставится таймер offline_delay. Иначе запущенное демоном осталось бы работать без клиентов.
// Вызывается после первого успешного опроса (когда уже известно, кто онлайн) и после reloadPolicy.
func (d *Daemon) policyReconcile() {
	e := d.policy
	if e == nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, p := range e.policies {
		if !p.Enabled || !e.ran[p.Name] || len(p.online) > 0 || p.timer != nil {
			continue
		}
		d.plog(fmt.Sprintf("POLICY: [%s] started by daemon earlier and no peers online, offline command in %s", p.Name, p.Delay))
		pp := p
		p.timer = time.AfterFunc(p.Delay, func() { d.policyRunOffline(pp, "", "", "") })
	}
}

// policyAfterPoll вызывается из главного цикла после каждого опроса; один раз включает восстановление.
func (d *Daemon) policyAfterPoll(ok bool) {
	if !ok || d.policy == nil || d.policyReady.Load() {
		return
	}
	d.policyReady.Store(true)
	d.policyReconcile()
}

// ─── runShell ─────────────────────────────────────────────────────────
// Выполняет команду через sh -c с таймаутом; при таймауте убивает всю группу процессов.
func runShell(cmdline string, timeout time.Duration, env []string) (int, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", cmdline)
	cmd.Env = append(os.Environ(), env...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(truncateUTF8(string(out), 300))
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode(), text, nil
		}
		return -1, text, err
	}
	return 0, text, nil
}

func policyEnv(p *Policy, event, name, ip, pk string) []string {
	return []string{"WG_POLICY=" + p.Name, "WG_EVENT=" + event, "WG_PEER_NAME=" + name, "WG_PEER_IP=" + ip, "WG_PEER_PUBKEY=" + pk}
}

// ─── policyPeerUp ─────────────────────────────────────────────────────
// Вызывается из основного цикла, когда пир стал онлайн. Быстрая: команды уходят в горутину.
func (d *Daemon) policyPeerUp(pk, name, ips string) {
	e := d.policy
	if e == nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, p := range e.policies {
		if !p.Enabled || !p.matches(pk, name, ips) {
			continue
		}
		wasEmpty := len(p.online) == 0
		p.online[pk] = true
		pending := false
		if p.timer != nil {
			pending = p.timer.Stop() // пир вернулся до истечения offline_delay: offline-команда отменена
			p.timer = nil
		}
		if !wasEmpty {
			continue
		}
		if pending {
			d.plog(fmt.Sprintf("POLICY: [%s] peer %s is back before offline_delay, offline command cancelled", p.Name, name))
			continue
		}
		if p.OnlineCmd == "" {
			continue
		}
		ip := firstIP(strings.Split(ips, ",")[0])
		d.plog(fmt.Sprintf("POLICY: [%s] first peer %s (%s) online", p.Name, name, ip))
		go d.policyRunOnline(p, name, ip, pk)
	}
}

// ─── policyPeerDown ───────────────────────────────────────────────────
func (d *Daemon) policyPeerDown(pk, name, ips string) {
	e := d.policy
	if e == nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, p := range e.policies {
		if !p.Enabled || !p.matches(pk, name, ips) {
			continue
		}
		if !p.online[pk] {
			continue
		}
		delete(p.online, pk)
		if len(p.online) > 0 {
			d.plog(fmt.Sprintf("POLICY: [%s] peer %s offline, %d peer(s) still online", p.Name, name, len(p.online)))
			continue
		}
		if p.timer != nil {
			p.timer.Stop()
		}
		ip := firstIP(strings.Split(ips, ",")[0])
		d.plog(fmt.Sprintf("POLICY: [%s] last peer %s (%s) offline, offline command in %s", p.Name, name, ip, p.Delay))
		pp := p
		p.timer = time.AfterFunc(p.Delay, func() { d.policyRunOffline(pp, name, ip, pk) })
	}
}

// ─── policyRunOnline ──────────────────────────────────────────────────
func (d *Daemon) policyRunOnline(p *Policy, name, ip, pk string) {
	e := d.policy
	e.actMu.Lock()
	defer e.actMu.Unlock()

	env := policyEnv(p, "online", name, ip, pk)
	if p.SkipIf != "" {
		code, _, err := runShell(p.SkipIf, p.Timeout, env)
		if err != nil {
			d.plog(fmt.Sprintf("POLICY: WARN: [%s] online_skip_if failed to run: %s", p.Name, err.Error()))
		} else if code == 0 {
			e.mu.Lock()
			own := e.ran[p.Name]
			e.mu.Unlock()
			if own {
				d.plog(fmt.Sprintf("POLICY: [%s] online_skip_if matched, online command skipped (started earlier by daemon, offline command will still run)", p.Name))
			} else {
				d.plog(fmt.Sprintf("POLICY: [%s] online_skip_if matched, online command skipped (not started by daemon, offline command will not run)", p.Name))
			}
			return
		}
	}
	code, out, err := runShell(p.OnlineCmd, p.Timeout, env)
	switch {
	case err != nil:
		d.plog(fmt.Sprintf("POLICY: WARN: [%s] online command failed to run: %s", p.Name, err.Error()))
	case code != 0:
		d.plog(fmt.Sprintf("POLICY: WARN: [%s] online command exit=%d: %s", p.Name, code, out))
	default:
		e.mu.Lock()
		e.ran[p.Name] = true
		e.saveStateLocked()
		e.mu.Unlock()
		d.plog(fmt.Sprintf("POLICY: [%s] online command done", p.Name))
	}
}

// ─── policyRunOffline ─────────────────────────────────────────────────
func (d *Daemon) policyRunOffline(p *Policy, name, ip, pk string) {
	e := d.policy
	e.actMu.Lock()
	defer e.actMu.Unlock()

	e.mu.Lock()
	if len(p.online) > 0 { // кто-то успел вернуться
		e.mu.Unlock()
		return
	}
	p.timer = nil
	ran := e.ran[p.Name]
	e.mu.Unlock()

	if p.OnlyIfRan && !ran {
		d.plog(fmt.Sprintf("POLICY: [%s] online command was not run by daemon - offline command skipped", p.Name))
		return
	}
	if p.OfflineCmd != "" {
		code, out, err := runShell(p.OfflineCmd, p.Timeout, policyEnv(p, "offline", name, ip, pk))
		switch {
		case err != nil:
			d.plog(fmt.Sprintf("POLICY: WARN: [%s] offline command failed to run: %s", p.Name, err.Error()))
			return
		case code != 0:
			d.plog(fmt.Sprintf("POLICY: WARN: [%s] offline command exit=%d: %s", p.Name, code, out))
			return
		}
		d.plog(fmt.Sprintf("POLICY: [%s] offline command done", p.Name))
	}
	e.mu.Lock()
	delete(e.ran, p.Name)
	e.saveStateLocked()
	e.mu.Unlock()
}

// ─── plog ─────────────────────────────────────────────────────────────
// Пишет событие политики в отдельный журнал POLICY_LOG_FILE (без дублирования в общий лог демона).
// Строка журнала: "2026-11-04 13:16:08 [name] offline command done" (префикс "POLICY: " отбрасывается).
// Если POLICY_LOG_FILE не задан или запись не удалась, сообщение уходит в общий лог демона.
func (d *Daemon) plog(msg string) {
	if d.cfg.PolicyLogFile == "" {
		d.log(msg)
		return
	}
	line := fmt.Sprintf("%s %s\n", time.Now().Format(policyLogTimeFmt), strings.TrimPrefix(msg, "POLICY: "))
	d.policyLogMu.Lock()
	defer d.policyLogMu.Unlock()
	// Файл открывается на каждую запись: после ротации logrotate'ом пишем уже в новый файл.
	f, err := os.OpenFile(d.cfg.PolicyLogFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0640)
	if err != nil {
		d.log("POLICY: WARN: cannot write " + d.cfg.PolicyLogFile + ": " + err.Error() + "; event: " + msg)
		return
	}
	defer f.Close()
	if _, err := f.WriteString(line); err != nil {
		d.log("POLICY: WARN: cannot write " + d.cfg.PolicyLogFile + ": " + err.Error() + "; event: " + msg)
	}
}

const policyLogTimeFmt = "2006-01-02 15:04:05"
