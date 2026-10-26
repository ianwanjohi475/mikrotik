// Translates OneISP business objects (packages, customers, vouchers, sites) into RouterOS ops.
// Read this file alongside docs/MIKROTIK-LAB.md to understand what OneISP really does to your router.

const slug = s => String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
const profileName = pkg => `OI-${slug(pkg.name)}`;
const queueName = c => `OI-${c.username}`;
const comment = c => `OneISP:${c.accountNo} ${c.name}`;

// MikroTik rate-limit for PPP/Hotspot is "rx/tx" seen from the router: rx = client upload, tx = client download.
function rateLimit(pkg, policy) {
  let s = `${pkg.upload}/${pkg.download}`;
  if (policy && policy.burstEnabled) {
    s += ` ${policy.burstUpload}/${policy.burstDownload} ${policy.thresholdUpload}/${policy.thresholdDownload} ${policy.burstTime}/${policy.burstTime}`;
    if (policy.priority && Number(policy.priority) !== 8) s += ` ${policy.priority}`;
  } else if (policy && policy.priority && Number(policy.priority) !== 8) { // 8 is the RouterOS default
    s += ` 0/0 0/0 0/0 ${policy.priority}`;
  }
  return s;
}

// RouterOS duration format (1d2h3m) from a package validity.
function rosDuration(pkg) {
  const n = Number(pkg.validityValue) || 1;
  return { minutes: `${n}m`, hours: `${n}h`, days: `${n}d`, months: `${n * 30}d` }[pkg.validityUnit] || `${n}d`;
}

function validityMs(pkg) {
  const n = Number(pkg.validityValue) || 1;
  return n * ({ minutes: 6e4, hours: 36e5, days: 864e5, months: 30 * 864e5 }[pkg.validityUnit] || 864e5);
}

function packageOps(pkg, policy, site) {
  const rl = rateLimit(pkg, policy);
  if (pkg.type === 'pppoe') {
    return [{
      menu: '/ppp/profile', action: 'upsert', find: { name: profileName(pkg) },
      props: { 'rate-limit': rl, 'local-address': site.pppoeGateway, 'remote-address': 'oneisp-pppoe-pool', 'dns-server': site.dns, 'only-one': 'yes', comment: `OneISP package ${pkg.name}` },
      note: 'A PPP profile carries the speed (rate-limit) and IP settings shared by every PPPoE user on this package',
    }];
  }
  if (pkg.type === 'hotspot') {
    return [{
      menu: '/ip/hotspot/user/profile', action: 'upsert', find: { name: profileName(pkg) },
      props: { 'rate-limit': rl, 'shared-users': pkg.sharedUsers || 1, 'address-pool': 'oneisp-hs-pool' },
      note: 'Hotspot user profile = speed + how many devices may share one login',
    }];
  }
  return []; // static & dhcp speeds live in per-customer simple queues
}

