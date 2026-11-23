// Файл: /opt/wg-watch/src/manager/wg-watch-manager.go
// HTTP-агент управления клиентами wg-watch: принимает /api/create, /api/delete, /api/config и запускает bash-скрипты create-client.sh, delete-client.sh и download-client-config.sh с таймаутом, возвращая их JSON-вывод как есть.
// Слушает MANAGER_HOST:MANAGER_PORT (по умолчанию 127.0.0.1:18083).
// Все /api/* защищены общим секретом MANAGER_TOKEN (заголовок X-Manager-Token), сравнение constant-time; /healthz доступен без токена для мониторинга.
// Длина MANAGER_TOKEN проверяется на старте (TOKEN_MIN_LEN, по умолчанию 32).
// CLIENT_NAME_MAX (по умолчанию 64) задаёт допустимую длину имени клиента и должен совпадать с Flask; имя проверяется регуляркой.
// CLIENT_SCRIPT_TIMEOUT (по умолчанию 30 с) — таймаут скрипта; должен быть меньше MANAGER_TIMEOUT во Flask, иначе Flask оборвёт запрос раньше, чем скрипт завершится.
// create/delete сериализуются мьютексом (меняют конфиг WireGuard и выдают IP), скачивание конфига блокировку не берёт.
// Контекст выполнения скрипта не зависит от запроса: если Flask оборвёт соединение, скрипт всё равно дойдёт до конца.
// Ответ скрипта возвращается как есть с корректным статусом: exit==0 и ok:true → 200, ok:false → 400, прочие ошибки/невалидный JSON/нет ok — 500.
// Коды выхода: 0 — норма, 1 — ошибка, 78 (EX_CONFIG) — ошибка конфигурации; systemd с RestartPreventExitStatus=78 не рестартит сервис в цикле.
package main

import (
        "context"
        "crypto/subtle"
        "encoding/json"
        "fmt"
        "net/http"
        "os"
        "log"
        "net"
        "os/exec"
        "os/signal"
        "path/filepath"
        "regexp"
        "strconv"
        "strings"
        "sync"
        "syscall"
        "time"
        "unicode/utf8"
)

// ═══════════════════════════════════════════════════════════════════════
// 1. КОНСТАНТЫ
// ═══════════════════════════════════════════════════════════════════════

// ─── Коды выхода ──────────────────────────────────────────────────────
// EX_CONFIG: systemd с RestartPreventExitStatus=78 не рестартит.
const (
        exitOK     = 0
        exitErr    = 1
        exitConfig = 78

        maxBodyBytes  = 64 * 1024
        maxStderrLen  = 500
        maxNameLenLim = 255

        // Сколько ждать завершения активных запросов при остановке сервиса.
        shutdownTimeout = 10 * time.Second
)

// ═══════════════════════════════════════════════════════════════════════
// 2. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
// ═══════════════════════════════════════════════════════════════════════

// ─── managerToken ─────────────────────────────────────────────────────
// Общий секрет с Flask, заполняется в loadEnvFile+main().
var managerToken string

// ─── scriptTimeout ────────────────────────────────────────────────────
// Таймаут bash-скрипта, заполняется в main() из env.
var scriptTimeout time.Duration
// ─── scriptMu ─────────────────────────────────────────────────────────
// Сериализует create/delete: они меняют конфиг WireGuard и выдают IP-адреса.
var scriptMu sync.Mutex

// ─── validName ────────────────────────────────────────────────────────
// Регулярка для имени клиента, строится в main() из CLIENT_NAME_MAX.
var validName *regexp.Regexp

// ─── validIP ──────────────────────────────────────────────────────────
// Допустимый формат IP/CIDR в --ip.
var validIP = regexp.MustCompile(`^[0-9a-fA-F:.]+(/[0-9]{1,3})?$`)

// ─── ClientRequest ────────────────────────────────────────────────────
type ClientRequest struct {
        Name string `json:"name"`
        IP   string `json:"ip,omitempty"`
}

// ═══════════════════════════════════════════════════════════════════════
// 3. УТИЛИТЫ
// ═══════════════════════════════════════════════════════════════════════

// ─── fatalExit ────────────────────────────────────────────────────────
// Логирует причину и выходит с кодом EX_CONFIG: systemd с RestartPreventExitStatus=78 не будет перезапускать сервис в цикле.
func fatalExit(msg string) {
        log.Printf("FATAL: %s", msg)
        fmt.Fprintln(os.Stderr, msg)
        os.Exit(exitConfig)
}

// ─── truncateUTF8 ─────────────────────────────────────────────────────
// Обрезает строку до max байт по границе руны.
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

