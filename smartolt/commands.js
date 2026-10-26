// Generates the vendor CLI that SmartOLT would send to the OLT over telnet/SSH for each action.
// Huawei (MA5608T / MA5683T / MA5800) and ZTE (C320 / C300) syntax.

const LINE_PROFILE = { id: 10, name: 'SMARTOLT_FLEXIBLE_GPON' };

function huawei(action, { olt, onu, type, down, up }) {
  const f = 0, s = onu.board, p = onu.port, id = onu.onuId;
  const iface = `interface gpon ${f}/${s}`;
  const desc = String(onu.name || onu.sn).replace(/"/g, '').slice(0, 64);
  const wan = () => {
    if (onu.mode !== 'routing') return [`ont port native-vlan ${p} ${id} eth 1 vlan ${onu.vlan} priority 0`];
    const out = [];
    if (onu.wanMode === 'pppoe') out.push(`ont ipconfig ${p} ${id} ip-index 0 pppoe vlan ${onu.vlan} priority 0 user-account username "${onu.pppoeUser}" password "${onu.pppoePass}"`);
    else if (onu.wanMode === 'static') out.push(`ont ipconfig ${p} ${id} ip-index 0 static ip-address ${onu.staticIp} mask ${onu.staticMask || '255.255.255.0'} gateway ${onu.staticGateway || ''} vlan ${onu.vlan} priority 0`);
    else out.push(`ont ipconfig ${p} ${id} ip-index 0 dhcp vlan ${onu.vlan} priority 0`);
    out.push(`ont internet-config ${p} ${id} ip-index 0`, `ont wan-config ${p} ${id} ip-index 0 profile-id 0`, `ont policy-route-config ${p} ${id} profile-id 0`);
    return out;
  };
  const sp = () => `service-port ${onu.servicePort} vlan ${onu.vlan} gpon ${f}/${s}/${p} ont ${id} gemport 1 multi-service user-vlan ${onu.vlan} tag-transform translate inbound traffic-table index ${up?.index ?? 6} outbound traffic-table index ${down?.index ?? 6}`;
  switch (action) {
    case 'authorize':
      return ['enable', 'config', iface,
        `ont add ${p} ${id} sn-auth "${onu.sn}" omci ont-lineprofile-id ${LINE_PROFILE.id} ont-srvprofile-id ${type?.srvProfileId ?? 10} desc "${desc}"`,
        ...wan(), 'quit', sp(), ...(onu.catv ? [iface, `ont port attribute ${p} ${id} catv 1 operational-state on`, 'quit'] : [])];
    case 'delete': return ['config', `undo service-port ${onu.servicePort}`, iface, `ont delete ${p} ${id}`, 'quit'];
    case 'reboot': return ['config', iface, `ont reset ${p} ${id}`, 'y', 'quit'];
    case 'disable': return ['config', iface, `ont deactivate ${p} ${id}`, 'quit'];
    case 'enable': return ['config', iface, `ont activate ${p} ${id}`, 'quit'];
    case 'resync': return ['config', iface, `ont modify ${p} ${id} desc "${desc}"`, ...wan(), 'quit', `undo service-port ${onu.servicePort}`, sp()];
    case 'speed': return ['config', `undo service-port ${onu.servicePort}`, sp()];
    case 'vlan': return ['config', `undo service-port ${onu.servicePort}`, sp(), iface, ...wan(), 'quit'];
    case 'mode': return ['config', iface, `undo ont ipconfig ${p} ${id} ip-index 0`, ...wan(), 'quit'];
    case 'rename': return ['config', iface, `ont modify ${p} ${id} desc "${desc}"`, 'quit'];
    case 'signal': return ['config', iface, `display ont optical-info ${p} ${id}`, 'quit'];
    case 'status': return [`display ont info ${f} ${s} ${p} ${id}`];
    case 'wifi': return [`# Wi-Fi (SSID "${onu.wifiSsid}") is pushed over TR-069 by the ACS, not by OLT CLI`];
    case 'catv': return ['config', iface, `ont port attribute ${p} ${id} catv 1 operational-state ${onu.catv ? 'on' : 'off'}`, 'quit'];
    default: return [];
  }
}

function zte(action, { onu, type, down, up }) {
  const b = onu.board, p = onu.port, id = onu.onuId;
  const olt = `interface gpon-olt_1/${b}/${p}`;
  const onuIf = `interface gpon-onu_1/${b}/${p}:${id}`;
  const mng = `pon-onu-mng gpon-onu_1/${b}/${p}:${id}`;
  const name = String(onu.name || onu.sn).replace(/\s+/g, '_').slice(0, 32);
  const wan = () => onu.mode === 'routing'
    ? [onu.wanMode === 'pppoe' ? `wan-ip 1 mode pppoe username ${onu.pppoeUser} password ${onu.pppoePass} vlan-profile VLAN${onu.vlan} host 1` : `wan-ip 1 mode dhcp vlan-profile VLAN${onu.vlan} host 1`, 'security-mgmt 1 state enable mode forward protocol web']
    : [`vlan port eth_0/1 mode tag vlan ${onu.vlan}`];
  switch (action) {
    case 'authorize':
      return ['configure terminal', olt, `onu ${id} type ${type?.name || 'ZTE-F660'} sn ${onu.sn}`, 'exit', onuIf, `name ${name}`,
        `tcont 1 profile ${up?.name || 'default'}`, 'gemport 1 tcont 1', `gemport 1 traffic-limit downstream ${down?.name || 'default'}`,
        `service-port 1 vport 1 user-vlan ${onu.vlan} vlan ${onu.vlan}`, 'exit', mng, `service internet gemport 1 vlan ${onu.vlan}`, ...wan(), 'exit'];
    case 'delete': return ['configure terminal', olt, `no onu ${id}`, 'exit'];
    case 'reboot': return ['configure terminal', mng, 'reboot', 'exit'];
    case 'disable': return ['configure terminal', onuIf, 'shutdown', 'exit'];
    case 'enable': return ['configure terminal', onuIf, 'no shutdown', 'exit'];
    case 'speed': return ['configure terminal', onuIf, `tcont 1 profile ${up?.name}`, `gemport 1 traffic-limit downstream ${down?.name}`, 'exit'];
    case 'vlan': return ['configure terminal', onuIf, 'no service-port 1', `service-port 1 vport 1 user-vlan ${onu.vlan} vlan ${onu.vlan}`, 'exit', mng, `service internet gemport 1 vlan ${onu.vlan}`, ...wan(), 'exit'];
    case 'mode': case 'resync': return ['configure terminal', onuIf, `name ${name}`, 'exit', mng, ...wan(), 'exit'];
    case 'rename': return ['configure terminal', onuIf, `name ${name}`, 'exit'];
    case 'signal': return [`show pon power attenuation gpon-onu_1/${b}/${p}:${id}`];
    case 'status': return [`show gpon onu detail-info gpon-onu_1/${b}/${p}:${id}`];
    case 'wifi': return [`# Wi-Fi (SSID "${onu.wifiSsid}") is pushed over TR-069 by the ACS`];
    case 'catv': return ['configure terminal', mng, `video ${onu.catv ? 'enable' : 'disable'}`, 'exit'];
    default: return [];
  }
}

function oltCommands(action, ctx) {
  return (ctx.olt.vendor === 'ZTE' ? zte : huawei)(action, ctx);
}

// One-time OLT setup commands SmartOLT expects (shown on the OLT settings page for learning).
function oltSetup(olt, { vlans, speedProfiles, onuTypes }) {
  if (olt.vendor === 'ZTE') {
    return ['configure terminal', ...vlans.map(v => `vlan ${v.vlan}\n name ${String(v.description || 'v' + v.vlan).replace(/\s+/g, '_')}\n exit`),
      ...speedProfiles.filter(s => s.type === 'upload').map(s => `gpon\n profile tcont ${s.name} type 4 maximum ${s.speed}\n exit`),
      ...speedProfiles.filter(s => s.type === 'download').map(s => `gpon\n profile traffic ${s.name} sir ${s.speed} pir ${s.speed}\n exit`),
      ...vlans.map(v => `pon\n onu-profile vlan VLAN${v.vlan} tag-mode tag cvlan ${v.vlan}\n exit`),
      `interface ${olt.uplink || 'gei_1/3/1'}\n switchport mode trunk\n switchport vlan ${vlans.map(v => v.vlan).join(',')} tag\n exit`].join('\n');
  }
  return ['enable', 'config',
    `vlan ${vlans.map(v => v.vlan).join(' ')} smart`,
    ...vlans.map(v => `port vlan ${v.vlan} 0/${olt.uplinkSlot ?? 3} ${olt.uplinkPort ?? 0}`),
    ...speedProfiles.map(s => `traffic table ip index ${s.index} name "${s.name}" cir ${s.speed} pir ${s.speed} priority 0 priority-policy local-setting`),
    `ont-lineprofile gpon profile-id ${LINE_PROFILE.id} profile-name "${LINE_PROFILE.name}"`,
    ' tcont 1 dba-profile-id 9', ' gem add 1 eth tcont 1', ' gem mapping 1 0 vlan 1-4094 (flexible: any VLAN)', ' commit', ' quit',
    ...onuTypes.filter(t => t.ponType === 'GPON').map(t => `ont-srvprofile gpon profile-id ${t.srvProfileId} profile-name "${t.name}"\n ont-port pots ${t.voip ? 1 : 0} eth ${t.ethPorts} catv ${t.catv ? 1 : 0}\n port vlan eth 1 transparent\n commit\n quit`),
    'interface gpon 0/1', ...Array.from({ length: 16 }, (_, i) => `port ${i} ont-auto-find enable`), 'quit',
  ].join('\n');
}

module.exports = { oltCommands, oltSetup, LINE_PROFILE };
