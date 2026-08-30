// Preenche a base URL real e os exemplos de curl com a origem atual.
(function () {
  var base = window.location.origin + "/external/v1";
  document.querySelectorAll("[data-base]").forEach(function (el) {
    el.textContent = base;
  });
  document.querySelectorAll("pre[data-curl] code, pre code").forEach(function (el) {
    el.textContent = el.textContent.replace(/\bBASE\b/g, base);
  });
})();
