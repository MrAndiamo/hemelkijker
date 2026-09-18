/* Hemelkijker — vaste "sky dome"-weergave van vliegtuigen, planeten en sterren.
 *
 * Geen kompas/kanteling nodig: het midden van de cirkel is recht boven je
 * (zenit), de rand is de horizon, en de hoek rondom is het kompaskwadrant
 * (noord boven, vast). Alles dat nu boven je is staat gewoon meteen in beeld.
 *
 * Uitbreiden: voeg een nieuwe "layer" toe door 1) een knop in index.html,
 * 2) een fetch/berekenfunctie die {name, az, alt, type, info} teruggeeft,
 * 3) die array meegeven aan collectObjects().
 */

(function () {
  "use strict";

  const state = {
    lat: null,
    lon: null,
    heightM: 0,
    layers: { planes: true, planets: true, stars: true },
    planes: [],
    planesRawCount: 0,
    planesFetched: false,
    planeError: null,
  };

  const startScreen = document.getElementById("start-screen");
  const skyScreen = document.getElementById("sky-screen");
  const startBtn = document.getElementById("start-btn");
  const startStatus = document.getElementById("start-status");
  const canvas = document.getElementById("sky");
  const ctx = canvas.getContext("2d");
  const planeCountEl = document.getElementById("plane-count");
  const timeReadout = document.getElementById("time-readout");
  const locReadout = document.getElementById("loc-readout");
  const warningEl = document.getElementById("warning");

  // ---------- helpers ----------

  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  function normalizeDeg(a) {
    a = a % 360;
    return a < 0 ? a + 360 : a;
  }

  function showWarning(msg) {
    warningEl.textContent = msg;
    warningEl.classList.remove("hidden");
  }
  function clearWarning() {
    warningEl.classList.add("hidden");
  }

  // ---------- locatie ----------

  function requestLocationOnce() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("Geen geolocatie beschikbaar"));
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      });
    });
  }

  function startWatchingLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.watchPosition(
      (pos) => {
        state.lat = pos.coords.latitude;
        state.lon = pos.coords.longitude;
        state.heightM = pos.coords.altitude || 0;
        locReadout.textContent = `📍 ${state.lat.toFixed(3)}, ${state.lon.toFixed(3)}`;
      },
      (err) => {
        console.warn("locatie-fout", err);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  // ---------- vliegtuigen (OpenSky Network) ----------

  function haversineBearingDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const φ1 = rad(lat1), φ2 = rad(lat2);
    const Δφ = rad(lat2 - lat1), Δλ = rad(lon2 - lon1);
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    const distance = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const bearing = normalizeDeg(deg(Math.atan2(y, x)));
    return { distance, bearing };
  }

  async function updatePlanes() {
    if (state.lat == null || state.lon == null) return;
    const delta = 1.2; // ~130 km box rond de gebruiker
    const lamin = state.lat - delta, lamax = state.lat + delta;
    const lomin = state.lon - delta, lomax = state.lon + delta;
    const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const rows = data.states || [];
      state.planesRawCount = rows.length;
      state.planes = rows
        .filter((s) => s[5] != null && s[6] != null && !s[8])
        .map((s) => {
          const lon = s[5], lat = s[6];
          const altM = s[13] != null ? s[13] : s[7] != null ? s[7] : 0;
          const { distance, bearing } = haversineBearingDistance(state.lat, state.lon, lat, lon);
          const elevation = deg(Math.atan2(altM - state.heightM, distance));
          const callsign = (s[1] || "").trim() || s[0];
          return {
            name: callsign,
            az: bearing,
            alt: elevation,
            type: "plane",
            info: `${Math.round(distance / 1000)} km · ${Math.round(altM)} m`,
          };
        })
        .filter((p) => p.alt > -2);
      state.planeError = null;
    } catch (err) {
      state.planeError = "Vliegtuigdata niet beschikbaar (" + err.message + ")";
      console.warn(err);
    } finally {
      state.planesFetched = true;
    }
  }

  function startPlanePolling() {
    updatePlanes();
    setInterval(updatePlanes, 20000);
  }

  // ---------- planeten & sterren ----------

  const PLANET_BODIES = [
    { body: "Sun", name: "Zon" },
    { body: "Moon", name: "Maan" },
    { body: "Mercury", name: "Mercurius" },
    { body: "Venus", name: "Venus" },
    { body: "Mars", name: "Mars" },
    { body: "Jupiter", name: "Jupiter" },
    { body: "Saturn", name: "Saturnus" },
  ];

  function getPlanetObjects() {
    if (state.lat == null || typeof Astronomy === "undefined") return [];
    const time = Astronomy.MakeTime(new Date());
    const observer = new Astronomy.Observer(state.lat, state.lon, state.heightM || 0);
    const out = [];
    for (const p of PLANET_BODIES) {
      try {
        const eq = Astronomy.Equator(p.body, time, observer, true, true);
        const hor = Astronomy.Horizon(time, observer, eq.ra, eq.dec, "normal");
        if (hor.altitude < -2) continue;
        out.push({
          name: p.name,
          az: hor.azimuth,
          alt: hor.altitude,
          type: p.body === "Sun" ? "sun" : p.body === "Moon" ? "moon" : "planet",
        });
      } catch (err) {
        console.warn("planeetberekening mislukt voor", p.body, err);
      }
    }
    return out;
  }

  function getStarObjects() {
    if (state.lat == null || typeof Astronomy === "undefined") return [];
    const time = Astronomy.MakeTime(new Date());
    const observer = new Astronomy.Observer(state.lat, state.lon, state.heightM || 0);
    const out = [];
    for (const s of BRIGHT_STARS) {
      try {
        const hor = Astronomy.Horizon(time, observer, s.ra, s.dec, "normal");
        if (hor.altitude < -2) continue;
        out.push({ name: s.name, az: hor.azimuth, alt: hor.altitude, type: "star", mag: s.mag });
      } catch (err) {
        console.warn("sterberekening mislukt voor", s.name, err);
      }
    }
    return out;
  }

  // ---------- tekenen ----------

  function collectObjects() {
    let objs = [];
    if (state.layers.planes) objs = objs.concat(state.planes);
    if (state.layers.planets) objs = objs.concat(getPlanetObjects());
    if (state.layers.stars) objs = objs.concat(getStarObjects());
    return objs;
  }

  function styleFor(obj) {
    switch (obj.type) {
      case "plane":
        return { icon: "✈️", color: "#8fd3ff" };
      case "sun":
        return { icon: "☀️", color: "#ffd35c" };
      case "moon":
        return { icon: "🌕", color: "#f0f0f0" };
      case "planet":
        return { icon: "🪐", color: "#ffb27a" };
      case "star":
        return { icon: "✦", color: "#ffffff" };
      default:
        return { icon: "•", color: "#ffffff" };
    }
  }

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  // Polair: rand = horizon (alt 0), rand van de globe = recht omhoog (alt 90),
  // hoek = kompasrichting, noord boven. De globe zelf vult het midden zodat
  // niets "achter de aarde" verdwijnt.
  function domeGeometry() {
    const w = canvas.width, h = canvas.height;
    const cx = w / 2;
    const cy = h / 2 + 10;
    const R = Math.min(w, h) * 0.47;
    const globeR = R * 0.55;
    return { w, h, cx, cy, R, globeR };
  }

  function project(az, alt, geo) {
    const clampedAlt = Math.max(0, Math.min(90, alt));
    const r = geo.globeR + (geo.R - geo.globeR) * (1 - clampedAlt / 90);
    const θ = rad(az);
    return { x: geo.cx + r * Math.sin(θ), y: geo.cy - r * Math.cos(θ) };
  }

  let globeBitmap = null;
  let globeBitmapKey = "";

  function ensureGlobeBitmap(diameter) {
    if (!EarthGlobe.isReady()) return null;
    const lat0 = state.lat != null ? state.lat : 25;
    const lon0 = state.lon != null ? state.lon : 15;
    const key = Math.round(diameter) + "|" + Math.round(lat0) + "|" + Math.round(lon0);
    if (key !== globeBitmapKey) {
      globeBitmap = EarthGlobe.render(diameter, lat0, lon0);
      globeBitmapKey = key;
    }
    return globeBitmap;
  }

  const DIRS = [
    [0, "N"], [45, "NO"], [90, "O"], [135, "ZO"],
    [180, "Z"], [225, "ZW"], [270, "W"], [315, "NW"],
  ];
  const ALT_RINGS = [0, 30, 60];

  function draw() {
    const { w, h, cx, cy, R, globeR } = domeGeometry();
    ctx.clearRect(0, 0, w, h);

    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.15);
    bg.addColorStop(0, "#0c1636");
    bg.addColorStop(1, "#01030a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // hoogte-ringen (rond de globe, niet erover)
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    for (const altVal of ALT_RINGS) {
      const r = globeR + (R - globeR) * (1 - altVal / 90);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(altVal + "°", cx, cy - r + 12);
    }

    // de aarde zelf, in het midden
    const globe = ensureGlobeBitmap(globeR * 2);
    if (globe) {
      ctx.drawImage(globe.canvas, cx - globe.size / 2, cy - globe.size / 2, globe.size, globe.size);
    } else {
      const placeholder = ctx.createRadialGradient(
        cx - globeR * 0.3, cy - globeR * 0.3, globeR * 0.1,
        cx, cy, globeR
      );
      placeholder.addColorStop(0, "#3a6ea8");
      placeholder.addColorStop(0.6, "#1c4a7a");
      placeholder.addColorStop(1, "#0a1f38");
      ctx.beginPath();
      ctx.arc(cx, cy, globeR, 0, Math.PI * 2);
      ctx.fillStyle = placeholder;
      ctx.fill();
    }

    // kompasrichtingen rondom de rand
    ctx.font = "13px sans-serif";
    for (const [dirAz, label] of DIRS) {
      const θ = rad(dirAz);
      const lx = cx + (R + 16) * Math.sin(θ);
      const ly = cy - (R + 16) * Math.cos(θ);
      ctx.fillStyle = dirAz % 90 === 0 ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.5)";
      ctx.fillText(label, lx, ly + 4);
    }

    const objects = collectObjects();
    for (const obj of objects) {
      const { x, y } = project(obj.az, obj.alt, { cx, cy, R, globeR });
      const { icon, color } = styleFor(obj);
      const dimAlpha = obj.type === "star" ? Math.max(0.35, 1 - (obj.mag + 1.5) / 6) : 1;

      ctx.globalAlpha = dimAlpha;
      ctx.font = obj.type === "star" ? "15px sans-serif" : "22px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(icon, x, y);

      ctx.globalAlpha = 1;
      ctx.font = "11px sans-serif";
      ctx.fillStyle = color;
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      ctx.shadowBlur = 4;
      ctx.fillText(obj.name, x, y + 16);
      if (obj.info) {
        ctx.font = "9px sans-serif";
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.fillText(obj.info, x, y + 28);
      }
      ctx.shadowBlur = 0;
    }

    planeCountEl.textContent = `✈️ ${state.planes.length}/${state.planesRawCount}`;
    timeReadout.textContent = new Date().toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });

    if (state.planeError && state.layers.planes) {
      showWarning(state.planeError);
    } else if (state.layers.planes && state.planesFetched && state.planesRawCount === 0) {
      showWarning("Geen vliegtuigen gevonden in de buurt op dit moment (geen fout, gewoon leeg).");
    } else {
      clearWarning();
    }

    requestAnimationFrame(draw);
  }

  // ---------- UI ----------

  document.querySelectorAll(".layer-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const layer = btn.dataset.layer;
      state.layers[layer] = !state.layers[layer];
      btn.classList.toggle("active", state.layers[layer]);
    });
  });

  window.addEventListener("resize", resizeCanvas);

  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    startStatus.textContent = "Locatie ophalen…";
    try {
      const pos = await requestLocationOnce();
      state.lat = pos.coords.latitude;
      state.lon = pos.coords.longitude;
      state.heightM = pos.coords.altitude || 0;

      startWatchingLocation();
      startPlanePolling();
      resizeCanvas();

      startScreen.classList.add("hidden");
      skyScreen.classList.remove("hidden");
      requestAnimationFrame(draw);
    } catch (err) {
      console.error(err);
      startStatus.textContent = "Kon niet starten: " + err.message;
      startBtn.disabled = false;
    }
  });
})();
