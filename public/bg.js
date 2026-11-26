// Random abstract background: soft, blurred colour shapes in random places, sizes and
// colours, different on every page load, plus a light film grain. Purely decorative.
(function () {
  if (document.getElementById("bgfx")) return;
  var COLORS = ["#b6ff3b", "#3de0ff", "#ff8fc1", "#a58bff", "#ffd23f", "#7dffb3", "#ffb36b"];
  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };

  // An organic closed shape: points around a circle with random radii, smoothed.
  function blob(cx, cy, r) {
    var n = Math.floor(rand(5, 9));
    var pts = [];
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 + rand(-0.3, 0.3);
      var rr = r * rand(0.55, 1.15);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    var mid = function (p, q) { return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; };
    var start = mid(pts[n - 1], pts[0]);
    var d = "M" + start[0].toFixed(1) + " " + start[1].toFixed(1);
    for (var j = 0; j < n; j++) {
      var p = pts[j], m = mid(p, pts[(j + 1) % n]);
      d += " Q" + p[0].toFixed(1) + " " + p[1].toFixed(1) + " " + m[0].toFixed(1) + " " + m[1].toFixed(1);
    }
    return d + "Z";
  }

  var palette = COLORS.slice().sort(function () { return Math.random() - 0.5; });
  var count = Math.floor(rand(5, 8));
  var shapes = "";
  for (var k = 0; k < count; k++) {
    var dur = rand(26, 48).toFixed(1);
    var dx = rand(-60, 60).toFixed(0), dy = rand(-60, 60).toFixed(0), rot = rand(-25, 25).toFixed(0);
    shapes +=
      '<path d="' + blob(rand(-50, 1050), rand(-50, 1050), rand(160, 360)) + '" fill="' + (palette[k % palette.length]) +
      '" fill-opacity="' + rand(0.22, 0.42).toFixed(2) + '" style="--dx:' + dx + 'px;--dy:' + dy + 'px;--rot:' + rot +
      'deg;animation-duration:' + dur + 's;animation-delay:-' + rand(0, 30).toFixed(1) + 's"/>';
  }

  var wrap = document.createElement("div");
  wrap.id = "bgfx";
  wrap.setAttribute("aria-hidden", "true");
  wrap.innerHTML =
    '<svg class="bgfx-shapes" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">' + shapes + "</svg>" +
    '<svg class="bgfx-grain" xmlns="http://www.w3.org/2000/svg"><filter id="bgfx-n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="' +
    Math.floor(rand(1, 999)) + '" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 .09 0 0 0 0 .08 0 0 0 0 .18 0 0 0 .09 0"/></filter><rect width="100%" height="100%" filter="url(#bgfx-n)"/></svg>';

  var add = function () { document.body.prepend(wrap); };
  if (document.body) add();
  else document.addEventListener("DOMContentLoaded", add);
})();
