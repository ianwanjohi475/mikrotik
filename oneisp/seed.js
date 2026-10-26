// Demo data so the simulator is useful from the first login. Delete data/oneisp.json to re-seed.
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  companyName: 'Lab Networks', currency: 'KES', paybill: '247247', accountPrefix: 'LN',
  expiredAction: 'disable', // 'disable' or 'redirect'
  reminderDays: 2, smsEnabled: true,
  serverIp: '192.168.56.1', // IP of the PC running OneISP, as seen by the MikroTik (VirtualBox host-only adapter)
  apiToken: 'oneisp-demo-token',
  smartolt: { url: 'http://localhost:4000', token: 'smartolt-demo-token' },
  smsTemplates: {
    welcome: 'Welcome to {company}, {name}! Account {account}. Username {username} password {password}. Package {package} expires {expiry}. Pay via paybill {paybill} acc {account}.',
    payment: 'Dear {name}, we received {currency} {amount}. Your {package} is active until {expiry}. Thank you!',
    reminder: 'Dear {name}, your {package} expires on {expiry}. Pay {currency} {price} to paybill {paybill} account {account} to stay connected.',
    expired: 'Dear {name}, your internet has expired. Pay {currency} {price} to paybill {paybill} account {account} to reconnect.',
    ticket: 'Dear {name}, ticket {ticket} has been opened. Our team will contact you shortly.',
  },
};

const DEFAULT_SITE = {
  mode: 'simulate', host: '192.168.56.101', port: 80, useHttps: false, username: 'oneisp', password: 'oneisp123',
  wanInterface: 'ether1', pppoeInterface: 'ether2', hotspotInterface: 'ether3', dhcpInterface: 'ether4', staticInterface: 'ether5',
  pppoeGateway: '10.10.0.1', pppoePool: '10.10.0.2-10.10.255.254', expiredPool: '172.30.0.2-172.30.255.254',
  hotspotGateway: '192.168.88.1', hotspotPool: '192.168.88.20-192.168.88.254', hotspotServer: 'oneisp-hotspot', hotspotDns: 'wifi.lab',
  dhcpGateway: '192.168.100.1', dhcpPool: '192.168.100.10-192.168.100.199', dhcpServer: 'oneisp-dhcp',
  staticGateway: '10.20.0.1', dns: '8.8.8.8,1.1.1.1',
};

const FIRST = ['John', 'Mary', 'Peter', 'Grace', 'James', 'Faith', 'Brian', 'Mercy', 'Kevin', 'Joy', 'Dennis', 'Ann', 'Samuel', 'Lucy', 'Victor', 'Esther', 'Collins', 'Ruth'];
const LAST = ['Kamau', 'Wanjiku', 'Otieno', 'Achieng', 'Mwangi', 'Njeri', 'Kiprop', 'Chebet', 'Ouma', 'Mutua', 'Wambui', 'Kariuki'];
const AREAS = ['Kahawa West', 'Roysambu', 'Zimmerman', 'Githurai 45', 'Kasarani', 'Ruiru Town', 'Juja', 'Thika Rd'];

