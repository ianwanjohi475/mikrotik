# GPON and SmartOLT: concepts, OLT commands, troubleshooting

## 1. The fiber network

```
MikroTik (PPPoE server, VLAN 100) --trunk--> OLT uplink (GE/10GE)
                                                   |
                                OLT PON port 0/1/3 (one fiber, 2.5G down / 1.25G up, shared)
                                                   |
                                     ODB / splitter 1:8 or 1:16 (passive, no power)
                                       /     |      \
                                   ONU     ONU     ONU   (customer: HG8546M, F660 ...)
```

- **OLT** (Optical Line Terminal): the box at the POP. Huawei MA5608T, MA5683T and MA5800, or ZTE C300, C320 and C600. It has **boards** (cards) and each GPON board has 8 or 16 **PON ports**.
- **ONU / ONT**: the customer's device. Each one is identified by its **serial number (SN)**, for example `HWTC1A2B3C01`. The first 4 letters are the vendor: `HWTC` is Huawei and `ZTEG` is ZTE.
- **ODB / splitter**: splits one fiber's light into 8, 16 or 32 outputs. SmartOLT calls it "ODB (Splitter)".
- **Position** of an ONU: `frame/slot/port:onu-id`. Huawei writes `0/1/3:5`; ZTE writes `gpon-onu_1/1/3:5`.

## 2. Optical budget

| Item | Loss |
|---|---|
| OLT SFP (class B+/C+) TX | +1.5 to +5 dBm |
| Splitter 1:2 / 1:4 / 1:8 / 1:16 / 1:32 | 3.5 / 7 / 10.5 / 13.5 / 17 dB |
| Fiber | ~0.35 dB/km (1310nm), ~0.25 dB/km (1490nm) |
| Connector / splice | ~0.5 / ~0.1 dB each |

Here is how to read **ONU Rx power** (SmartOLT signal colours):

| Rx (dBm) | Meaning |
|---|---|
| -8 to -15 | Too strong for short links (rare) |
| **-15 to -25** | **Good** (green) |
| -25 to -27 | **Warning** (orange): dirty connector, tight bend, too many splitters |
| below -27 | **Critical** (red): will drop; most ONUs lose sync near -28 to -29 |

Worked example: OLT +3 dBm, then a 1:8 splitter (−10.5), then a 1:8 splitter (−10.5), 2 km of fiber (−0.6) and 4 connectors (−2). The result is about **−20.6 dBm**, which is good.

## 3. ONU statuses

| Icon | Status | Cause | What to do |
|---|---|---|---|
| 🌐 green | Online | – | – |
| 🔌 | Power fail (dying gasp) | The ONU sent "losing power" before it went off | Usually the customer switched it off or had a power cut. Call them |
| ✗ red | LOS (loss of signal) | No light reaches the ONU | Fiber cut, bent drop, unplugged patch cord. **Many LOS on one port at once means a feeder or splitter problem** |
| 🌐 grey | Offline | Unknown / never came up | Check that the SN is on the right port and the device is on |
| ⊘ | Disabled | You deactivated it | Enable it |

## 4. Huawei MA56xx / MA58xx commands

The SmartOLT simulator's **OLT CLI** page accepts these commands.

```
enable
config
display board 0                         # cards in the chassis
display ont autofind all                # ONUs waiting for authorization (SmartOLT "Unconfigured")
interface gpon 0/1                      # enter a GPON board (frame 0, slot 1)
display ont info 3 all                  # all ONUs on PON port 3
display ont info 3 5                    # one ONU (port 3, id 5)
display ont optical-info 3 5            # Rx/Tx power, temperature
```

### Authorize an ONU (what SmartOLT sends)

```
interface gpon 0/1
ont add 3 5 sn-auth "HWTC1A2B3C01" omci ont-lineprofile-id 10 ont-srvprofile-id 11 desc "John Kamau"
```

Then pick one of the two modes.

**Routing mode** (the ONU dials PPPoE itself):

```
ont ipconfig 3 5 ip-index 0 pppoe vlan 100 priority 0 user-account username "ln1001" password "secret"
ont internet-config 3 5 ip-index 0
ont wan-config 3 5 ip-index 0 profile-id 0
```

**Bridging mode** (a router behind the ONU dials PPPoE):

```
ont port native-vlan 3 5 eth 1 vlan 100 priority 0
```

Then connect the ONU's GEM port to VLAN 100 on the uplink:

```
quit
service-port 101 vlan 100 gpon 0/1/3 ont 5 gemport 1 multi-service user-vlan 100 tag-transform translate inbound traffic-table index 22 outbound traffic-table index 12
```

| Piece | Meaning |
|---|---|
| `ont-lineprofile` | T-CONT, DBA and GEM ports (how upstream bandwidth is scheduled). SmartOLT uses one flexible profile, `SMARTOLT_FLEXIBLE_GPON` |
| `ont-srvprofile` | Port capabilities of the ONU model (number of ETH, POTS and CATV ports) |
| `service-port` | The cross-connect from the ONU's GEM port to the uplink VLAN. **Without it, no traffic flows** |
| `traffic table ip index N` | Speed limit. These are SmartOLT's "speed profiles" (inbound = upload, outbound = download) |