// mode: 'activate' | 'suspend' | 'delete'
// activate/suspend both describe the complete desired router state, so they also (re)create missing entries.
function customerOps(c, pkg, policy, site, mode, settings = {}) {
  const ops = [];
  const on = mode === 'activate';
  const kickPpp = { menu: '/ppp/active', action: 'remove', find: { name: c.username }, note: 'Disconnect the live session so the change applies immediately' };
  const kickHs = { menu: '/ip/hotspot/active', action: 'remove', find: { user: c.username }, note: 'Log the hotspot user out' };

  if (c.connectionType === 'pppoe') {
    if (mode === 'delete') return [{ menu: '/ppp/secret', action: 'remove', find: { name: c.username } }, kickPpp];
    const redirect = settings.expiredAction === 'redirect';
    ops.push(...packageOps(pkg, policy, site));
    ops.push({
      menu: '/ppp/secret', action: 'upsert', find: { name: c.username },
      props: { password: c.password, service: 'pppoe', profile: on || !redirect ? profileName(pkg) : 'OI-EXPIRED', disabled: on || redirect ? 'no' : 'yes', 'remote-address': c.ipAddress || undefined, comment: comment(c) },
      note: on ? 'The PPP secret is the customer account the router authenticates against'
        : redirect ? 'Expired: moved to the OI-EXPIRED profile - they can connect but only reach the pay page' : 'Expired/disabled: a disabled secret cannot log in',
    });
    if (!on || c._profileChanged) ops.push(kickPpp);
  }

  if (c.connectionType === 'hotspot') {
    if (mode === 'delete') return [{ menu: '/ip/hotspot/user', action: 'remove', find: { name: c.username } }, kickHs];
    ops.push(...packageOps(pkg, policy, site));
    ops.push({
      menu: '/ip/hotspot/user', action: 'upsert', find: { name: c.username },
      props: { password: c.password, profile: profileName(pkg), server: site.hotspotServer || 'all', 'mac-address': c.macAddress || undefined, disabled: on ? 'no' : 'yes', comment: comment(c) },
      note: on ? 'Hotspot user = username/password typed on the captive portal login page' : 'Disabled hotspot users get "user disabled" on the login page',
    });
    if (!on || c._profileChanged) ops.push(kickHs);
  }

  if (c.connectionType === 'static' || c.connectionType === 'dhcp') {
    const inList = (list, note) => ({ menu: '/ip/firewall/address-list', action: 'upsert', find: { list, address: c.ipAddress }, props: { comment: comment(c) }, note });
    const outList = list => ({ menu: '/ip/firewall/address-list', action: 'remove', find: { list, address: c.ipAddress } });
    if (mode === 'delete') {
      if (c.connectionType === 'dhcp') ops.push({ menu: '/ip/dhcp-server/lease', action: 'remove', find: { 'mac-address': c.macAddress } });
      else if (c.macAddress) ops.push({ menu: '/ip/arp', action: 'remove', find: { address: c.ipAddress } });
      return ops.concat({ menu: '/queue/simple', action: 'remove', find: { name: queueName(c) } }, outList('OI-ACTIVE'), outList('OI-EXPIRED'));
    }
    if (c.connectionType === 'dhcp') {
      ops.push({
        menu: '/ip/dhcp-server/lease', action: 'upsert', find: { 'mac-address': c.macAddress },
        props: { address: c.ipAddress, server: site.dhcpServer, 'block-access': on ? 'no' : 'yes', comment: comment(c) },
        note: on ? 'A static DHCP lease pins the customer router (MAC) to a fixed IP' : 'block-access=yes: the router stops answering this client',
      });
    } else if (c.macAddress) {
      ops.push({ menu: '/ip/arp', action: 'upsert', find: { address: c.ipAddress }, props: { 'mac-address': c.macAddress, interface: site.staticInterface, comment: comment(c) }, note: 'Static ARP binds IP to MAC (stops IP theft when interface arp=reply-only)' });
    }
    ops.push({
      menu: '/queue/simple', action: 'upsert', find: { name: queueName(c) },
      props: { target: `${c.ipAddress}/32`, 'max-limit': `${pkg.upload}/${pkg.download}`, disabled: 'no', comment: comment(c) },
      note: 'Static/DHCP users have no login, so speed is enforced with a simple queue on their IP',
    });
    if (on) ops.push(outList('OI-EXPIRED'), inList('OI-ACTIVE', 'Firewall only forwards addresses in OI-ACTIVE'));
    else ops.push(outList('OI-ACTIVE'), inList('OI-EXPIRED', 'Addresses in OI-EXPIRED are blocked / redirected by the firewall'));
  }
  return ops;
}

function voucherOps(v, pkg, policy, site, mode) {
  if (mode === 'delete') return [
    { menu: '/ip/hotspot/user', action: 'remove', find: { name: v.code } },
    { menu: '/ip/hotspot/active', action: 'remove', find: { user: v.code } },
  ];
  return [
    ...packageOps(pkg, policy, site),
    {
      menu: '/ip/hotspot/user', action: 'upsert', find: { name: v.code },
      props: { password: v.code, profile: profileName(pkg), server: site.hotspotServer || 'all', 'limit-uptime': rosDuration(pkg), comment: `OneISP voucher batch ${v.batch}` },
      note: 'Voucher = hotspot user whose username and password are the code; limit-uptime stops it after the package time',
    },
  ];
}

