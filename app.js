/* Hemelkijker — kompas-weergave van vliegtuigen, planeten en sterren.
 *
 * Aanname: telefoon wordt rechtop (portret) vastgehouden, met de achterkant
 * (of de bovenrand) richting de lucht gekanteld — niet gedraaid om de lengte-as.
 * Dat maakt de kompas/pitch-berekening simpel en robuust genoeg voor dit doel.
 *
 * Uitbreiden: voeg een nieuwe "layer" toe door 1) een knop in index.html,
 * 2) een fetch/berekenfunctie die {name, az, alt, type, info} teruggeeft,
 * 3) die array meegeven aan collectObjects().
 */

(function () {
  "use strict";

  const FOV_H = 70; // horizontale kijkhoek in graden die het scherm breed toont

  const state = {
    lat: null,
    lon: null,
    heightM: 0,
    heading: 0, // gefilterde kompasrichting (0=N, 90=O)
    pitch: 0,   // gefilterde omhoog/omlaag-hoek (0=horizon, 90=recht omhoog)
    layers: { planes: true, planets: true, stars: true },
    planes: [],
    planeError: null,
  };

  const startScreen = document.getElementById("start-screen");
  const skyScreen = document.getElementById("sky-screen");
  const startBtn = document.getElementById("start-btn");
  const startStatus = document.getElementById("start-status");
  const canvas = document.getElementById("sky");
  const ctx = canvas.getContext("2d");
  const headingReadout = document.getElementById("heading-readout");
  const pitchReadout = document.getElementById("pitch-readout");
  const locReadout = document.getElementById("loc-readout");
  const warningEl = document.getElementById("warning");

  // ---------- helpers ----------

  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  function normalizeDeg(a) {
    a = a % 360;
    return a < 0 ? a + 360 : a;
  }

  // kleinste hoekverschil a-b, resultaat in -180..180
  function angleDiff(a, b) {
    let d = normalizeDeg(a - b);
    if (d > 180) d -= 360;
    return d;
  }

  function lerpAngle(current, target, t) {
    return normalizeDeg(current + angleDiff(target, current) * t);
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

  // ---------- oriëntatie (kompas + kanteling) ----------

  function handleOrientation(event) {
    let heading;
    if (typeof event.webkitCompassHeading === "number" && !isNaN(event.webkitCompassHeading)) {
      heading = event.webkitCompassHeading; // iOS: al kloksgewijs vanaf noord
    } else if (event.alpha !== null) {
      heading = 360 - event.alpha; // Android/Chrome-conventie
    } else {
      return;
    }
    heading = normalizeDeg(heading);

    let pitch = 0;
    if (event.beta !== null) {
      pitch = event.beta - 90; // rechtop vasthouden => beta ~90 => pitch ~0 (horizon)
      pitch = Math.max(-90, Math.min(90, pitch));
    }

    state.heading = lerpAngle(state.heading, heading, 0.25);
    state.pitch = state.pitch + (pitch - state.pitch) * 0.25;
  }

  async function enableOrientation() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      const perm = await DOE.requestPermission();
      if (perm !== "granted") throw new Error("Toestemming voor sensoren geweigerd");
    }
    if ("ondeviceorientationabsolute" in window) {
      window.addEventListener("deviceorientationabsolute", handleOrientation, true);
    } else {
      window.addEventListener("deviceorientation", handleOrientation, true);
    }
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

  let planePollFailures = 0;

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
        .filter((p) => p.alt > -10); // ver onder horizon niet tonen
      planePollFailures = 0;
      state.planeError = null;
    } catch (err) {
      planePollFailures++;
      state.planeError = "Vliegtuigdata niet beschikbaar (" + err.message + ")";
      console.warn(err);
    }
  }

  function startPlanePolling() {
    updatePlanes();
    setInterval(() => {
      // bij herhaalde fouten iets rustiger pollen om OpenSky niet te bestoken
      updatePlanes();
    }, 20000);
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
        if (hor.altitude < -5) continue;
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

  function draw() {
    const w = canvas.width, h = canvas.height;
    const fovV = FOV_H * (h / w);

    // horizonlijn (alt = 0) t.o.v. huidige pitch
    const horizonY = h / 2 + (state.pitch / (fovV / 2)) * (h / 2);

    const skyGrad = ctx.createLinearGradient(0, 0, 0, Math.max(horizonY, 1));
    skyGrad.addColorStop(0, "#000308");
    skyGrad.addColorStop(1, "#12224a");
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, Math.max(horizonY, 0));

    const groundGrad = ctx.createLinearGradient(0, Math.min(horizonY, h), 0, h);
    groundGrad.addColorStop(0, "#1c1a12");
    groundGrad.addColorStop(1, "#050503");
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, Math.min(horizonY, h), w, h - Math.min(horizonY, h));

    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    ctx.lineTo(w, horizonY);
    ctx.stroke();

    // middenkruis = richting waar de telefoon nu op wijst
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath();
    ctx.moveTo(w / 2 - 12, h / 2);
    ctx.lineTo(w / 2 + 12, h / 2);
    ctx.moveTo(w / 2, h / 2 - 12);
    ctx.lineTo(w / 2, h / 2 + 12);
    ctx.stroke();

    const objects = collectObjects();
    for (const obj of objects) {
      const dAz = angleDiff(obj.az, state.heading);
      const dAlt = obj.alt - state.pitch;
      if (Math.abs(dAz) > FOV_H / 2 + 5 || Math.abs(dAlt) > fovV / 2 + 5) continue;

      const x = w / 2 + (dAz / (FOV_H / 2)) * (w / 2);
      const y = h / 2 - (dAlt / (fovV / 2)) * (h / 2);

      const { icon, color } = styleFor(obj);
      const dimAlpha = obj.type === "star" ? Math.max(0.35, 1 - (obj.mag + 1.5) / 6) : 1;

      ctx.globalAlpha = dimAlpha;
      ctx.font = obj.type === "star" ? "16px sans-serif" : "26px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(icon, x, y);

      ctx.globalAlpha = 1;
      ctx.font = "12px sans-serif";
      ctx.fillStyle = color;
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      ctx.shadowBlur = 4;
      ctx.fillText(obj.name, x, y + 20);
      if (obj.info) {
        ctx.font = "10px sans-serif";
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.fillText(obj.info, x, y + 34);
      }
      ctx.shadowBlur = 0;
    }

    headingReadout.textContent = Math.round(state.heading) + "°";
    pitchReadout.textContent = Math.round(state.pitch) + "°";

    if (state.planeError && state.layers.planes) {
      showWarning(state.planeError);
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
    startStatus.textContent = "Locatie en sensoren aanvragen…";
    try {
      const pos = await requestLocationOnce();
      state.lat = pos.coords.latitude;
      state.lon = pos.coords.longitude;
      state.heightM = pos.coords.altitude || 0;

      await enableOrientation();

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