### Other actions

```
ont reset 3 5                 # reboot
ont deactivate 3 5            # disable
ont activate 3 5              # enable
ont modify 3 5 desc "New name"
undo service-port 101
ont delete 3 5                # delete (it reappears in autofind if still connected)
display service-port all
display traffic table ip from-index 0
display vlan all
```

### One-time OLT setup

On OLT → *base configuration* in the simulator:

```
vlan 100 200 300 smart
port vlan 100 0/2 0                         # VLAN 100 allowed on uplink slot 2 port 0
traffic table ip index 12 name "10M" cir 10240 pir 10240 priority 0 priority-policy local-setting
ont-lineprofile gpon profile-id 10 profile-name "SMARTOLT_FLEXIBLE_GPON"
 tcont 1 dba-profile-id 9
 gem add 1 eth tcont 1
 commit
 quit
interface gpon 0/1
 port 3 ont-auto-find enable
```

## 5. ZTE C300 / C320 commands

```
show gpon onu uncfg                                  # autofind
show gpon onu state gpon-olt_1/1/1
configure terminal
interface gpon-olt_1/1/1
 onu 5 type ZTE-F660 sn ZTEGC1234567
 exit
interface gpon-onu_1/1/1:5
 name John_Kamau
 tcont 1 profile 10M-up
 gemport 1 tcont 1
 service-port 1 vport 1 user-vlan 100 vlan 100
 exit
pon-onu-mng gpon-onu_1/1/1:5
 service internet gemport 1 vlan 100
 wan-ip 1 mode pppoe username ln1001 password secret vlan-profile VLAN100 host 1
 exit
show pon power attenuation gpon-onu_1/1/1:5           # signal
```

## 6. Connecting the OLT to the MikroTik

The OLT uplink is a trunk that carries VLAN 100 (internet) and VLAN 300 (management / TR-069). On the MikroTik:

```
/interface vlan add name=vlan100-ftth vlan-id=100 interface=ether3 comment="from OLT uplink"
/interface vlan add name=vlan300-mgmt vlan-id=300 interface=ether3
/ip address add address=10.30.0.1/24 interface=vlan300-mgmt
/interface pppoe-server server add service-name=ftth interface=vlan100-ftth default-profile=OI-DEFAULT one-session-per-host=yes disabled=no
```

After that, every routing-mode ONU (or customer router behind a bridge-mode ONU) dials PPPoE on VLAN 100 with the username that **OneISP** created. OneISP enforces billing on the MikroTik, and SmartOLT only deals with the optical side. The **PPPoE username** connects the two systems.

> You can simulate the OLT trunk in VirtualBox with no OLT. Make a second CHR the "ONU": add `/interface vlan add name=v100 vlan-id=100 interface=ether1` and then `/interface pppoe-client add interface=v100 user=... password=... disabled=no`.

## 7. Troubleshooting checklist

1. **No internet, ONU online, signal good**: in OneISP, check whether the customer has expired or been disabled. Then check WinBox → PPP → Active. If the PPPoE login fails, check `/log print where topics~"ppp"` for a wrong password.
2. **ONU LOS**: check the drop cable and the patch cord at the ODB. If the whole port is LOS (SmartOLT Diagnostics → "PON ports with LOS"), look at the feeder or splitter.
3. **Signal critical**: clean the connectors (SC/APC is green, SC/UPC is blue, and you must not mix them). Look for tight bends, then count the splitters.
4. **Authorized but offline**: wrong board or port, or a wrong SN typed by hand. Compare with `display ont autofind all`.
5. **Slow speeds**: compare the ONU speed profile (traffic table) with the OneISP package. The lower of the two wins. Check the MikroTik queue with `/queue simple print stats`.
6. **Power fail repeatedly**: the customer's power supply or UPS is faulty.

## 8. SmartOLT API (simulator)

Send the header `X-Token: smartolt-demo-token` (Settings → General).

```
GET  /api/system/get_olts
GET  /api/onu/unconfigured_onus
GET  /api/onu/get_all_onus_details
GET  /api/onu/get_onu_details/HWTC1A2B3C01
GET  /api/onu/get_onu_signal/HWTC1A2B3C01
POST /api/onu/authorize_onu   {olt_id, board, port, sn, onu_type, onu_mode: Routing|Bridging, vlan, zone, name, onu_external_id, pppoe_username, pppoe_password}
POST /api/onu/reboot/{sn}  /resync_config/{sn}  /disable/{sn}  /enable/{sn}  /delete/{sn}
```

Example from PowerShell:

```powershell
curl.exe -H "X-Token: smartolt-demo-token" http://localhost:4000/api/onu/get_onu_signal/HWTC1A2B3C01
```

OneISP exposes `GET /api/v1/customers` and `POST /api/v1/customers/{id}/onu`, protected with the header `X-Token: oneisp-demo-token`. SmartOLT uses these to search customers and link ONUs.
