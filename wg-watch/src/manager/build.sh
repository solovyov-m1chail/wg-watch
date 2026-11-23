#!/bin/bash
# Файл: /opt/wg-watch/src/manager/build.sh
# Скрипт сборки и установки wg-watch-manager: gofmt, go vet, go build, установка прав.
set -e

echo "=========================================="
echo "  Сборка wg-watch-manager"
echo "=========================================="

# Запрашиваем подтверждение, по умолчанию — продолжать.
read -r -p "Вы хотите собрать и установить менеджер? (Y/n) " answer
case ${answer:0:1} in
    n|N ) echo "Отменено."; exit 0 ;;
    * ) ;;
esac

cd /opt/wg-watch/src/manager

# Проверяем форматирование (gofmt).
echo "-> 1. Проверка форматирования (gofmt)..."
gofmt -l .

# Запускаем статический анализ (go vet).
echo "-> 2. Статический анализ (go vet)..."
go vet ./...

# Компилируем статический бинарник с обрезанными символами.
echo "-> 3. Компиляция..."
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /opt/wg-watch/bin/wg-watch-manager .

# Устанавливаем владельца и права на бинарник.
echo "-> 4. Установка прав..."
chown root:root /opt/wg-watch/bin/wg-watch-manager
chmod 0750 /opt/wg-watch/bin/wg-watch-manager

echo "Готово! Менеджер собран."
echo "Не забудьте перезапустить сервис:"
echo "systemctl restart wg-watch-manager.service"
