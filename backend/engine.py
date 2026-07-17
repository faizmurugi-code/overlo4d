"""
Overlord Grid — Sovereign Shield simulation engine.

Models a small cellular grid (3 macro cells + roaming UEs), a rogue
base-station (IMSI catcher) attack chain, heuristic detection, and an
802.11s-style encrypted mesh fallback.

The engine is deterministic-friendly (seedable) and stepped by `update(dt)`.
Everything the frontend renders comes out of `snapshot()`.
"""

import math
import random
from collections import deque


# ----------------------------------------------------------------------------
# World constants
# ----------------------------------------------------------------------------

WORLD_X = 42.0          # half-extent of the playfield on X
WORLD_Z = 24.0          # half-extent of the playfield on Z

N_UES = 24
UE_SPEED = 1.6          # units / second (walk speed)

LEGIT_TX_DBM = -38.0    # macro cell reference tx power
ROGUE_TX_DBM = -30.0    # rogue BTS is overpowered so it wins reselection
PATHLOSS = 26.0         # 26 * log10(d) loss curve -> realistic urban macro

RESELECT_HYSTERESIS_DB = 6.0
ROGUE_GRAB_RADIUS = 26.0
UE_VULNERABLE_RATIO = 0.7   # share of fleet with 2G fallback enabled (attack surface)

MESH_RANGE = 14.5       # 802.11s / BLE-ish link budget
DOWNGRADE_T1 = 2.5      # s on rogue before A5/3 -> A5/1
DOWNGRADE_T2 = 5.5      # s on rogue before A5/1 -> A5/0 (+ IMSI exposed)

STATUS_SECURE = "SECURE"
STATUS_SUSPICIOUS = "SUSPICIOUS"
STATUS_ATTACK = "ATTACK_DETECTED"
STATUS_MESH = "MESH_ACTIVE"

# Scenario phases (scripted timeline)
PH_SECURE = "SECURE"
PH_ROGUE_UP = "ROGUE_ACTIVATION"
PH_DOWNGRADE = "DOWNGRADE"
PH_MITIGATION = "MESH_FORMATION"
PH_CONTAINED = "CONTAINED"

# Scripted timeline (seconds from scenario start)
SCENARIO = [
    (0.0,  PH_SECURE),
    (8.0,  PH_ROGUE_UP),
    (20.0, PH_DOWNGRADE),
    (46.0, PH_MITIGATION),
    (66.0, PH_CONTAINED),
]

TOWER_SPECS = [
    {"id": "KABARAK-MAIN", "x": -25.0, "z": 2.0,  "tac": "7A31", "pci": 12, "earfcn": 1815},
    {"id": "NAKURU-CBD", "x":   0.0, "z": -3.0, "tac": "7A31", "pci": 28, "earfcn": 1815},
    {"id": "RAFIKI-NODE", "x":  25.0, "z": 2.0,  "tac": "7A32", "pci": 41, "earfcn": 1840},
]

ROGUE_SPEC = {"id": "ROGUE-VAN-01", "x": 6.0, "z": -7.0, "tac": "9F21", "pci": 77, "earfcn": 3850}

def _rsrp(tx_dbm: float, dist: float) -> float:
    """Log-distance path loss with light fast-fading."""
    d = max(dist, 1.0)
    return tx_dbm - PATHLOSS * math.log10(d) + random.uniform(-2.5, 2.5)


