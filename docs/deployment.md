# Deploying Dhaba POS

One build, two profiles, chosen with `DEPLOY_PROFILE`:

| | `lan` (default) — counter PC | `cloud` — VPS for owner access from home |
|---|---|---|
| Listens on | a private LAN address only (`HOST`, default: this PC's first private IPv4); `0.0.0.0` and public addresses are refused | `HOST` (default `0.0.0.0`) |
| Transport | HTTP allowed; optional HTTPS with a locally trusted (mkcert) certificate | HTTPS only (Let's Encrypt); plain HTTP only answers 301 → HTTPS (`HTTP_REDIRECT_PORT`) or stays closed |
| CORS | none (the web app is served by the backend, same origin) | only `CORS_ORIGIN` |
| Login rate limit | none | 10 attempts / minute / IP → 429 |
| Off-server backup | optional (`OFFSITE_BACKUP_DIR`) | **mandatory**: nightly copy to `OFFSITE_BACKUP_DIR` at `OFFSITE_BACKUP_TIME` (IST, default 02:30) |
| Internet | not needed | needed at the dhaba |

The server refuses to start ("pos-api refused to start: invalid deployment configuration") when a
profile's rules are broken. `npm run check:deploy` runs the same checks plus the data folder
permissions and the off-server folder, and exits 1 on any failure — run it before handing over.

## Counter PC (LAN profile)

1. Install Node 20, then in the repository: `npm ci && npm run build`. Copy the web app build to a
   folder (e.g. `C:\DhabaPOS\web`).
2. In the router, reserve a fixed IP for the counter PC (DHCP reservation), e.g. `192.168.1.20`.
3. Install the service:
   - **Windows** (elevated PowerShell, `nssm.exe` on PATH):
     ```powershell
     .\deploy\windows\install-service.ps1 -DataDir C:\DhabaPOS\data -LanIp 192.168.1.20 -WebDir C:\DhabaPOS\web
     ```
     Registers the `DhabaPOS` NSSM service (auto-start, restart on crash, runs as LocalService),
     restricts `DataDir` with `icacls` to LocalService + Administrators, opens the port only for the
     Private firewall profile / local subnet, and waits for `/api/v1/health`.
   - **Linux** (`sudo`, env file with the `.env.example` settings, `DEPLOY_PROFILE=lan`):
     ```bash
     sudo deploy/linux/install.sh ./pos-api.env
     ```
     Creates the `dhabapos` account, `/etc/dhaba-pos/pos-api.env` (mode 640), the data folder (mode
     700), runs `check:deploy`, starts PM2 and registers `pm2 startup` so it starts on boot.
4. Disable write caching on the data disk and fit a small UPS (a cached fsync can lose a confirmed
   payment on a power cut).
5. Run the acceptance checklist below.

### LAN acceptance checklist

| Check | How | Pass |
|---|---|---|
| Auto-start | Reboot the counter PC; do not log in. From a phone: `http://pos.local/api/v1/health` | `200` with `"status":"green"` |
| Offline | Unplug the router's WAN cable; take a dine-in order and record a payment from two phones | both succeed |
| Router Wi-Fi | Router admin page | staff Wi-Fi is WPA2 (or WPA2/WPA3), not WEP/open |
| Guest network | Join a phone to the customers' guest Wi-Fi; open `http://192.168.1.20/api/v1/health` | connection fails (guest/AP isolation on) |
| WAN port scan | From a phone on mobile data: `nmap -Pn -p 80,443,3000 <public IP>` (or an online port checker) | all closed/filtered; no port forwarding or UPnP mapping to the PC |
| Bind address | `netstat -an` / `ss -ltn` on the PC | listens on `192.168.1.20:<port>` only, not `0.0.0.0` |
| Data folder | `npm run check:deploy` (Linux) or `icacls <DataDir>` (Windows) | only the service account (and Administrators) |

## pos.local name and certificate (spike)

Goal: staff open `http://pos.local` (or `https://pos.local`) on phones on the dhaba Wi-Fi.

Findings to confirm on the actual router and phones:

- **Name resolution.** Android Chrome does not reliably resolve mDNS `.local` names, so do not rely on
  Bonjour/Avahi alone. Preferred: add a **static DNS entry on the router** (`pos.local` →
  `192.168.1.20`; most routers call it "Local DNS", "Static DNS" or "Hostname mapping"; on OpenWrt:
  `Network → DHCP and DNS → Hostnames`). Keep Avahi/Bonjour on the PC as a bonus for iOS and laptops.
- **Port.** `http://pos.local` means port 80: install with `-Port 80` (Windows) or `PORT=80` (Linux;
  the installer grants `cap_net_bind_service`).
- **Installable PWA.** Chrome installs a PWA and runs its service worker only in a secure context, so
  plain `http://pos.local` works in a browser tab but will not install or launch offline. Preferred
  fix: serve HTTPS on the LAN with a locally trusted certificate:
  ```bash
  mkcert -install                       # once, on the PC that makes the certificates
  mkcert pos.local 192.168.1.20         # writes pos.local+1.pem and pos.local+1-key.pem
  ```
  Set `TLS_CERT_FILE`, `TLS_KEY_FILE`, `PORT=443` and `HTTP_REDIRECT_PORT=80` (the installer's
  `-TlsCertFile`/`-TlsKeyFile`), then install mkcert's `rootCA.pem` on every staff device
  (Android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate;
  iOS: install the profile, then enable full trust in Settings → General → About → Certificate Trust Settings).
- **Fallback** if installing the root certificate on each phone is impractical: bookmark
  `http://192.168.1.20` (fixed IP) and use the app in a browser tab without install or offline launch.

Record the result for each device model (name resolves? cert trusted? installs?) in the phase gate.

## Cloud VPS (cloud profile)

1. A VPS with 1 vCPU / 1 GB RAM is enough. PM2 caps the heap at 512 MB
   (`NODE_MAX_OLD_SPACE_MB`) and restarts the process above 750 MB (`PM2_MAX_MEMORY`) rather than
   letting the kernel OOM-kill it.
2. Point a DNS name at the VPS and get a Let's Encrypt certificate (port 80 must be free during
   issuance, so stop pos-api first or use the hooks):
   ```bash
   sudo certbot certonly --standalone -d pos.example.in \
     --pre-hook "sudo -H -u dhabapos pm2 stop pos-api" --post-hook "sudo -H -u dhabapos pm2 start pos-api"
   ```
3. Mount the off-server backup target (another machine or cloud storage), e.g.
   `rclone mount remote:dhaba-backups /mnt/offsite --daemon` or an sshfs/SMB mount. The server copies
   a fresh verified snapshot there every night and keeps the same retention as `backups/`.
4. Env file:
   ```ini
   DEPLOY_PROFILE=cloud
   PORT=443
   HTTP_REDIRECT_PORT=80
   DATA_DIR=/var/lib/dhaba-pos
   WORKBOOK_SHEET_PASSWORD=<random>
   TLS_CERT_FILE=/etc/letsencrypt/live/pos.example.in/fullchain.pem
   TLS_KEY_FILE=/etc/letsencrypt/live/pos.example.in/privkey.pem
   CORS_ORIGIN=https://pos.example.in
   OFFSITE_BACKUP_DIR=/mnt/offsite
   WEB_DIR=/opt/dhaba-pos/web
   ```
5. `sudo deploy/linux/install.sh ./pos-api.env` (fails if the review fails).

### Cloud review checklist

| Check | Pass |
|---|---|
| `npm run check:deploy` with the production env | "Review passed." — a missing `OFFSITE_BACKUP_DIR` fails review |
| `curl -I http://pos.example.in/api/v1/health` | `301` to `https://…`, never content |
| `curl https://pos.example.in/api/v1/health` | `200`, `Strict-Transport-Security` header |
| 11 `POST /api/v1/auth/login` within a minute from one IP | the 11th answers `429 TOO_MANY_ATTEMPTS` |
| `curl -H 'Origin: https://other.example' -I https://pos.example.in/api/v1/health` | no `Access-Control-Allow-Origin` header |
| Next morning: `ls /mnt/offsite` | a `snapshot-YYYYMMDD-0230xx-auto.xlsx` from last night |
| Daily load on the 1 GB VPS (`pm2 monit` during a lunch-rush run) | no restart for memory, no OOM in `dmesg` |
