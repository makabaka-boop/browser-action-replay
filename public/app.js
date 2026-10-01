/* 演练页应用逻辑：标签页、表单、可重建弹窗、滚动列表、异步回写。
   暴露 window.WalkthroughApp 供回放与测试复位初始状态。 */
(function () {
  'use strict';

  var doc = document;
  var ASYNC_DELAY = 30; // 模拟“迟到的异步界面更新”

  function $(id) { return doc.getElementById(id); }

  var TABS = [
    { tab: 'wt-tab-profile', panel: 'wt-panel-profile' },
    { tab: 'wt-tab-prefs', panel: 'wt-panel-prefs' },
    { tab: 'wt-tab-activity', panel: 'wt-panel-activity' }
  ];

  var app = {
    pendingAsync: [],
    listeners: [],

    on: function (target, type, handler, useCapture) {
      target.addEventListener(type, handler, !!useCapture);
      this.listeners.push({ target: target, type: type, handler: handler, useCapture: !!useCapture });
    },

    // ---- 初始状态：回放每一步都从这里开始 ----
    reset: function () {
      var self = this;
      self.pendingAsync.forEach(clearTimeout);
      self.pendingAsync = [];

      TABS.forEach(function (t, i) {
        $(t.tab).setAttribute('aria-selected', i === 0 ? 'true' : 'false');
        $(t.panel).classList.toggle('wt-hidden', i !== 0);
      });

      var form = $('wt-profile-form');
      form.reset();
      $('wt-profile-status').textContent = '（未保存）';
      $('wt-theme-select').value = 'light';
      $('wt-notify-check').checked = false;
      $('wt-role-user').checked = true;
      $('wt-role-admin').checked = false;
      $('wt-async-status').textContent = '（无）';
      self._saveCount = 0;
      self._modalNote = '';

      // 弹窗覆盖层关闭，卡片回到 v0（下次打开仍会整体重建）
      var overlay = $('wt-modal-overlay');
      overlay.classList.add('wt-hidden');
      overlay.setAttribute('data-modal-version', '0');
      this._renderModalCard(0, true);

      this.renderLogs(20);
      $('wt-log-scroll').scrollTop = 0;

      doc.body.scrollTop = 0;
      if (doc.documentElement) doc.documentElement.scrollTop = 0;

      if (doc.activeElement && typeof doc.activeElement.blur === 'function') {
        doc.activeElement.blur();
      }
    },

    renderLogs: function (count) {
      var list = $('wt-log-list');
      list.innerHTML = '';
      for (var i = 1; i <= count; i++) {
        var li = doc.createElement('li');
        li.textContent = '日志 #' + i + ' · 初始条目';
        list.appendChild(li);
      }
      this._logCount = count;
    },

    appendLog: function () {
      this._logCount = (this._logCount || 0) + 1;
      var li = doc.createElement('li');
      li.textContent = '日志 #' + this._logCount + ' · 手动追加 @ ' + new Date().toLocaleTimeString();
      $('wt-log-list').appendChild(li);
    },

    // ---- 弹窗：每次打开整体重建卡片（新节点、新版本号），ID 稳定 ----
    _renderModalCard: function (version, freshInput) {
      var card = $('wt-modal-card');
      var noteVal = freshInput ? '' : (this._modalNote || '');
      card.innerHTML =
        '<h2>确认操作</h2>' +
        '<p class="wt-hint">重建版本：v' + version + '</p>' +
        '<div class="wt-field">' +
        '  <label for="wt-modal-note">备注</label>' +
        '  <input type="text" id="wt-modal-note" autocomplete="off" />' +
        '</div>' +
        '<p id="wt-modal-status" class="wt-status" data-snapshot-text>填写备注后确认</p>' +
        '<div class="wt-modal-actions">' +
        '  <button type="button" id="wt-modal-cancel" data-modal-close>取消</button>' +
        '  <button type="button" id="wt-modal-confirm" data-modal-confirm class="wt-btn wt-btn-primary">确认</button>' +
        '</div>';
      var note = $('wt-modal-note');
      note.value = noteVal;
      var self = this;
      self.on(note, 'input', function () {
        self._modalNote = note.value;
      });
    },

    openModal: function () {
      var overlay = $('wt-modal-overlay');
      var version = parseInt(overlay.getAttribute('data-modal-version') || '0', 10) + 1;
      overlay.setAttribute('data-modal-version', String(version));
      this._renderModalCard(version, true);
      this._modalNote = '';
      overlay.classList.remove('wt-hidden');
    },

    closeModal: function () {
      $('wt-modal-overlay').classList.add('wt-hidden');
    },

    confirmModal: function () {
      // 先关闭弹窗，再延迟回写底部状态 —— 典型的“迟到异步更新”
      this.closeModal();
      var self = this;
      var timer = setTimeout(function () {
        $('wt-async-status').textContent = '弹窗已于 v' +
          $('wt-modal-overlay').getAttribute('data-modal-version') + ' 确认';
        self.pendingAsync = self.pendingAsync.filter(function (t) { return t !== timer; });
      }, ASYNC_DELAY);
      self.pendingAsync.push(timer);
    },

    init: function () {
      var self = this;

      TABS.forEach(function (t) {
        self.on($(t.tab), 'click', function () {
          TABS.forEach(function (o) {
            var selected = o.tab === t.tab;
            $(o.tab).setAttribute('aria-selected', selected ? 'true' : 'false');
            $(o.panel).classList.toggle('wt-hidden', !selected);
          });
        });
      });

      self.on($('wt-open-modal-btn'), 'click', function () { self.openModal(); });

      // 事件委托：弹窗按钮在重建后仍然可用
      self.on($('wt-modal-overlay'), 'click', function (e) {
        var t = e.target;
        if (t === $('wt-modal-overlay')) { self.closeModal(); return; }
        if (t.closest && t.closest('[data-modal-close]')) { self.closeModal(); return; }
        if (t.closest && t.closest('[data-modal-confirm]')) { self.confirmModal(); return; }
      });

      self.on($('wt-profile-form'), 'submit', function (e) {
        e.preventDefault();
        var name = $('wt-name-input').value.trim() || '匿名';
        self._saveCount = (self._saveCount || 0) + 1;
        $('wt-profile-status').textContent = '第 ' + self._saveCount + ' 次保存：' + name;
      });

      self.on($('wt-add-log-btn'), 'click', function () { self.appendLog(); });

      self.reset();
    }
  };

  window.WalkthroughApp = app;
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', function () { app.init(); });
  } else {
    app.init();
  }
})();
