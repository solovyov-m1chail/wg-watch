// Файл: /opt/wg-watch/web/static/js/theme-init.js
// Применяет сохранённую или системную тему до первой отрисовки страницы (анти-FOUC):
// читает wgwatch.theme из localStorage (со значением по умолчанию «auto»), при auto
// определяет светлую/тёмную по prefers-color-scheme и сразу выставляет data-theme на
// <html>. Загружается синхронно в <head>, до <link rel="stylesheet"> — чтобы страница
// отрисовалась сразу в нужной теме без вспышки светлого/тёмного фона. Всё в IIFE,
// ошибки localStorage (приватный режим, отключённое хранилище) молча игнорируются.

// ─── Анти-FOUC ────────────────────────────────────────────────────────
(function () {
try {
  var p = localStorage.getItem("wgwatch.theme") || "auto";
  var t = p === "auto"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : p;
  document.documentElement.setAttribute("data-theme", t === "light" ? "light" : "dark");
} catch (e) { /* Молча игнорируем. */ }
})();
