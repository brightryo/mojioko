// ============================================
// MOJIOKO Download Page - Common Scripts
// ============================================

(function () {
  'use strict';

  // ----- 言語自動リダイレクト（日本語版ページのみ実行）-----
  // <html lang="ja"> の場合のみ、ブラウザ言語を判定して英語版へリダイレクト
  function handleAutoRedirect() {
    var htmlLang = document.documentElement.lang;
    if (htmlLang !== 'ja') return;

    try {
      var key = 'mojioko_lang_redirected';
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');

      var lang = (navigator.language || navigator.userLanguage || '').toLowerCase();
      if (lang.indexOf('ja') !== 0) {
        window.location.href = 'en/index.html';
      }
    } catch (e) {
      // sessionStorage が使えない環境では何もしない
    }
  }

  // ----- 言語切替リンクの明示遷移処理 -----
  // ローカルファイル（file://）でもブラウザの解釈に依存せず確実に動作させる
  function attachLangSwitchHandlers() {
    var links = document.querySelectorAll('a[data-lang-link]');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', function (event) {
        event.preventDefault();
        var href = this.getAttribute('href');
        if (href) {
          window.location.href = href;
        }
      });
    }
  }

  // ----- 初期化 -----
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      handleAutoRedirect();
      attachLangSwitchHandlers();
    });
  } else {
    handleAutoRedirect();
    attachLangSwitchHandlers();
  }
})();
