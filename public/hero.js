// Landing-page demo: the phone scans, then Florae answers and the result stickers pop out.
// Loops while the page is visible; shows the finished state if the user prefers less motion.
(function () {
  var art = document.querySelector(".hero-art");
  if (!art) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    art.classList.add("done");
    return;
  }
  var SCAN_MS = 3200; // scanning phase
  var CYCLE_MS = 9500; // whole loop
  var timer;
  function cycle() {
    art.classList.remove("done");
    timer = setTimeout(function () {
      art.classList.add("done");
    }, SCAN_MS);
  }
  cycle();
  var loop = setInterval(function () {
    if (!document.hidden) cycle();
  }, CYCLE_MS);
  window.addEventListener("pagehide", function () {
    clearInterval(loop);
    clearTimeout(timer);
  });
})();