function seed(db) {
  const r = n => crypto.randomBytes(1)[0] % n;
  const mac = () => Array.from(crypto.randomBytes(6), (b, i) => (i === 0 ? b & 0xfe : b).toString(16).padStart(2, '0')).join(':').toUpperCase();
  const pw = () => crypto.randomBytes(3).toString('hex');
  const day = 864e5;

  db.data.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const hash = p => crypto.createHash('sha256').update('oneisp:' + p).digest('hex');
  db.insert('users', { username: 'admin', name: 'Administrator', role: 'admin', phone: '0700000000', passwordHash: hash('admin') });
  db.insert('users', { username: 'support', name: 'Support Agent', role: 'support', phone: '0700000001', passwordHash: hash('support') });

  const site = db.insert('sites', { ...DEFAULT_SITE, name: 'Lab CHR (VirtualBox)', location: 'Home lab' });

  const std = db.insert('policies', { name: 'Standard (no burst)', burstEnabled: false, priority: 8, description: 'Plain max-limit' });
  const burst = db.insert('policies', { name: 'Burst x2 for 16s', burstEnabled: true, burstDownload: '20M', burstUpload: '10M', thresholdDownload: '8M', thresholdUpload: '4M', burstTime: '16s', priority: 8, description: 'Customer gets double speed for short downloads (web pages feel fast)' });

  const pk = (o) => db.insert('packages', { sharedUsers: 1, public: true, ...o });
  const pppoe = [
    pk({ name: 'Home 5Mbps', type: 'pppoe', price: 1500, validityValue: 1, validityUnit: 'months', download: '5M', upload: '2M', policyId: std.id }),
    pk({ name: 'Home 10Mbps', type: 'pppoe', price: 2500, validityValue: 1, validityUnit: 'months', download: '10M', upload: '5M', policyId: burst.id }),
    pk({ name: 'Home 20Mbps', type: 'pppoe', price: 3500, validityValue: 1, validityUnit: 'months', download: '20M', upload: '10M', policyId: std.id }),
  ];
  const hs = [
    pk({ name: '1 Hour', type: 'hotspot', price: 10, validityValue: 1, validityUnit: 'hours', download: '3M', upload: '1M', sharedUsers: 1 }),
    pk({ name: '24 Hours', type: 'hotspot', price: 50, validityValue: 1, validityUnit: 'days', download: '5M', upload: '2M', sharedUsers: 1 }),
    pk({ name: 'Weekly', type: 'hotspot', price: 250, validityValue: 7, validityUnit: 'days', download: '5M', upload: '2M', sharedUsers: 2 }),
  ];
  const stat = [pk({ name: 'Business Static 10M', type: 'static', price: 6000, validityValue: 1, validityUnit: 'months', download: '10M', upload: '10M' })];
  const dhcp = [pk({ name: 'DHCP Basic 6M', type: 'dhcp', price: 1800, validityValue: 1, validityUnit: 'months', download: '6M', upload: '3M' })];

  let n = 0;
  const cust = (type, pkg, expiresInDays, extra = {}) => {
    n++;
    const name = `${FIRST[n % FIRST.length]} ${LAST[(n * 7) % LAST.length]}`;
    const accountNo = `LN${1000 + db.nextId('accountNo')}`;
    const c = db.insert('customers', {
      accountNo, name, phone: `07${String(10000000 + n * 7919).slice(0, 8)}`, email: '', address: AREAS[n % AREAS.length], location: AREAS[n % AREAS.length],
      siteId: site.id, packageId: pkg.id, connectionType: type, username: type === 'hotspot' ? 'hs' + (1000 + n) : accountNo.toLowerCase(), password: pw(),
      balance: 0, disabled: false, online: false, expiresAt: new Date(Date.now() + expiresInDays * day).toISOString(),
      createdAt: new Date(Date.now() - (60 + r(200)) * day).toISOString(), ...extra,
    });
    // payment history for revenue charts
    const months = 1 + r(6);
    for (let m = months; m >= 0; m--) {
      if (expiresInDays < 0 && m === 0) continue;
      db.insert('payments', { customerId: c.id, customerName: c.name, accountNo: c.accountNo, amount: pkg.price, method: r(4) ? 'mpesa' : 'cash', reference: 'S' + crypto.randomBytes(5).toString('hex').toUpperCase(), periods: 1, packageName: pkg.name, by: 'seed', createdAt: new Date(Date.now() - (m * 30 + r(20)) * day).toISOString() });
    }
    return c;
  };
  for (let i = 0; i < 9; i++) cust('pppoe', pppoe[i % 3], [25, 12, 1, -3, 18, 6, -10, 29, 2][i]);
  const dis = cust('pppoe', pppoe[0], 15); dis.disabled = true;
  cust('static', stat[0], 20, { ipAddress: '10.20.0.10', macAddress: mac() });
  cust('static', stat[0], -2, { ipAddress: '10.20.0.11', macAddress: mac() });
  cust('dhcp', dhcp[0], 14, { ipAddress: '192.168.100.200', macAddress: mac() });
  cust('dhcp', dhcp[0], 3, { ipAddress: '192.168.100.201', macAddress: mac() });
  cust('hotspot', hs[1], 0.5, { macAddress: mac() });
  cust('hotspot', hs[2], 4, { macAddress: mac() });
  db.col('customers').filter(c => c.id <= 8).forEach(c => { c.onuSn = 'HWTC' + (0x1a2b3c00 + c.id).toString(16).toUpperCase().padStart(8, '0'); });
  db.col('customers').forEach(c => { c.status = c.disabled ? 'disabled' : new Date(c.expiresAt) > new Date() ? 'active' : 'expired'; });
  // chronological payments
  db.data.payments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  ['A3K9PQ', 'B7M2XZ', 'C4N8WT', 'D9R3HJ', 'E2T6YU', 'F8Q4LK'].forEach(code => db.insert('vouchers', { code, packageId: hs[0].id, siteId: site.id, batch: 'BDEMO', status: 'unused' }));

  db.insert('leads', { name: 'Paul Njoroge', phone: '0711222333', location: 'Kahawa Sukari', source: 'Facebook', interest: 'Home 10Mbps', status: 'new', notes: 'Wants installation on Saturday' });
  db.insert('leads', { name: 'Cyber Point Cafe', phone: '0722111999', location: 'Ruiru Town', source: 'Walk-in', interest: 'Business Static 10M', status: 'survey', notes: 'Site survey: needs fiber drop ~120m from ODB-RU-03' });
  db.insert('leads', { name: 'Alice Wairimu', phone: '0733444555', location: 'Juja', source: 'Referral', interest: 'Home 5Mbps', status: 'contacted' });

  db.insert('tickets', { number: 'TK1001', customerId: 1, subject: 'Slow internet in the evening', category: 'Speed', priority: 'medium', status: 'open', openedBy: 'support', comments: [{ by: 'support', text: 'Asked customer to run speedtest via cable.', at: new Date().toISOString() }] });
  db.insert('tickets', { number: 'TK1002', customerId: 4, subject: 'No internet - red LOS light on router', category: 'Fiber', priority: 'high', status: 'in_progress', openedBy: 'admin', assignedTo: 'support', comments: [{ by: 'admin', text: 'SmartOLT shows LOS. Technician dispatched to check drop cable.', at: new Date().toISOString() }] });

  db.insert('expenses', { category: 'Bandwidth', amount: 45000, note: 'Upstream transit', date: new Date().toISOString().slice(0, 10), by: 'admin' });
  db.insert('expenses', { category: 'Equipment', amount: 12000, note: '6x ONU HG8546M', date: new Date().toISOString().slice(0, 10), by: 'admin' });
}

module.exports = { seed, DEFAULT_SETTINGS, DEFAULT_SITE };
