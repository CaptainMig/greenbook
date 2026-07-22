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

/* keep-alive agents, one per destination host: sockets (and their CONNECT
 * tunnels) are pooled and reused. Without pooling, bulk range-read runs open
 * a fresh tunnel per request and proxies drop the churn with ECONNRESET. */
const agents = new Map();
function agentFor(u, proxy) {
  const key = (proxy ? proxy.host + "→" : "") + u.hostname;
  if (agents.has(key)) return agents.get(key);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 6, maxFreeSockets: 6, timeout: 60000 });
  if (proxy) {
    agent.createConnection = (opts, cb) => {
      tunnel(proxy, u.hostname, +u.port || 443, 30000)
        .then((socket) => {
          const ts = tls.connect({ socket, servername: u.hostname });
          /* idle pooled sockets the proxy closes must not crash the process;
             in-flight requests still see errors via the http client itself */
          ts.on("error", () => {});
          cb(null, ts);
        })
        .catch(cb);
    };
  }
  agents.set(key, agent);
  return agent;
}

function requestOnce(url, opts) {
  const u = new URL(url);
  const timeout = opts.timeout || 120000;
  const proxy = proxyFor(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: u.hostname, port: +u.port || 443, path: u.pathname + u.search,
      method: opts.method || "GET", headers: opts.headers || {},
      agent: agentFor(u, proxy),
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

/* transient network errors (connection reuse races, proxy resets) retry with
 * backoff; HTTP statuses are returned as-is — callers judge those. */
const TRANSIENT = /ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket disconnected|socket hang up|timeout/i;
async function request(url, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await requestOnce(url, opts);
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1) ** 2));
    }
  }
  throw lastErr;
}

module.exports = { request };
