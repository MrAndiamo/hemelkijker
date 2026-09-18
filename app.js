/* Hemelkijker — een 3D-aarde (Three.js) die op de echte huidige tijd draait,
 * met sterren/zon/maan/planeten als vaste hemelbol op hun echte RA/Dec-positie
 * (dus ze "circelen" om de aarde doordat de aarde er scheenbaar onder
 * doorheen draait — precies zoals in het echt). Vliegtuigen zitten op een
 * heel andere schaal (kilometers, niet lichtjaren) en staan daarom als losse
 * lijst naast de globe, niet in de 3D-scene.
 *
 * Uitbreiden: nieuwe hemelobjecten? voeg toe aan addCelestialSprites() of
 * updateCelestialBodies(). Nieuwe niet-hemelse laag (zoals vliegtuigen)?
 * volg het patroon van updatePlanes()/renderPlaneList().
 */

(function () {
  "use strict";

  const DEG2RAD = Math.PI / 180;
  const EARTH_RADIUS = 1;
  const SKY_RADIUS = 30;

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
  const globeContainer = document.getElementById("globe-container");
  const timeReadout = document.getElementById("time-readout");
  const locReadout = document.getElementById("loc-readout");
  const planePanel = document.getElementById("plane-panel");
  const planeListEl = document.getElementById("plane-list");

  // ---------- tijd / astronomie helpers ----------

  function julianDate(date) {
    return date.getTime() / 86400000 + 2440587.5;
  }

  // Greenwich Mean Sidereal Time, in graden (0-360).
  function gmstDegrees(date) {
    const jd = julianDate(date);
    const T = (jd - 2451545.0) / 36525;
    let g = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - (T * T * T) / 38710000;
    g = g % 360;
    return g < 0 ? g + 360 : g;
  }

  // lat/lon (graden) -> punt op een bol met gegeven straal, in dezelfde
  // conventie als de standaard UV-mapping van THREE.SphereGeometry.
  // Voor hemelobjecten gebruiken we dec als "lat" en ra (in graden) als "lon".
  function latLonToVector3(latDeg, lonDeg, radius) {
    const phi = (90 - latDeg) * DEG2RAD;
    const theta = (lonDeg + 180) * DEG2RAD;
    return new THREE.Vector3(
      -radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta)
    );
  }

  const COMPASS = ["N", "NO", "O", "ZO", "Z", "ZW", "W", "NW"];
  function compassLabel(bearingDeg) {
    return COMPASS[Math.round(((bearingDeg % 360) + 360) % 360 / 45) % 8];
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
        placeLocationMarker();
      },
      (err) => console.warn("locatie-fout", err),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  // ---------- vliegtuigen (OpenSky Network) ----------

  function haversineBearingDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const rad = (d) => (d * Math.PI) / 180;
    const φ1 = rad(lat1), φ2 = rad(lat2);
    const Δφ = rad(lat2 - lat1), Δλ = rad(lon2 - lon1);
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    const distance = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    return { distance, bearing };
  }

  async function updatePlanes() {
    if (state.lat == null || state.lon == null) return;
    const delta = 1.2;
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
          const callsign = (s[1] || "").trim() || s[0];
          return { name: callsign, distance, bearing, altM };
        })
        .sort((a, b) => a.distance - b.distance);
      state.planeError = null;
    } catch (err) {
      state.planeError = "Vliegtuigdata niet beschikbaar (" + err.message + ")";
      console.warn(err);
    } finally {
      state.planesFetched = true;
      renderPlaneList();
    }
  }

  function renderPlaneList() {
    if (state.planeError) {
      planeListEl.innerHTML = `<div class="plane-empty">${state.planeError}</div>`;
    } else if (state.planes.length === 0) {
      planeListEl.innerHTML = `<div class="plane-empty">Geen vliegtuigen gevonden in de buurt.</div>`;
    } else {
      planeListEl.innerHTML = state.planes
        .slice(0, 12)
        .map(
          (p) =>
            `<div class="plane-item"><span class="cs">${p.name}</span><br>` +
            `<span class="meta">${Math.round(p.distance / 1000)} km ${compassLabel(p.bearing)} · ${Math.round(p.altM)} m</span></div>`
        )
        .join("");
    }
  }

  function startPlanePolling() {
    updatePlanes();
    setInterval(updatePlanes, 20000);
  }

  // ---------- Three.js scene ----------

  let renderer, scene, camera;
  let earthGroup, earthMesh, locationMarker;
  let sunLight;
  const planetSprites = {}; // body -> sprite

  const PLANET_BODIES = [
    { body: "Sun", name: "Zon", emoji: "☀️" },
    { body: "Moon", name: "Maan", emoji: "🌕" },
    { body: "Mercury", name: "Mercurius", emoji: "🪐" },
    { body: "Venus", name: "Venus", emoji: "🪐" },
    { body: "Mars", name: "Mars", emoji: "🪐" },
    { body: "Jupiter", name: "Jupiter", emoji: "🪐" },
    { body: "Saturn", name: "Saturnus", emoji: "🪐" },
  ];

  function makeEmojiSprite(emoji, worldSize) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const cx = c.getContext("2d");
    cx.font = "48px sans-serif";
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText(emoji, 32, 34);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(worldSize, worldSize, 1);
    return sprite;
  }

  function makeStarTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const cx = c.getContext("2d");
    const g = cx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.4, "rgba(255,255,255,0.9)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    cx.fillStyle = g;
    cx.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
  }

  function initScene() {
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    globeContainer.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0x404868, 0.55));
    sunLight = new THREE.DirectionalLight(0xffffff, 1.4);
    sunLight.position.set(5, 2, 5);
    scene.add(sunLight);

    earthGroup = new THREE.Group();
    scene.add(earthGroup);

    const loader = new THREE.TextureLoader();
    loader.crossOrigin = "anonymous";
    const earthTexture = loader.load(
      "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/textures/planets/earth_atmos_2048.jpg"
    );
    const earthMat = new THREE.MeshPhongMaterial({ map: earthTexture, shininess: 6 });
    earthMesh = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS, 64, 64), earthMat);
    earthGroup.add(earthMesh);

    // dunne sfeerglow
    const atmoMat = new THREE.MeshBasicMaterial({
      color: 0x4d9fff,
      transparent: true,
      opacity: 0.12,
      side: THREE.BackSide,
    });
    const atmoMesh = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS * 1.03, 48, 48), atmoMat);
    earthGroup.add(atmoMesh);

    // "je bent hier"-markering, kind van earthMesh zodat hij automatisch meedraait
    const markerMat = new THREE.SpriteMaterial({ map: makeStarTexture(), color: 0xff4d4d, depthTest: false });
    locationMarker = new THREE.Sprite(markerMat);
    locationMarker.scale.set(0.07, 0.07, 1);
    locationMarker.visible = false;
    earthMesh.add(locationMarker);

    addStarSprites();
    addPlanetSprites();

    window.addEventListener("resize", onResize);
    setupZoomControls(renderer.domElement);
  }

  function addStarSprites() {
    const starTex = makeStarTexture();
    state.starGroup = new THREE.Group();
    for (const s of BRIGHT_STARS) {
      const pos = latLonToVector3(s.dec, s.ra, SKY_RADIUS);
      const opacity = Math.max(0.35, Math.min(1, 1 - (s.mag + 1.5) / 6));
      const size = Math.max(0.25, 0.55 - s.mag * 0.05) * (SKY_RADIUS / 30);
      const mat = new THREE.SpriteMaterial({ map: starTex, transparent: true, opacity, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(pos);
      sprite.scale.set(size, size, 1);
      state.starGroup.add(sprite);
    }
    scene.add(state.starGroup);
  }

  function addPlanetSprites() {
    state.planetGroup = new THREE.Group();
    for (const p of PLANET_BODIES) {
      const sprite = makeEmojiSprite(p.emoji, p.body === "Sun" ? 2.6 : p.body === "Moon" ? 1.8 : 1.4);
      sprite.position.set(0, 0, SKY_RADIUS * 0.94);
      state.planetGroup.add(sprite);
      planetSprites[p.body] = sprite;
    }
    scene.add(state.planetGroup);
  }

  function updateCelestialBodies() {
    if (typeof Astronomy === "undefined") return;
    const time = Astronomy.MakeTime(new Date());
    const observer = new Astronomy.Observer(state.lat || 0, state.lon || 0, state.heightM || 0);

    for (const p of PLANET_BODIES) {
      try {
        const eq = Astronomy.Equator(p.body, time, observer, true, true);
        const pos = latLonToVector3(eq.dec, eq.ra * 15, SKY_RADIUS * 0.94);
        planetSprites[p.body].position.copy(pos);
      } catch (err) {
        console.warn("kon positie niet berekenen voor", p.body, err);
      }
    }

    // zonlicht komt van de echte richting van de zon
    try {
      const sunEq = Astronomy.Equator("Sun", time, observer, true, true);
      const sunDir = latLonToVector3(sunEq.dec, sunEq.ra * 15, 10);
      sunLight.position.copy(sunDir);
    } catch (err) {
      console.warn("kon zonrichting niet berekenen", err);
    }
  }

  function placeLocationMarker() {
    if (state.lat == null || !locationMarker) return;
    const pos = latLonToVector3(state.lat, state.lon, EARTH_RADIUS * 1.02);
    locationMarker.position.copy(pos);
    locationMarker.visible = true;
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // ---------- zoom (scrollwiel + pinch) ----------

  const ZOOM_MIN = 1.35;
  const ZOOM_MAX = 55; // ver voorbij SKY_RADIUS (30), zodat de hele sterrenbol in beeld past
  let camDist = 3.3;
  let pinchStartDist = null;
  let pinchStartCamDist = null;

  function clampZoom(v) {
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v));
  }

  function setupZoomControls(el) {
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        camDist = clampZoom(camDist * (1 + e.deltaY * 0.0015));
      },
      { passive: false }
    );

    el.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2) {
          pinchStartDist = touchDistance(e.touches);
          pinchStartCamDist = camDist;
        }
      },
      { passive: true }
    );

    el.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length === 2 && pinchStartDist) {
          e.preventDefault();
          const d = touchDistance(e.touches);
          camDist = clampZoom(pinchStartCamDist * (pinchStartDist / d));
        }
      },
      { passive: false }
    );

    el.addEventListener("touchend", () => {
      pinchStartDist = null;
    });
  }

  function touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  let camAngle = 0;
  function animate() {
    requestAnimationFrame(animate);

    const gmstRad = gmstDegrees(new Date()) * DEG2RAD;
    earthGroup.rotation.y = gmstRad;

    camAngle += 0.0009;
    camera.position.set(
      camDist * Math.sin(camAngle),
      camDist * 0.26,
      camDist * Math.cos(camAngle)
    );
    camera.lookAt(0, 0, 0);

    state.planetGroup.visible = state.layers.planets;
    state.starGroup.visible = state.layers.stars;

    renderer.render(scene, camera);

    timeReadout.textContent = new Date().toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  }

  // ---------- UI ----------

  document.querySelectorAll(".layer-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const layer = btn.dataset.layer;
      state.layers[layer] = !state.layers[layer];
      btn.classList.toggle("active", state.layers[layer]);
      if (layer === "planes") planePanel.classList.toggle("hidden", !state.layers.planes);
    });
  });

  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    startStatus.textContent = "Locatie ophalen…";
    try {
      const pos = await requestLocationOnce();
      state.lat = pos.coords.latitude;
      state.lon = pos.coords.longitude;
      state.heightM = pos.coords.altitude || 0;
      locReadout.textContent = `📍 ${state.lat.toFixed(3)}, ${state.lon.toFixed(3)}`;

      initScene();
      placeLocationMarker();
      updateCelestialBodies();
      setInterval(updateCelestialBodies, 30000);

      startWatchingLocation();
      startPlanePolling();
      planePanel.classList.remove("hidden");

      startScreen.classList.add("hidden");
      skyScreen.classList.remove("hidden");
      animate();
    } catch (err) {
      console.error(err);
      startStatus.textContent = "Kon niet starten: " + err.message;
      startBtn.disabled = false;
    }
  });
})();
