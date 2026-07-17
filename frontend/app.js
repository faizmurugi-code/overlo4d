/* Overlord Grid — Sovereign Shield | operator console client
   Renders the live engine snapshot (WebSocket, 5 Hz) into a 3D battlespace
   and the NOC HUD. Vanilla JS + three.js r128, no build step. */

/* global THREE */

const WORLD = { x: 42, z: 24 };

let scene, camera, renderer;
let towers3D = {};        // towerId -> group
let ueMeshes = {};        // ueId    -> mesh
let meshLineSegs = null;
let roguePulseRings = [];
let packets = [];         // mesh packet pulses
let sweepMeshes = {};
let lastMeshKey = "";

let snapshot = null;
let lastEventKey = null;

// camera orbit state
const cam = { theta: 0.6, phi: 0.95, radius: 62, auto: true };

const COLORS = {
    IN_SERVICE: 0x00e5ff,
    CAMPED_ROGUE: 0xff3355,
    IMSI_EXPOSED: 0xff3355,
    MESH_NODE: 0x00ff88,
    GATEWAY: 0xffd54f,
    tower: 0x2f7bff,
    rogue: 0xff3355,
    meshLine: 0x00ff88,
};

/* ============================== scene setup ============================== */

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x01040a);
    scene.fog = new THREE.Fog(0x01040a, 70, 160);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    document.body.appendChild(renderer.domElement);

    // ground grid
    const grid = new THREE.GridHelper(140, 70, 0x064a30, 0x03271a);
    grid.position.y = -0.02;
    scene.add(grid);
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));

    buildTowers();
    buildUEs();
    initCameraControls();

    window.addEventListener("resize", onResize);
    connectWebSocket();
    setInterval(tickClock, 250);
    animate();
}

function buildTowers() {
    const specs = [
        { id: "KABARAK-MAIN", x: -25, z: 2 },
        { id: "NAKURU-CBD", x: 0, z: -3 },
        { id: "RAFIKI-NODE", x: 25, z: 2 },
        // The two new rogue towers
        { id: "ROGUE-LEFT", x: 14, z: -8, rogue: true },
        { id: "ROGUE-RIGHT", x: -16, z: 10, rogue: true },
    ];
    // ... rest of the function stays the same
    specs.forEach(spec => {
        const g = new THREE.Group();
        const color = spec.rogue ? COLORS.rogue : COLORS.tower;

        const body = new THREE.Mesh(
            new THREE.CylinderGeometry(0.8, 1.8, 11, 4),
            new THREE.MeshBasicMaterial({ color, wireframe: true })
        );
        body.position.y = 5.5;
        const head = new THREE.Mesh(
            new THREE.SphereGeometry(1.3, 12, 12),
            new THREE.MeshBasicMaterial({ color })
        );
        head.position.y = 11.6;
        g.add(body); g.add(head);

        // coverage ring
        const ring = makeRing(17, color, 0.35);
        ring.position.y = 0.05;
        g.add(ring);

        // rotating sweep beam
        const sweepGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0.06, 0), new THREE.Vector3(17, 0.06, 0),
        ]);
        const sweep = new THREE.Line(sweepGeo,
            new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }));
        g.add(sweep);
        sweepMeshes[spec.id] = sweep;

        g.position.set(spec.x, 0, spec.z);
        if (spec.rogue) {
            g.visible = false;
            // pulsing warning rings, animated when rogue is live
            for (let i = 0; i < 3; i++) {
                const pr = makeRing(1, COLORS.rogue, 0.8);
                pr.position.y = 0.08;
                g.add(pr);
                roguePulseRings.push(pr);
            }
        }
        scene.add(g);
        towers3D[spec.id] = g;
    });
}

function makeRing(radius, color, opacity) {
    const pts = [];
    for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({
        color, transparent: true, opacity,
    }));
}

function buildUEs() {
    const geo = new THREE.SphereGeometry(0.55, 10, 10);
    for (let i = 1; i <= 24; i++) {
        const id = `UE-${String(i).padStart(2, "0")}`;
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COLORS.IN_SERVICE }));
        m.position.set((Math.random() - 0.5) * 2 * WORLD.x, 0.6, (Math.random() - 0.5) * 2 * WORLD.z);
        m.userData.target = m.position.clone();
        scene.add(m);
        ueMeshes[id] = m;
    }
}

