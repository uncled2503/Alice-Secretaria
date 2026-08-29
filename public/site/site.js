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

})();
