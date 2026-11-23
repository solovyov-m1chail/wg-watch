#!/bin/bash
# Файл: /opt/wg-watch/src/daemon/build.sh
# Скрипт сборки и установки wg-watch-daemon: gofmt, go vet, go build, установка прав.
set -e

echo "=========================================="
echo "  Сборка wg-watch-daemon"
echo "=========================================="

# Запрашиваем подтверждение, по умолчанию — продолжать.
read -r -p "Вы хотите собрать и установить демон? (Y/n) " answer
case ${answer:0:1} in
    n|N ) echo "Отменено."; exit 0 ;;
    * ) ;;
esac

cd /opt/wg-watch/src/daemon

# Проверяем форматирование (gofmt).
echo "-> 1. Проверка форматирования (gofmt)..."
gofmt -l .

# Запускаем статический анализ (go vet).
echo "-> 2. Статический анализ (go vet)..."
go vet ./...

# Компилируем статический бинарник с обрезанными символами.
echo "-> 3. Компиляция..."
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /opt/wg-watch/bin/wg-watch-daemon .

# Устанавливаем владельца и права на бинарник.
echo "-> 4. Установка прав..."
chown root:root /opt/wg-watch/bin/wg-watch-daemon
chmod 0750 /opt/wg-watch/bin/wg-watch-daemon

echo "Готово! Демон собран."
echo "Не забудьте перезапустить сервис:"
echo "systemctl restart wg-watch-daemon.service"
