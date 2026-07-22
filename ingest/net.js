/**
 * Zero-dep HTTPS helper that honors HTTPS_PROXY / NO_PROXY (CONNECT tunnel).
 *
 * Node's built-in fetch (undici) ignores proxy environment variables, which
 * strands the ingest tools in proxied environments (e.g. managed cloud
 * sessions). This speaks plain CONNECT + TLS; NODE_EXTRA_CA_CERTS is honored
 * automatically by Node's default trust store. Without a proxy configured it
 * is a straight https.request.
 *
 *   const { request } = require("./net");
 *   const { status, buffer } = await request(url, { method, headers, body, timeout });
 */

const http = require("http");
const https = require("https");
const tls = require("tls");

function proxyFor(url) {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!p) return null;
  const host = new URL(url).hostname;
  const skip = (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  for (const n of skip) {
    const pat = n.replace(/^\*?\./, "");
    if (host === n || host === pat || host.endsWith("." + pat)) return null;
  }
  return new URL(p);
}

function tunnel(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname, port: +proxy.port || 80,
      method: "CONNECT", path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
    });
    req.setTimeout(timeout, () => req.destroy(new Error("proxy CONNECT timeout")));
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`proxy CONNECT ${res.statusCode}`)); }
      else resolve(socket);
    });
    req.on("error", reject);
    req.end();
  });
}

async function request(url, opts = {}) {
  const u = new URL(url);
  const timeout = opts.timeout || 120000;
  const proxy = proxyFor(url);
  const socket = proxy ? await tunnel(proxy, u.hostname, +u.port || 443, timeout) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: u.hostname, port: +u.port || 443, path: u.pathname + u.search,
      method: opts.method || "GET", headers: opts.headers || {},
      ...(socket ? { createConnection: () => tls.connect({ socket, servername: u.hostname }) } : {}),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`request timeout after ${timeout} ms`)));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

module.exports = { request };
