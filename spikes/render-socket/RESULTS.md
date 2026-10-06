# Spike (b) and (d, server part): results

Run 2026-10-06 against `https://playhub-api-nlgk.onrender.com` (Render free, Singapore), from GitHub
runners (`.github/workflows/spike-render.yml`), because this Mac's corporate proxy intercepts
`*.onrender.com`.

## (b) Socket.IO on Render free: 32-minute soak

| t (s) | Event |
|---|---|
| 1 | connect, hello ok, epoch 2 |
| 495 | disconnect `transport close` (owner restarted the service) |
| 498 | reconnect, hello ok, **epoch 3** (new boot) |
| 983 | disconnect `transport close` (deploy of `TRUST_PROXY_HOPS=3`) |
| 985 | reconnect, hello ok, **epoch 4** |
| 1920 | end: 3 connects, 2 disconnects, 31 pings, RTT p50 176 ms / max 178 ms (westus3 → Singapore) |

**Verdict:**

- It stays connected for 30+ minutes with no idle drops.
- It survives a restart and a deploy, reconnecting automatically within 2–3 s.
- Epochs increase across boots, as designed.

**Finding (changes ARCHITECTURE §5.6):** Render cuts existing WebSockets with `transport close` when the
new instance takes over. The old instance's `server:moving` was **not** received (`serverMoving: 0`).

- Clients must treat `transport close` like `server:moving`: reconnect and rejoin with `lastStateVersion`.
- The fencing design still holds. In practice the overlap with live sockets on the old instance is
  shorter than 60 s.

## (d) Carrom physics on Render free (0.1 CPU)

`POST /ops/bench/carrom?shots=200` (20 warm-up shots):

- **p50 16.2 ms per shot**, p95 100.5 ms, max 299 ms;
- 51.7 steps per shot on average;
- 220 shots in 15.4 s wall time.

That's about 9× the laptop's 1.76 ms, matching the brief's 10× estimate.

**Verdict:** within budget, so no physics worker thread is needed for one shot. The 300 ms striker
wind-up hides the p50 to p95 range. Re-check the bot's 3-simulation turns in Phase 3.

## Proxy hops (ARCHITECTURE §5.7)

`X-Forwarded-For` was `client, 172.70.x (Cloudflare), 10.25.x (Render balancer)`, and the socket peer
was `127.0.0.1` (a local proxy). So `TRUST_PROXY_HOPS=3`, which is set in `render.yaml`.
