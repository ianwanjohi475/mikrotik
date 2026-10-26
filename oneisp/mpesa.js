// Safaricom Daraja (M-Pesa) client: OAuth, STK push (Lipa na M-Pesa Online), STK query, C2B.
// Docs: https://developer.safaricom.co.ke  - sandbox base https://sandbox.safaricom.co.ke
const BASE = { sandbox: 'https://sandbox.safaricom.co.ke', production: 'https://api.safaricom.co.ke' };

// 0712345678 / +254712345678 / 712345678 / 254712345678 -> 254712345678
function normalizePhone(p) {
  let s = String(p || '').replace(/[^0-9]/g, '');
  if (s.startsWith('0')) s = '254' + s.slice(1);
  else if (/^[17]\d{8}$/.test(s)) s = '254' + s;
  if (!/^254[17]\d{8}$/.test(s)) throw new Error(`Invalid Safaricom phone number "${p}" - use 07XXXXXXXX or 2547XXXXXXXX`);
  return s;
}

function timestamp(d = new Date()) {
  // Daraja wants local Kenyan time YYYYMMDDHHmmss
  const k = new Date(d.getTime() + (3 * 60 + d.getTimezoneOffset()) * 60000);
  const z = n => String(n).padStart(2, '0');
  return `${k.getFullYear()}${z(k.getMonth() + 1)}${z(k.getDate())}${z(k.getHours())}${z(k.getMinutes())}${z(k.getSeconds())}`;
}

class Mpesa {
  constructor(cfg) { this.cfg = cfg; this._token = null; this._exp = 0; }
  base() { return (this.cfg.baseUrl || BASE[this.cfg.mode] || BASE.sandbox).replace(/\/$/, ''); }
  password(ts) { return Buffer.from(`${this.cfg.shortcode}${this.cfg.passkey}${ts}`).toString('base64'); }

  async request(method, path, body, auth) {
    let r;
    try {
      r = await fetch(this.base() + path, {
        method, signal: AbortSignal.timeout(20000),
        headers: { Authorization: auth || `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { throw new Error(`Cannot reach M-Pesa (${this.base()}): ${e.cause?.code || e.message}`); }
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (!r.ok) {
      const err = new Error(j.errorMessage || j.ResultDesc || j.raw || `HTTP ${r.status}`);
      err.code = j.errorCode; err.status = r.status; err.body = j;
      throw err;
    }
    return j;
  }

  async token() {
    if (this._token && Date.now() < this._exp) return this._token;
    const { consumerKey, consumerSecret } = this.cfg;
    if (!consumerKey || !consumerSecret) throw new Error('M-Pesa consumer key/secret missing (Settings > M-Pesa)');
    const basic = 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const j = await this.request('GET', '/oauth/v1/generate?grant_type=client_credentials', null, basic);
    if (!j.access_token) throw new Error('M-Pesa did not return an access token - check consumer key/secret');
    this._token = j.access_token;
    this._exp = Date.now() + (Number(j.expires_in || 3599) - 60) * 1000;
    return this._token;
  }

  // Lipa na M-Pesa Online: the customer gets a PIN prompt on their phone.
  async stkPush({ phone, amount, reference, description, callbackUrl }) {
    const ts = timestamp();
    const till = this.cfg.type === 'till';
    return this.request('POST', '/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: this.cfg.shortcode, Password: this.password(ts), Timestamp: ts,
      TransactionType: till ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
      Amount: Math.max(1, Math.ceil(Number(amount))), PartyA: normalizePhone(phone),
      PartyB: till ? this.cfg.till || this.cfg.shortcode : this.cfg.shortcode, PhoneNumber: normalizePhone(phone),
      CallBackURL: callbackUrl, AccountReference: String(reference || 'WIFI').slice(0, 12), TransactionDesc: String(description || 'Payment').slice(0, 13),
    });
  }

  // Ask M-Pesa what happened to an STK push - works without a public callback URL.
  async stkQuery(checkoutRequestId) {
    const ts = timestamp();
    return this.request('POST', '/mpesa/stkpushquery/v1/query', { BusinessShortCode: this.cfg.shortcode, Password: this.password(ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId });
  }

  // C2B: customers pay to the paybill from the SIM menu; M-Pesa POSTs to our confirmation URL.
  async c2bRegister({ confirmationUrl, validationUrl }) {
    return this.request('POST', '/mpesa/c2b/v1/registerurl', { ShortCode: this.cfg.c2bShortcode || this.cfg.shortcode, ResponseType: 'Completed', ConfirmationURL: confirmationUrl, ValidationURL: validationUrl });
  }
  async c2bSimulate({ amount, phone, billRef }) {
    return this.request('POST', '/mpesa/c2b/v1/simulate', { ShortCode: this.cfg.c2bShortcode || this.cfg.shortcode, CommandID: 'CustomerPayBillOnline', Amount: Math.ceil(Number(amount)), Msisdn: normalizePhone(phone), BillRefNumber: billRef });
  }
}

// STK result codes worth explaining to a learner.
const RESULT_CODES = {
  0: 'Success', 1: 'Insufficient M-Pesa balance', 1001: 'Another transaction is in progress for this number', 1019: 'Transaction expired',
  1025: 'Error sending the push', 1032: 'Cancelled by the customer', 1037: 'Customer did not respond in time (phone unreachable)', 2001: 'Wrong M-Pesa PIN',
};

module.exports = { Mpesa, normalizePhone, timestamp, RESULT_CODES };
