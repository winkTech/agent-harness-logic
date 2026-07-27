/*!
 * fx-runtime.js — 幻灯片入场动画运行时（无依赖，配合 runtime.js 使用）
 *
 * 用法：给元素加 data-fx="fade|slide-up|slide-left|zoom|draw"，
 *       可选 data-fx-delay="120"（ms）、data-fx-duration="500"。
 *       同一页内多个元素可用 data-fx-step="1|2|3" 分步触发（按 → 键逐步显现）。
 *
 * 设计取舍：
 *   - 只用 CSS transition/transform，不引入动画库，PPT 导出/打印时可整体关闭
 *   - 尊重 prefers-reduced-motion：用户要求减少动效时直接显示终态
 *   - 分步动画在最后一步之后才把翻页交回 Deck，避免"按一下跳两页"
 */
(function () {
  'use strict';

  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var FX = {
    'fade': { from: 'opacity:0', to: 'opacity:1' },
    'slide-up': { from: 'opacity:0;transform:translateY(24px)', to: 'opacity:1;transform:none' },
    'slide-left': { from: 'opacity:0;transform:translateX(32px)', to: 'opacity:1;transform:none' },
    'zoom': { from: 'opacity:0;transform:scale(.92)', to: 'opacity:1;transform:none' },
    'draw': { from: 'opacity:0;clip-path:inset(0 100% 0 0)', to: 'opacity:1;clip-path:inset(0 0 0 0)' },
  };

  function applyStyle(el, css) {
    css.split(';').forEach(function (rule) {
      var i = rule.indexOf(':');
      if (i > 0) el.style.setProperty(rule.slice(0, i).trim(), rule.slice(i + 1).trim());
    });
  }

  function reset(el) {
    var fx = FX[el.getAttribute('data-fx')] || FX.fade;
    el.style.transition = 'none';
    applyStyle(el, fx.from);
    // 强制回流，保证下一帧的 transition 生效
    void el.offsetWidth;
  }

  function show(el) {
    var fx = FX[el.getAttribute('data-fx')] || FX.fade;
    var dur = parseInt(el.getAttribute('data-fx-duration'), 10) || 420;
    var delay = parseInt(el.getAttribute('data-fx-delay'), 10) || 0;
    if (REDUCED) { el.style.transition = 'none'; applyStyle(el, fx.to); return; }
    el.style.transition = 'all ' + dur + 'ms cubic-bezier(.22,.61,.36,1) ' + delay + 'ms';
    applyStyle(el, fx.to);
  }

  function stepsOf(slide) {
    var map = {};
    Array.prototype.forEach.call(slide.querySelectorAll('[data-fx]'), function (el) {
      var s = parseInt(el.getAttribute('data-fx-step'), 10) || 0;
      (map[s] = map[s] || []).push(el);
    });
    return map;
  }

  var state = { slide: null, step: 0, max: 0, map: {} };

  function enter(slide) {
    state.slide = slide;
    state.map = stepsOf(slide);
    state.max = Math.max.apply(null, Object.keys(state.map).map(Number).concat([0]));
    state.step = 0;
    Array.prototype.forEach.call(slide.querySelectorAll('[data-fx]'), reset);
    requestAnimationFrame(function () { (state.map[0] || []).forEach(show); });
  }

  function advance() {
    if (!state.slide || state.step >= state.max) return false;   // 交回 Deck 翻页
    state.step += 1;
    (state.map[state.step] || []).forEach(show);
    return true;                                                  // 本次按键被动画消费
  }

  function hook() {
    if (!window.Deck) return;
    var slides = document.querySelectorAll('.slide');
    window.Deck.on('change', function (e) {
      var s = slides[e.index];
      if (s) enter(s);
    });
    // 抢在 Deck 之前处理 → 键：还有未播完的步骤就先播，不翻页
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowRight' && ev.key !== ' ' && ev.key !== 'PageDown') return;
      if (advance()) { ev.stopImmediatePropagation(); ev.preventDefault(); }
    }, true);
    var cur = slides[window.Deck.current()];
    if (cur) enter(cur);
  }

  window.DeckFX = { enter: enter, advance: advance, reduced: REDUCED, effects: Object.keys(FX) };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook);
  else hook();
})();
