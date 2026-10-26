# ISP Lab: OneISP + SmartOLT simulators

Two separate web apps that copy how **OneISP** (ISP billing and customer management) and **SmartOLT** (GPON OLT/ONU management) work, so you can practice running an ISP on your **MikroTik CHR in VirtualBox** without paying for either service.

| App | URL | Login | What it does |
|---|---|---|---|
| **OneISP simulator** | http://localhost:3000 | `admin` / `admin` | Sites (MikroTik routers), packages, bandwidth policies, vouchers, PPPoE / Static / DHCP / Hotspot customers, payments with simulated M-Pesa, expiry, leads, tickets, SMS, hotspot captive portal, customer self-service portal |
| **SmartOLT simulator** | http://localhost:4000 | `admin` / `admin` | Huawei & ZTE OLTs, autofind of unconfigured ONUs, authorization, configured list with filters, ONU details, signal & traffic graphs, events, diagnostics, reports, a working **OLT telnet CLI**, settings (zones, ODBs/splitters, ONU types, speed profiles, VLANs) |

They **work together** the same way the real ones do:

- When you authorize an ONU in SmartOLT, you search for a OneISP customer. The ONU is then set up with that customer's PPPoE username and password, and OneISP is told which ONU belongs to the customer.
- A OneISP customer's **Fiber / ONU** tab shows the ONU's live status and signal, with Reboot, Resync, Disable and Enable buttons.
- SmartOLT pulls PPPoE password changes from OneISP every 5 minutes.

## The learning part

Every change OneISP makes to a router is shown as the **exact RouterOS command** in a pop-up panel. The same commands are saved under **Router Logs**. Every ONU action in SmartOLT shows the **Huawei or ZTE OLT commands** it sends. You can copy any command and type it yourself in WinBox → New Terminal.

## Requirements

- **Node.js 18 or newer** (https://nodejs.org, LTS version). You don't need to install anything else: there are **no npm packages**.
- Optional: your MikroTik CHR (RouterOS v7) for live mode.

## Start

Windows: double-click **`start-windows.bat`**. Or from a terminal in this folder:

```bash
npm start            # both apps
npm run oneisp       # only OneISP  (port 3000)
npm run smartolt     # only SmartOLT (port 4000)
npm run reset        # delete data/ -> demo data is re-created next start
```

Data is kept in `data/oneisp.json` and `data/smartolt.json`. Both apps start with demo data: 16 customers, 20 ONUs, 2 OLTs, payment history, tickets and leads.

To change the ports, set `ONEISP_PORT` or `SMARTOLT_PORT`. If you change the OneISP port, also update OneISP's URL in SmartOLT → Settings.

## Simulated mode vs live MikroTik

Each OneISP **Site** has a mode:

- **simulate** (default): OneISP keeps a virtual router inside itself. Every feature works, and the *Router tables* tab shows what WinBox would show.
- **live**: OneISP talks to your real CHR through the **RouterOS v7 REST API** (`http://<router>/rest/...`), just as billing systems do through the API.

To go live, follow [`docs/MIKROTIK-LAB.md`](docs/MIKROTIK-LAB.md). In short:

1. In VirtualBox, give the CHR a **Host-only adapter**. Your PC is usually `192.168.56.1` and the CHR gets something like `192.168.56.101`.
2. In WinBox, open New Terminal and run `/ip service set www disabled=no`.
3. In OneISP, open Sites → *Lab CHR* → **Provisioning script**. Check the interface names, then paste the script into the WinBox terminal.
4. Edit the site: set mode to **live**, host to the CHR's IP, and user/password to `oneisp` / `oneisp123` (created by the script). Click **Test connection**, then **Re-provision all**.
5. Open WinBox → PPP → Secrets. Your OneISP customers are now on the router.

## Guides

- [`docs/MIKROTIK-LAB.md`](docs/MIKROTIK-LAB.md): the VirtualBox lab, then MikroTik topic by topic (interfaces, IP, DHCP, DNS, NAT, firewall, PPPoE, hotspot, queues, VLANs, routing, WireGuard, scripting, backups), with exercises that use OneISP.
- [`docs/SMARTOLT-GPON.md`](docs/SMARTOLT-GPON.md): GPON basics, optical budget, a Huawei and ZTE command reference, ONU troubleshooting, and how fiber customers reach the MikroTik PPPoE server.

## Project layout

```
lib/            shared mini web framework, JSON database, RouterOS REST client + simulator
oneisp/         OneISP server (server.js), MikroTik provisioning logic (provision.js), UI (public/)
smartolt/       SmartOLT server, OLT command generators (commands.js), OLT CLI simulator (cli.js), UI
docs/           learning guides
data/           runtime data (git-ignored)
```

These are independent learning tools. They are not affiliated with OneISP or SmartOLT. Payments, SMS and the OLT hardware are simulated. The MikroTik integration is real.