class UE:
    def __init__(self, idx: int):
        self.id = f"UE-{idx:02d}"
        self.imsi_tail = random.randint(1000, 9999)
        self.x = random.uniform(-WORLD_X, WORLD_X)
        self.z = random.uniform(-WORLD_Z, WORLD_Z)
        self.vx = random.uniform(-1, 1)
        self.vz = random.uniform(-1, 1)
        self.cell = None            # serving cell id (tower id or ROGUE-BTS)
        self.cipher = "A5/3"
        self.rsrp = -85.0
        self.on_rogue_since = None  # timestamp when it camped on the rogue cell
        self.imsi_exposed = False
        self.vulnerable = random.random() < UE_VULNERABLE_RATIO  # 2G fallback on
        self._resist_logged = False
        self.mesh = False           # part of the fallback mesh
        self.gateway = False        # mesh gateway (still has clean backhaul)
        self.hops = 0               # mesh hop count to gateway
        self.path = []              # list of UE ids to gateway (for viz)

    @property
    def status(self) -> str:
        if self.gateway:
            return "GATEWAY"
        if self.mesh:
            return "MESH_NODE"
        if self.cell == ROGUE_SPEC["id"]:
            return "IMSI_EXPOSED" if self.imsi_exposed else "CAMPED_ROGUE"
        return "IN_SERVICE"

    def move(self, dt: float):
        # smooth random walk, bounce at world edges
        if random.random() < 0.02:
            self.vx += random.uniform(-0.6, 0.6)
            self.vz += random.uniform(-0.6, 0.6)
        speed = math.hypot(self.vx, self.vz) or 1.0
        scale = UE_SPEED / speed
        self.vx, self.vz = self.vx * scale, self.vz * scale
        self.x += self.vx * dt
        self.z += self.vz * dt
        if abs(self.x) > WORLD_X:
            self.vx *= -1
            self.x = max(-WORLD_X, min(WORLD_X, self.x))
        if abs(self.z) > WORLD_Z:
            self.vz *= -1
            self.z = max(-WORLD_Z, min(WORLD_Z, self.z))


