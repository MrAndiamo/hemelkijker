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
  const WORLD_Y = new THREE.Vector3(0, 1, 0);
  let lastGmstRad = 0;

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
  const infoCard = document.getElementById("info-card");
  const infoNameEl = document.getElementById("info-name");
  const infoBodyEl = document.getElementById("info-body");
  const infoCloseBtn = document.getElementById("info-close-btn");
  const centerBadge = document.getElementById("center-badge");
  const modeToggleBtn = document.getElementById("mode-toggle-btn");
  const layerToggleEl = document.getElementById("layer-toggle");

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
  let worldGroup, earthGroup, earthMesh, locationMarker;
  let solarGroup, orbitRingsPivot, sunMesh, solarStarGroup;
  let sunLight;
  const planetSprites = {}; // body -> sprite
  const solarSprites = {}; // body -> sprite (zonnestelsel-overzicht), incl. "Sun"

  let viewMode = "earth"; // "earth" | "solar"
  let selectedSolarBody = null; // sprite die nu gevolgd/uitgelicht wordt, of null
  let centerBodyKey = null; // null = zon-centrum (standaard), anders bv. "Mars" of "Sun"
  let cameraAnim = null; // vloeiende overgang bij selecteren/deselecteren
  const cameraLookAt = new THREE.Vector3(0, 0, 0);

  const PLANET_BODIES = [
    { body: "Sun", name: "Zon", emoji: "☀️", desc: "Onze eigen ster — het licht dat je nu ziet vertrok hier zo'n 8 minuten geleden." },
    { body: "Moon", name: "Maan", emoji: "🌕", desc: "Aardes enige natuurlijke maan, op ongeveer 1 lichtseconde afstand." },
    { body: "Mercury", name: "Mercurius", emoji: "🪐", desc: "De kleinste en meest binnenste planeet van het zonnestelsel." },
    { body: "Venus", name: "Venus", emoji: "🪐", desc: "De heetste planeet — een dik broeikas-atmosfeer houdt de warmte vast." },
    { body: "Mars", name: "Mars", emoji: "🪐", desc: "De rode planeet, genoemd naar de Romeinse oorlogsgod." },
    { body: "Jupiter", name: "Jupiter", emoji: "🪐", desc: "De grootste planeet van het zonnestelsel." },
    { body: "Saturn", name: "Saturnus", emoji: "🪐", desc: "Bekend van zijn ringen (hier alleen als icoon te zien, niet als plaatje)." },
  ];
  const AU_IN_KM = 149597870.7;

  // Zonnestelsel-overzicht: schematische (niet schaalgetrouwe) baanstralen,
  // alleen de hoek rond de zon is live/echt (Astronomy.EclipticLongitude).
  const SOLAR_SYSTEM_BODIES = [
    { body: "Mercury", name: "Mercurius", emoji: "🪐", orbitR: 1.6, periodDays: 88, desc: "De kleinste en meest binnenste planeet van het zonnestelsel." },
    { body: "Venus", name: "Venus", emoji: "🪐", orbitR: 2.2, periodDays: 225, desc: "De heetste planeet — een dik broeikas-atmosfeer houdt de warmte vast." },
    { body: "Earth", name: "Aarde", emoji: "🌍", orbitR: 2.8, periodDays: 365.25, desc: "Onze eigen planeet — de enige die we kennen met leven." },
    { body: "Mars", name: "Mars", emoji: "🪐", orbitR: 3.6, periodDays: 687, desc: "De rode planeet, genoemd naar de Romeinse oorlogsgod." },
    { body: "Jupiter", name: "Jupiter", emoji: "🪐", orbitR: 5.2, periodDays: 4333, desc: "De grootste planeet van het zonnestelsel." },
    { body: "Saturn", name: "Saturnus", emoji: "🪐", orbitR: 6.8, periodDays: 10759, desc: "Bekend van zijn ringen (hier alleen als icoon te zien, niet als plaatje)." },
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

    // worldGroup bevat aarde + sterren + planeten samen — dit is wat de
    // gebruiker vastpakt en draait, zodat de hele hemel meebeweegt met de
    // aarde. De kleine eigen rotaties (echte aardrotatie, sier-omloop van de
    // sterren) blijven daarbinnen los doorlopen.
    worldGroup = new THREE.Group();
    scene.add(worldGroup);

    earthGroup = new THREE.Group();
    worldGroup.add(earthGroup);
    lastGmstRad = gmstDegrees(new Date()) * DEG2RAD;
    earthGroup.rotateOnWorldAxis(WORLD_Y, lastGmstRad); // astronomisch correcte startoriëntatie

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
    addSolarSystemScene();

    window.addEventListener("resize", onResize);
    setupPointerControls(renderer.domElement);
  }

  function addSolarSystemScene() {
    solarGroup = new THREE.Group();
    solarGroup.visible = false;
    scene.add(solarGroup);

    // Echte sterrenachtergrond, net als in de aarde-weergave — vanaf welke
    // planeet je ook kijkt, de sterren staan zo ver weg dat hun richting
    // niet meetbaar verschilt, dus deze schuift NIET mee met centerBodyKey.
    solarStarGroup = createStarSprites(16);
    solarGroup.add(solarStarGroup);

    // orbitRingsPivot bevat alleen de baanringen — die staan vast t.o.v. de
    // zon (rond (0,0,0) in de ruwe, zon-gecentreerde berekening). Als je op
    // een andere planeet centreert (centerBodyKey) schuift dit hele groepje
    // mee, zodat de banen blijven kloppen met de nieuwe herkomst van de scène.
    orbitRingsPivot = new THREE.Group();
    solarGroup.add(orbitRingsPivot);

    sunMesh = new THREE.Mesh(new THREE.SphereGeometry(0.45, 32, 32), new THREE.MeshBasicMaterial({ color: 0xffcc55 }));
    solarGroup.add(sunMesh);
    const sunGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeStarTexture(), color: 0xffcc55, transparent: true, opacity: 0.7, depthWrite: false })
    );
    sunGlow.scale.set(2.4, 2.4, 1);
    sunGlow.userData = {
      kind: "solarBody",
      name: "Zon",
      desc: "Onze eigen ster — het licht dat je nu ziet vertrok hier zo'n 8 minuten geleden.",
      periodDays: null,
      distAU: 0,
      bodyKey: "Sun",
    };
    solarGroup.add(sunGlow);
    solarSprites.Sun = sunGlow;

    for (const p of SOLAR_SYSTEM_BODIES) {
      const ringPts = [];
      const SEGMENTS = 96;
      for (let i = 0; i <= SEGMENTS; i++) {
        const a = (i / SEGMENTS) * Math.PI * 2;
        ringPts.push(new THREE.Vector3(Math.cos(a) * p.orbitR, 0, Math.sin(a) * p.orbitR));
      }
      const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
      orbitRingsPivot.add(new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: 0x44557a, transparent: true, opacity: 0.55 })));

      const sprite = makeEmojiSprite(p.emoji, p.body === "Earth" ? 0.5 : 0.4);
      sprite.userData = { kind: "solarBody", name: p.name, desc: p.desc, periodDays: p.periodDays, distAU: null, bodyKey: p.body };
      solarGroup.add(sprite);
      solarSprites[p.body] = sprite;
    }
  }

  function updateSolarSystemPositions() {
    if (typeof Astronomy === "undefined" || !solarGroup) return;
    const time = Astronomy.MakeTime(new Date());
    const rawPositions = { Sun: new THREE.Vector3() };
    for (const p of SOLAR_SYSTEM_BODIES) {
      try {
        const lonRad = Astronomy.EclipticLongitude(p.body, time) * DEG2RAD;
        rawPositions[p.body] = new THREE.Vector3(Math.cos(lonRad) * p.orbitR, 0, Math.sin(lonRad) * p.orbitR);
        const hv = Astronomy.HelioVector(p.body, time);
        solarSprites[p.body].userData.distAU = Math.hypot(hv.x, hv.y, hv.z);
      } catch (err) {
        console.warn("kon zonnestelsel-positie niet berekenen voor", p.body, err);
        rawPositions[p.body] = new THREE.Vector3();
      }
    }

    // centerBodyKey verschuift de hele weergave: die planeet (of de zon)
    // komt op (0,0,0) te staan (net als de aarde standaard in de
    // aarde-weergave), alle andere lichamen worden herberekend t.o.v. haar
    // echte (schematische) positie.
    const offset = (centerBodyKey && rawPositions[centerBodyKey]) || new THREE.Vector3();
    for (const p of SOLAR_SYSTEM_BODIES) {
      solarSprites[p.body].position.copy(rawPositions[p.body]).sub(offset);
    }
    const sunPos = rawPositions.Sun.clone().sub(offset);
    sunMesh.position.copy(sunPos);
    solarSprites.Sun.position.copy(sunPos);
    orbitRingsPivot.position.copy(sunPos);
  }

  function updateCenterBadge() {
    if (!centerBodyKey) {
      centerBadge.classList.add("hidden");
      return;
    }
    const def = SOLAR_SYSTEM_BODIES.find((b) => b.body === centerBodyKey);
    centerBadge.textContent = `🎯 ${def ? def.name : centerBodyKey} is nu het centrum — tik om terug te gaan naar de zon`;
    centerBadge.classList.remove("hidden");
  }

  // Bouwt een bol van echte sterren (RA/Dec uit BRIGHT_STARS) met de
  // opgegeven straal — herbruikt voor zowel de aarde-weergave als de
  // sterrenachtergrond in de zonnestelsel-weergave.
  function createStarSprites(radius) {
    const starTex = makeStarTexture();
    const group = new THREE.Group();
    for (const s of BRIGHT_STARS) {
      const pos = latLonToVector3(s.dec, s.ra, radius);
      const opacity = Math.max(0.35, Math.min(1, 1 - (s.mag + 1.5) / 6));
      const size = Math.max(0.25, 0.55 - s.mag * 0.05) * (radius / 30);
      const mat = new THREE.SpriteMaterial({ map: starTex, transparent: true, opacity, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(pos);
      sprite.scale.set(size, size, 1);
      sprite.userData = { kind: "star", name: s.name, mag: s.mag };
      group.add(sprite);
    }
    return group;
  }

  function addStarSprites() {
    state.starGroup = createStarSprites(SKY_RADIUS);
    worldGroup.add(state.starGroup);
  }

  function addPlanetSprites() {
    state.planetGroup = new THREE.Group();
    for (const p of PLANET_BODIES) {
      const sprite = makeEmojiSprite(p.emoji, p.body === "Sun" ? 2.6 : p.body === "Moon" ? 1.8 : 1.4);
      sprite.position.set(0, 0, SKY_RADIUS * 0.94);
      sprite.userData = { kind: "planet", name: p.name, desc: p.desc, distAU: null };
      state.planetGroup.add(sprite);
      planetSprites[p.body] = sprite;
    }
    worldGroup.add(state.planetGroup);
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
        planetSprites[p.body].userData.distAU = eq.dist;
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

  // ---------- zoom + aarde-draaien + tik-to-inspect (één pointer-systeem) ----------

  const ZOOM_MIN = 1.35;
  const ZOOM_MAX = 55; // ver voorbij SKY_RADIUS (30), zodat de hele sterrenbol in beeld past
  const ROTATE_SPEED = 0.005;
  const TAP_MAX_MOVE = 8; // px — verplaatsing hieronder = tik, niet slepen
  let camDist = 3.3;

  function clampZoom(v) {
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v));
  }

  function pointDistance(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function rotateWorldByDrag(dxPixels, dyPixels) {
    // Draait de hele scène (aarde + sterren + planeten samen) — niet alleen
    // de aarde — zodat de hemel gewoon meebeweegt zoals je 'm vastpakt.
    worldGroup.rotateOnWorldAxis(WORLD_Y, dxPixels * ROTATE_SPEED);
    const right = new THREE.Vector3();
    camera.matrixWorld.extractBasis(right, new THREE.Vector3(), new THREE.Vector3());
    worldGroup.rotateOnWorldAxis(right.normalize(), dyPixels * ROTATE_SPEED);
    worldGroup.quaternion.normalize();
  }

  function setupPointerControls(el) {
    const pointers = new Map(); // pointerId -> {x, y}
    let pinchStartDist = null;
    let pinchStartCamDist = null;
    let gesture = null; // info over de lopende aanraking, voor tik-detectie

    function rebaselinePinchIfNeeded() {
      if (pointers.size === 2) {
        const pts = [...pointers.values()];
        pinchStartDist = pointDistance(pts[0], pts[1]);
        pinchStartCamDist = camDist;
      }
    }

    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        camDist = clampZoom(camDist * (1 + e.deltaY * 0.0015));
      },
      { passive: false }
    );

    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return; // alleen links-klik roteert/tikt
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        gesture = { startX: e.clientX, startY: e.clientY, maxMove: 0, multiTouch: false, pointerType: e.pointerType };
      } else if (gesture) {
        gesture.multiTouch = true;
      }
      rebaselinePinchIfNeeded();
    });

    el.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); // altijd bijwerken, ook tijdens pinch

      if (pointers.size === 1) {
        if (viewMode === "earth") rotateWorldByDrag(dx, dy);
        if (gesture) {
          gesture.maxMove = Math.max(gesture.maxMove, pointDistance({ x: e.clientX, y: e.clientY }, { x: gesture.startX, y: gesture.startY }));
        }
      } else if (pointers.size === 2 && pinchStartDist) {
        const pts = [...pointers.values()];
        const d = pointDistance(pts[0], pts[1]);
        camDist = clampZoom(pinchStartCamDist * (pinchStartDist / d));
      }
    });

    function endPointer(e) {
      const wasSingle = pointers.size === 1 && pointers.has(e.pointerId);
      pointers.delete(e.pointerId);
      rebaselinePinchIfNeeded(); // dekt 3->2; bij 2->1 of 1->0 doet dit niets

      if (wasSingle && gesture && !gesture.multiTouch && gesture.maxMove < TAP_MAX_MOVE) {
        handleTap(e.clientX, e.clientY, gesture.pointerType);
      }
      if (pointers.size === 0) gesture = null;
    }
    el.addEventListener("pointerup", endPointer);
    el.addEventListener("pointercancel", endPointer);

    // Muizen geven een betrouwbaar, browser-eigen dblclick-event — dat
    // gebruiken we rechtstreeks om te centreren, in plaats van zelf de tijd
    // tussen twee losse klikken te schatten (dat bleek onbetrouwbaar: de
    // camera-vlucht van de eerste klik verschuift het doelwit al voordat de
    // tweede klik binnenkomt). Voor touch (geen dblclick-event) blijft
    // handleTap() zelf dubbeltikken herkennen op timing.
    el.addEventListener("dblclick", (e) => {
      if (viewMode !== "solar") return;
      let best = { dist: 24, data: null, sprite: null };
      best = nearestSpriteInGroup(solarGroup, e.clientX, e.clientY, best);
      best = nearestSpriteInGroup(solarStarGroup, e.clientX, e.clientY, best);
      if (best.data) acceptCenter(best);
    });
  }

  // ---------- tik-to-inspect ----------

  function projectToScreen(worldPos) {
    const v = worldPos.clone().project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (1 - (v.y * 0.5 + 0.5)) * window.innerHeight,
      z: v.z,
    };
  }

  function nearestSpriteInGroup(group, clientX, clientY, bestSoFar) {
    let best = bestSoFar;
    for (const sprite of group.children) {
      if (!sprite.userData || !sprite.userData.name) continue; // skip baanringen/zon-mesh e.d.
      const wp = new THREE.Vector3();
      sprite.getWorldPosition(wp);
      const sp = projectToScreen(wp);
      if (sp.z > 1 || sp.z < -1) continue; // buiten beeld / achter de camera
      const d = Math.hypot(sp.x - clientX, sp.y - clientY);
      if (d < best.dist) best = { dist: d, data: sprite.userData, sprite };
    }
    return best;
  }

  const DOUBLE_TAP_MS = 450;
  let lastTap = { sprite: null, time: 0 };

  function handleTap(clientX, clientY, pointerType) {
    let best = { dist: 24, data: null, sprite: null }; // 24px tik-tolerantie

    if (viewMode === "solar") {
      best = nearestSpriteInGroup(solarGroup, clientX, clientY, best);
      best = nearestSpriteInGroup(solarStarGroup, clientX, clientY, best);
      if (best.data) {
        if (pointerType === "mouse") {
          // dubbelklikken wordt afgehandeld door de aparte "dblclick"-listener
          selectSolarBody(best);
        } else {
          const now = performance.now();
          const isDoubleTap = lastTap.sprite === best.sprite && now - lastTap.time < DOUBLE_TAP_MS;
          lastTap = { sprite: best.sprite, time: now };
          if (isDoubleTap) acceptCenter(best);
          else selectSolarBody(best);
        }
      } else {
        lastTap = { sprite: null, time: 0 };
        deselectSolarBody();
      }
      return;
    }

    if (state.layers.stars && state.starGroup.visible) best = nearestSpriteInGroup(state.starGroup, clientX, clientY, best);
    if (state.layers.planets && state.planetGroup.visible) best = nearestSpriteInGroup(state.planetGroup, clientX, clientY, best);
    if (best.data) showInfoCard(best.data);
    else hideInfoCard();
  }

  function showInfoCard(data) {
    infoNameEl.textContent = data.name;
    if (data.kind === "star") {
      infoBodyEl.textContent = `Magnitude ${data.mag} — hoe lager, hoe helderder deze ster is.`;
    } else if (data.kind === "solarBody" && data.bodyKey === "Sun") {
      infoBodyEl.textContent = data.desc;
    } else if (data.kind === "solarBody") {
      const kmText = data.distAU != null ? Math.round(data.distAU * AU_IN_KM).toLocaleString("nl-NL") + " km" : "…";
      const periodText = data.periodDays > 500 ? (data.periodDays / 365.25).toFixed(1) + " jaar" : Math.round(data.periodDays) + " dagen";
      infoBodyEl.textContent = `${data.desc} Nu ongeveer ${kmText} van de zon. Eén rondje om de zon duurt ${periodText}.`;
    } else {
      const kmText = data.distAU != null ? Math.round(data.distAU * AU_IN_KM).toLocaleString("nl-NL") + " km" : "…";
      infoBodyEl.textContent = `${data.desc} Nu ongeveer ${kmText} van de aarde.`;
    }
    infoCard.classList.remove("hidden");
  }

  function hideInfoCard() {
    infoCard.classList.add("hidden");
  }

  // ---------- zonnestelsel: selecteren + camera-vlucht ----------

  function startCameraFlyTo(toPos, toTarget) {
    cameraAnim = {
      fromPos: camera.position.clone(),
      toPos,
      fromTarget: cameraLookAt.clone(),
      toTarget,
      start: performance.now(),
      duration: 900,
    };
  }

  function selectSolarBody(best) {
    selectedSolarBody = best.sprite;
    showInfoCard(best.data);
    const p = best.sprite.position.clone();
    const dir = p.clone().normalize();
    const camTo = p.clone().add(dir.multiplyScalar(1.3)).add(new THREE.Vector3(0, 0.55, 0));
    startCameraFlyTo(camTo, p);
  }

  function deselectSolarBody() {
    selectedSolarBody = null;
    hideInfoCard();
    // camDist terugzetten naar de overzicht-afstand: anders gebruikt de
    // volgende animate()-frame (zodra deze vlucht klaar is) nog de laatst
    // ingezoomde afstand van acceptCenter() en springt de camera meteen
    // weer terug naar dichtbij.
    camDist = 12;
    startCameraFlyTo(new THREE.Vector3(0, camDist * 0.6, camDist), new THREE.Vector3(0, 0, 0));
  }

  // Dubbeltik/dubbelklik op een planeet of de zon: maakt 'm het nieuwe
  // centrum van de weergave (net als de aarde standaard in de
  // aarde-weergave) — nogmaals dubbeltikken op het huidige centrum (of op
  // de zon) zet het terug naar zon-centrum.
  function acceptCenter(best) {
    const key = best.data.bodyKey;
    if (!key) return;
    // dubbeltikken op de zon, of nogmaals op het huidige centrum, gaat terug
    // naar zon-centrum — voor de zon zelf is dat toch al hetzelfde beeld.
    centerBodyKey = key === "Sun" || centerBodyKey === key ? null : key;
    updateSolarSystemPositions();
    updateCenterBadge();
    selectedSolarBody = null;
    hideInfoCard();
    // Het nieuwe centrum komt op (0,0,0) te staan — zoom daarop in i.p.v.
    // terug te springen naar het volledige overzicht, zodat je omringd
    // bent door de sterrenachtergrond bij het lichaam waar je net op
    // dubbelklikte. (De centrum-badge blijft de weg terug naar het
    // volledige overzicht.)
    camDist = clampZoom(2.4);
    startCameraFlyTo(new THREE.Vector3(0, camDist * 0.6, camDist), new THREE.Vector3(0, 0, 0));
  }

  // Camera staat vast (alleen afstand verandert door zoom) — de zichtbare
  // beweging komt van de hemelbol zelf die om de aarde draait, niet van een
  // camera die om een stilstaande scène cirkelt (dat zag er plat/links-rechts
  // uit i.p.v. als "eromheen gaan", want sterren staan zo ver weg dat een
  // camera-omloop daar geen diepte-effect op geeft).
  let skySpin = 0;
  function animate() {
    requestAnimationFrame(animate);

    if (viewMode === "earth") {
      const gmstRad = gmstDegrees(new Date()) * DEG2RAD;
      let gmstDelta = gmstRad - lastGmstRad;
      // normaliseer naar (-π, π] zodat de dagelijkse 360°->0° wrap geen sprong geeft
      gmstDelta = ((gmstDelta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      earthGroup.rotateOnWorldAxis(WORLD_Y, gmstDelta); // echte, tijd-gebaseerde rotatie (heel langzaam)
      earthGroup.quaternion.normalize(); // voorkomt drift na heel veel kleine rotaties over een lange sessie
      lastGmstRad = gmstRad;

      skySpin += 0.0028; // sierlijke, zichtbare omloop: ± 1 ronde per 37s
      state.starGroup.rotation.y = skySpin;
      // planeten/zon/maan draaien NIET decoratief mee — die staan op hun echte,
      // bijna stilstaande astronomische positie (updateCelestialBodies()).

      camera.position.set(0, camDist * 0.8, camDist);
      cameraLookAt.set(0, 0, 0);
      camera.lookAt(cameraLookAt);

      state.planetGroup.visible = state.layers.planets;
      state.starGroup.visible = state.layers.stars;
    } else {
      // zonnestelsel-modus: camera volgt de selectie, of toont het overzicht
      let campos, look;
      if (cameraAnim) {
        const t = Math.min(1, (performance.now() - cameraAnim.start) / cameraAnim.duration);
        const eased = 1 - Math.pow(1 - t, 3);
        campos = cameraAnim.fromPos.clone().lerp(cameraAnim.toPos, eased);
        look = cameraAnim.fromTarget.clone().lerp(cameraAnim.toTarget, eased);
        if (t >= 1) cameraAnim = null;
      } else if (selectedSolarBody) {
        const p = selectedSolarBody.position.clone();
        const dir = p.clone().normalize();
        campos = p.clone().add(dir.multiplyScalar(1.3)).add(new THREE.Vector3(0, 0.55, 0));
        look = p;
      } else {
        campos = new THREE.Vector3(0, camDist * 0.6, camDist);
        look = new THREE.Vector3(0, 0, 0);
      }
      camera.position.copy(campos);
      cameraLookAt.copy(look);
      camera.lookAt(cameraLookAt);
    }

    renderer.render(scene, camera);

    timeReadout.textContent = new Date().toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  }

  // ---------- UI ----------

  infoCloseBtn.addEventListener("click", () => {
    if (viewMode === "solar" && selectedSolarBody) deselectSolarBody();
    else hideInfoCard();
  });

  centerBadge.addEventListener("click", () => {
    centerBodyKey = null;
    updateSolarSystemPositions();
    updateCenterBadge();
    deselectSolarBody();
  });

  modeToggleBtn.addEventListener("click", () => {
    viewMode = viewMode === "earth" ? "solar" : "earth";
    worldGroup.visible = viewMode === "earth";
    solarGroup.visible = viewMode === "solar";
    layerToggleEl.classList.toggle("hidden", viewMode === "solar");
    planePanel.classList.toggle("hidden", viewMode === "solar" || !state.layers.planes);
    selectedSolarBody = null;
    cameraAnim = null;
    hideInfoCard();
    lastTap = { sprite: null, time: 0 };
    if (viewMode === "earth") {
      centerBodyKey = null;
      updateSolarSystemPositions();
      updateCenterBadge();
    }
    modeToggleBtn.textContent = viewMode === "earth" ? "🌞 Zonnestelsel" : "🌍 Aarde";
    camDist = viewMode === "solar" ? 12 : 3.3;
  });

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
      updateSolarSystemPositions();
      setInterval(() => {
        updateCelestialBodies();
        updateSolarSystemPositions();
      }, 30000);

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
