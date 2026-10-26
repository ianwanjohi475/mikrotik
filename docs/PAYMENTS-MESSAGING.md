# Real M-Pesa, SMS and WhatsApp in the OneISP simulator

Out of the box everything is **simulated**: payments approve after 4 seconds and messages only go to the outbox. This guide switches each part over to the real **sandbox** services, so the flow is the same as at a real ISP.

All keys are entered in **OneISP → Settings**. They are saved in `data/oneisp.json`, which is **not** pushed to git. Never put keys in the code.

---

## 0. Checklist: "no prompt / no code" (read this first)

| Check | Why |
|---|---|
| **Settings → M-Pesa → Mode = `Daraja sandbox`**, then **Save** | In *simulate* mode **nothing** is sent to Safaricom. An orange banner at the top of OneISP warns you while this is the case |
| Pay with **your own Safaricom number** (07…) | The test number **254708374149 never rings**. A real line gets the real sandbox PIN prompt, and no money moves |
| **M-Pesa → Diagnose** with your number | Checks the mode, keys, passkey, connection and OAuth, then sends a real push. Each ✗ tells you what to fix |
| A **WhatsApp/SMS provider** chosen in Settings → Messaging | With provider *simulate* the code is **not sent**. The outbox says "not sent" |
| Watch the **black OneISP window** | Every Safaricom call is printed as `[M-Pesa] POST /mpesa/stkpush/... -> 200 {...}` |
| Click **Details** on a transaction | Shows the exact request OneISP sent and Safaricom's reply |

## 1. M-Pesa (Safaricom Daraja sandbox)

1. Log in at https://developer.safaricom.co.ke → **My Apps** and create an app (or use your existing one) with *Lipa Na M-Pesa Sandbox* and *M-Pesa Sandbox* enabled.
2. In OneISP → **Settings → M-Pesa**, fill in:
   - **Mode:** `Daraja sandbox`
   - **Consumer key / Consumer secret:** from your app
   - **Shortcode** `174379` and **Passkey**: already filled in with Safaricom's public sandbox values
3. Click **Save & test keys**. You should see *"Connected to Daraja sandbox. Access token … received."*
4. Go to **M-Pesa → Test STK push**, enter phone `254708374149` (or your own Safaricom number) and amount `1`.
   - With your own number you get a **real PIN prompt** on your phone. In the sandbox no money moves.
   - The transaction row changes from *pending* to *success*, *cancelled* or *failed* by itself.

### How OneISP learns the result

| Method | Needs | How it works |
|---|---|---|
| **Polling** (default) | Nothing | Every few seconds OneISP calls `/mpesa/stkpushquery/v1/query` until the result is known. This works on your PC with no public URL |
| **Callback** | A public **https** URL | Safaricom POSTs the result to `<Public base URL>/api/portal/pay/stk-result`. It includes the **real receipt number** (e.g. `TJQ1ABC2DE`) |

With polling only, the receipt is saved as `STK…` because the query API doesn't return the receipt number. Add a public URL and the real receipt replaces it automatically.

### Getting a public URL with Cloudflare Tunnel (free, no account needed)

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:8080
```

It prints a URL like `https://random-words.trycloudflare.com`. Paste it into **Settings → M-Pesa → Public base URL** and save. The URL changes every time you restart cloudflared, so update the setting each time.

### Paybill (C2B): the customer pays from the SIM menu

1. Set the public base URL (above). Set the C2B shortcode to `600982` (sandbox).
2. Go to **M-Pesa → Register C2B URLs**. This tells Safaricom where to send confirmations.
3. Go to **M-Pesa → Simulate paybill payment** with BillRefNumber = a customer account number (e.g. `LN1001`).
4. Safaricom POSTs to `/api/portal/pay/c2b-confirm` and that account is renewed. An unknown account number shows up as **unmatched**; click **Allocate** to assign it to a customer.

In *simulate* mode the C2B button posts the same kind of confirmation that Safaricom would send, so you can practice without internet.

### STK result codes you will see

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Insufficient balance |
| 1032 | Customer cancelled the prompt |
| 1037 | Phone unreachable / no response (timeout) |
| 2001 | Wrong PIN |
| 1001 | Another transaction is in progress for this number |

---

## 2. Hotspot sales with the code sent by WhatsApp

This is what happens when a customer buys WiFi:

1. The customer joins the WiFi and the MikroTik hotspot shows the OneISP portal (see MIKROTIK-LAB.md §8).
2. They pick a package and enter their M-Pesa number. An **STK push** goes to their phone.
3. When the payment succeeds, OneISP creates a hotspot user on the router. The **username and password are one 6-character code** (e.g. `5DZ4TM`).
4. The portal shows the code and **logs the device in automatically** by posting it to the router.
5. The code is also sent by **WhatsApp** (or SMS: Settings → *Send hotspot codes by*), so the customer can log in on another device or after reconnecting.
6. **I have a code** accepts both printed vouchers and bought codes. **Lost code** re-sends the active code to the number they paid with.

If the same number buys again, it keeps the same code. The time is added on, and the package changes if they picked a different one.

---

## 3. WhatsApp

### Option A: Twilio WhatsApp sandbox (easiest)

1. Create a free account at https://www.twilio.com and open **Messaging → Try it out → Send a WhatsApp message**.
2. From your WhatsApp, send the shown `join <word-word>` message to **+1 415 523 8886**. Every recipient must do this once.
3. In OneISP → Settings → Messaging, set:
   - **WhatsApp provider:** Twilio
   - **Account SID** and **Auth token:** from the Twilio console
   - **Twilio WhatsApp number:** `+14155238886`
4. Enter your number under **Save & send test**. The message arrives in WhatsApp.

### Option B: Meta WhatsApp Cloud API

1. Go to https://developers.facebook.com → create an app → add **WhatsApp**. You get a free test number.
2. In *API Setup*, add your phone as a recipient, then copy the **Phone number ID** and the **temporary access token** (it lasts 24h; create a system-user token for a permanent one).
3. In OneISP, set **WhatsApp provider** to *Meta WhatsApp Cloud API*.
4. Be aware of Meta's rule: you can only send **free text within 24h after the customer messaged your number**. Otherwise you need an **approved template**:
   - In Meta Business Manager, create a template, e.g. `wifi_code` with body `Your WiFi code is {{1}}`.
   - Enter its name in **Template name**, set the language (`en_US`) and tick **Template has one {{1}} body parameter**.
   - OneISP puts the whole message text into `{{1}}`.
   - For a quick test, use the built-in `hello_world` template with the parameter box unticked.

---

## 4. SMS: Africa's Talking sandbox

1. Create an account at https://account.africastalking.com → open the **Sandbox** app → **Settings → API Key** → generate a key.
2. In OneISP, set:
   - **SMS provider:** Africa's Talking
   - **Use sandbox:** ticked
   - **API key:** your sandbox key
3. Open the AT **simulator** (https://simulator.africastalking.com), enter a phone number, then send a test from OneISP to that number. The SMS appears in the simulator phone.
4. For live sending, untick sandbox and enter your live username and key. A sender ID is optional.

---

## 5. Where to see what happened

| Page | Shows |
|---|---|
| **M-Pesa** | Every STK push and paybill payment, its status, receipt and errors. *Callback log* shows the raw JSON Safaricom sent |
| **SMS & WhatsApp** | Every message, its channel and its real delivery status. If it failed, you see the provider's error |
| **Customer → Statement / M-Pesa / Activity / Messages** | Everything about one customer |

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| `Invalid Authentication passed` | Wrong consumer key or secret, or the app doesn't have the sandbox products enabled |
| `Bad Request - Invalid PhoneNumber` | Use 2547XXXXXXXX or 07XXXXXXXX |
| `Bad Request - Invalid CallBackURL` | The Public base URL must be https and must not contain words like *mpesa*, *safaricom*, *exe*, *cmd*, *sql* or *query*. OneISP refuses such URLs when you save |
| STK sent but nothing on your phone | Use a Safaricom line. The sandbox is sometimes slow, so wait 30–60s. The test number 254708374149 never shows a prompt |
| Stays *pending* for 3 minutes, then *failed: timeout* | The customer didn't answer, or the sandbox was busy. Click *Check now* on the row |
| WhatsApp `failed: ... 131047` (Meta) | Outside the 24h window. Use a template |
| WhatsApp `failed: ... 63015/63016` (Twilio) | The recipient hasn't sent `join …` to the sandbox |
| `Cannot reach sandbox.safaricom.co.ke` | No internet on the PC, or a firewall/proxy is blocking it |