// ─── writeJSONError ───────────────────────────────────────────────────
// Отдаёт JSON-ошибку с корректным Content-Type.
func writeJSONError(w http.ResponseWriter, code int, errMsg string) {
        w.Header().Set("Content-Type", "application/json")
        w.Header().Set("Cache-Control", "no-store")
        w.WriteHeader(code)
        json.NewEncoder(w).Encode(map[string]interface{}{
                "ok":    false,
                "error": errMsg,
        })
}

// ═══════════════════════════════════════════════════════════════════════
// 4. ЗАГРУЗКА ENV
// ═══════════════════════════════════════════════════════════════════════

// ─── loadEnvFile ──────────────────────────────────────────────────────
// Читает простой .env файл (KEY=VALUE) и устанавливает переменные.
// Уже заданные в окружении переменные (включая пустые) не перезаписываются; снимает внешние одинарные/двойные кавычки у значений.
func loadEnvFile(path string) {
        data, err := os.ReadFile(path)
        if err != nil {
                return
        }
        for _, line := range strings.Split(string(data), "\n") {
                line = strings.TrimSpace(line)
                if line == "" || strings.HasPrefix(line, "#") {
                        continue
                }
                parts := strings.SplitN(line, "=", 2)
                if len(parts) != 2 {
                        continue
                }
                key := strings.TrimSpace(parts[0])
                if key == "" {
                        continue
                }
                val := strings.TrimSpace(parts[1])
                if n := len(val); n >= 2 {
                        first, last := val[0], val[n-1]
                        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
                                val = val[1 : n-1]
                        }
                }
                if _, exists := os.LookupEnv(key); !exists {
                        os.Setenv(key, val)
                }
        }
}

// ═══════════════════════════════════════════════════════════════════════
// 5. ПРОВЕРКА ТОКЕНА
// ═══════════════════════════════════════════════════════════════════════

// ─── requireToken ─────────────────────────────────────────────────────
// Проверяет заголовок X-Manager-Token за постоянное время; сравнение constant-time защищает от timing-атак на секрет.
func requireToken(next http.HandlerFunc) http.HandlerFunc {
        want := []byte(managerToken)
        return func(w http.ResponseWriter, r *http.Request) {
                got := []byte(r.Header.Get("X-Manager-Token"))
// Ранний выход по длине: сама длина токена — не секрет, а ConstantTimeCompare требует одинаковых длин.
                if len(got) != len(want) || subtle.ConstantTimeCompare(got, want) != 1 {
                        log.Printf("AUTH: rejected %s from %s", r.URL.Path, r.RemoteAddr)
                        writeJSONError(w, http.StatusUnauthorized, "unauthorized")
                        return
                }
                next(w, r)
        }
}

// ═══════════════════════════════════════════════════════════════════════
// 6. ОБРАБОТЧИКИ
// ═══════════════════════════════════════════════════════════════════════

// ─── handleCreate ─────────────────────────────────────────────────────
func handleCreate(w http.ResponseWriter, r *http.Request) {
        handleScript(w, r, "create-client.sh", http.MethodPost)
}

// ─── handleDelete ─────────────────────────────────────────────────────
func handleDelete(w http.ResponseWriter, r *http.Request) {
        handleScript(w, r, "delete-client.sh", http.MethodPost)
}

// ─── handleConfig ─────────────────────────────────────────────────────
func handleConfig(w http.ResponseWriter, r *http.Request) {
        handleScript(w, r, "download-client-config.sh", http.MethodGet)
}

