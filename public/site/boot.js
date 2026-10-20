document.documentElement.className += " js";
// Fonte (Google Fonts) sem bloquear a primeira renderizacao: entra depois, trocando a fonte do sistema (font-display: swap).
(function () {
  var l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap";
  l.media = "print";
  l.onload = function () { l.media = "all"; };
  document.head.appendChild(l);
})();
