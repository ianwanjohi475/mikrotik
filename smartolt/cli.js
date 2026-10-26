// A small Huawei MA5600/MA5800-style OLT shell (and a few ZTE "show" commands).
// Commands act on the same database the web UI uses, so `ont add` here really authorizes an ONU.

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const LINE = '  ' + '-'.repeat(77);

function snHex(sn) {
  return Buffer.from(sn.slice(0, 4)).toString('hex').toUpperCase() + sn.slice(4).toUpperCase();
}
function snNormalize(input) {
  let s = String(input).replace(/"/g, '').trim().toUpperCase();
  if (/^[0-9A-F]{16}$/.test(s)) s = Buffer.from(s.slice(0, 8), 'hex').toString() + s.slice(8);
  return s.replace('-', '');
}
function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 86400)} day(s), ${Math.floor((s % 86400) / 3600)} hour(s), ${Math.floor((s % 3600) / 60)} minute(s), ${s % 60} second(s)`;
}
const ts = d => { if (!d) return '-'; const x = new Date(d), z = n => String(n).padStart(2, '0'), off = -x.getTimezoneOffset(); return `${x.getFullYear()}-${z(x.getMonth() + 1)}-${z(x.getDate())} ${z(x.getHours())}:${z(x.getMinutes())}:${z(x.getSeconds())}${off >= 0 ? '+' : '-'}${z(Math.floor(Math.abs(off) / 60))}:${z(Math.abs(off) % 60)}`; };

function createCli({ db, ops }) {
  const sessions = new Map();

  function prompt(olt, st) {
    const h = olt.hostname || olt.hardware || 'OLT';
    if (olt.vendor === 'ZTE') return st.mode === 'config' ? `${h}(config)#` : `${h}#`;
    return { user: `${h}>`, enable: `${h}#`, config: `${h}(config)#`, iface: `${h}(config-if-gpon-0/${st.slot})#` }[st.mode];
  }

  const onusOf = (olt, pred = () => true) => db.find('onus', o => o.oltId === olt.id && pred(o));
  const runState = o => (o.disabled ? 'offline' : o.status === 'online' ? 'online' : 'offline');

  function ontInfoDetail(olt, o) {
    const type = db.get('onuTypes', o.onuTypeId);
    return [LINE,
      `  F/S/P                   : 0/${o.board}/${o.port}`, `  ONT-ID                  : ${o.onuId}`,
      `  Control flag            : ${o.disabled ? 'deactivated' : 'active'}`, `  Run state               : ${runState(o)}`,
      '  Config state            : normal', '  Match state             : match', '  DBA type                : SR',
      `  ONT distance(m)         : ${o.status === 'online' ? o.distance : '-'}`, '  ONT battery state       : not support',
      `  Memory occupation       : ${o.status === 'online' ? 40 + (o.id % 30) + '%' : '-'}`, `  CPU occupation          : ${o.status === 'online' ? 1 + (o.id % 5) + '%' : '-'}`,
      `  Temperature             : ${o.status === 'online' ? Math.round(o.temperature) + '(C)' : '-'}`, '  Authentic type          : SN-auth',
      `  SN                      : ${snHex(o.sn)} (${o.sn.slice(0, 4)}-${o.sn.slice(4)})`, '  Management mode         : OMCI',
      '  Software work mode      : normal', '  Isolation state         : normal',
      `  ONT IP 0 address/mask   : ${o.mode === 'routing' && o.status === 'online' ? (o.wanIp || '-') : '-'}`,
      `  Description             : ${o.name || ''}`, `  Last down cause         : ${o.lastDownCause || '-'}`,
      `  Last up time            : ${ts(o.uptimeStart)}`, `  Last down time          : ${ts(o.lastDownAt)}`,
      `  ONT online duration     : ${o.status === 'online' ? duration(Date.now() - new Date(o.uptimeStart)) : '-'}`,
      `  Type C support          : Not support`, `  ONT NNI type            : ${type?.ponType || 'GPON'}`,
      LINE, `  Line profile ID      : 10`, `  Line profile name    : SMARTOLT_FLEXIBLE_GPON`, `  Service profile ID   : ${type?.srvProfileId ?? 10}`, `  Service profile name : ${type?.name || '-'}`, LINE].join('\n');
  }

  function ontInfoTable(list) {
    if (!list.length) return '  Failure: The ONT does not exist';
    return [LINE, '  F/S/P   ONT         SN         Control     Run      Config   Match    Protect', '          ID                     flag        state    state    state    side', LINE,
      ...list.map(o => `  0/ ${o.board}/${pad(o.port, 3)}${lpad(o.onuId, 3)}  ${snHex(o.sn)}  ${pad(o.disabled ? 'deactive' : 'active', 10)}  ${pad(runState(o), 7)}  normal   match    no`), LINE,
      '  F/S/P   ONT-ID   Description', LINE, ...list.map(o => `  0/ ${o.board}/${pad(o.port, 3)}${lpad(o.onuId, 4)}     ${o.name || ''}`), LINE,
      `  In port 0/${list[0].board}/${list[0].port}, the total of ONTs are: ${list.length}, online: ${list.filter(o => runState(o) === 'online').length}`, LINE].join('\n');
  }

  function optical(o) {
    if (o.status !== 'online') return '  Failure: The ONT is not online';
    return [LINE, '  ONU NNI port ID                        : 0', '  Module type                            : GPON', '  Module sub-type                        : CLASS B+',
      '  Used type                              : ONU', '  Encapsulation Type                     : BOSA ON BOARD', '  Optical power precision(dBm)           : 3.0',
      '  Vendor name                            : HUAWEI', `  Rx optical power(dBm)                  : ${o.rxPower.toFixed(2)}`,
      '  Rx power current warning threshold(dBm): [-,-]', '  Rx power current alarm threshold(dBm)  : [-29.0,-7.0]',
      `  Tx optical power(dBm)                  : ${o.txPower.toFixed(2)}`, '  Tx power current alarm threshold(dBm)  : [0.0,5.0]',
      `  Laser bias current(mA)                 : ${10 + (o.id % 8)}`, `  Temperature(C)                         : ${Math.round(o.temperature)}`,
      '  Voltage(V)                             : 3.280', `  OLT Rx ONT optical power(dBm)          : ${o.oltRxPower.toFixed(2)}`, LINE].join('\n');
  }

  function autofind(olt, slot) {
    const list = db.find('unconfigured', u => u.oltId === olt.id && (slot === undefined || u.board === slot));
    if (!list.length) return '  Failure: The automatically found ONTs do not exist';
    return list.map((u, i) => [LINE, `   Number              : ${i + 1}`, `   F/S/P               : 0/${u.board}/${u.port}`, `   Ont SN              : ${snHex(u.sn)} (${u.sn.slice(0, 4)}-${u.sn.slice(4)})`,
      '   Password            : 0x00000000000000000000', '   Loid                : ', '   Checkcode           : ', `   VendorID            : ${u.sn.slice(0, 4)}`,
      '   Ont Version         : 10C7.A', `   Ont SoftwareVersion : ${u.sw || 'V5R019C10S115'}`, `   Ont EquipmentID     : ${u.equipmentId}`, `   Ont autofind time   : ${ts(u.detectedAt)}`].join('\n')).join('\n') + `\n${LINE}\n   The number of GPON autofind ONT is ${list.length}\n${LINE}`;
  }

  function servicePorts(olt) {
    const list = onusOf(olt, o => o.servicePort !== undefined).sort((a, b) => a.servicePort - b.servicePort);
    return ['  ' + '-'.repeat(91), '    INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI   FLOW  FLOW       RX   TX   STATE', '          ID   ATTR     TYPE                    TYPE  PARA', '  ' + '-'.repeat(91),
      ...list.map(o => `  ${lpad(o.servicePort, 7)} ${lpad(o.vlan, 4)} common   gpon 0/${o.board} /${pad(o.port, 2)} ${lpad(o.onuId, 4)} 1     vlan  ${pad(o.vlan, 10)} ${lpad(db.get('speedProfiles', o.uploadProfileId)?.index ?? 6, 4)} ${lpad(db.get('speedProfiles', o.downloadProfileId)?.index ?? 6, 4)}   ${runState(o) === 'online' ? 'up' : 'down'}`),
      '  ' + '-'.repeat(91), `   Total : ${list.length}  (Up/Down :    ${list.filter(o => runState(o) === 'online').length}/${list.filter(o => runState(o) !== 'online').length})`, '  ' + '-'.repeat(91)].join('\n');
  }

  const HELP_HW = `Supported commands (Huawei syntax):
  enable | config | interface gpon 0/<slot> | quit | return
  display version | display board 0 | display ont autofind all | display vlan all
  display ont info 0 <slot> <port> <id>      display ont info summary 0/<slot>
  display service-port all | display traffic table ip from-index 0 | display ont-lineprofile gpon all
  (interface mode)
  display ont info <port> all | display ont info <port> <id> | display ont optical-info <port> <id>
  ont add <port> <id> sn-auth <SN> omci ont-lineprofile-id 10 ont-srvprofile-id <n> desc "<name>"
  ont delete <port> <id> | ont reset <port> <id> | ont activate|deactivate <port> <id>
  ont port native-vlan <port> <id> eth 1 vlan <vlan> priority 0
  ont ipconfig <port> <id> ip-index 0 pppoe vlan <v> priority 0 user-account username "<u>" password "<p>"
  (config mode)
  service-port <idx> vlan <v> gpon 0/<s>/<p> ont <id> gemport 1 multi-service user-vlan <v> ...
  undo service-port <idx>`;

  function huawei(olt, st, line) {
    const a = line.trim().split(/\s+/);
    const cmd = line.trim().toLowerCase();
    if (!cmd) return '';
    if (cmd === '?' || cmd === 'help') return HELP_HW;
    if (cmd === 'enable') { if (st.mode === 'user') st.mode = 'enable'; return ''; }
    if (cmd === 'config' || cmd === 'configure terminal') { if (st.mode === 'user') return '  % Unknown command, the error locates at \'^\''; st.mode = 'config'; return ''; }
    if (cmd === 'quit' || cmd === 'exit') { st.mode = { iface: 'config', config: 'enable', enable: 'user', user: 'user' }[st.mode]; return ''; }
    if (cmd === 'return') { st.mode = 'enable'; return ''; }
    if (cmd === 'y' || cmd === 'n') return '';
    if (cmd === 'display version') return `  VERSION : ${olt.software}\n  PRODUCT : ${olt.hardware}\n  Uptime is ${duration(Date.now() - new Date(olt.bootTime))}`;
    if (cmd.startsWith('display board')) {
      return ['  ' + '-'.repeat(70), '  SlotID  BoardName  Status          SubType0 SubType1    Online/Offline', '  ' + '-'.repeat(70),
        ...olt.boards.map(b => `  ${pad(b.slot, 7)} ${pad(b.type, 10)} ${pad(b.type.match(/MC|SCU/) ? 'Active_normal' : 'Normal', 15)}`), '  ' + '-'.repeat(70)].join('\n');
    }
    if (cmd === 'display ont autofind all') return autofind(olt);
    if (cmd.startsWith('display vlan')) return ['  ' + '-'.repeat(50), '  VLAN  Type    Attribute  STND-Port NUM  SERV-Port NUM', '  ' + '-'.repeat(50), ...db.find('vlans', v => !v.oltId || v.oltId === olt.id).map(v => `  ${pad(v.vlan, 5)} smart   common     1              ${onusOf(olt, o => Number(o.vlan) === Number(v.vlan)).length}`), '  ' + '-'.repeat(50)].join('\n');
    if (cmd.startsWith('display traffic table')) return ['  ' + '-'.repeat(60), '  TID  CIR(kbps)  PIR(kbps)  Pri  Name', '  ' + '-'.repeat(60), ...db.col('speedProfiles').map(s => `  ${pad(s.index, 4)} ${pad(s.speed, 10)} ${pad(s.speed, 10)} 0    ${s.name}`)].join('\n');
    if (cmd.startsWith('display ont-lineprofile')) return `  ${'-'.repeat(50)}\n  Profile-ID  Profile-name                    Binding times\n  ${'-'.repeat(50)}\n  10          SMARTOLT_FLEXIBLE_GPON          ${onusOf(olt).length}\n  ${'-'.repeat(50)}`;
    if (cmd === 'display service-port all') return servicePorts(olt);
    if (cmd.startsWith('display ont info summary')) { const slot = Number(a[4]?.split('/')[1] ?? 1); return olt.boards.filter(b => b.ports && b.slot === slot).map(() => Array.from({ length: 16 }, (_, p) => { const l = onusOf(olt, o => o.board === slot && o.port === p); return l.length ? ontInfoTable(l) : ''; }).filter(Boolean).join('\n')).join('\n') || '  No ONT'; }
    if (st.mode !== 'iface' && /^display ont info 0 \d+ \d+ \d+$/.test(cmd)) {
      const [, , , , s, p, id] = a.map(Number);
      const o = db.findOne('onus', x => x.oltId === olt.id && x.board === s && x.port === p && x.onuId === id);
      return o ? ontInfoDetail(olt, o) : '  Failure: The ONT does not exist';
    }
    if (st.mode === 'config' && cmd.startsWith('interface gpon')) {
      const slot = Number((a[2] || '').split('/')[1]);
      if (!olt.boards.find(b => b.slot === slot && b.ports)) return '  Failure: The board does not exist or is not a GPON board';
      st.mode = 'iface'; st.slot = slot; return '';
    }
    if (st.mode === 'config' && a[0] === 'service-port') {
      const m = line.match(/service-port\s+(\d+)\s+vlan\s+(\d+)\s+gpon\s+0\/(\d+)\/(\d+)\s+ont\s+(\d+)/i);
      if (!m) return '  % Parameter error';
      const o = db.findOne('onus', x => x.oltId === olt.id && x.board === Number(m[3]) && x.port === Number(m[4]) && x.onuId === Number(m[5]));
      if (!o) return '  Failure: The ONT does not exist';
      ops.update(o, { servicePort: Number(m[1]), vlan: Number(m[2]) }, `CLI: ${line.trim()}`);
      return '';
    }
    if (st.mode === 'config' && cmd.startsWith('undo service-port')) {
      const o = db.findOne('onus', x => x.oltId === olt.id && x.servicePort === Number(a[2]));
      if (!o) return '  Failure: The service virtual port does not exist';
      ops.update(o, { servicePort: undefined }, `CLI: ${line.trim()}`);
      return '';
    }
    if (st.mode === 'iface') {
      const slot = st.slot;
      const find = (p, id) => db.findOne('onus', x => x.oltId === olt.id && x.board === slot && x.port === Number(p) && x.onuId === Number(id));
      if (/^display ont info \d+ all$/.test(cmd)) return ontInfoTable(onusOf(olt, o => o.board === slot && o.port === Number(a[3])).sort((x, y) => x.onuId - y.onuId));
      if (/^display ont info \d+ \d+$/.test(cmd)) { const o = find(a[3], a[4]); return o ? ontInfoDetail(olt, o) : '  Failure: The ONT does not exist'; }
      if (/^display ont optical-info \d+ \d+$/.test(cmd)) { const o = find(a[3], a[4]); return o ? optical(o) : '  Failure: The ONT does not exist'; }
      if (cmd === 'display ont autofind all') return autofind(olt, slot);
      if (a[0] === 'ont' && a[1] === 'add') {
        const m = line.match(/ont add\s+(\d+)\s+(\d+)\s+sn-auth\s+"?([0-9A-Za-z-]+)"?/i);
        if (!m) return '  % Parameter error, usage: ont add <port> <id> sn-auth <SN> omci ont-lineprofile-id 10 ont-srvprofile-id <n> desc "<name>"';
        const [, p, id, rawSn] = m;
        const desc = (line.match(/desc\s+"([^"]*)"/i) || [])[1];
        if (find(p, id)) return '  Failure: The ONT ID has already existed';
        const sn = snNormalize(rawSn);
        if (db.findOne('onus', x => x.sn === sn)) return '  Failure: SN already exists';
        const srvId = Number((line.match(/ont-srvprofile-id\s+(\d+)/i) || [])[1] || 10);
        const o = ops.authorize({ olt, board: slot, port: Number(p), onuId: Number(id), sn, name: desc || sn, srvProfileId: srvId, via: 'cli' });
        return `  Number of ONTs that can be added: 1, success: 1\n  PortID :${p}, ONTID :${id}${o.status === 'online' ? '' : '\n  (ONT is not in autofind list on this port - pre-provisioned, will stay offline)'}`;
      }
      if (a[0] === 'ont' && a[1] === 'delete') { const o = find(a[2], a[3]); if (!o) return '  Failure: The ONT does not exist'; ops.remove(o, 'cli'); return '  Number of ONTs that can be deleted: 1, success: 1'; }
      if (a[0] === 'ont' && a[1] === 'reset') { const o = find(a[2], a[3]); if (!o) return '  Failure: The ONT does not exist'; ops.action(o, 'reboot', 'cli'); return '  Are you sure to reset the ONT? (y/n)[n]: y'; }
      if (a[0] === 'ont' && (a[1] === 'activate' || a[1] === 'deactivate')) { const o = find(a[2], a[3]); if (!o) return '  Failure: The ONT does not exist'; ops.action(o, a[1] === 'activate' ? 'enable' : 'disable', 'cli'); return ''; }
      if (a[0] === 'ont' && a[1] === 'modify') { const o = find(a[2], a[3]); const d = line.match(/desc\s+"([^"]*)"/i); if (!o) return '  Failure: The ONT does not exist'; if (d) ops.update(o, { name: d[1] }, `CLI: ${line.trim()}`); return ''; }
      if (a[0] === 'ont' && a[1] === 'port' && a[2] === 'native-vlan') {
        const o = find(a[3], a[4]); const v = line.match(/vlan\s+(\d+)/i);
        if (!o || !v) return '  Failure: The ONT does not exist';
        ops.update(o, { mode: 'bridging', vlan: Number(v[1]) }, `CLI: ${line.trim()}`); return '';
      }
      if (a[0] === 'ont' && a[1] === 'ipconfig') {
        const o = find(a[2], a[3]);
        if (!o) return '  Failure: The ONT does not exist';
        const v = line.match(/vlan\s+(\d+)/i), u = line.match(/username\s+"?([^"\s]+)"?/i), pw = line.match(/password\s+"?([^"\s]+)"?/i);
        const wanMode = /pppoe/i.test(line) ? 'pppoe' : /static/i.test(line) ? 'static' : 'dhcp';
        ops.update(o, { mode: 'routing', wanMode, ...(v ? { vlan: Number(v[1]) } : {}), ...(u ? { pppoeUser: u[1] } : {}), ...(pw ? { pppoePass: pw[1] } : {}) }, `CLI: ${line.trim()}`);
        return '';
      }
      if (a[0] === 'ont') return ''; // other ont sub-commands accepted silently (internet-config, wan-config ...)
    }
    return `                  ^\n  % Unknown command, the error locates at '^'   (type ? for help)`;
  }

  function zteCli(olt, st, line) {
    const cmd = line.trim().toLowerCase();
    if (!cmd) return '';
    if (cmd === '?' || cmd === 'help') return 'Supported (ZTE syntax): configure terminal | exit | show gpon onu uncfg | show gpon onu state gpon-olt_1/<slot>/<port> | show pon power attenuation gpon-onu_1/<s>/<p>:<id> | show gpon onu detail-info gpon-onu_1/<s>/<p>:<id> | show running-config interface gpon-onu_1/<s>/<p>:<id>';
    if (cmd === 'configure terminal' || cmd === 'conf t') { st.mode = 'config'; return 'Enter configuration commands, one per line.  End with CTRL/Z.'; }
    if (cmd === 'exit' || cmd === 'end') { st.mode = 'enable'; return ''; }
    if (cmd === 'show gpon onu uncfg') {
      const l = db.find('unconfigured', u => u.oltId === olt.id);
      return 'OnuIndex                 Sn                  State\n---------------------------------------------------\n' + l.map(u => `gpon-onu_1/${u.board}/${u.port}:1   ${pad(u.sn, 19)} unknown`).join('\n');
    }
    let m = cmd.match(/^show gpon onu state gpon-olt_1\/(\d+)\/(\d+)$/);
    if (m) return 'OnuIndex   Admin State  OMCC State  Phase State  Channel\n--------------------------------------------------------------\n' + onusOf(olt, o => o.board === Number(m[1]) && o.port === Number(m[2])).map(o => `1/${o.board}/${o.port}:${pad(o.onuId, 4)} ${pad(o.disabled ? 'disable' : 'enable', 12)} ${pad(o.status === 'online' ? 'enable' : 'disable', 11)} ${pad(o.status === 'online' ? 'working' : o.status === 'los' ? 'LOS' : o.status === 'power_fail' ? 'DyingGasp' : 'OffLine', 12)} 1(GPON)`).join('\n');
    m = cmd.match(/gpon-onu_1\/(\d+)\/(\d+):(\d+)$/);
    const o = m && db.findOne('onus', x => x.oltId === olt.id && x.board === Number(m[1]) && x.port === Number(m[2]) && x.onuId === Number(m[3]));
    if (m && !o) return '%Code 32310-GPONSRV : ONU does not exist.';
    if (cmd.startsWith('show pon power attenuation')) return o.status !== 'online' ? '%Code: ONU is offline' : `           OLT                  ONU              Attenuation\n--------------------------------------------------------------------------\n up      Rx :${o.oltRxPower.toFixed(3)}(dbm)      Tx:${o.txPower.toFixed(3)}(dbm)        ${(o.txPower - o.oltRxPower).toFixed(3)}(dB)\n down    Tx :5.200(dbm)        Rx:${o.rxPower.toFixed(3)}(dbm)       ${(5.2 - o.rxPower).toFixed(3)}(dB)`;
    if (cmd.startsWith('show gpon onu detail-info')) return `ONU interface:          gpon-onu_1/${o.board}/${o.port}:${o.onuId}\n  Name:                 ${o.name}\n  Type:                 ${db.get('onuTypes', o.onuTypeId)?.name}\n  State:                ready\n  Admin state:          ${o.disabled ? 'disable' : 'enable'}\n  Phase state:          ${o.status === 'online' ? 'working' : 'OffLine'}\n  Serial number:        ${o.sn}\n  ONU Distance:         ${o.distance}m\n  Online Duration:      ${o.status === 'online' ? duration(Date.now() - new Date(o.uptimeStart)) : '-'}`;
    if (cmd.startsWith('show running-config interface')) return ops.commands(o, 'authorize').join('\n');
    return '%Error 20200: Invalid input detected at \'^\' marker. (type ? for help)';
  }

  return function run(olt, sid, line) {
    if (!sessions.has(sid)) sessions.set(sid, { mode: olt.vendor === 'ZTE' ? 'enable' : 'user' });
    const st = sessions.get(sid);
    const output = (olt.vendor === 'ZTE' ? zteCli : huawei)(olt, st, line);
    return { output, prompt: prompt(olt, st) };
  };
}

module.exports = { createCli, snHex, snNormalize };