/* ============================ camera controls ============================ */

function initCameraControls() {
    let dragging = false, px = 0, py = 0;
    const el = renderer.domElement;
    el.addEventListener("pointerdown", e => { dragging = true; px = e.clientX; py = e.clientY; cam.auto = false; });
    window.addEventListener("pointerup", () => { dragging = false; });
    window.addEventListener("pointermove", e => {
        if (!dragging) return;
        cam.theta -= (e.clientX - px) * 0.005;
        cam.phi = Math.min(1.35, Math.max(0.25, cam.phi - (e.clientY - py) * 0.004));
        px = e.clientX; py = e.clientY;
    });
    el.addEventListener("wheel", e => {
        cam.radius = Math.min(120, Math.max(24, cam.radius + e.deltaY * 0.05));
    }, { passive: true });
}

function updateCamera() {
    if (cam.auto) cam.theta += 0.0012;
    const y = Math.sin(cam.phi) * cam.radius;
    const r = Math.cos(cam.phi) * cam.radius;
    camera.position.set(Math.sin(cam.theta) * r, y, Math.cos(cam.theta) * r);
    camera.lookAt(0, 2, 0);
}

/* ============================ websocket client =========================== */

function connectWebSocket() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const host = location.host || "localhost:8000";
    const socket = new WebSocket(`${proto}://${host}/ws`);
    const conn = document.getElementById("conn");

    socket.onopen = () => { conn.textContent = "● LINK ESTABLISHED"; conn.className = "mono ok"; };
    socket.onclose = () => {
        conn.textContent = "● LINK DOWN — retrying";
        conn.className = "mono down";
        setTimeout(connectWebSocket, 2000);
    };
    socket.onerror = () => socket.close();
    socket.onmessage = ev => {
        snapshot = JSON.parse(ev.data);
        updateHUD(snapshot);
    };
}

/* ================================ HUD =================================== */

const PHASE_ORDER = ["SECURE", "ROGUE_ACTIVATION", "DOWNGRADE", "MESH_FORMATION", "CONTAINED"];
const PHASE_CLASS = { ROGUE_ACTIVATION: "hostile", DOWNGRADE: "hostile", MESH_FORMATION: "good", CONTAINED: "good" };

function updateHUD(s) {
    // status pill
    const pill = document.getElementById("status-pill");
    const label = { SECURE: "SECURE", SUSPICIOUS: "SUSPICIOUS", ATTACK_DETECTED: "ATTACK DETECTED", MESH_ACTIVE: "MESH ACTIVE" }[s.status] || s.status;
    pill.textContent = label;
    pill.className = "pill " + { SECURE: "secure", SUSPICIOUS: "suspicious", ATTACK_DETECTED: "attack", MESH_ACTIVE: "mesh" }[s.status];

    // confidence
    document.getElementById("confidence-fill").style.width = s.confidence + "%";
    document.getElementById("confidence-val").textContent = Math.round(s.confidence) + "%";

    // kill chain
    const cur = PHASE_ORDER.indexOf(s.phase);
    document.querySelectorAll("#phases li").forEach(li => {
        const idx = PHASE_ORDER.indexOf(li.dataset.phase);
        li.classList.remove("active", "done", "hostile", "good");
        if (idx < cur) li.classList.add("done");
        if (idx === cur) {
            li.classList.add("active");
            if (PHASE_CLASS[li.dataset.phase]) li.classList.add(PHASE_CLASS[li.dataset.phase]);
        }
    });

    // KPIs
    setKPI("kpi-rogue", s.kpis.ues_on_rogue, s.kpis.ues_on_rogue > 0 ? "hot" : "");
    setKPI("kpi-imsi", s.kpis.imsi_exposed, s.kpis.imsi_exposed > 0 ? "hot" : "");
    setKPI("kpi-mesh", s.kpis.mesh_nodes, s.kpis.mesh_nodes > 0 ? "cool" : "");
    setKPI("kpi-hops", s.kpis.mesh_nodes ? s.kpis.avg_hops : "—", "cool");
    setKPI("kpi-tput", s.kpis.mesh_nodes ? s.kpis.mesh_throughput_kbps + " kb/s" : "—", "cool");
    setKPI("kpi-relayed", s.kpis.mesh_relayed, "");

    // cipher line
    const enc = document.getElementById("enc");
    enc.textContent = s.telemetry.encryption;
    enc.className = "mono" + (s.telemetry.encryption.includes("A5/0") ? " bad" : "");

    renderEvents(s.events);
}