// ─── handleScript ─────────────────────────────────────────────────────
// Общая обвязка вызова bash-скрипта; allowedMethod — единственный разрешённый HTTP-метод для этого эндпоинта.
func handleScript(w http.ResponseWriter, r *http.Request, scriptName, allowedMethod string) {
        if r.Method != allowedMethod {
                w.Header().Set("Allow", allowedMethod)
                writeJSONError(w, http.StatusMethodNotAllowed, "method_not_allowed")
                return
        }

// Ограничиваем тело запроса.
        r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)

        var req ClientRequest
        if r.Method == http.MethodPost {
                if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                        log.Printf("ERROR: invalid json from %s: %v", r.RemoteAddr, err)
                        writeJSONError(w, http.StatusBadRequest, "invalid_json")
                        return
                }
        } else {
                req.Name = r.URL.Query().Get("name")
                req.IP = r.URL.Query().Get("ip")
        }

        name := strings.TrimSpace(req.Name)
        ip := strings.TrimSpace(req.IP)

        if !validName.MatchString(name) || strings.HasPrefix(name, ".") {
                log.Printf("ERROR: invalid client name %q from %s", name, r.RemoteAddr)
                writeJSONError(w, http.StatusBadRequest, "invalid_name")
                return
        }
        if ip != "" && !validIP.MatchString(ip) {
                log.Printf("ERROR: invalid client ip %q from %s", ip, r.RemoteAddr)
                writeJSONError(w, http.StatusBadRequest, "invalid_ip")
                return
        }

        if ip != "" {
                log.Printf("ACTION: running %s for client %q (ip=%s)", scriptName, name, ip)
        } else {
                log.Printf("ACTION: running %s for client %q", scriptName, name)
        }

        // create/delete выполняем по одному; скачивание конфига только читает, ему блокировка не нужна.
        if scriptName != "download-client-config.sh" {
        	scriptMu.Lock()
        	defer scriptMu.Unlock()
        }
        // Контекст не зависит от запроса: если Flask оборвёт соединение, скрипт всё равно дойдёт до конца (иначе клиент останется наполовину создан).
        ctx, cancel := context.WithTimeout(context.Background(), scriptTimeout)
        defer cancel()

        scriptDir := os.Getenv("CLIENT_SCRIPTS_DIR")
        if scriptDir == "" {
                scriptDir = "/opt/wg-watch/scripts"
        }
        scriptPath := filepath.Join(scriptDir, scriptName)

        args := []string{"--name", name, "--json"}
        if ip != "" {
                args = append(args, "--ip", ip)
        }

        cmd := exec.CommandContext(ctx, scriptPath, args...)
        cmd.Env = os.Environ()

// Output() не даёт логам скрипта (INFO: email sent...) смешаться с JSON в stdout.
        out, err := cmd.Output()

// Определяет HTTP-статус ответа: exit==0 и ok:true → 200; exit==0 и ok:false → 400 (скрипт отработал, но операция не удалась); exit!=0 → 500, кроме случая, когда скрипт всё же отдал JSON с ok:false — тогда тоже 400; нет stdout → 500.
        if err != nil {
                if ctx.Err() == context.DeadlineExceeded {
                	log.Printf("ERROR: script %s timed out for %q (limit=%s)",
                		scriptName, name, scriptTimeout)
                } else if exitErr, ok := err.(*exec.ExitError); ok {
                        stderr := truncateUTF8(string(exitErr.Stderr), maxStderrLen)
                        log.Printf("ERROR: script %s failed for %q: %v, stderr: %s",
                                scriptName, name, err, stderr)
                } else if ctx.Err() == context.DeadlineExceeded {
                        log.Printf("ERROR: script %s timed out for %q (limit=%s)",
                                scriptName, name, scriptTimeout)
                } else {
                        log.Printf("ERROR: script %s failed for %q: %v", scriptName, name, err)
                }
                if len(out) == 0 {
                        writeJSONError(w, http.StatusInternalServerError, "internal_error")
                        return
                }
        } else {
                log.Printf("SUCCESS: %s completed for client %q", scriptName, name)
        }

// Пытается интерпретировать stdout как JSON и вернуть 400 вместо 200, если там ok:false, чтобы клиент (Flask) корректно понял «неуспех».
        statusCode := http.StatusOK
        var parsed map[string]interface{}
        if jerr := json.Unmarshal(out, &parsed); jerr != nil || parsed == nil {
// Невалидный JSON — это не штатный ответ скрипта.
                log.Printf("ERROR: script %s returned non-JSON stdout for %q (len=%d)",
                        scriptName, name, len(out))
                writeJSONError(w, http.StatusInternalServerError, "invalid_script_output")
                return
        }
        if v, exists := parsed["ok"]; exists {
                if b, isBool := v.(bool); isBool && !b {
                        statusCode = http.StatusBadRequest
                }
        } else {
// Контракт: скрипт обязан вернуть поле ok.
                log.Printf("ERROR: script %s output has no 'ok' field for %q", scriptName, name)
                writeJSONError(w, http.StatusInternalServerError, "invalid_script_output")
                return
        }

        w.Header().Set("Content-Type", "application/json")
        w.Header().Set("Cache-Control", "no-store")
        w.WriteHeader(statusCode)
        w.Write(out)
}

// ═══════════════════════════════════════════════════════════════════════
// 7. MAIN
// ═══════════════════════════════════════════════════════════════════════

