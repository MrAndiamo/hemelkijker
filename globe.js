// Tekent een belichte Aarde-globe (orthografische projectie) op een offscreen
// canvas, één keer gerenderd en daarna hergebruikt — geen WebGL nodig.
// view (lat0/lon0) bepaalt welk punt van de aarde "recht op je toe" wijst;
// we gebruiken hiervoor de eigen locatie van de gebruiker zodat de globe
// letterlijk "jouw kant" van de aarde laat zien.
const EarthGlobe = (function () {
  "use strict";

  const TEXTURE_URL =
    "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/textures/planets/earth_atmos_2048.jpg";

  const img = new Image();
  img.crossOrigin = "anonymous";
  let ready = false;
  let srcData = null; // { data, width, height }

  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    try {
      srcData = cx.getImageData(0, 0, c.width, c.height);
      ready = true;
    } catch (err) {
      console.warn("Kon aarde-textuur niet lezen (CORS?)", err);
    }
  };
  img.onerror = (err) => console.warn("Aarde-textuur kon niet laden", err);
  img.src = TEXTURE_URL;

  const rad = (d) => (d * Math.PI) / 180;

  // Licht komt schuin van linksboven, iets naar de kijker toe.
  const LIGHT = normalize3(-0.5, 0.55, 0.7);
  function normalize3(x, y, z) {
    const len = Math.sqrt(x * x + y * y + z * z);
    return { x: x / len, y: y / len, z: z / len };
  }

  // Rendert een cirkelvormige globe-bitmap. diameter = doorsnee in pixels
  // van de bol zelf (het canvas is iets groter voor de sfeerglow-rand).
  function render(diameter, lat0, lon0) {
    if (!ready) return null;

    const pad = Math.ceil(diameter * 0.06);
    const size = diameter + pad * 2;
    const out = document.createElement("canvas");
    out.width = size;
    out.height = size;
    const octx = out.getContext("2d");
    const outData = octx.createImageData(size, size);
    const dst = outData.data;

    const R = diameter / 2;
    const ocx = size / 2, ocy = size / 2;
    const sinLat0 = Math.sin(rad(lat0)), cosLat0 = Math.cos(rad(lat0));
    const lon0Rad = rad(lon0);

    const sw = srcData.width, sh = srcData.height, sdata = srcData.data;

    for (let py = 0; py < size; py++) {
      const y = -(py - ocy + 0.5) / R; // scherm-y omhoog -> noord omhoog
      for (let px = 0; px < size; px++) {
        const idx = (py * size + px) * 4;
        const x = (px - ocx + 0.5) / R;
        const rho2 = x * x + y * y;
        if (rho2 > 1) {
          dst[idx + 3] = 0;
          continue;
        }
        const rho = Math.sqrt(rho2);
        const cosc = Math.sqrt(1 - rho2); // cos(asin(rho))
        const sinc = rho;
        const z = cosc;

        let lat, lon;
        if (rho < 1e-6) {
          lat = rad(lat0);
          lon = lon0Rad;
        } else {
          lat = Math.asin(cosc * sinLat0 + (y * sinc * cosLat0) / rho);
          lon =
            lon0Rad +
            Math.atan2(x * sinc, rho * cosc * cosLat0 - y * sinc * sinLat0);
        }

        let lonDeg = (lon * 180) / Math.PI;
        lonDeg = ((lonDeg + 180) % 360 + 360) % 360 - 180;
        const latDeg = (lat * 180) / Math.PI;

        let tx = Math.floor(((lonDeg + 180) / 360) * sw);
        let ty = Math.floor(((90 - latDeg) / 180) * sh);
        if (tx < 0) tx = 0; else if (tx >= sw) tx = sw - 1;
        if (ty < 0) ty = 0; else if (ty >= sh) ty = sh - 1;
        const sidx = (ty * sw + tx) * 4;

        const ndotl = x * LIGHT.x + y * LIGHT.y + z * LIGHT.z;
        const limb = 1 - 0.18 * rho2 * rho2;
        const brightness = Math.max(0.16, Math.min(1.25, 0.22 + 1.05 * Math.max(0, ndotl))) * limb;

        dst[idx] = Math.min(255, sdata[sidx] * brightness);
        dst[idx + 1] = Math.min(255, sdata[sidx + 1] * brightness);
        dst[idx + 2] = Math.min(255, sdata[sidx + 2] * brightness);
        dst[idx + 3] = 255;
      }
    }
    octx.putImageData(outData, 0, 0);

    // dunne sfeerglow net buiten de bol
    octx.save();
    const glow = octx.createRadialGradient(ocx, ocy, R * 0.98, ocx, ocy, R * 1.12);
    glow.addColorStop(0, "rgba(140,190,255,0.55)");
    glow.addColorStop(1, "rgba(140,190,255,0)");
    octx.fillStyle = glow;
    octx.beginPath();
    octx.arc(ocx, ocy, R * 1.12, 0, Math.PI * 2);
    octx.fill();
    octx.restore();

    return { canvas: out, size, R };
  }

  return {
    isReady: () => ready,
    render,
  };
})();
