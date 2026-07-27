/*!
 * runtime.js — HTML 幻灯片运行时（无依赖，可直接内联）
 *
 * 提供：键盘/触摸/滚轮翻页、进度条、页码、URL hash 深链、overview 缩略图、
 *       打印模式（每页一张）、演讲者模式的跨窗口同步事件。
 *
 * 用法：<script src="assets/runtime.js"></script>，幻灯片为 .slide 元素。
 *       全局暴露 window.Deck（goTo/next/prev/current/count/on）。
 */
(function () {
  'use strict';

  var slides = [];
  var idx = 0;
  var listeners = {};
  var CHANNEL = 'deck-sync';
  // 某些 file:// / 沙箱环境下 BroadcastChannel 存在但构造会抛；演讲者同步是可选功能，
  // 失败时静默降级为"单窗口模式"，不能因此让整个翻页运行时挂掉。
  var bc = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') bc = new BroadcastChannel(CHANNEL);
  } catch (e) { bc = null; }

  function emit(name, payload) {
    (listeners[name] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { /* 单个订阅者出错不影响翻页 */ }
    });
  }

  function clamp(i) { return Math.max(0, Math.min(slides.length - 1, i)); }

  function render() {
    slides.forEach(function (s, i) {
      s.classList.toggle('active', i === idx);
      s.setAttribute('aria-hidden', i === idx ? 'false' : 'true');
    });
    var bar = document.querySelector('.deck-progress-bar');
    if (bar) bar.style.width = slides.length > 1 ? (idx / (slides.length - 1) * 100) + '%' : '100%';
    var num = document.querySelector('.deck-page-num');
    if (num) num.textContent = (idx + 1) + ' / ' + slides.length;
    if (history.replaceState) history.replaceState(null, '', '#' + (idx + 1));
    emit('change', { index: idx, total: slides.length });
  }

  function goTo(i, opts) {
    var next = clamp(i);
    if (next === idx) return;
    idx = next;
    render();
    if (bc && !(opts && opts.silent)) bc.postMessage({ type: 'goto', index: idx });
  }

  function next() { goTo(idx + 1); }
  function prev() { goTo(idx - 1); }

  // ── 输入 ──────────────────────────────────────────────────────────────
  function onKey(e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    switch (e.key) {
      case 'ArrowRight': case 'PageDown': case ' ': next(); e.preventDefault(); break;
      case 'ArrowLeft': case 'PageUp': prev(); e.preventDefault(); break;
      case 'Home': goTo(0); e.preventDefault(); break;
      case 'End': goTo(slides.length - 1); e.preventDefault(); break;
      case 'o': case 'O': document.body.classList.toggle('deck-overview'); break;
      case 'f': case 'F':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
        break;
      default: break;
    }
  }

  var touchX = null;
  function onTouchStart(e) { touchX = e.changedTouches[0].clientX; }
  function onTouchEnd(e) {
    if (touchX === null) return;
    var dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) (dx < 0 ? next : prev)();
    touchX = null;
  }

  var wheelLock = false;
  function onWheel(e) {
    if (wheelLock || Math.abs(e.deltaY) < 20) return;
    wheelLock = true;
    setTimeout(function () { wheelLock = false; }, 400);
    (e.deltaY > 0 ? next : prev)();
  }

  function init() {
    slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
    if (!slides.length) return;

    var fromHash = parseInt((location.hash || '').replace('#', ''), 10);
    idx = clamp(isNaN(fromHash) ? 0 : fromHash - 1);

    document.addEventListener('keydown', onKey);
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('hashchange', function () {
      var h = parseInt((location.hash || '').replace('#', ''), 10);
      if (!isNaN(h)) goTo(h - 1);
    });
    // overview 点击缩略图跳转
    slides.forEach(function (s, i) {
      s.addEventListener('click', function () {
        if (document.body.classList.contains('deck-overview')) {
          document.body.classList.remove('deck-overview');
          goTo(i);
        }
      });
    });
    if (bc) bc.onmessage = function (ev) {
      if (ev.data && ev.data.type === 'goto') goTo(ev.data.index, { silent: true });
    };
    // 打印：全部展开，避免只印出当前页
    if (window.matchMedia) {
      var mq = window.matchMedia('print');
      var onPrint = function (m) { document.body.classList.toggle('deck-print', m.matches); };
      mq.addListener && mq.addListener(onPrint);
    }
    render();
  }

  window.Deck = {
    goTo: goTo, next: next, prev: prev,
    current: function () { return idx; },
    count: function () { return slides.length; },
    on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    _init: init,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