// Full router bootstrap script, the equivalent of OneISP's "Router configuration script".
function bootstrapScript(site, settings, serverIp) {
  const s = site;
  return `# =====================================================================
# OneISP (simulator) provisioning script for site: ${s.name}
# Paste into WinBox > New Terminal. Read each section - that is the lesson.
# Interfaces used: WAN=${s.wanInterface} PPPoE=${s.pppoeInterface} Hotspot=${s.hotspotInterface}
#                  DHCP=${s.dhcpInterface} Static=${s.staticInterface}
# TIP: in a VirtualBox lab you can create empty bridges instead of real ports:
#   /interface bridge add name=br-pppoe ; /interface bridge add name=br-hotspot ...
# =====================================================================

# ---- 1. API access so OneISP can manage the router (REST API, RouterOS v7) ----
/ip service set www disabled=no port=80
# (rest-api policy exists on RouterOS 7.17+; on older v7 remove it from the list)
/user group add name=oneisp policy=read,write,api,rest-api,test,policy,sensitive comment="OneISP management"
/user add name=${s.username} group=oneisp password="${s.password}" comment="OneISP API user"

# ---- 2. NAT so customers reach the internet through the WAN ----
/ip firewall nat add chain=srcnat out-interface=${s.wanInterface} action=masquerade comment="OneISP: NAT"

# ---- 3. PPPoE server ----
/ip pool add name=oneisp-pppoe-pool ranges=${s.pppoePool}
/ip pool add name=oneisp-expired-pool ranges=${s.expiredPool}
/ppp profile add name=OI-DEFAULT local-address=${s.pppoeGateway} remote-address=oneisp-pppoe-pool dns-server=${s.dns} only-one=yes
/ppp profile add name=OI-EXPIRED local-address=${s.pppoeGateway} remote-address=oneisp-expired-pool address-list=OI-EXPIRED rate-limit=256k/256k comment="Expired users land here"
/interface pppoe-server server add service-name=oneisp interface=${s.pppoeInterface} default-profile=OI-DEFAULT authentication=pap,chap,mschap1,mschap2 one-session-per-host=yes max-mtu=1480 max-mru=1480 disabled=no

# ---- 4. Hotspot (captive portal) ----
/ip address add address=${s.hotspotGateway}/24 interface=${s.hotspotInterface} comment="OneISP hotspot gateway"
/ip pool add name=oneisp-hs-pool ranges=${s.hotspotPool}
/ip hotspot profile add name=oneisp-hsprof hotspot-address=${s.hotspotGateway} dns-name=${s.hotspotDns} login-by=http-pap,http-chap,mac-cookie html-directory=hotspot
/ip hotspot add name=${s.hotspotServer} interface=${s.hotspotInterface} address-pool=oneisp-hs-pool profile=oneisp-hsprof disabled=no
/ip dhcp-server add name=oneisp-hs-dhcp interface=${s.hotspotInterface} address-pool=oneisp-hs-pool lease-time=1h disabled=no
/ip dhcp-server network add address=${networkOf(s.hotspotGateway)}/24 gateway=${s.hotspotGateway} dns-server=${s.hotspotGateway}
# Let unpaid hotspot clients reach the OneISP payment portal before login:
/ip hotspot walled-garden ip add dst-address=${serverIp} action=accept comment="OneISP portal"
/ip hotspot walled-garden add dst-host=${serverIp} comment="OneISP portal"

# ---- 5. DHCP customers (fixed leases + queues) ----
/ip address add address=${s.dhcpGateway}/24 interface=${s.dhcpInterface} comment="OneISP DHCP customers"
/ip pool add name=oneisp-dhcp-pool ranges=${s.dhcpPool}
/ip dhcp-server add name=${s.dhcpServer} interface=${s.dhcpInterface} address-pool=oneisp-dhcp-pool lease-time=1h disabled=no
/ip dhcp-server network add address=${networkOf(s.dhcpGateway)}/24 gateway=${s.dhcpGateway} dns-server=${s.dns}

# ---- 6. Static IP customers ----
/ip address add address=${s.staticGateway}/24 interface=${s.staticInterface} comment="OneISP static customers"

# ---- 7. Firewall: only paying static/DHCP customers get out ----
/ip firewall filter add chain=forward connection-state=established,related action=accept comment="OneISP: allow established"
/ip firewall filter add chain=forward src-address-list=OI-EXPIRED protocol=udp dst-port=53 action=accept comment="OneISP: expired may resolve DNS"
/ip firewall filter add chain=forward src-address-list=OI-EXPIRED dst-address=${serverIp} action=accept comment="OneISP: expired may reach pay portal"
/ip firewall filter add chain=forward src-address-list=OI-EXPIRED action=reject reject-with=icmp-network-unreachable comment="OneISP: block expired"
/ip firewall filter add chain=forward in-interface=${s.staticInterface} src-address-list=!OI-ACTIVE action=drop comment="OneISP: unknown static IPs"
/ip firewall filter add chain=forward in-interface=${s.dhcpInterface} src-address-list=!OI-ACTIVE action=drop comment="OneISP: unknown DHCP IPs"
${settings.expiredAction === 'redirect' ? `# Redirect web traffic of expired users to the pay portal
/ip firewall nat add chain=dstnat src-address-list=OI-EXPIRED protocol=tcp dst-port=80 action=dst-nat to-addresses=${serverIp} to-ports=${settings.portalPort || 8080} comment="OneISP: expired -> portal"` : '# (expiredAction=disable: expired PPPoE secrets are disabled instead of redirected)'}

# ---- 8. Identity & time (expiry depends on correct time!) ----
/system identity set name="${s.name.replace(/"/g, '')}"
/system ntp client set enabled=yes servers=pool.ntp.org
:log info "OneISP provisioning complete"
`;
}

function networkOf(ip) { const p = String(ip).split('.'); p[3] = '0'; return p.join('.'); }

// Captive-portal login.html for the router's hotspot folder that sends users to the OneISP portal.
function hotspotLoginHtml(site, portalBase) {
  return `<!DOCTYPE html>
<!-- Upload to the router: Files > hotspot/login.html (replace the original). -->
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${site.name} WiFi</title></head>
<body style="font-family:sans-serif;text-align:center;padding-top:40px">
<p>Redirecting to payment portal...</p>
<script>
location.href = "${portalBase}/portal/hotspot.html?site=${site.id}&mac=$(mac-esc)&ip=$(ip)&login=" + encodeURIComponent("$(link-login-only)") + "&dst=" + encodeURIComponent("$(link-orig)");
</script>
<noscript><a href="${portalBase}/portal/hotspot.html?site=${site.id}&mac=$(mac-esc)">Continue</a></noscript>
</body></html>`;
}

module.exports = { customerOps, voucherOps, packageOps, bootstrapScript, hotspotLoginHtml, validityMs, rosDuration, rateLimit, profileName, queueName };
