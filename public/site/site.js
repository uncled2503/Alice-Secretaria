(function () {
  var header = document.getElementById("header");

  var toggle = document.getElementById("navToggle");
  if (toggle) toggle.addEventListener("click", function () { header.classList.toggle("open"); });
  document.querySelectorAll(".nav-links a").forEach(function (link) {
    link.addEventListener("click", function () { header.classList.remove("open"); });
  });

  var year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();

  var onScroll = function () { header.classList.toggle("scrolled", window.scrollY > 8); };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var selector = ".section-head, .proof-grid > div, .compare-col, .card, .testi-card, .step, .plan, .band .container > *, .faq details";
  var items = Array.prototype.slice.call(document.querySelectorAll(selector));

  if (!reduceMotion && "IntersectionObserver" in window) {
    try {
      items.forEach(function (element) { element.classList.add("reveal"); });

      document.querySelectorAll(".compare-col").forEach(function (element, index) {
        element.classList.add(index % 2 ? "from-right" : "from-left");
      });
      document.querySelectorAll(".band .container > *").forEach(function (element) {
        element.classList.add("zoom");
      });
      [".cards", ".testi", ".steps", ".plans"].forEach(function (gridSelector) {
        document.querySelectorAll(gridSelector).forEach(function (grid) {
          Array.prototype.forEach.call(grid.children, function (element, index) {
            element.style.setProperty("--reveal-delay", ((index % 3) * 0.08).toFixed(2) + "s");
          });
        });
      });

      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("reveal--in");
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12, rootMargin: "0px 0px -7% 0px" });

      items.forEach(function (element) { observer.observe(element); });
      setTimeout(function () {
        items.forEach(function (element) { element.classList.add("reveal--in"); });
      }, 4000);
    } catch (_error) {
      items.forEach(function (element) { element.classList.remove("reveal"); });
    }
  }

  var fab = document.getElementById("aiFab");
  var panel = document.getElementById("aiPanel");
  var chatBody = document.getElementById("aiBody");
  var form = document.getElementById("aiForm");
  var input = document.getElementById("aiText");
  var history = [];
  var busy = false;
  var greeted = false;

  function scrollDown() { chatBody.scrollTop = chatBody.scrollHeight; }

  function addMessage(role, message) {
    var element = document.createElement("div");
    element.className = "ai-msg ai-msg--" + role;
    element.textContent = message;
    chatBody.appendChild(element);
    scrollDown();
    return element;
  }

  function setOpen(open) {
    panel.classList.toggle("open", open);
    fab.classList.toggle("open", open);
    fab.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      if (!greeted) {
        greeted = true;
        addMessage("bot", "Oi! Sou o assistente do site da Alice. Posso explicar como ela funciona, os planos e a configuração. O que você quer saber?");
      }
      setTimeout(function () { input.focus(); }, 60);
    }
  }

  fab.addEventListener("click", function () { setOpen(!panel.classList.contains("open")); });
  document.getElementById("aiClose").addEventListener("click", function () { setOpen(false); });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && panel.classList.contains("open")) setOpen(false);
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    addMessage("user", text);
    history.push({ role: "user", content: text });

    busy = true;
    var typing = document.createElement("div");
    typing.className = "ai-msg ai-msg--bot ai-typing";
    typing.innerHTML = "<span></span><span></span><span></span>";
    chatBody.appendChild(typing);
    scrollDown();

    fetch("/api/site/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history.slice(-10) })
    })
      .then(function (response) {
        return response.json().then(function (data) { return { ok: response.ok, data: data }; });
      })
      .then(function (result) {
        typing.remove();
        var reply = result.ok && result.data.reply
          ? result.data.reply
          : (result.data && result.data.error) || "Não consegui responder agora. Tente novamente ou fale com a equipe pelo WhatsApp.";
        addMessage("bot", reply);
        if (result.ok && result.data.reply) history.push({ role: "assistant", content: result.data.reply });
      })
      .catch(function () {
        typing.remove();
        addMessage("bot", "Falha de conexão. Tente novamente ou use o botão do WhatsApp.");
      })
      .finally(function () { busy = false; input.focus(); });
  });
})();
