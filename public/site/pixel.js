// Pixel da Meta (navegador) da landing. So o ID do Pixel (publico) fica aqui; o token de acesso da API de Conversoes e SEGREDO e nunca vai para o navegador.
!function (f, b, e, v, n, t, s) {
  if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
  if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
  t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
}(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
fbq("init", "2049397675719435");
fbq("track", "PageView");
// A landing avisa seus eventos por "alice:track" (sem dados pessoais); aqui o formulario enviado vira "Lead" e o clique no WhatsApp vira "Contact".
window.addEventListener("alice:track", function (ev) {
  try {
    var n = ev && ev.detail && ev.detail.event;
    if (n === "alice_lead_submitted") window.fbq("track", "Lead");
    else if (n === "alice_whatsapp_click") window.fbq("track", "Contact");
  } catch (e) { /* o pixel nunca atrapalha a pagina */ }
});
