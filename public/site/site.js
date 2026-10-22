/* Alice — landing. Sem dependencias. O conteudo funciona sem JS; aqui entram so as interacoes e o movimento. */
(function () {
  "use strict";
  var doc = document, root = doc.documentElement;
  var $ = function (s, c) { return (c || doc).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); };

  /* ---------- preferencia de movimento ---------- */
  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  var manualOff = false;
  try { manualOff = localStorage.getItem("alice_no_motion") === "1"; } catch (e) { /* sem armazenamento: segue o padrao */ }
  if (manualOff) root.classList.add("no-motion");
  var reduced = function () { return mq.matches || root.classList.contains("no-motion"); };

  var motionBtn = $("#motionToggle");
  if (motionBtn) {
    motionBtn.setAttribute("aria-pressed", String(manualOff));
    motionBtn.textContent = manualOff ? "Retomar animações" : "Pausar animações";
    motionBtn.addEventListener("click", function () {
      var off = root.classList.toggle("no-motion");
      motionBtn.setAttribute("aria-pressed", String(off));
      motionBtn.textContent = off ? "Retomar animações" : "Pausar animações";
      try { localStorage.setItem("alice_no_motion", off ? "1" : "0"); } catch (e) { /* ok */ }
      if (off) { showAllChat(); setJourney(1); }
      sjMode();
    });
  }

  /* ---------- mensuracao (sem dados pessoais; sem IDs de terceiros) ---------- */
  var lastEvent = {};
  function track(name, props) {
    var now = Date.now();
    var key = name + JSON.stringify(props || {});
    if (lastEvent[key] && now - lastEvent[key] < 800) return; // evita duplicar o mesmo evento
    lastEvent[key] = now;
    var detail = { event: "alice_" + name };
    for (var k in (props || {})) detail[k] = props[k];
    try { if (Array.isArray(window.dataLayer)) window.dataLayer.push(detail); } catch (e) { /* ok */ }
    try { window.dispatchEvent(new CustomEvent("alice:track", { detail: detail })); } catch (e) { /* ok */ }
  }
  var once = {};
  function trackOnce(name, props) { var k = name + JSON.stringify(props || {}); if (once[k]) return; once[k] = 1; track(name, props); }

  /* ---------- origem do visitante (UTM e referrer), preservada na sessao ---------- */
  var ATTR_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid"];
  function readAttribution() {
    var stored = {};
    try { stored = JSON.parse(sessionStorage.getItem("alice_attr") || "{}") || {}; } catch (e) { stored = {}; }
    var params = new URLSearchParams(location.search);
    var fresh = false;
    ATTR_KEYS.forEach(function (k) { var v = params.get(k); if (v) { stored[k] = v.slice(0, 200); fresh = true; } });
    if (!stored.landing) stored.landing = (location.pathname + (fresh ? "?" + ATTR_KEYS.filter(function (k) { return params.get(k); }).map(function (k) { return k + "=" + params.get(k); }).join("&") : "")).slice(0, 300);
    if (!stored.referrer && doc.referrer) { try { var r = new URL(doc.referrer); if (r.host !== location.host) stored.referrer = r.origin + r.pathname; } catch (e) { /* ok */ } }
    try { sessionStorage.setItem("alice_attr", JSON.stringify(stored)); } catch (e) { /* ok */ }
    return stored;
  }
  var attribution = readAttribution();

  /* ---------- ano, cabecalho, menu ---------- */
  var year = $("#year"); if (year) year.textContent = new Date().getFullYear();
  var header = $("#header");
  var toggle = $("#navToggle");
  function setMenu(open) { header.classList.toggle("open", open); if (toggle) { toggle.setAttribute("aria-expanded", String(open)); toggle.setAttribute("aria-label", open ? "Fechar menu" : "Abrir menu"); } }
  if (toggle) toggle.addEventListener("click", function () { setMenu(!header.classList.contains("open")); });
  $$("#mobileMenu a").forEach(function (a) { a.addEventListener("click", function () { setMenu(false); }); });
  doc.addEventListener("keydown", function (e) { if (e.key === "Escape" && header.classList.contains("open")) { setMenu(false); toggle.focus(); } });
  var onScroll = function () { header.classList.toggle("scrolled", window.scrollY > 8); };
  onScroll();
  /* o "alice." do hero acompanha o menu depois que o hero sai da tela */
  var heroLogo = $(".hero-logo"), dock = $("#brandDock");
  if (heroLogo && dock && "IntersectionObserver" in window) {
    new IntersectionObserver(function (es) {
      var gone = !es[0].isIntersecting && es[0].boundingClientRect.bottom < 80;
      header.classList.toggle("dock-on", gone); dock.tabIndex = gone ? 0 : -1;
    }, { rootMargin: "-76px 0px 0px 0px" }).observe(heroLogo);
  }

  /* ---------- aparecer ao rolar, com stagger ---------- */
  var reveals = $$(".reveal");
  ["pain-grid", "res-grid", "steps", "trust", "faq", "two-modes", "ctl-grid", "factors"].forEach(function (cls) {
    $$("." + cls).forEach(function (g) { Array.prototype.forEach.call(g.children, function (el, i) { el.style.setProperty("--reveal-delay", (i % 6 * 0.07).toFixed(2) + "s"); }); });
  });
  if ("IntersectionObserver" in window && !reduced()) {
    var rio = new IntersectionObserver(function (es) { es.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add("in"); rio.unobserve(en.target); } }); }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    reveals.forEach(function (el) { rio.observe(el); });
    setTimeout(function () { reveals.forEach(function (el) { el.classList.add("in"); }); }, 5000); // rede de seguranca: nada fica invisivel
  } else { reveals.forEach(function (el) { el.classList.add("in"); }); }

  /* ---------- pausa de animacoes fora da tela ---------- */
  if ("IntersectionObserver" in window) {
    var vio = new IntersectionObserver(function (es) { es.forEach(function (en) { en.target.classList.toggle("is-visible", en.isIntersecting); }); }, { rootMargin: "80px" });
    $$(".wsep, .mock, .hero").forEach(function (el) { vio.observe(el); });
  } else { $$(".wsep, .mock, .hero").forEach(function (el) { el.classList.add("is-visible"); }); }

  /* ---------- conversa demonstrativa (mensagens surgindo em sequencia) ---------- */
  var steps = $$(".chat [data-step]");
  var typing = $(".chat .typing");
  var chatTimer = null, chatStarted = false;
  function showAllChat() { clearTimeout(chatTimer); steps.forEach(function (s) { s.classList.add("on"); }); if (typing) typing.classList.remove("on"); }
  function playChat() {
    if (chatStarted) return; chatStarted = true;
    if (reduced()) { showAllChat(); return; }
    var i = 0;
    (function next() {
      if (i >= steps.length) { if (typing) typing.classList.remove("on"); return; }
      var el = steps[i];
      var isAlice = el.classList.contains("alice");
      var wait = i === 0 ? 500 : isAlice ? 900 : 1100;
      if (isAlice && typing) { typing.classList.add("on"); }
      chatTimer = setTimeout(function () { if (typing) typing.classList.remove("on"); el.classList.add("on"); i++; next(); }, wait);
    })();
  }
  var chatBox = $(".chat");
  if (chatBox) {
    if ("IntersectionObserver" in window) { var cio = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { playChat(); cio.disconnect(); } }, { threshold: 0.3 }); cio.observe(chatBox); } else { playChat(); }
  }

  /* ---------- progresso visual da jornada ---------- */
  var journey = $("#journey"), jfill = $("#journeyFill"), jsteps = $$(".jstep");
  function setJourney(p) {
    if (!jfill) return;
    jfill.style.setProperty("--p", String(Math.max(0, Math.min(1, p))));
    jfill.parentNode.style.setProperty("--p", String(p));
    jfill.style.transform = (window.innerWidth >= 960 ? "scaleX(" : "scaleY(") + Math.max(0, Math.min(1, p)) + ")";
    jsteps.forEach(function (s, i) { s.classList.toggle("done", p >= (i + 0.35) / jsteps.length); });
  }
  function updateJourney() {
    if (!journey) return;
    if (reduced()) { setJourney(1); return; }
    var r = journey.getBoundingClientRect(), vh = window.innerHeight || 800;
    var p = (vh * 0.78 - r.top) / (r.height * 0.9 + 1);
    setJourney(p);
  }

  /* ---------- jornada em S (desktop): palco fixo no centro, caminho tracejado desenhado conforme a rolagem ---------- */
  var sj = $("#sJourney"), sjSvg = $("#sjSvg"), sjCps = $$("#sJourney .sj-cp");
  var SVGNS = "http://www.w3.org/2000/svg", sjSegs = [], sjDeco = [], sjHead = null, sjBuilt = false;
  var clamp01 = function (v) { return Math.max(0, Math.min(1, v)); };
  function sjBuild() {
    if (sjBuilt || !sj || !sjSvg) return; sjBuilt = true;
    var defs = doc.createElementNS(SVGNS, "defs");
    defs.innerHTML = '<linearGradient id="sjGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f59e0b"/><stop offset="1" stop-color="#c2410c"/></linearGradient>';
    sjSvg.appendChild(defs);
    var pts = sjCps.map(function (c) { return [Number(c.getAttribute("data-x")), Number(c.getAttribute("data-y"))]; });
    // formas abstratas ao fundo (aneis e arcos pontilhados) que tambem acendem com o avanco
    [["M60,330 C40,250 140,230 170,300 C200,370 100,400 60,330 Z", 0.12], ["M860,90 C940,60 980,150 920,200 C860,250 790,130 860,90 Z", 0.3], ["M80,640 C160,600 230,650 200,690", 0.62], ["M930,330 C990,380 960,470 890,480", 0.5], ["M500,20 C560,0 640,30 600,70", 0.2], ["M470,690 C540,660 620,700 660,670", 0.88]].forEach(function (d) {
      var p = doc.createElementNS(SVGNS, "path"); p.setAttribute("d", d[0]); p.setAttribute("class", "sj-deco"); p.dataset.at = d[1]; sjSvg.appendChild(p); sjDeco.push(p);
    });
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1], s = i % 2 ? 1 : -1, dx = b[0] - a[0], mx = a[0] + dx / 2, my = (a[1] + b[1]) / 2;
      // sai para o lado, faz uma curva solta no meio e chega no checkpoint seguinte
      // um unico fio continuo: sai de cada checkpoint na vertical e faz um "S" largo ate o proximo (sem quinas nem pontas soltas)
      var dy2 = b[1] - a[1], k = 1.7;
      var d = "M" + a[0] + "," + a[1] + " C" + a[0] + "," + (a[1] + dy2 * k) + " " + b[0] + "," + (b[1] - dy2 * k) + " " + b[0] + "," + b[1];
      var ghost = doc.createElementNS(SVGNS, "path"); ghost.setAttribute("d", d); ghost.setAttribute("class", "sj-ghost");
      var lit = doc.createElementNS(SVGNS, "path"); lit.setAttribute("d", d); lit.setAttribute("class", "sj-lit"); lit.setAttribute("mask", "url(#sjM" + i + ")");
      var mask = doc.createElementNS(SVGNS, "mask"); mask.setAttribute("id", "sjM" + i); mask.setAttribute("maskUnits", "userSpaceOnUse"); mask.setAttribute("x", "-100"); mask.setAttribute("y", "-100"); mask.setAttribute("width", "1200"); mask.setAttribute("height", "900");
      var mp = doc.createElementNS(SVGNS, "path"); mp.setAttribute("d", d); mp.setAttribute("fill", "none"); mp.setAttribute("stroke", "#fff"); mp.setAttribute("stroke-width", "16"); mp.setAttribute("stroke-linecap", "round");
      var len = mp.getTotalLength(); mp.style.strokeDasharray = len + " " + len; mp.style.strokeDashoffset = len;
      mask.appendChild(mp); defs.appendChild(mask); sjSvg.appendChild(ghost); sjSvg.appendChild(lit);
      sjSegs.push({ mp: mp, len: len });
    }
    sjHead = doc.createElementNS(SVGNS, "circle"); sjHead.setAttribute("r", "8"); sjHead.setAttribute("class", "sj-head"); sjSvg.appendChild(sjHead);
  }
  function sjUpdate() {
    if (!root.classList.contains("sj-on") || !sj) return;
    sjBuild();
    var r = sj.getBoundingClientRect(), total = sj.offsetHeight - (window.innerHeight || 800);
    var p = clamp01(-r.top / Math.max(1, total));
    var q = clamp01((p - 0.05) / 0.86), n = sjSegs.length, pos = q * n;
    sjSegs.forEach(function (s, i) { s.mp.style.strokeDashoffset = String(s.len * (1 - clamp01(pos - i))); });
    sjCps.forEach(function (c, i) { c.classList.toggle("on", p > 0.015 && pos >= i - 0.04); });
    sjDeco.forEach(function (d) { d.classList.toggle("on", q >= Number(d.dataset.at)); });
    if (sjHead) {
      var k = Math.min(n - 1, Math.floor(pos)), f = clamp01(pos - k), seg = sjSegs[k];
      var pt = seg ? seg.mp.getPointAtLength(seg.len * f) : null;
      if (pt && q > 0 && q < 1) { sjHead.setAttribute("cx", pt.x); sjHead.setAttribute("cy", pt.y); sjHead.style.opacity = "1"; } else sjHead.style.opacity = "0";
    }
  }
  function sjMode() { var on = !!sj && window.innerWidth >= 960 && !reduced(); root.classList.toggle("sj-on", on); if (on) sjUpdate(); }
  sjMode();
  window.addEventListener("resize", sjMode);
  if (mq.addEventListener) mq.addEventListener("change", sjMode);

  var ticking = false;
  window.addEventListener("scroll", function () {
    if (ticking) return; ticking = true;
    requestAnimationFrame(function () { onScroll(); updateJourney(); sjUpdate(); stickyUpdate(); ticking = false; });
  }, { passive: true });
  window.addEventListener("resize", function () { updateJourney(); });
  updateJourney();

  /* ---------- CTA fixo no mobile: some perto do formulario e do rodape ---------- */
  var sticky = $("#stickyCta"), final = $("#demonstracao"), foot = $(".footer");
  var inFinal = false;
  if ("IntersectionObserver" in window && final) {
    var fio = new IntersectionObserver(function (es) { inFinal = es[0].isIntersecting; stickyUpdate(); }, { threshold: 0.05 });
    fio.observe(final);
  }
  function stickyUpdate() {
    if (!sticky) return;
    var show = window.scrollY > 520 && !inFinal;
    sticky.classList.toggle("show", show);
    var wf = $("#waFloat"); if (wf) wf.classList.toggle("hide", inFinal); // no formulario ja ha botao de WhatsApp: o flutuante sai da frente
  }
  stickyUpdate();

  /* ---------- abas da demonstracao ---------- */
  var tabs = $$(".tab");
  function selectTab(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1;
      var p = doc.getElementById(t.getAttribute("aria-controls"));
      if (p) { p.classList.toggle("active", on); if (on) p.removeAttribute("hidden"); else p.setAttribute("hidden", ""); }
    });
    if (focus) tab.focus();
    trackOnce("demo_interaction", { tab: tab.getAttribute("data-tab") });
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { selectTab(t, false); });
    t.addEventListener("keydown", function (e) {
      var n = null;
      if (e.key === "ArrowRight") n = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") n = tabs[0];
      else if (e.key === "End") n = tabs[tabs.length - 1];
      if (n) { e.preventDefault(); selectTab(n, true); }
    });
  });

  /* ---------- accordions com transicao ---------- */
  $$("details.acc").forEach(function (d) {
    var sum = d.querySelector("summary"), body = d.querySelector(".acc-body");
    if (!sum || !body) return;
    sum.addEventListener("click", function (e) {
      if (reduced() || !body.animate) return; // sem animacao: comportamento nativo
      e.preventDefault();
      if (d._anim) d._anim.cancel();
      if (d.open) {
        var h = body.offsetHeight;
        d._anim = body.animate([{ height: h + "px", opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 260, easing: "cubic-bezier(.22,1,.36,1)" });
        d._anim.onfinish = function () { d.open = false; d._anim = null; body.style.height = ""; };
        d.classList.add("closing");
      } else {
        d.open = true; d.classList.remove("closing");
        var h2 = body.offsetHeight;
        d._anim = body.animate([{ height: "0px", opacity: 0 }, { height: h2 + "px", opacity: 1 }], { duration: 300, easing: "cubic-bezier(.22,1,.36,1)" });
        d._anim.onfinish = function () { d._anim = null; };
      }
    });
  });

  /* ---------- segmentos: carrossel de cards girando; clicar abre o detalhe ---------- */
  var segData = []; try { segData = JSON.parse(($("#segData") || {}).textContent || "[]"); } catch (e) { segData = []; }
  var segApp = $("#segApp"), segRing = $("#segRing"), segStageEl = $("#segStage"), segDetail = $("#segDetail"), segStatic = $("#segStatic");
  var segPrev = $("#segPrev"), segNext = $("#segNext"), segPause = $("#segPause");
  var formSeg = $("#f-seg");
  var segTouchedByUser = false;
  if (formSeg) formSeg.addEventListener("change", function () { segTouchedByUser = true; });
  function setFormSegment(id) { if (formSeg && !segTouchedByUser) formSeg.value = id; }
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var SEG_ART = {
    "estetica": ["M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z", "#e8a0a8", "#b9577a"],
    "clinicas": ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M12 8v8 M8 12h8", "#7cc4c8", "#2f8a98"],
    "saude-bem-estar": ["M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z", "#9fcf9a", "#3f9660"],
    "pet": ["M7 8.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z M11 4.7a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z M16 5.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z M19 9.7a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z M8 18c0-3 2.5-5 5-5s4.5 2 4.5 4.5c0 1.8-1.7 2.5-3 2.2-1.2-.3-1.7-.7-3-.4-1.2.3-1.8.9-2.7.4-.5-.2-.8-.7-.8-1.2z", "#f3c27a", "#c9772b"],
    "varejo": ["M5 8h14l-1 12H6L5 8z M9 8V6a3 3 0 0 1 6 0v2", "#f0a98a", "#cc5a35"],
    "casa": ["M3 11l9-7 9 7 M5 10v10h14V10 M10 20v-6h4v6", "#d8b78d", "#a06b32"],
    "tecnicos": ["M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M18.4 5.6l-2.1 2.1 M7.7 16.3l-2.1 2.1", "#a3b3c6", "#4f6788"],
    "automotivo": ["M4 15l1.6-5A2 2 0 0 1 7.5 8.6h9a2 2 0 0 1 1.9 1.4L20 15 M4.5 15h15a1.5 1.500 0 0 1 1.500 1.500V19h-18v-2.500A1.500 1.500 0 0 1 4.500 15z M7.500 17h.01 M16.500 17h.01", "#b0a8d6", "#6a5cae"],
    "educacao": ["M2 9l10-5 10 5-10 5z M6 11.500V16c0 1.500 3 3 6 3s6-1.500 6-3v-4.500", "#f1d37a", "#b98a14"],
    "profissionais": ["M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2 M3 13h18", "#9db7d9", "#3f6aa6"],
    "imoveis": ["M6 3h12a1 1 0 0 1 1 1v17H5V4a1 1 0 0 1 1-1z M9 7h2 M13 7h2 M9 11h2 M13 11h2 M10 21v-4h4v4", "#c7a6cf", "#8450a0"],
    "eventos": ["M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M3 10h18 M8 3v4 M16 3v4 M12 13l1 2 2.200.300-1.600 1.500.400 2.200-2-1.100-2 1.100.400-2.200L8.800 15.300 11 15z", "#f2a6c0", "#c0457a"],
    "turismo": ["M12 21s-6-5.500-6-11a6 6 0 0 1 12 0c0 5.500-6 11-6 11z M12 7.800a2.200 2.200 0 1 0 0 4.400 2.200 2.200 0 0 0 0-4.400z", "#8fd0e0", "#2a8fb0"],
    "alimentacao": ["M7 3v8 M5 3v5a2 2 0 0 0 4 0V3 M7 11v10 M17 21V3c-2.500 1.500-3 4.500-3 7h3", "#f4b27a", "#d05f1c"],
    "b2b": ["M3 21V11l6 4v-4l6 4V5h4v16H3z", "#a8bfa8", "#52775a"],
    "financeiro": ["M12 3l8 3v6c0 5-3.500 8-8 9-4.500-1-8-4-8-9V6z M9 12l2 2 4-4", "#8fc7b0", "#2c8466"]
  };
  function segArt(id) {
    var a = SEG_ART[id]; if (!a) return "";
    return '<span class="sc-art" aria-hidden="true" style="background:linear-gradient(135deg,' + a[1] + ',' + a[2] + ')"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="' + a[0] + '"/></svg></span>';
  }
  function renderSeg(s, swap) {
    segDetail.innerHTML = '<h3>' + esc(s.name) + '</h3><p class="seg-list">' + esc(s.list.charAt(0).toUpperCase() + s.list.slice(1)) + '.</p>' +
      '<div class="seg-cols"><div class="seg-box"><h4>Uma dor comum</h4><p>' + esc(s.pain) + '</p></div><div class="seg-box"><h4>Como a Alice ajuda</h4><p>' + esc(s.use) + '</p></div></div>' +
      '<p class="seg-note">' + esc(s.note) + '</p>' +
      '<div class="seg-foot"><a class="btn btn-primary" href="#demonstracao" data-seg-cta="' + esc(s.id) + '">Quero ver para ' + esc(s.name.toLowerCase()) + '</a></div>';
    if (swap && !reduced()) { segDetail.classList.remove("swap"); void segDetail.offsetWidth; segDetail.classList.add("swap"); }
  }
  if (segApp && segRing && segDetail && segData.length) {
    var N = segData.length, STEP = 360 / N, CARD_W = 230;
    var R = Math.round((CARD_W * 1.45 / 2) / Math.tan(Math.PI / N));
    var cards = [], cache = [], sel = 0, angle = 0, target = null, mode3d = false, auto = true, userPaused = false, hovering = false, holdUntil = 0, running = false, last = 0, visible = false;
    segData.forEach(function (s, i) {
      var b = doc.createElement("button");
      b.type = "button"; b.className = "seg-card"; b.setAttribute("data-seg", s.id); b.setAttribute("aria-pressed", String(i === 0)); b.tabIndex = i === 0 ? 0 : -1;
      b.innerHTML = segArt(s.id) + '<b>' + esc(s.name) + '</b><small>' + esc(s.list.split(",").slice(0, 3).join(", ")) + '</small>';
      b.style.setProperty("--a", (i * STEP) + "deg");
      b.addEventListener("click", function () { select(i, true); });
      b.addEventListener("keydown", function (e) {
        var n = null;
        if (e.key === "ArrowRight") n = (i + 1) % N; else if (e.key === "ArrowLeft") n = (i - 1 + N) % N; else if (e.key === "Home") n = 0; else if (e.key === "End") n = N - 1;
        if (n !== null) { e.preventDefault(); select(n, true); cards[n].focus(); }
      });
      segRing.appendChild(b); cards.push(b); cache.push({});
    });
    segApp.style.setProperty("--seg-r", R + "px");
    var norm = function (d) { d = d % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
    function apply() {
      segRing.style.transform = "translateZ(" + (-R) + "px) rotateY(" + (-angle) + "deg)";
      for (var i = 0; i < N; i++) {
        var z = Math.cos((i * STEP - angle) * Math.PI / 180), c = cards[i], st = cache[i];
        var op = (0.22 + 0.78 * Math.max(0, (z + 0.45) / 1.45)).toFixed(2), pe = z > 0 ? "auto" : "none", fr = z > 0.96;
        if (st.op !== op) { c.style.opacity = op; st.op = op; }
        if (st.pe !== pe) { c.style.pointerEvents = pe; st.pe = pe; }
        if (st.fr !== fr) { c.classList.toggle("front", fr); st.fr = fr; }
      }
    }
    function frame(ts) {
      if (!running) return;
      var dt = Math.min(64, ts - last); last = ts;
      if (target !== null) { var diff = norm(target - angle); angle += diff * 0.12; if (Math.abs(diff) < 0.15) { angle = target; target = null; } }
      else if (auto && !userPaused && !hovering && Date.now() > holdUntil) angle += dt * 0.0045; // ~4,5 graus por segundo: uma volta em ~80 s
      apply();
      if (target === null && auto && !userPaused) { var f = ((Math.round(angle / STEP) % N) + N) % N; if (f !== sel) select(f, false, true); }
      requestAnimationFrame(frame);
    }
    function segRun() { var want = mode3d && visible && !reduced(); if (want && !running) { running = true; last = performance.now(); requestAnimationFrame(frame); } else if (!want) running = false; }
    function setPaused(p) { userPaused = p; if (segPause) { segPause.setAttribute("aria-pressed", String(p)); segPause.textContent = p ? "Girar cards" : "Pausar giro"; } }
    function select(i, user, auto) {
      if (auto && i === sel) return;
      if (user) setPaused(true);
      sel = i;
      cards.forEach(function (c, k) { c.setAttribute("aria-pressed", String(k === i)); c.tabIndex = k === i ? 0 : -1; c.classList.toggle("on", k === i); });
      renderSeg(segData[i], true);
      if (auto) { /* o card da frente ja e o selecionado */ }
      else if (mode3d) { target = angle + norm(i * STEP - angle); if (!running) { angle = target; target = null; apply(); } }
      else if (user && cards[i].scrollIntoView) cards[i].scrollIntoView({ inline: "center", block: "nearest", behavior: reduced() ? "auto" : "smooth" });
      if (user) { setFormSegment(segData[i].id); track("segment_select", { segment: segData[i].id }); }
    }
    function fixHeight() {
      segDetail.style.minHeight = "";
      var keep = segDetail.innerHTML, max = 0;
      segData.forEach(function (s) { renderSeg(s, false); max = Math.max(max, segDetail.offsetHeight); });
      segDetail.innerHTML = keep; segDetail.style.minHeight = max + "px";
    }
    var fixT = 0;
    function segMode() {
      mode3d = window.innerWidth >= 760 && !reduced();
      segApp.classList.toggle("seg-3d", mode3d);
      if (mode3d) { apply(); } else { segRing.style.transform = ""; cards.forEach(function (c) { c.style.opacity = ""; c.style.pointerEvents = ""; c.classList.remove("front"); }); }
      segRun();
    }
    segRing.parentNode.addEventListener("mouseenter", function () { hovering = true; });
    segRing.parentNode.addEventListener("mouseleave", function () { hovering = false; });
    segApp.addEventListener("focusin", function () { hovering = true; });
    segApp.addEventListener("focusout", function () { hovering = false; });
    if (segPrev) segPrev.addEventListener("click", function () { select((sel - 1 + N) % N, true); });
    if (segNext) segNext.addEventListener("click", function () { select((sel + 1) % N, true); });
    if (segPause) segPause.addEventListener("click", function () { setPaused(!userPaused); });
    if ("IntersectionObserver" in window) { new IntersectionObserver(function (es) { visible = es[0].isIntersecting; segRun(); }, { rootMargin: "100px" }).observe(segApp); } else visible = true;
    window.addEventListener("resize", function () { segMode(); clearTimeout(fixT); fixT = setTimeout(fixHeight, 200); });
    if (mq.addEventListener) mq.addEventListener("change", segMode);
    renderSeg(segData[0], false); cards[0].classList.add("on");
    segApp.hidden = false; if (segStatic) segStatic.hidden = true;
    segMode(); fixHeight();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fixHeight);
    window.__segMode = segMode;
    segDetail.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("[data-seg-cta]") : null;
      if (a) { setFormSegment(a.getAttribute("data-seg-cta")); track("cta_click", { cta_id: "segmento" }); }
    });
  }

  /* ---------- planos: periodo escolhido muda o valor mensal com desconto ---------- */
  var planBar = $("#ppBar"), planData = null;
  try { planData = JSON.parse(($("#planData") || {}).textContent || "null"); } catch (e) { planData = null; }
  if (planBar && planData) {
    var fmt = function (n) { return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var money = function (n) { return "R$ " + fmt(n); };
    var round2 = function (n) { return Math.round(n * 100) / 100; };
    var pBtns = $$(".pp-btn", planBar), pNote = $("#ppNote");
    var tween = function (el, from, to) {
      if (reduced() || !window.requestAnimationFrame) { el.textContent = fmt(to); return; }
      var t0 = performance.now(), dur = 450;
      (function step(t) { var k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); })(t0);
    };
    var applyPeriod = function (btn) {
      var m = Number(btn.getAttribute("data-m")), d = Number(btn.getAttribute("data-d"));
      pBtns.forEach(function (x) { var on = x === btn; x.setAttribute("aria-checked", String(on)); x.tabIndex = on ? 0 : -1; });
      $$(".plan-card").forEach(function (card) {
        var base = Number(card.querySelector(".pc-val").getAttribute("data-base")), now = round2(base * (1 - d / 100));
        var val = card.querySelector(".pc-val"), old = card.querySelector(".pc-old"), tot = card.querySelector(".pc-total"), sav = card.querySelector(".pc-save");
        var from = Number(String(val.textContent).replace(/\./g, "").replace(",", ".")) || base;
        tween(val, from, now);
        if (d > 0) {
          old.hidden = false; old.textContent = money(base) + "/mês";
          tot.hidden = false; tot.textContent = "Total no período: " + money(round2(now * m)) + " em " + m + (m === 1 ? " mês" : " meses");
          sav.hidden = false; sav.textContent = "Você economiza " + money(round2((base - now) * m)); sav.style.animation = "none"; void sav.offsetWidth; sav.style.animation = "";
        } else { old.hidden = true; tot.hidden = true; sav.hidden = true; }
      });
      if (pNote) pNote.textContent = d > 0 ? "Plano de " + btn.firstChild.textContent.toLowerCase() + ": " + d + "% de desconto sobre o valor mensal." : "Valor mensal, sem desconto. Contratando por mais tempo, o desconto aumenta.";
    };
    pBtns.forEach(function (btn, i) {
      btn.addEventListener("click", function () { applyPeriod(btn); });
      btn.addEventListener("keydown", function (e) {
        var n = null;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") n = (i + 1) % pBtns.length; else if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = (i - 1 + pBtns.length) % pBtns.length;
        if (n !== null) { e.preventDefault(); applyPeriod(pBtns[n]); pBtns[n].focus(); }
      });
    });
  }

  /* ---------- desempenho: animacoes infinitas so rodam nas secoes que estao na tela ---------- */
  if ("IntersectionObserver" in window) {
    var paintIO = new IntersectionObserver(function (es) { es.forEach(function (e) { e.target.classList.toggle("is-off", !e.isIntersecting); }); }, { rootMargin: "200px 0px" });
    $$("main section, .footer").forEach(function (s) { paintIO.observe(s); });
  }

  /* ---------- cliques nos CTAs ---------- */
  doc.addEventListener("click", function (e) {
    var el = e.target.closest ? e.target.closest("[data-cta],[data-track]") : null;
    if (!el) return;
    var id = el.getAttribute("data-cta");
    if (id) {
      if (id.indexOf("whatsapp") === 0) { track("whatsapp_click", { cta_id: id }); }
      else if (id !== "formulario") track("cta_click", { cta_id: id });
    } else if (el.getAttribute("data-track") === "client_link") track("client_link_click", {});
  });
  var waBtn = $("#waBtn");
  if (waBtn) waBtn.addEventListener("click", function () {
    var seg = formSeg && formSeg.value ? formSeg.options[formSeg.selectedIndex].text : "";
    try { var u = new URL(waBtn.href); var t = u.searchParams.get("text") || ""; if (seg && t.indexOf("Meu segmento") < 0) { u.searchParams.set("text", t + " Meu segmento é " + seg + "."); waBtn.href = u.toString(); } } catch (e) { /* ok */ }
  });

  /* ---------- formulario ---------- */
  var form = $("#leadForm");
  if (form) {
    var status = $("#formStatus"), submit = $("#formSubmit"), startedAt = 0;
    var fields = { name: $("#f-nome"), phone: $("#f-whats"), company: $("#f-empresa"), segment: $("#f-seg") };
    var errs = { name: $("#e-nome"), phone: $("#e-whats"), company: $("#e-empresa"), segment: $("#e-seg") };
    form.addEventListener("focusin", function () { if (!startedAt) startedAt = Date.now(); trackOnce("form_start", {}); });
    function phoneDigits(v) { var d = String(v).replace(/\D/g, ""); if (d.length >= 12 && d.indexOf("55") === 0) d = d.slice(2); return d; }
    function validate() {
      var bad = [];
      var set = function (k, msg) { fields[k].setAttribute("aria-invalid", msg ? "true" : "false"); errs[k].textContent = msg || ""; if (msg) bad.push(k); };
      var nm = fields.name.value.trim(); set("name", nm.length < 2 || !/[A-Za-zÀ-ÿ]/.test(nm) ? "Informe seu nome." : "");
      var ph = phoneDigits(fields.phone.value); set("phone", ph.length < 10 || ph.length > 11 || ph.charAt(0) === "0" ? "Informe o WhatsApp com DDD, por exemplo (11) 91234-5678." : "");
      var co = fields.company.value.trim(); set("company", co.length < 2 ? "Informe o nome da empresa." : "");
      set("segment", fields.segment.value ? "" : "Escolha o segmento mais próximo.");
      return bad;
    }
    function say(kind, text) { status.hidden = false; status.className = "form-status " + kind; status.textContent = text; }
    function busy(on) { submit.setAttribute("aria-busy", String(on)); submit.disabled = on; var l = submit.querySelector(".label"); if (on) { l.textContent = "Enviando…"; if (!submit.querySelector(".spinner")) { var sp = doc.createElement("span"); sp.className = "spinner"; sp.setAttribute("aria-hidden", "true"); submit.insertBefore(sp, l); } } else { l.textContent = "Quero conhecer a Alice"; var s2 = submit.querySelector(".spinner"); if (s2) s2.remove(); } }
    Object.keys(fields).forEach(function (k) { fields[k].addEventListener("input", function () { if (fields[k].getAttribute("aria-invalid") === "true") validate(); }); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (submit.disabled) return;
      status.hidden = true;
      var bad = validate();
      if (bad.length) { fields[bad[0]].focus(); say("fail", "Confira os campos destacados e tente novamente."); return; }
      var payload = {
        name: fields.name.value.trim(), phone: fields.phone.value.trim(), company: fields.company.value.trim(), segment: fields.segment.value,
        volume: ($("#f-vol") || {}).value || "", website: (form.elements.website || {}).value || "", elapsedMs: startedAt ? Date.now() - startedAt : 0, attribution: attribution,
      };
      // O botao leva os dados para o WHATSAPP da Alice, com a mensagem ja preenchida. Abre ANTES de qualquer chamada assincrona (o navegador so permite abrir a janela no clique);
      // o registro do contato no servidor segue em segundo plano (melhor esforco) e nunca atrapalha o WhatsApp.
      var segLabel = fields.segment.options[fields.segment.selectedIndex] ? fields.segment.options[fields.segment.selectedIndex].text : payload.segment;
      var volEl = $("#f-vol"), volLabel = volEl && volEl.value && volEl.options[volEl.selectedIndex] ? volEl.options[volEl.selectedIndex].text : "";
      var lines = ["Oi! Vim pelo site da Alice e quero conhecer (7 dias grátis).", "", "Nome: " + payload.name, "Empresa: " + payload.company, "Segmento: " + segLabel, "WhatsApp: " + payload.phone];
      if (volLabel) lines.push("Contatos novos por mês: " + volLabel);
      // o numero vem do botao de WhatsApp do HTML (um so lugar); a mensagem preenchida substitui o texto padrao
      var waBtnEl = $("#waBtn"), waUrl = "";
      try { var wu = new URL(waBtnEl.href); waUrl = wu.origin + wu.pathname + "?text=" + encodeURIComponent(lines.join("\n")); } catch (err) { waUrl = waBtnEl ? waBtnEl.href : ""; }
      var win = null;
      try { win = window.open(waUrl, "_blank"); if (win) win.opener = null; } catch (err) { win = null; } // (com "noopener" o navegador devolve null mesmo abrindo: por isso o opener e zerado depois)
      try { fetch("/site/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), keepalive: true }).catch(function () { /* melhor esforco */ }); } catch (err) { /* melhor esforco */ }
      trackOnce("lead_submitted", { segment: payload.segment });
      status.hidden = false; status.className = "form-status ok"; status.textContent = "";
      status.appendChild(doc.createTextNode(win ? "Abrimos o WhatsApp com os seus dados já preenchidos. É só enviar a mensagem. " : "Não conseguimos abrir o WhatsApp sozinhos. Seus dados continuam aqui: toque no botão para abrir a conversa já preenchida. "));
      var again = doc.createElement("a"); again.href = waUrl; again.target = "_blank"; again.rel = "noopener"; again.textContent = "Abrir o WhatsApp";
      again.addEventListener("click", function () { track("whatsapp_click", { cta_id: "formulario_wa" }); });
      status.appendChild(again);
      if (!win) { try { window.location.href = waUrl; } catch (err) { /* o link acima resolve */ } }
    });
  }
})();