function setKPI(id, val, cls) {
    const el = document.getElementById(id);
    el.textContent = val;
    el.className = "mono " + cls;
}

function renderEvents(events) {
    const log = document.getElementById("event-log");
    if (!events.length) return;
    let start = 0;
    if (lastEventKey) {
        const idx = events.findIndex(e => eventKey(e) === lastEventKey);
        if (idx >= 0) start = idx + 1;
        else start = Math.max(0, events.length - 40); // engine reset — resync
    }
    for (let i = start; i < events.length; i++) {
        const e = events[i];
        const div = document.createElement("div");
        div.className = "ev";
        div.innerHTML = `<span class="t">[${fmtTime(e.t)}]</span><span class="src">${e.src}</span><span class="${e.sev}">${escapeHtml(e.msg)}</span>`;
        log.appendChild(div);
    }
    while (log.children.length > 60) log.removeChild(log.firstChild);
    lastEventKey = eventKey(events[events.length - 1]);
}

function eventKey(e) { return `${e.t}|${e.src}|${e.msg}`; }
function fmtTime(t) {
    const m = Math.floor(t / 60), s = (t % 60).toFixed(1);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(4, "0")}`;
}
function escapeHtml(str) {
    return str.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function tickClock() {
    if (!snapshot) return;
    document.getElementById("clock").textContent = "T+" + fmtTime(snapshot.elapsed);
}

/* ============================ 3D state sync ============================= */

function syncScene(dt, now) {
    if (!snapshot) return;

    // towers
    snapshot.towers.forEach(tw => {
        const g = towers3D[tw.id];
        if (!g) return;
        if (tw.rogue) {
            g.visible = !!tw.active;
            if (tw.active) g.scale.set(1, Math.max(0.05, tw.ramp), 1);
        }
    });

    // rogue pulse rings
    const rogueOn = snapshot.towers.some(t => t.rogue && t.active);
    roguePulseRings.forEach((r, i) => {
        const p = ((now * 0.7) + i / roguePulseRings.length) % 1;
        r.scale.setScalar(2 + p * 16);
        r.material.opacity = rogueOn ? (1 - p) * 0.7 : 0;
    });

    // UEs
    snapshot.ues.forEach(ue => {
        const m = ueMeshes[ue.id];
        if (!m) return;
        m.userData.target.set(ue.x, 0.6, ue.z);
        let color = COLORS[ue.status] || COLORS.IN_SERVICE;
        if (ue.status === "IMSI_EXPOSED" && Math.sin(now * 6) > 0) color = 0xffffff; // strobe
        m.material.color.setHex(color);
        m.scale.setScalar(ue.status === "GATEWAY" ? 1.7 : 1);
    });

    // mesh links (positions refresh every frame — nodes drift)
    updateMeshLines(snapshot.mesh.links);

    // packet pulses along routed paths
    spawnPackets(snapshot, dt);
    updatePackets(dt);
}

const MAX_MESH_LINKS = 64;
let meshPosArray = null;

function updateMeshLines(links) {
    if (!meshLineSegs) {
        meshPosArray = new Float32Array(MAX_MESH_LINKS * 2 * 3);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(meshPosArray, 3));
        meshLineSegs = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
            color: COLORS.meshLine, transparent: true, opacity: 0.4,
        }));
        meshLineSegs.frustumCulled = false;
        scene.add(meshLineSegs);
    }
    const n = Math.min(links.length, MAX_MESH_LINKS);
    for (let i = 0; i < n; i++) {
        const ma = ueMeshes[links[i][0]], mb = ueMeshes[links[i][1]];
        if (!ma || !mb) continue;
        meshPosArray[i * 6 + 0] = ma.position.x;
        meshPosArray[i * 6 + 1] = 0.7;
        meshPosArray[i * 6 + 2] = ma.position.z;
        meshPosArray[i * 6 + 3] = mb.position.x;
        meshPosArray[i * 6 + 4] = 0.7;
        meshPosArray[i * 6 + 5] = mb.position.z;
    }
    meshLineSegs.geometry.setDrawRange(0, n * 2);
    meshLineSegs.geometry.attributes.position.needsUpdate = true;
    meshLineSegs.visible = n > 0;
}

let packetSpawnAcc = 0;
function spawnPackets(s, dt) {
    packetSpawnAcc += dt;
    if (packetSpawnAcc < 0.22) return;
    packetSpawnAcc = 0;
    const routed = s.ues.filter(u => u.status === "MESH_NODE" && u.path && u.path.length > 1);
    if (!routed.length || packets.length > 40) return;
    const ue = routed[Math.floor(Math.random() * routed.length)];
    packets.push({ path: ue.path.slice(), seg: 0, t: 0, mesh: makePacketMesh() });
}
function makePacketMesh() {
    const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.32, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xeafff3 })
    );
    scene.add(m);
    return m;
}
function updatePackets(dt) {
    for (let i = packets.length - 1; i >= 0; i--) {
        const p = packets[i];
        p.t += dt * 2.2; // hop speed
        if (p.t >= 1) { p.t = 0; p.seg++; }
        const a = ueMeshes[p.path[p.seg]], b = ueMeshes[p.path[p.seg + 1]];
        if (!a || !b) {
            scene.remove(p.mesh);
            packets.splice(i, 1);
            continue;
        }
        p.mesh.position.lerpVectors(a.position, b.position, p.t);
        p.mesh.position.y = 0.9;
    }
}

/* ================================ loop ================================== */

let lastFrame = performance.now();
function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    const t = now / 1000;

    // tower sweeps
    Object.entries(sweepMeshes).forEach(([id, sw]) => {
        const g = towers3D[id];
        if (g && g.visible) sw.rotation.y = t * (id === "ROGUE-BTS" ? 2.4 : 0.7);
    });

    // smooth UE motion toward snapshot targets
    Object.values(ueMeshes).forEach(m => m.position.lerp(m.userData.target, 0.12));

    syncScene(dt, t);
    updateCamera();
    renderer.render(scene, camera);
}

function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

window.onload = init;

/* ============================ SHODAN OSINT PIVOT ============================ */
let osintTriggered = false;

function checkOsintTrigger(phase) {
    if (phase === "CONTAINED" && !osintTriggered) {
        osintTriggered = true;
        triggerOsintSequence();
    } else if (phase === "SECURE") {
        osintTriggered = false;
        document.getElementById('osint-panel').classList.add('hidden');
        document.getElementById('ai-box').classList.add('hidden');
    }
}

// Hook this into the existing updateHUD function
const originalUpdateHUD = updateHUD;
updateHUD = function(s) {
    originalUpdateHUD(s);
    checkOsintTrigger(s.phase);
};

function triggerOsintSequence() {
    const panel = document.getElementById('osint-panel');
    const term = document.getElementById('osint-term');
    const vid = document.getElementById('cctv-video');
    
    // 1. Show the panel
    panel.classList.remove('hidden');
    
    // 2. FORCE the video to play (Bypasses browser autoplay limits on hidden divs)
    if(vid) {
        vid.currentTime = 0; // Reset video to start
        vid.play().catch(err => console.log("Video Autoplay blocked by browser:", err));
    }
    
    // 3. Fake Terminal Sequence
    const sequence = [
        "[+] TDOA Geolocation complete. Target acquired.",
        "[*] Initiating Shodan.io API Pivot...",
        "[*] Query: has_screenshot:true port:554 geo:-1.2921,36.8219 radius:100",
        "[*] Found 1 exposed RTSP camera (Insecam DB matched).",
        "[*] Bypassing default auth (admin:admin)...",
        "[+] VIDEO STREAM HIJACKED."
    ];
    
    term.innerHTML = "";
    let delay = 0;
    
    sequence.forEach((line, index) => {
        setTimeout(() => {
            term.innerHTML += `<div>${line}</div>`;
            // Scroll to bottom as text types
            term.scrollTop = term.scrollHeight; 
        }, delay);
        delay += 800; // Typewriter delay
    });

    // 4. Show AI Bounding Box after stream "loads"
    setTimeout(() => {
        document.getElementById('ai-box').classList.remove('hidden');
    }, delay + 1000);
}
/* ============================ DARAJA API LOGIC ============================ */
function triggerSTKPush() {
    const term = document.getElementById('mpesa-terminal');
    const mpesaStatus = document.getElementById('mpesa-status');
    const phase = snapshot ? snapshot.phase : "SECURE";
    
    // Clear terminal
    term.innerHTML = "";

    term.innerHTML += `<div>[*] Initiating Daraja OAuth Token...</div>`;
    
    setTimeout(() => {
        term.innerHTML += `<div>[*] Payload: { "Amount": 5000, "PartyA": "0712***", "TransType": "PayBill" }</div>`;
        
        setTimeout(() => {
            if (phase === "SECURE") {
                // Normal Cellular
                term.innerHTML += `<div class="msg-success">[+] STK Push transmitted via Safaricom BTS-1 (A5/3 Encrypted).</div>`;
                term.innerHTML += `<div class="msg-success">[+] TRANSACTION COMPLETE.</div>`;
            } 
            else if (phase === "ROGUE_ACTIVATION" || phase === "DOWNGRADE") {
                // Interception Attack
                term.innerHTML += `<div class="msg-error">[!] CRITICAL: Network downgraded to A5/0 (NULL CIPHER).</div>`;
                term.innerHTML += `<div class="msg-error">[!] DARAJA PAYLOAD HALTED. STK Push vulnerable to Man-In-The-Middle attack!</div>`;
                mpesaStatus.className = "mono status-danger";
                mpesaStatus.innerText = "● INTERCEPT RISK";
            } 
            else if (phase === "MESH_FORMATION" || phase === "CONTAINED") {
                // Sovereign Mesh Rescue
                term.innerHTML += `<div>[*] Cellular layer compromised. Bypassing Safaricom RAN...</div>`;
                term.innerHTML += `<div class="msg-mesh">[+] Routing Daraja Payload via Sovereign P2P Mesh Network...</div>`;
                term.innerHTML += `<div class="msg-mesh">[+] STK Push delivered via AES-256-GCM Tunnel.</div>`;
                term.innerHTML += `<div class="msg-success">[+] TRANSACTION SECURELY COMPLETED.</div>`;
                mpesaStatus.className = "mono status-mesh";
                mpesaStatus.innerText = "● MESH TUNNEL ACTIVE";
            }
            term.scrollTop = term.scrollHeight;
        }, 800);
    }, 400);
}

// Auto-update the Daraja Status text when the snapshot phase changes
const originalHUDUpdate = updateHUD;
updateHUD = function(s) {
    originalHUDUpdate(s);
    checkOsintTrigger(s.phase); // From previous CCTV update
    
    const mpesaStatus = document.getElementById('mpesa-status');
    if (s.phase === "SECURE") {
        mpesaStatus.className = "mono status-ok";
        mpesaStatus.innerText = "● SECURE TUNNEL";
    } else if (s.phase === "ROGUE_ACTIVATION" || s.phase === "DOWNGRADE") {
        mpesaStatus.className = "mono status-danger";
        mpesaStatus.innerText = "● INTERCEPT RISK";
    } else if (s.phase === "MESH_FORMATION" || s.phase === "CONTAINED") {
        mpesaStatus.className = "mono status-mesh";
        mpesaStatus.innerText = "● MESH TUNNEL ACTIVE";
    }
};
/* ============================ DARAJA API LOGIC ============================ */
/* ============================ DARAJA API PIN STEALER ============================ */
window.triggerSTKPush = function() {
    const term = document.getElementById('mpesa-terminal');
    const mpesaStatus = document.getElementById('mpesa-status');
    const phase = snapshot ? snapshot.phase : "SECURE";
    
    term.innerHTML = `<div>[*] Initiating Daraja OAuth Token...</div>`;
    
    // Simulate the phone vibrating and popping up the STK push
    setTimeout(() => {
        // Native browser prompt mimics the SIM Toolkit popup perfectly!
        let pin = prompt("SAFARICOM STK PUSH\nPay KES 5,000 to Kabarak Uni.\n\nEnter M-PESA PIN:");
        
        if (!pin) {
            term.innerHTML += `<div class="msg-error">[-] User cancelled STK Push.</div>`;
            return;
        }

        term.innerHTML += `<div>[*] Payload: { "Amount": 5000, "PartyA": "0712***", "TransType": "PayBill" }</div>`;
        term.scrollTop = term.scrollHeight;
        
        setTimeout(() => {
            if (phase === "SECURE") {
                // NORMAL
                term.innerHTML += `<div class="msg-success">[+] PIN Encrypted: ********</div>`;
                term.innerHTML += `<div class="msg-success">[+] STK Push transmitted via KABARAK-MAIN (A5/3 Encrypted).</div>`;
            } 
            else if (phase === "ROGUE_ACTIVATION" || phase === "DOWNGRADE") {
                // THE HACK: Show the PIN in plain text!
                term.innerHTML += `<div class="msg-error" style="font-size: 14px; font-weight: bold; background: #300;">[!] CRITICAL INTERCEPT: PIN EXPOSED IN PLAIN TEXT: ${pin}</div>`;
                term.innerHTML += `<div class="msg-error">[!] DARAJA PAYLOAD HALTED. Man-In-The-Middle attack detected!</div>`;
            } 
            else if (phase === "MESH_FORMATION" || phase === "CONTAINED") {
                // MESH SAVES THE DAY
                term.innerHTML += `<div>[*] Cellular layer compromised. Bypassing Safaricom RAN...</div>`;
                term.innerHTML += `<div class="msg-mesh">[+] PIN AES-Encrypted Locally: [ENCRYPTED-HASH-0x9F]</div>`;
                term.innerHTML += `<div class="msg-mesh">[+] Routing Daraja Payload via Sovereign P2P Mesh Network...</div>`;
            }
            term.scrollTop = term.scrollHeight;
        }, 800);
    }, 400);
};

/* ============================ SHODAN DUAL CAMERA ============================ */
function triggerOsintSequence() {
    const panel = document.getElementById('osint-panel');
    const term = document.getElementById('osint-term');
    
    panel.classList.remove('hidden');
    
    // THE MAGIC: Put Teammate 1's Ngrok link here
    document.getElementById('cctv-video-1').src = "https://TEAMMATE_1_NGROK.ngrok-free.app/video_feed";
    // Put Teammate 2's Ngrok link here
    document.getElementById('cctv-video-2').src = "https://TEAMMATE_2_NGROK.ngrok-free.app/video_feed";
    
    const sequence = [
        "[+] Distributed TDOA Geolocation complete. Targets acquired.",
        "[*] Initiating Shodan.io API Pivot in Nakuru County...",
        "[*] Bypassing firewall for CAM-KABARAK-GATE...",
        "[*] Bypassing firewall for CAM-NAKURU-CBD...",
        "[+] LIVE VIDEO STREAMS HIJACKED."
    ];
    
    term.innerHTML = "";
    let delay = 0;
    
    sequence.forEach((line) => {
        setTimeout(() => {
            term.innerHTML += `<div>${line}</div>`;
            term.scrollTop = term.scrollHeight; 
        }, delay);
        delay += 800;
    });

    setTimeout(() => {
        document.getElementById('ai-box-1').classList.remove('hidden');
        document.getElementById('ai-box-2').classList.remove('hidden');
    }, delay + 1000);
}

// Auto-update the M-Pesa Status text during the scenario
const mpesaHUDUpdate = updateHUD;
updateHUD = function(s) {
    mpesaHUDUpdate(s);
    
    const mpesaStatus = document.getElementById('mpesa-status');
    if(mpesaStatus) {
        if (s.phase === "SECURE") {
            mpesaStatus.className = "mono status-ok";
            mpesaStatus.innerText = "● SECURE TUNNEL";
        } else if (s.phase === "ROGUE_ACTIVATION" || s.phase === "DOWNGRADE") {
            mpesaStatus.className = "mono status-danger";
            mpesaStatus.innerText = "● INTERCEPT RISK";
        } else if (s.phase === "MESH_FORMATION" || s.phase === "CONTAINED") {
            mpesaStatus.className = "mono status-mesh";
            mpesaStatus.innerText = "● MESH TUNNEL ACTIVE";
        }
    }
};
/* ============================ 3D CLICK DETECTION (RAYCASTER) ============================ */
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

window.addEventListener('pointerdown', (event) => {
    // Ignore clicks if the camera panel is already open
    if (!document.getElementById('osint-panel').classList.contains('hidden')) return;

    // Calculate mouse position
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    // Get the 3D meshes of the two red towers
    const rogueMeshes = [];
    if(towers3D['ROGUE-LEFT'] && towers3D['ROGUE-LEFT'].visible) rogueMeshes.push(...towers3D['ROGUE-LEFT'].children);
    if(towers3D['ROGUE-RIGHT'] && towers3D['ROGUE-RIGHT'].visible) rogueMeshes.push(...towers3D['ROGUE-RIGHT'].children);

    const intersects = raycaster.intersectObjects(rogueMeshes, true);

    if (intersects.length > 0) {
        // Find which tower was clicked
        let clickedId = 'ROGUE-LEFT';
        let currentObj = intersects[0].object;
        
        while(currentObj.parent && currentObj.parent.type !== "Scene") {
            if (currentObj.parent === towers3D['ROGUE-RIGHT']) { clickedId = 'ROGUE-RIGHT'; break; }
            currentObj = currentObj.parent;
        }
        
        openCameraFor(clickedId);
    }
});

/* ============================ OSINT DYNAMIC CAMERA LOGIC ============================ */
function openCameraFor(towerId) {
    const panel = document.getElementById('osint-panel');
    const term = document.getElementById('osint-term');
    const img = document.getElementById('cctv-video-single');
    const title = document.getElementById('cctv-title');
    const aiBox = document.getElementById('ai-box-single');

    panel.classList.remove('hidden');
    aiBox.classList.add('hidden');
    term.innerHTML = "<div>[*] Establishing secure tunnel to selected node...</div>";

    if (towerId === 'ROGUE-LEFT') {
        title.innerText = "CAM: LEFT END OF BACK SEAT";
        img.src = "https://snowdrift-fidgety-staple.ngrok-free.dev/video_feed"; // <-- PUT NGROK LINK 1 HERE
        aiBox.innerText = "TEAMMATE 1 ACQUIRED";
    } else {
        title.innerText = "CAM: RIGHT END OF BACK SEAT";
        img.src = "https://TEAMMATE_2_NGROK.ngrok-free.app/video_feed"; // <-- PUT NGROK LINK 2 HERE
        aiBox.innerText = "TEAMMATE 2 ACQUIRED";
    }

    setTimeout(() => {
        term.innerHTML += "<div>[+] STREAM HIJACKED SUCCESSFULLY.</div>";
        aiBox.classList.remove('hidden');
    }, 1000);
}

// THIS FUNCTION STOPS THE LAG WHEN YOU CLICK 'X'
window.closeOSINT = function() {
    document.getElementById('osint-panel').classList.add('hidden');
    // Emptying the src instantly stops the video download, freeing up your computer's memory!
    document.getElementById('cctv-video-single').src = ""; 
};

// Update OSINT sequence to prompt the user to click
function triggerOsintSequence() {
    const term = document.getElementById('event-log');
    term.innerHTML += `<div class="msg-error" style="font-size: 14px; background: rgba(255,0,0,0.2); padding: 5px; margin-top: 5px;">[!] TDOA GEOLOCATION COMPLETE. TWO ROGUE NODES DETECTED.</div>`;
    term.innerHTML += `<div class="msg-mesh" style="font-size: 14px; font-weight: bold; animation: blink 1s infinite;">>>> CLICK ON A RED TOWER TO INTERCEPT LIVE CAMERA FEED <<<</div>`;
    term.scrollTop = term.scrollHeight;
}