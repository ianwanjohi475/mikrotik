# MikroTik ISP lab: VirtualBox CHR + OneISP simulator

This guide takes you from a bare CHR to a working small ISP: PPPoE, hotspot, DHCP and static customers, all billed by the OneISP simulator. Each section explains the concept, gives the RouterOS v7 commands, and ends with an exercise.

> Commands go into **WinBox → New Terminal**. Each command also has a matching WinBox menu, so try both.
> Use **Safe Mode** (the button in WinBox's top bar) before you touch firewall rules or addresses. If you lock yourself out, the router undoes your changes when the connection drops.

---

## 0. Lab topology

```
                 Internet (VirtualBox NAT)
                          |
                       ether1 (WAN, DHCP client)
                 +-------------------+
   Your PC ------| ether2 host-only  |  CHR  (RouterOS 7)
 192.168.56.1    | 192.168.56.101    |
 OneISP :8080    +-------------------+
 SmartOLT :4000     ether3  ether4  ether5   (VirtualBox "Internal network" adapters)
                      |       |       |
                 PPPoE/    DHCP     Static
                 Hotspot   clients  clients   <- other VMs (a 2nd CHR, Windows, Linux)
```

### VirtualBox adapters for the CHR (VM powered off → Settings → Network)

| Adapter | Attached to | Becomes | Purpose |
|---|---|---|---|
| 1 | NAT | ether1 | Internet (WAN) |
| 2 | Host-only Adapter (`VirtualBox Host-Only Ethernet Adapter`) | ether2 | WinBox + OneISP API from your PC |
| 3 | Internal Network `lan-pppoe` | ether3 | PPPoE / hotspot customers |
| 4 | Internal Network `lan-dhcp` | ether4 | DHCP / static customers |

The GUI only offers 4 adapters. More are possible with `VBoxManage modifyvm`, but VLANs and bridges usually do the job (see §9).

> The OneISP site defaults are WAN=ether1, PPPoE=ether2, Hotspot=ether3, DHCP=ether4, Static=ether5. **With the table above you must change them** (Sites → Edit). A good choice is PPPoE=ether3, Hotspot=a VLAN or bridge, DHCP=ether4, Static=a VLAN on ether4. If you have no free ports, see "Lab without spare ports" below.

### Lab without spare ports: empty bridges

A bridge works as a virtual switch, so every service can have its own interface:

```
/interface bridge add name=br-pppoe
/interface bridge add name=br-hotspot
/interface bridge add name=br-dhcp
/interface bridge add name=br-static
```

Put those names in the OneISP site settings. To connect a client VM later, add a real port to the bridge: `/interface bridge port add bridge=br-pppoe interface=ether3`.

---

## 1. First login, identity, users, services

```
/system identity set name=LAB-CHR
/user add name=ian group=full password=StrongPass123     # your own admin account
/user disable admin                                     # after testing the new account!
/ip service print
/ip service disable telnet,ftp,api                      # keep winbox, ssh, www (for REST)
/ip service set www disabled=no port=80                 # OneISP uses REST over HTTP in this lab
/ip service set winbox address=192.168.56.0/24          # only allow WinBox from the host-only network
/system clock set time-zone-name=Africa/Nairobi
/system ntp client set enabled=yes servers=pool.ntp.org
```

**Why it matters for an ISP:** OneISP decides when an account has expired. If the router's clock is wrong, scheduled jobs and logs will be wrong too.

**Exercise:** Create a user group `readonly` with policy `read,winbox` and a user in it. Log in with that user in WinBox and try to change something.

---

## 2. Interfaces and IP addressing

```
/interface print
/interface ethernet print
/interface set ether1 comment=WAN
/ip dhcp-client add interface=ether1 disabled=no comment="WAN from VirtualBox NAT"
/ip dhcp-client print            # status should be "bound"
/ip address print
/ip address add address=192.168.56.101/24 interface=ether2 comment=MGMT   # if not given by DHCP
/ip route print                  # the default route 0.0.0.0/0 comes from the DHCP client
/ping 8.8.8.8 count=3
```

WinBox: **Interfaces**, **IP → Addresses**, **IP → Routes**, **IP → DHCP Client**.

**Exercise:** Find the CHR's MAC address on ether2, then run `arp -a` on Windows and find the same MAC there.

---

## 3. DNS

```
/ip dns set servers=8.8.8.8,1.1.1.1 allow-remote-requests=yes cache-size=4096KiB
/ip dns static add name=router.lab address=192.168.56.101
/ip dns cache print
```

`allow-remote-requests=yes` lets customers use the router as their DNS server. If you turn it on, **block DNS from the WAN** (§5), or your router becomes an open resolver that attackers can abuse.

---

## 4. NAT (masquerade)

Customers have private IPs. NAT rewrites their traffic so it leaves with the router's WAN address:

```
/ip firewall nat add chain=srcnat out-interface=ether1 action=masquerade comment="NAT to internet"
/ip firewall nat print
```

Port forwarding (dstnat), for example to reach a customer's CCTV recorder:

```
/ip firewall nat add chain=dstnat in-interface=ether1 protocol=tcp dst-port=8080 action=dst-nat to-addresses=10.20.0.10 to-ports=80
```

---

## 5. Firewall basics

Rules are checked **top to bottom** and the first match wins. There are three chains: `input` (traffic to the router), `forward` (traffic through it) and `output` (traffic from it).

```
# protect the router
/ip firewall filter
add chain=input connection-state=established,related action=accept comment="accept established"
add chain=input connection-state=invalid action=drop
add chain=input protocol=icmp action=accept
add chain=input in-interface=ether2 action=accept comment="mgmt network"
add chain=input in-interface=ether1 protocol=udp dst-port=53 action=drop comment="no open DNS"
add chain=input in-interface=ether1 action=drop comment="drop rest from WAN"
# forward
add chain=forward connection-state=established,related action=accept
add chain=forward connection-state=invalid action=drop
```

OneISP adds its own `forward` rules with **address lists**:

- `OI-ACTIVE`: static and DHCP customers who have paid. Only these get through.
- `OI-EXPIRED`: customers who haven't paid. They can only use DNS and reach the pay portal.

```
/ip firewall address-list print where list~"OI-"
```

**Exercise:** Expire a static customer in OneISP (customer page → *Expire now*). Watch the IP move from `OI-ACTIVE` to `OI-EXPIRED` in **IP → Firewall → Address Lists**, then record a payment and watch it move back.

---

## 6. IP pools and the DHCP server

```
/ip address add address=192.168.100.1/24 interface=ether4
/ip pool add name=oneisp-dhcp-pool ranges=192.168.100.10-192.168.100.199
/ip dhcp-server add name=oneisp-dhcp interface=ether4 address-pool=oneisp-dhcp-pool lease-time=1h disabled=no
/ip dhcp-server network add address=192.168.100.0/24 gateway=192.168.100.1 dns-server=8.8.8.8
/ip dhcp-server lease print
```

The quick way is `/ip dhcp-server setup`, which asks a few questions and does all of the above.

**How OneISP DHCP customers work:** OneISP creates a **static lease** that pins the customer's MAC address to a fixed IP, plus a **simple queue** that sets their speed. When they expire, the lease gets `block-access=yes` and the router stops serving them.

```
/ip dhcp-server lease add mac-address=AA:BB:CC:DD:EE:01 address=192.168.100.200 server=oneisp-dhcp comment="manual test"
/ip dhcp-server lease set [find mac-address=AA:BB:CC:DD:EE:01] block-access=yes
```

**Exercise:** Attach a Windows or Linux VM to Internal Network `lan-dhcp`. In OneISP, create a DHCP customer with that VM's MAC address. Renew the VM's lease (`ipconfig /renew`) and check that it gets the reserved IP. Expire the customer and see the lease get blocked.

---

## 7. PPPoE server (the core of most ISPs)

PPPoE means every customer logs in with a username and password, and gets their own IP and speed limit.

```
/ip pool add name=oneisp-pppoe-pool ranges=10.10.0.2-10.10.255.254
/ppp profile add name=OI-DEFAULT local-address=10.10.0.1 remote-address=oneisp-pppoe-pool dns-server=8.8.8.8,1.1.1.1 only-one=yes
/interface pppoe-server server add service-name=oneisp interface=ether3 default-profile=OI-DEFAULT authentication=pap,chap,mschap1,mschap2 one-session-per-host=yes max-mtu=1480 max-mru=1480 disabled=no
```

These are the pieces:

| Object | Menu | What OneISP puts there |
|---|---|---|
| **Profile** | PPP → Profiles | One per package (`OI-Home-10Mbps`) holding the `rate-limit` |
| **Secret** | PPP → Secrets | One per customer: name, password, profile, `disabled`, comment `OneISP:LN1001 Name` |
| **Active** | PPP → Active Connections | Customers online right now (OneISP reads this to show the online dot) |

The `rate-limit` format, seen from the router: `rx/tx` = **customer upload/customer download**.

```
rate-limit=5M/10M                         # 5M up, 10M down
rate-limit=5M/10M 10M/20M 4M/8M 16s/16s 8 # + burst-limit, burst-threshold, burst-time, priority
```

When an account expires, OneISP does one of two things (Settings → *When a PPPoE customer expires*):

- **disable**: `/ppp secret set [find name=ln1001] disabled=yes` and then `/ppp active remove [find name=ln1001]`.
- **redirect**: move the customer to the `OI-EXPIRED` profile. Its `address-list=OI-EXPIRED` sends them to the pay page.

### Test with a PPPoE client (second CHR VM)

Import the CHR image again as a second VM and attach its adapter 1 to Internal Network `lan-pppoe`. Then:

```
/interface pppoe-client add name=pppoe-out1 interface=ether1 user=ln1001 password=<from OneISP customer page> add-default-route=yes disabled=no
/interface pppoe-client monitor pppoe-out1
/ping 8.8.8.8
```

Windows works too: Settings → Network → Dial-up → *Set up a new connection* → Broadband (PPPoE).

**Exercises:**

1. Change the Home 10Mbps package to 15M in OneISP and watch the profile's `rate-limit` change. The client must reconnect for the new speed to apply.
2. Run `/tool bandwidth-test` from the client to the server and confirm the speed limit holds.
3. Click *Disconnect* in OneISP and watch the session disappear from **PPP → Active**.
4. In OneISP click Sites → *Sync sessions*. The customer gets a green online dot.

---

## 8. Hotspot (captive portal, vouchers, M-Pesa)

```
/ip address add address=192.168.88.1/24 interface=br-hotspot
/ip pool add name=oneisp-hs-pool ranges=192.168.88.20-192.168.88.254
/ip hotspot profile add name=oneisp-hsprof hotspot-address=192.168.88.1 dns-name=wifi.lab login-by=http-pap,http-chap,mac-cookie
/ip hotspot add name=oneisp-hotspot interface=br-hotspot address-pool=oneisp-hs-pool profile=oneisp-hsprof disabled=no
/ip dhcp-server add name=oneisp-hs-dhcp interface=br-hotspot address-pool=oneisp-hs-pool disabled=no
/ip dhcp-server network add address=192.168.88.0/24 gateway=192.168.88.1 dns-server=192.168.88.1
/ip hotspot walled-garden ip add dst-address=192.168.56.1 action=accept comment="OneISP portal"
```

`/ip hotspot setup` is the quick wizard.

| Object | Menu | OneISP |
|---|---|---|
| User profile | IP → Hotspot → User Profiles | One per hotspot package: `rate-limit` and `shared-users` (how many devices can use one login) |
| User | IP → Hotspot → Users | A voucher, or a customer who paid on the portal. `limit-uptime=1h` ends a 1-hour voucher |
| Active | IP → Hotspot → Active | Logged-in devices |
| Walled garden | IP → Hotspot → Walled Garden | Sites reachable *before* login (the pay portal) |

**How the OneISP payment portal works:**

1. In OneISP open Sites → *Hotspot portal* → **Download login.html**.
2. In WinBox → **Files**, drag it into the `hotspot` folder and replace the existing file.
3. Connect a client VM to the hotspot network and open any http site. The router sends it to the OneISP portal. Pick a package and enter a phone number; the simulated M-Pesa payment is approved after 4 seconds.
4. OneISP creates the hotspot user on the router. The portal sends the username and password to `$(link-login-only)` and the client is online.

**Exercise:** Generate 5 vouchers (Vouchers → Generate). Find them under **IP → Hotspot → Users**, log in with one from the client, then check *Hotspot Active* and the voucher's status in OneISP.

---

## 9. VLANs and bridges

VLANs let one cable carry many separate networks. ISPs use them to keep PPPoE, hotspot and management traffic apart, and **fiber (OLT) uplinks always use VLANs** (see SMARTOLT-GPON.md).

Simple VLAN interfaces on a port:

```
/interface vlan add name=vlan100-ftth vlan-id=100 interface=ether3
/interface vlan add name=vlan200-hotspot vlan-id=200 interface=ether3
/interface pppoe-server server add service-name=ftth interface=vlan100-ftth default-profile=OI-DEFAULT disabled=no
```

A bridge with VLAN filtering (a switch with trunk and access ports):

```
/interface bridge add name=br-lan vlan-filtering=no
/interface bridge port add bridge=br-lan interface=ether4 pvid=10          # access port VLAN 10
/interface bridge port add bridge=br-lan interface=ether3                  # trunk
/interface bridge vlan add bridge=br-lan vlan-ids=10 tagged=br-lan,ether3 untagged=ether4
/interface vlan add name=vlan10 vlan-id=10 interface=br-lan
/interface bridge set br-lan vlan-filtering=yes      # turn on LAST, in Safe Mode
```

---

## 10. Queues (bandwidth management)

- **Simple queues** (`/queue simple`): one rule per IP or subnet. OneISP uses these for static and DHCP customers (`OI-<username>`).
- **PPP / hotspot rate-limit**: RouterOS creates a dynamic simple queue for each session automatically (`<pppoe-ln1001>`).
- **Queue trees + PCQ**: share bandwidth fairly across many users.

```
/queue simple add name=test-10M target=192.168.100.200/32 max-limit=5M/10M
/queue simple add name=burst-test target=192.168.100.201/32 max-limit=5M/10M burst-limit=10M/20M burst-threshold=4M/8M burst-time=16s/16s
# PCQ: share 50M among everyone on the DHCP network
/queue type add name=pcq-down kind=pcq pcq-classifier=dst-address pcq-rate=0
/queue type add name=pcq-up kind=pcq pcq-classifier=src-address pcq-rate=0
/queue simple add name=dhcp-shared target=192.168.100.0/24 max-limit=20M/50M queue=pcq-up/pcq-down
/queue simple print stats
```

**How burst works:** a user can go up to `burst-limit` as long as their *average* speed over `burst-time` stays below `burst-threshold`. Short downloads like web pages feel fast, while a long download settles at `max-limit`. The "Burst x2 for 16s" policy in OneISP does exactly this.

---

## 11. Routing

```
/ip route add dst-address=10.50.0.0/24 gateway=192.168.56.102 comment="static route to another POP"
/ip route print detail
/routing ospf instance add name=default-v2 router-id=1.1.1.1
/routing ospf area add name=backbone instance=default-v2 area-id=0.0.0.0
/routing ospf interface-template add area=backbone interfaces=ether2
/routing ospf neighbor print
```

Two CHRs on the host-only network can form an OSPF neighbourship. That's how routers at different ISP sites learn each other's customer subnets.

---

## 12. WireGuard (remote management and connecting sites)

Billing servers in the cloud reach routers behind NAT through a VPN.

```
/interface wireguard add name=wg0 listen-port=13231
/interface wireguard print            # copy the public-key
/ip address add address=10.99.0.1/24 interface=wg0
/interface wireguard peers add interface=wg0 public-key="<peer public key>" allowed-address=10.99.0.2/32
/ip firewall filter add chain=input protocol=udp dst-port=13231 action=accept place-before=0
```

---

## 13. Monitoring and tools

```
/tool torch interface=ether3             # live traffic by IP and port
/tool bandwidth-test address=10.10.0.1 direction=both
/tool netwatch add host=8.8.8.8 interval=30s down-script=":log warning \"internet down\""
/tool profile                            # what is using the CPU
/log print where topics~"pppoe"
/system logging add topics=pppoe,ppp,info action=memory
/tool sniffer quick interface=ether3
/snmp set enabled=yes                    # so monitoring (and SmartOLT-like tools) can poll it
```

---

## 14. Scripting and the scheduler

```
/system script add name=kick-expired source={
  :foreach s in=[/ppp secret find where disabled=yes] do={
    :local n [/ppp secret get $s name]
    /ppp active remove [find name=$n]
    :log info ("kicked " . $n)
  }
}
/system scheduler add name=kick-expired interval=5m on-event=kick-expired
/system script run kick-expired
```

Billing systems that use RADIUS or the API do this work for you. Writing it yourself shows you how it works underneath.

---

## 15. Backups and reset

```
/system backup save name=before-lab          # binary backup, same router only
/export file=config-export                    # readable script, shows only your changes
/export show-sensitive file=full              # includes passwords
/system reset-configuration no-defaults=yes skip-backup=yes   # start fresh (keep your VM snapshot!)
```

Take a VirtualBox **snapshot** before each big lab, so you can roll back in one click.

---

## 16. The REST API (how OneISP talks to the router)

RouterOS v7 has a REST API on the `www` / `www-ssl` service. The menu path becomes the URL:

| CLI | REST |
|---|---|
| `/ppp secret print` | `GET /rest/ppp/secret` |
| `/ppp secret print where name=ln1001` | `GET /rest/ppp/secret?name=ln1001` |
| `/ppp secret add name=x password=y` | `PUT /rest/ppp/secret` body `{"name":"x","password":"y"}` |
| `/ppp secret set *5 disabled=yes` | `PATCH /rest/ppp/secret/*5` body `{"disabled":"yes"}` |
| `/ppp secret remove *5` | `DELETE /rest/ppp/secret/*5` |
| run any script | `POST /rest/execute` body `{"script":"/log info hi"}` |

Try it from Windows PowerShell:

```powershell
curl.exe -u admin:yourpass http://192.168.56.101/rest/system/resource
curl.exe -u admin:yourpass http://192.168.56.101/rest/ppp/active
```

OneISP's **Router Logs** page shows every call it made, written as the CLI command you would type.

---

## 17. Full exercise: one customer, end to end

1. **OneISP → Leads**: add a lead and click *Convert*. Pick PPPoE, the Home 10Mbps package and your site. The command panel shows the profile and secret being added.
2. **WinBox → PPP → Secrets**: the customer is there, with the `OneISP:` comment.
3. **SmartOLT → Unconfigured**: click *Authorize* on an ONU, search the new customer, *Use*, then Authorize. The panel shows the Huawei `ont add` / `ont ipconfig ... pppoe ... username` / `service-port` commands.
4. **OneISP → customer → Fiber / ONU**: the ONU's signal appears.
5. **Second CHR** as the "ONU in routing mode": dial PPPoE with the same credentials, then click *Sync sessions* in OneISP and the customer shows online.
6. **Expire now** in OneISP: the secret is disabled and the session is kicked. The client loses internet.
7. **Record payment** (or pay from the customer portal at `/portal/account.html`): the secret is enabled again and the expiry moves forward by one month.
8. **Ticket**: open "slow internet" for the customer. In SmartOLT → Diagnostics, check whether their signal is in the warning range.
