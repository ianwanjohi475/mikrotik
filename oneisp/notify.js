// Message delivery: SMS (Africa's Talking) and WhatsApp (free wa.me click-to-send links, or the Meta WhatsApp Cloud API).
const { normalizePhone } = require('./mpesa');

const e164 = p => { try { return normalizePhone(p); } catch { return String(p || '').replace(/[^0-9]/g, ''); } };

async function post(url, { headers = {}, json, form, auth }) {
  const h = { Accept: 'application/json', ...headers };
  if (auth) h.Authorization = 'Basic ' + Buffer.from(auth).toString('base64');
  let body;
  if (json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  let r;
  try { r = await fetch(url, { method: 'POST', headers: h, body, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new Error(`Cannot reach ${new URL(url).host}: ${e.cause?.code || e.message}`); }
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(j.error?.message || j.message || j.raw || `HTTP ${r.status}`);
  return j;
}

async function sendSms(cfg, to, text) {
  if (cfg.provider !== 'africastalking') return { status: 'NOT SENT - SMS provider is "simulate" (Settings > Messaging)' };
  const host = cfg.sandbox ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  const j = await post(`${host}/version1/messaging`, {
    headers: { apiKey: cfg.apiKey },
    form: { username: cfg.sandbox ? 'sandbox' : cfg.username, to: '+' + e164(to), message: text, ...(cfg.senderId ? { from: cfg.senderId } : {}) },
  });
  const rec = j.SMSMessageData?.Recipients?.[0];
  if (!rec) throw new Error(j.SMSMessageData?.Message || 'No recipient in response');
  if (!['Success', 'Sent'].includes(rec.status)) throw new Error(`${rec.status} (${rec.statusCode})`);
  return { status: `sent via Africa's Talking${cfg.sandbox ? ' sandbox' : ''}`, providerId: rec.messageId, cost: rec.cost };
}

async function sendWhatsApp(cfg, to, text) {
  if (cfg.provider === 'meta') {
    const msg = cfg.template
      ? { type: 'template', template: { name: cfg.template, language: { code: cfg.templateLang || 'en_US' }, ...(cfg.templateHasParam ? { components: [{ type: 'body', parameters: [{ type: 'text', text: text.replace(/\s*\n\s*/g, ' ').slice(0, 1000) }] }] } : {}) } }
      : { type: 'text', text: { preview_url: false, body: text } };
    const j = await post(`https://graph.facebook.com/${cfg.apiVersion || 'v21.0'}/${cfg.phoneNumberId}/messages`, {
      headers: { Authorization: `Bearer ${cfg.token}` }, json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: e164(to), ...msg },
    });
    return { status: `sent via WhatsApp Cloud API${cfg.template ? ' (template ' + cfg.template + ')' : ''}`, providerId: j.messages?.[0]?.id };
  }
  // Free option: no API. The message gets a wa.me link; opening it starts WhatsApp with the text ready to send.
  return { status: 'READY - click "Send in WhatsApp" to send it from your WhatsApp', link: waLink(to, text) };
}

const waLink = (to, text) => `https://wa.me/${e164(to)}?text=${encodeURIComponent(text)}`;

// channel: 'sms' | 'whatsapp'
async function deliver(messaging, channel, to, text) {
  return channel === 'whatsapp' ? sendWhatsApp(messaging.whatsapp || {}, to, text) : sendSms(messaging.sms || {}, to, text);
}

module.exports = { deliver, waLink };
