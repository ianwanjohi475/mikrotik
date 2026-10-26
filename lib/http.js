// Minimal zero-dependency HTTP framework (routing, JSON bodies, cookies, static files).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.rsc': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function compile(p) {
  const keys = [];
  const re = new RegExp('^' + p.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  return { re, keys };
}

function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) reject(new HttpError(413, 'Body too large')); });
    req.on('end', () => {
      if (!data) return resolve({});
      const type = req.headers['content-type'] || '';
      try {
        if (type.includes('application/json')) return resolve(JSON.parse(data));
        if (type.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(data)));
        try { return resolve(JSON.parse(data)); } catch { return resolve({ raw: data }); }
      } catch (e) { reject(new HttpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function createApp({ publicDir, spaFallback = true } = {}) {
  const routes = [];
  const middleware = [];
  const app = { use: fn => middleware.push(fn) };
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    app[m] = (p, handler) => routes.push({ method: m.toUpperCase(), ...compile(p), handler });
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    req.path = decodeURIComponent(u.pathname);
    req.query = Object.fromEntries(u.searchParams);
    req.cookies = parseCookies(req.headers.cookie);
    res.json = (obj, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(obj));
    };
    res.send = (body, type = 'text/html; charset=utf-8', status = 200, headers = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(body);
    };
    res.redirect = loc => { res.writeHead(302, { Location: loc }); res.end(); };
    res.cookie = (name, value, opts = '') => {
      const prev = res.getHeader('Set-Cookie') || [];
      res.setHeader('Set-Cookie', [...prev, `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${opts}`]);
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, X-Token, Authorization',
      });
      return res.end();
    }

    try {
      const route = routes.find(r => r.method === req.method && r.re.test(req.path));
      if (route) {
        const m = req.path.match(route.re);
        req.params = {};
        route.keys.forEach((k, i) => { req.params[k] = m[i + 1]; });
        req.body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        for (const mw of middleware) {
          const stop = await mw(req, res);
          if (stop === false || res.writableEnded) return;
        }
        const out = await route.handler(req, res);
        if (!res.writableEnded && out !== undefined) res.json(out);
        return;
      }
      if (req.method === 'GET' && publicDir) return serveStatic(req, res);
      throw new HttpError(404, 'Not found: ' + req.path);
    } catch (e) {
      if (!e.status) console.error(e);
      if (!res.writableEnded) res.json({ error: e.message }, e.status || 500);
    }
  }

  function serveStatic(req, res) {
    let file = path.normalize(path.join(publicDir, req.path));
    if (!file.startsWith(publicDir)) throw new HttpError(403, 'Forbidden');
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      if (!spaFallback || req.path.startsWith('/api')) throw new HttpError(404, 'Not found');
      file = path.join(publicDir, 'index.html');
    }
    res.send(fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  }

  app.listen = (port, host, cb) => http.createServer(handle).listen(port, host, cb);
  return app;
}

module.exports = { createApp, HttpError };
