Каталог собранных бинарников Go-сервисов wg-watch.

Здесь должны лежать:
  wg-watch-daemon    демон мониторинга
  wg-watch-manager   демон управления клиентами

Бинарники не хранятся в репозитории, их нужно собрать самому:
  cd /opt/wg-watch/src/daemon  && ./build.sh
  cd /opt/wg-watch/src/manager && ./build.sh

После сборки (или обновления исходников) перезапустите сервисы:
  systemctl restart wg-watch-daemon wg-watch-manager
