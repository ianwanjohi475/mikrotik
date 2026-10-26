// Demo data for the SmartOLT simulator. Delete data/smartolt.json to re-seed.
const DEFAULT_SETTINGS = {
  companyName: 'Lab Telecom', username: 'admin', password: 'admin',
  apiToken: 'smartolt-demo-token',
  oneisp: { url: 'http://localhost:3000', token: 'oneisp-demo-token' },
  signalWarning: -25, signalCritical: -27,
  simulation: { faults: true, autofind: true, speed: 1 },
  tr069Url: 'http://10.30.0.10:7547',
};

const NAMES = ['Mary Chebet', 'Peter Otieno', 'Grace Mutua', 'James Wambui', 'Faith Kariuki', 'Brian Kamau', 'Mercy Achieng', 'Kevin Mwangi', 'Esther Njeri', 'Collins Kiprop',
  'Ruth Ouma', 'Samuel Wanjiku', 'Lucy Otieno', 'Victor Kamau', 'Ann Mutua', 'Dennis Chebet', 'Joy Kariuki', 'Cyber Point Cafe', 'St. Mary School', 'Green Court Apt B4', 'Juja Pharmacy', 'Kahawa Butchery'];

function seed(db) {
  db.data.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const boot = new Date(Date.now() - 41 * 864e5).toISOString();
  const hw = db.insert('olts', {
    name: 'OLT-HQ-Huawei', vendor: 'Huawei', hardware: 'MA5608T', software: 'MA5600V800R018C10', hostname: 'MA5608T', ip: '10.0.0.2', telnetPort: 23, snmpPort: 161,
    snmpCommunity: 'public', uplinkSlot: 2, uplinkPort: 0, bootTime: boot, temperature: 41,
    boards: [{ slot: 0, type: 'GPFD', ports: 16 }, { slot: 1, type: 'GPFD', ports: 16 }, { slot: 2, type: 'MCUD', ports: 0 }, { slot: 4, type: 'MPWC', ports: 0 }],
  });
  const zt = db.insert('olts', {
    name: 'OLT-Ruiru-ZTE', vendor: 'ZTE', hardware: 'C320', software: 'V2.1.0', hostname: 'ZXAN', ip: '10.0.1.2', telnetPort: 23, snmpPort: 161,
    snmpCommunity: 'public', uplink: 'gei_1/3/1', bootTime: new Date(Date.now() - 12 * 864e5).toISOString(), temperature: 38,
    boards: [{ slot: 1, type: 'GTGO', ports: 8 }, { slot: 2, type: 'GTGO', ports: 8 }, { slot: 3, type: 'SMXA', ports: 0 }, { slot: 4, type: 'PRAM', ports: 0 }],
  });

  const zones = ['Kahawa West', 'Roysambu', 'Ruiru', 'Juja'].map(name => db.insert('zones', { name }));
  const odbs = [['ODB-KW-01', 0], ['ODB-KW-02', 0], ['ODB-RY-01', 1], ['ODB-RU-03', 2], ['ODB-JJ-01', 3]].map(([name, z], i) =>
    db.insert('odbs', { name, zoneId: zones[z].id, ports: i % 2 ? 16 : 8, splitter: i % 2 ? '1:16' : '1:8', latitude: -1.18 - i * 0.01, longitude: 36.92 + i * 0.01 }));

  const types = [
    { name: 'HG8546M', ponType: 'GPON', ethPorts: 4, wifi: true, voip: 2, catv: false, srvProfileId: 11, vendor: 'Huawei', modes: 'routing,bridging' },
    { name: 'EG8145V5', ponType: 'GPON', ethPorts: 4, wifi: true, voip: 1, catv: false, srvProfileId: 12, vendor: 'Huawei', modes: 'routing,bridging' },
    { name: 'HG8010H', ponType: 'GPON', ethPorts: 1, wifi: false, voip: 0, catv: false, srvProfileId: 13, vendor: 'Huawei', modes: 'bridging' },
    { name: 'HG8247H', ponType: 'GPON', ethPorts: 4, wifi: true, voip: 2, catv: true, srvProfileId: 14, vendor: 'Huawei', modes: 'routing,bridging' },
    { name: 'ZTE-F660', ponType: 'GPON', ethPorts: 4, wifi: true, voip: 2, catv: false, srvProfileId: 15, vendor: 'ZTE', modes: 'routing,bridging' },
    { name: 'ZTE-F601', ponType: 'GPON', ethPorts: 1, wifi: false, voip: 0, catv: false, srvProfileId: 16, vendor: 'ZTE', modes: 'bridging' },
    { name: 'ZTE-F670L', ponType: 'GPON', ethPorts: 4, wifi: true, voip: 1, catv: false, srvProfileId: 17, vendor: 'ZTE', modes: 'routing,bridging' },
  ].map(t => db.insert('onuTypes', t));

  const sp = (name, type, speed, index) => db.insert('speedProfiles', { name, type, speed, index });
  const down = [sp('5M', 'download', 5120, 11), sp('10M', 'download', 10240, 12), sp('20M', 'download', 20480, 13), sp('50M', 'download', 51200, 14), sp('100M', 'download', 102400, 15)];
  const up = [sp('2M-up', 'upload', 2048, 21), sp('5M-up', 'upload', 5120, 22), sp('10M-up', 'upload', 10240, 23), sp('20M-up', 'upload', 20480, 24)];

  [[100, 'Internet PPPoE'], [200, 'Hotspot'], [300, 'Management TR069'], [400, 'Business static']].forEach(([vlan, description]) => db.insert('vlans', { vlan, description, oltId: null }));

  const now = Date.now();
  const make = (i, olt, board, port, onuId, extra = {}) => {
    const huawei = olt.vendor === 'Huawei';
    const type = huawei ? types[[0, 1, 0, 2, 3][i % 5]] : types[[4, 6, 5][i % 3]];
    const baseRx = [-19.2, -21.5, -23.8, -24.6, -22.1, -26.1, -27.6, -20.4, -18.7, -25.4][i % 10];
    const sn = (huawei ? 'HWTC' : 'ZTEG') + (0x1a2b3c00 + i + 1).toString(16).toUpperCase().padStart(8, '0');
    const status = extra.status || 'online';
    const linked = i < 8 && huawei;
    return db.insert('onus', {
      sn, oltId: olt.id, board, port, onuId, name: NAMES[i], address: zones[i % 4].name, phone: '07' + String(20000000 + i * 104729).slice(0, 8),
      zoneId: zones[i % 4].id, odbId: odbs[i % 5].id, odbPort: (i % 8) + 1, onuTypeId: type.id, ponType: 'GPON',
      mode: type.modes.includes('routing') && i % 4 !== 3 ? 'routing' : 'bridging', vlan: i % 6 === 5 ? 400 : 100, wanMode: 'pppoe',
      pppoeUser: linked ? `ln${1001 + i}` : `fb${2001 + i}`, pppoePass: linked ? '' : 'pass' + (1000 + i),
      downloadProfileId: down[i % 5].id, uploadProfileId: up[i % 4].id, catv: type.catv, wifiSsid: `LabFiber-${1001 + i}`, wifiPassword: '12345678',
      status, disabled: false, baseRx, rxPower: baseRx, txPower: 2.1 + (i % 4) * 0.1, oltRxPower: baseRx - 1.7, temperature: 44 + (i % 9), distance: 300 + i * 173,
      uptimeStart: new Date(now - (i + 1) * 3.7 * 36e5).toISOString(), lastDownCause: i % 3 ? 'dying-gasp' : 'LOS', lastDownAt: new Date(now - (i + 1) * 3.8 * 36e5).toISOString(),
      servicePort: 100 + i, externalId: linked ? i + 1 : null, authorizedAt: new Date(now - (((i * 7) % 20) + 0.5) * 864e5).toISOString(), via: 'seed',
      trafficDown: 0, trafficUp: 0, history: { sig: [], traf: [] }, ...extra,
    });
  };
  let i = 0;
  for (const [port, count] of [[0, 4], [1, 3], [3, 3]]) for (let k = 1; k <= count; k++) make(i++, hw, 0, port, k);
  for (let k = 1; k <= 4; k++) make(i++, hw, 1, 2, k, k === 2 ? { status: 'los', lastDownCause: 'LOS', lastDownAt: new Date(now - 2 * 36e5).toISOString() } : k === 4 ? { status: 'power_fail', lastDownCause: 'dying-gasp', lastDownAt: new Date(now - 40 * 6e4).toISOString() } : {});
  for (let k = 1; k <= 4; k++) make(i++, zt, 1, 1, k, k === 3 ? { status: 'offline', lastDownCause: 'unknown' } : {});
  make(i++, zt, 2, 4, 1);
  make(i++, zt, 2, 4, 2, { disabled: true, status: 'offline', lastDownCause: 'deactivated' });
  // ONU 4 of OneISP's demo (customer #4, ticket "red LOS light") is the LOS one
  const los = db.findOne('onus', o => o.externalId === 4);
  if (los) Object.assign(los, { status: 'los', lastDownCause: 'LOS', lastDownAt: new Date(now - 3 * 36e5).toISOString() });

  const auto = (olt, board, port, sn, equipmentId) => db.insert('unconfigured', { oltId: olt.id, board, port, sn, equipmentId, ponType: 'GPON', detectedAt: new Date(now - Math.random() * 36e5).toISOString() });
  auto(hw, 0, 1, 'HWTC9F3E2A11', 'HG8546M');
  auto(hw, 0, 5, 'HWTCB7C41D02', 'EG8145V5');
  auto(hw, 1, 2, 'HWTC0D5577A3', 'HG8010H');
  auto(zt, 1, 1, 'ZTEGC8810E44', 'F670L');

  db.insert('events', { oltId: hw.id, onuSn: 'HWTC1A2B3C04', type: 'LOS', severity: 'critical', message: 'ONU HWTC1A2B3C04 (James Wambui) LOS - fiber cut or disconnected' });
  db.insert('events', { oltId: hw.id, type: 'autofind', severity: 'info', message: 'New ONU HWTC9F3E2A11 found on 0/0/1' });
}

module.exports = { seed, DEFAULT_SETTINGS };