class Engine:
    def __init__(self, seed: int | None = None):
        if seed is not None:
            random.seed(seed)
        self.sim_time = 0.0
        self.tick_count = 0
        self.reset()

    # ------------------------------------------------------------------ setup

    def reset(self):
        self.sim_time = 0.0
        self.tick_count = 0
        self.ues = [UE(i + 1) for i in range(N_UES)]
        self.rogue = dict(ROGUE_SPEC, active=False, ramp=0.0, on_since=None)
        self.phase = PH_SECURE
        self.confidence = 4.0
        self.events = deque(maxlen=200)
        self.scenario_running = False
        self.scenario_t = 0.0
        self.mesh_links = []        # [(ue_id_a, ue_id_b)]
        self.mesh_relayed = 0
        self.mesh_throughput = 0.0
        self._det = {               # detection indicator accumulators
            "lac_mismatch": 0.0,
            "cipher_downgrade": 0.0,
            "null_cipher": 0.0,
            "signal_anomaly": 0.0,
            "identity_storm": 0.0,
        }
        self._identity_requests = 0
        self._last_identity_check = 0.0
        self._signal_anomaly_armed = True
        self._auto_chain = None
        self._mesh_stable_ticks = 0
        self._downgrade_start = 0.0
        # initial attachment
        for ue in self.ues:
            self._attach_best_legit(ue)
        self._log("CORE", "OK", "Grid nominal — 3 macro cells, 24 UEs attached, cipher A5/3 enforced")

    # ---------------------------------------------------------------- helpers

    def _log(self, src: str, sev: str, msg: str):
        self.events.append({
            "t": round(self.sim_time, 1),
            "src": src, "sev": sev, "msg": msg,
        })

    def _dist(self, a, b) -> float:
        return math.hypot(a.x - b["x"] if isinstance(b, dict) else a.x - b.x,
                          a.z - b["z"] if isinstance(b, dict) else a.z - b.z)

    @staticmethod
    def _d(ax, az, bx, bz) -> float:
        return math.hypot(ax - bx, az - bz)

    def _legit_towers(self):
        return TOWER_SPECS

    def _attach_best_legit(self, ue: UE):
        best, best_rsrp = None, -999.0
        for tw in self._legit_towers():
            r = _rsrp(LEGIT_TX_DBM, self._d(ue.x, ue.z, tw["x"], tw["z"]))
            if r > best_rsrp:
                best, best_rsrp = tw, r
        ue.cell = best["id"]
        ue.rsrp = best_rsrp

    # ------------------------------------------------------------ public API

    def start_scenario(self):
        """Begin the scripted attack->detect->mesh timeline."""
        if self.scenario_running:
            return
        self.reset()
        self.scenario_running = True
        self.scenario_t = 0.0
        self._log("CORE", "INFO", "Scenario runner engaged — live fire exercise starting")

    def start_attack(self):
        """Manual override: deploy the rogue BTS now and let the chain run."""
        if not self.rogue["active"]:
            self.scenario_running = False
            self._enter_phase(PH_ROGUE_UP)
            self._auto_chain = PH_DOWNGRADE  # continue automatically
        else:
            self._log("CORE", "WARN", "Rogue BTS already on air — override ignored")

    def start_mitigation(self):
        """Manual override: force mesh fallback now."""
        self.scenario_running = False
        if self.phase in (PH_DOWNGRADE, PH_ROGUE_UP) and self.rogue["active"]:
            self._enter_phase(PH_MITIGATION)
        elif self.phase in (PH_MITIGATION, PH_CONTAINED):
            self._log("MESH", "INFO", "Mesh fallback already active")
        else:
            self._log("MESH", "WARN", "No threat to mitigate — grid is clean")

    # ------------------------------------------------------------ state machine

    def _enter_phase(self, phase: str):
        self.phase = phase
        if phase == PH_ROGUE_UP:
            self.rogue["active"] = True
            self.rogue["on_since"] = self.sim_time
            self._log("RAN", "WARN",
                      f"Unknown cell on air — EARFCN {self.rogue['earfcn']}, PCI {self.rogue['pci']}, "
                      f"TAC {self.rogue['tac']} (not in neighbor list)")
            self._det["lac_mismatch"] += 25
        elif phase == PH_DOWNGRADE:
            self._downgrade_start = self.sim_time
            self._log("RAN", "CRIT", "Reselection storm — UEs camping on strongest-signal cell")
        elif phase == PH_MITIGATION:
            self._form_mesh()
        elif phase == PH_CONTAINED:
            self._log("CORE", "OK",
                      "Rogue BTS geolocated via TDOA (±40 m) — blacklisted, TAC "
                      f"{self.rogue['tac']} quarantined, traffic remains on mesh")

    # ---------------------------------------------------------------- tick

    def update(self, dt: float):
        self.tick_count += 1
        self.sim_time += dt
        now = self.sim_time

        # scripted timeline advancement
        if self.scenario_running:
            self.scenario_t += dt
            for t, phase in SCENARIO:
                if self.scenario_t >= t and self._phase_rank(self.phase) < self._phase_rank(phase):
                    self._enter_phase(phase)

        # manual attack chain continues automatically
        if getattr(self, "_auto_chain", None) == PH_DOWNGRADE and self.phase == PH_ROGUE_UP:
            if now - (self.rogue["on_since"] if self.rogue["on_since"] is not None else now) > 6:
                self._enter_phase(PH_DOWNGRADE)
                self._auto_chain = PH_MITIGATION
        elif getattr(self, "_auto_chain", None) == PH_MITIGATION and self.phase == PH_DOWNGRADE:
            if self.confidence >= 70:
                self._enter_phase(PH_MITIGATION)
                self._auto_chain = PH_CONTAINED
        elif getattr(self, "_auto_chain", None) == PH_CONTAINED and self.phase == PH_MITIGATION:
            if self._mesh_stable_ticks > 40:
                self._enter_phase(PH_CONTAINED)
                self._auto_chain = None

        # UEs roam
        for ue in self.ues:
            ue.move(dt)

        # rogue power ramp-up after activation
        if self.rogue["active"] and self.rogue["ramp"] < 1.0:
            self.rogue["ramp"] = min(1.0, self.rogue["ramp"] + dt / 3.0)

        # radio behaviour per UE
        for ue in self.ues:
            if ue.mesh:
                continue
            serving = next((t for t in self._legit_towers() if t["id"] == ue.cell), None)
            if serving:
                ue.rsrp = _rsrp(LEGIT_TX_DBM, self._d(ue.x, ue.z, serving["x"], serving["z"]))

            if self.rogue["active"] and self.phase in (PH_ROGUE_UP, PH_DOWNGRADE):
                d_rogue = self._d(ue.x, ue.z, self.rogue["x"], self.rogue["z"])
                r_rogue = _rsrp(ROGUE_TX_DBM, d_rogue) * 1.0 + 8.0 * self.rogue["ramp"]
                if (d_rogue < ROGUE_GRAB_RADIUS and ue.cell != self.rogue["id"]
                        and r_rogue > ue.rsrp + RESELECT_HYSTERESIS_DB):
                    if not ue.vulnerable:
                        if not ue._resist_logged:
                            ue._resist_logged = True
                            self._log("RR", "INFO",
                                      f"{ue.id} rejected reselection — LTE-only policy, 2G fallback disabled")
                        continue
                    ue.cell = self.rogue["id"]
                    ue.rsrp = r_rogue
                    ue.on_rogue_since = now
                    self._log("RRC", "WARN",
                              f"{ue.id} reselect → {self.rogue['tac']}-{self.rogue['pci']} "
                              f"(RSRP {r_rogue:.0f} dBm > serving {ue.rsrp - RESELECT_HYSTERESIS_DB:.0f} dBm)")
                    self._signal_anomaly_check(r_rogue)

            # downgrade cascade for camped UEs
            if ue.cell == self.rogue["id"] and self.phase in (PH_DOWNGRADE, PH_MITIGATION, PH_CONTAINED):
                # clock starts when active exploitation begins, not at camp time
                held = now - max(ue.on_rogue_since or now, self._downgrade_start)
                if ue.cipher == "A5/3" and held > DOWNGRADE_T1:
                    ue.cipher = "A5/1"
                    self._det["cipher_downgrade"] += 15
                    self._log("RR", "CRIT", f"CIPHERING MODE CMD — {ue.id}: A5/3 → A5/1 (weak cipher forced)")
                if ue.cipher == "A5/1" and held > DOWNGRADE_T2:
                    ue.cipher = "A5/0"
                    self._det["null_cipher"] += 25
                    self._log("RR", "CRIT", f"CIPHERING MODE CMD — {ue.id}: A5/1 → A5/0 (NULL CIPHER)")
                if not ue.imsi_exposed and held > DOWNGRADE_T2 + 0.8:
                    ue.imsi_exposed = True
                    self._identity_requests += 1
                    self._det["identity_storm"] += 12
                    self._log("MM", "CRIT",
                              f"IDENTITY REQUEST ← rogue cell — {ue.id} responded, "
                              f"IMSI 001-01-****-{ue.imsi_tail} captured")

        # identity-request storm rate check (every 4 s)
        if now - self._last_identity_check > 4.0:
            self._last_identity_check = now
            if self._identity_requests >= 4:
                self._log("DETECT", "WARN",
                          f"Identity-request storm: {self._identity_requests} IMSI pulls / 4 s window")
            self._identity_requests = 0

        # confidence = weighted indicators with slow decay
        raw = (self._det["lac_mismatch"] + self._det["cipher_downgrade"]
               + self._det["null_cipher"] + self._det["signal_anomaly"]
               + self._det["identity_storm"])
        target = min(100.0, 4.0 + raw)
        if target > self.confidence:
            self.confidence += (target - self.confidence) * min(1.0, dt * 3.0)
        elif self.phase == PH_SECURE:
            self.confidence = max(3.0, self.confidence - dt * 1.5)
        for k in self._det:
            if self.phase == PH_SECURE:
                self._det[k] = max(0.0, self._det[k] - dt * 4.0)

        # mesh churn while mitigation is running
        if self.phase in (PH_MITIGATION, PH_CONTAINED):
            self._mesh_stable_ticks = getattr(self, "_mesh_stable_ticks", 0) + 1
            self._mesh_recompute_paths()
            routed_n = sum(1 for u in self.ues if u.mesh and not u.gateway and u.path)
            if routed_n:
                self.mesh_relayed += random.randint(3, 14)
                if self.mesh_throughput == 0:
                    self.mesh_throughput = 420.0
                self.mesh_throughput = max(180.0, min(920.0,
                    self.mesh_throughput + random.uniform(-30, 30)))
            else:
                self.mesh_throughput = 0.0

    def _phase_rank(self, phase: str) -> int:
        order = [PH_SECURE, PH_ROGUE_UP, PH_DOWNGRADE, PH_MITIGATION, PH_CONTAINED]
        return order.index(phase) if phase in order else 0

    def _signal_anomaly_check(self, r_rogue: float):
        if self._signal_anomaly_armed and r_rogue > -52:
            self._signal_anomaly_armed = False
            self._det["signal_anomaly"] += 15
            self._log("DETECT", "WARN",
                      f"Signal anomaly: RSRP {r_rogue:.0f} dBm exceeds every known macro in grid DB "
                      f"(TA inconsistent)")

    # ------------------------------------------------------------------ mesh

    def _form_mesh(self):
        """UEs that were on the rogue cell drop cellular and mesh up."""
        victims = [u for u in self.ues if u.cell == self.rogue["id"]]
        if not victims:
            self._log("MESH", "WARN", "Mesh ordered but no UEs were camped on the rogue cell")
            return
        # candidate gateways: clean UEs closest to the victim cluster
        clean = [u for u in self.ues if u.cell != self.rogue["id"]]
        clean.sort(key=lambda u: min(self._d(u.x, u.z, v.x, v.z) for v in victims))
        gateways = clean[:2]
        if not gateways:
            # whole fleet was camped on the rogue cell — promote the two UEs
            # farthest from it as backhaul gateways (directional link)
            gateways = sorted(victims,
                              key=lambda v: -self._d(v.x, v.z, self.rogue["x"], self.rogue["z"]))[:2]
            self._log("MESH", "WARN",
                      "No clean UEs in range — promoting edge nodes to backhaul gateways")
        for g in gateways:
            g.gateway = True
            g.mesh = True
            g.hops = 0
        for v in victims:
            v.cell = None
            v.cipher = "AES-256-GCM"
            v.mesh = True
            v.rsrp = 0.0
        self._log("MESH", "OK",
                  f"Fallback engaged — {len(victims)} UEs dropped cellular, "
                  f"Noise-handshake NNpsk0 complete, 802.11s mesh forming")
        self._mesh_build_links()
        self._mesh_recompute_paths()
        n_paths = sum(1 for u in self.ues if u.mesh and not u.gateway and u.path)
        self._log("MESH", "OK",
                  f"{n_paths} routed paths up — avg {self._avg_hops():.1f} hops to gateway, "
                  "all traffic encapsulated AES-256-GCM")

    def _mesh_build_links(self):
        nodes = [u for u in self.ues if u.mesh]
        links = []
        for i, a in enumerate(nodes):
            for b in nodes[i + 1:]:
                if self._d(a.x, a.z, b.x, b.z) < MESH_RANGE:
                    links.append((a.id, b.id))
        self.mesh_links = links

    def _mesh_recompute_paths(self):
        """BFS from every mesh node to nearest gateway; refresh links too."""
        self._mesh_build_links()
        nodes = {u.id: u for u in self.ues if u.mesh}
        adj = {u.id: [] for u in nodes.values()}
        for a, b in self.mesh_links:
            adj[a].append(b)
            adj[b].append(a)
        gateways = [u.id for u in nodes.values() if u.gateway]
        for uid, ue in nodes.items():
            if ue.gateway:
                ue.hops, ue.path = 0, [uid]
                continue
            prev = {uid: None}
            q = deque([uid])
            found = None
            while q:
                cur = q.popleft()
                if cur in gateways:
                    found = cur
                    break
                for nb in adj[cur]:
                    if nb not in prev:
                        prev[nb] = cur
                        q.append(nb)
            if found:
                path = [found]
                while path[-1] != uid:
                    path.append(prev[path[-1]])
                ue.path = list(reversed(path))
                ue.hops = len(ue.path) - 1
            else:
                ue.path, ue.hops = [], 0

    def _avg_hops(self) -> float:
        routed = [u.hops for u in self.ues if u.mesh and not u.gateway and u.path]
        return sum(routed) / len(routed) if routed else 0.0

    # ------------------------------------------------------------------ status

    @property
    def status(self) -> str:
        if self.phase in (PH_MITIGATION, PH_CONTAINED):
            return STATUS_MESH
        if self.confidence >= 70:
            return STATUS_ATTACK
        if self.confidence >= 30 or self.phase in (PH_ROGUE_UP, PH_DOWNGRADE):
            return STATUS_SUSPICIOUS
        return STATUS_SECURE

    # --------------------------------------------------------------- snapshot

    def snapshot(self) -> dict:
        on_rogue = sum(1 for u in self.ues if u.cell == self.rogue["id"])
        exposed = sum(1 for u in self.ues if u.imsi_exposed)
        mesh_nodes = sum(1 for u in self.ues if u.mesh)

        # In engine.py inside the snapshot() function...
        towers = []
        for tw in self._legit_towers():
            towers.append({
                "id": tw["id"], "x": tw["x"], "z": tw["z"],
                "tac": tw["tac"], "pci": tw["pci"], "earfcn": tw["earfcn"],
                "ues": sum(1 for u in self.ues if u.cell == tw["id"]),
                "rogue": False,
            })
            
        # NEW: Output TWO rogue towers for the frontend to render
        towers.append({
            "id": "ROGUE-LEFT", "x": 14.0, "z": -8.0,
            "tac": self.rogue["tac"], "pci": self.rogue["pci"], "earfcn": self.rogue["earfcn"],
            "ues": on_rogue // 2, "rogue": True,
            "active": self.rogue["active"], "ramp": round(self.rogue["ramp"], 2),
        })
        towers.append({
            "id": "ROGUE-RIGHT", "x": -16.0, "z": 10.0,
            "tac": self.rogue["tac"], "pci": self.rogue["pci"], "earfcn": self.rogue["earfcn"],
            "ues": on_rogue - (on_rogue // 2), "rogue": True,
            "active": self.rogue["active"], "ramp": round(self.rogue["ramp"], 2),
        })

        ues = [{
            "id": u.id, "x": round(u.x, 2), "z": round(u.z, 2),
            "cell": u.cell, "cipher": u.cipher, "rsrp": round(u.rsrp, 1),
            "status": u.status, "hops": u.hops, "path": u.path,
        } for u in self.ues]

        if self.status == STATUS_MESH:
            enc = "AES-256-GCM (P2P MESH)"
        elif on_rogue and self.confidence >= 30:
            enc = "A5/0 NULL CIPHER on rogue cell"
        else:
            enc = "A5/3 (3GPP SNOW-based)"

        return {
            "tick": self.tick_count,
            "elapsed": round(self.sim_time, 1),
            "status": self.status,
            "phase": self.phase,
            "scenario_running": self.scenario_running,
            "confidence": round(self.confidence, 1),
            "towers": towers,
            "ues": ues,
            "mesh": {
                "links": self.mesh_links,
                "nodes": mesh_nodes,
                "avg_hops": round(self._avg_hops(), 1),
                "throughput_kbps": round(self.mesh_throughput if mesh_nodes else 0, 0),
                "relayed": self.mesh_relayed,
                "gateways": [u.id for u in self.ues if u.gateway],
            },
            "kpis": {
                "ues_total": len(self.ues),
                "ues_on_rogue": on_rogue,
                "imsi_exposed": exposed,
                "mesh_nodes": mesh_nodes,
                "avg_hops": round(self._avg_hops(), 1),
                "mesh_throughput_kbps": round(self.mesh_throughput if mesh_nodes else 0, 0),
                "mesh_relayed": self.mesh_relayed,
            },
            "telemetry": {
                "encryption": enc,
                "signal": round(max((u.rsrp for u in self.ues), default=-90), 0),
            },
            "events": list(self.events)[-60:],
        }