// ─── main ─────────────────────────────────────────────────────────────
func main() {
        loadEnvFile("/opt/wg-watch/conf/wg-watch-manager.env")

        logPath := os.Getenv("MANAGER_LOG")
        if logPath == "" {
                logPath = "/opt/wg-watch/logs/wg-watch-manager.log"
        }

        host := os.Getenv("MANAGER_HOST")
        if host == "" {
                host = "127.0.0.1"
        }
        port := os.Getenv("MANAGER_PORT")
        if port == "" {
                port = "18083"
        }
        if p, err := strconv.Atoi(port); err != nil || p < 1 || p > 65535 {
                fmt.Fprintln(os.Stderr, "err: MANAGER_PORT")
                os.Exit(exitConfig)
        }

        if err := os.MkdirAll(filepath.Dir(logPath), 0750); err != nil {
                fmt.Fprintf(os.Stderr, "cannot create log dir: %v\n", err)
                os.Exit(exitConfig)
        }
        f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0640)
        if err != nil {
                fmt.Fprintf(os.Stderr, "cannot open log file: %v\n", err)
                os.Exit(exitConfig)
        }
        defer f.Close()

// Логируем только в файл (без дублирования в journald).
        log.SetOutput(f)

        managerToken = os.Getenv("MANAGER_TOKEN")
        if managerToken == "" {
                fatalExit("MANAGER_TOKEN is required (env or wg-watch-manager.env)")
        }

// Слишком короткий секрет легко подобрать, поэтому в работу не пускаем; порог через TOKEN_MIN_LEN (по умолчанию 32), ниже 16 не имеет смысла.
        tokenMinLen := 32
        if v := os.Getenv("TOKEN_MIN_LEN"); v != "" {
                if n, err := strconv.Atoi(v); err == nil && n >= 16 {
                        tokenMinLen = n
                }
        }
        if len(managerToken) < tokenMinLen {
                fatalExit(fmt.Sprintf("MANAGER_TOKEN is too short (min %d chars)", tokenMinLen))
        }

// CLIENT_NAME_MAX должен совпадать с Flask.
        nameMaxRaw := os.Getenv("CLIENT_NAME_MAX")
        if nameMaxRaw == "" {
                nameMaxRaw = "64"
        }
        nameMax, err := strconv.Atoi(nameMaxRaw)
        if err != nil || nameMax < 1 || nameMax > maxNameLenLim {
                fatalExit(fmt.Sprintf("CLIENT_NAME_MAX invalid: %q", nameMaxRaw))
        }
        validName = regexp.MustCompile(fmt.Sprintf(`^[A-Za-z0-9._-]{1,%d}$`, nameMax))

// CLIENT_SCRIPT_TIMEOUT должен быть меньше MANAGER_TIMEOUT во Flask (35с), иначе Flask оборвёт запрос раньше, чем скрипт завершится.
        timeoutRaw := os.Getenv("CLIENT_SCRIPT_TIMEOUT")
        if timeoutRaw == "" {
                timeoutRaw = "30"
        }
        parsed, err := time.ParseDuration(timeoutRaw + "s")
        if err != nil || parsed <= 0 {
                fatalExit(fmt.Sprintf("CLIENT_SCRIPT_TIMEOUT invalid: %q", timeoutRaw))
        }
        scriptTimeout = parsed

        mux := http.NewServeMux()
        mux.HandleFunc("/api/create", requireToken(handleCreate))
        mux.HandleFunc("/api/delete", requireToken(handleDelete))
        mux.HandleFunc("/api/config", requireToken(handleConfig))
        mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "application/json")
                w.Header().Set("Cache-Control", "no-store")
                w.Write([]byte(`{"status":"ok"}`))
        })

        addr := fmt.Sprintf("%s:%s", host, port)
        srv := &http.Server{
                Addr:              addr,
                Handler:           mux,
                ReadHeaderTimeout: 5 * time.Second,
                ReadTimeout:       15 * time.Second,
                WriteTimeout:      scriptTimeout + 15*time.Second,
                IdleTimeout:       60 * time.Second,
        }

        // Порт занимаем заранее, чтобы "started service" не писалось, если адрес занят.
        ln, err := net.Listen("tcp", addr)
        if err != nil {
                log.Printf("FATAL: cannot listen on %s: %v", addr, err)
                os.Exit(exitErr)
        }

        // Корректная остановка по SIGTERM/SIGINT: даём завершиться запросам (в том числе скриптам create/delete), но не дольше shutdownTimeout.
        stopCh := make(chan os.Signal, 1)
        signal.Notify(stopCh, syscall.SIGTERM, syscall.SIGINT)
        stopped := make(chan struct{})
        go func() {
                defer close(stopped)
                <-stopCh
                log.Printf("stopped service")
                ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
                defer cancel()
                if err := srv.Shutdown(ctx); err != nil {
                        log.Printf("WARN: shutdown: %v", err)
                }
        }()

        log.Printf("started service")
        log.Printf("Manager API listening on %s", addr)
        if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
                log.Printf("FATAL: server failed: %v", err)
                os.Exit(exitErr)
        }
        // Serve возвращается сразу после Shutdown; ждём, пока он действительно завершится.
        <-stopped
}
