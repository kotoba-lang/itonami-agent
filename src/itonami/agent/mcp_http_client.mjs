import fs from "node:fs";
import path from "node:path";

const request = JSON.parse(fs.readFileSync(0, "utf8"));

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function tokenIsFresh(tokens, tokenPath) {
  let expiry = Number(tokens?.expires_at || 0);
  if (!expiry && Number(tokens?.expires_in) > 0) {
    try {
      expiry = fs.statSync(tokenPath).mtimeMs / 1000 + Number(tokens.expires_in);
    } catch {}
  }
  return Boolean(tokens?.access_token) && expiry > Date.now() / 1000 + 60;
}

function waitBriefly() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}

function acquireRefreshLock(lockPath, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          if (Number(fs.readFileSync(lockPath, "utf8")) === process.pid) fs.unlinkSync(lockPath);
        } catch {}
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = 0;
      try {
        owner = Number(fs.readFileSync(lockPath, "utf8"));
      } catch {}
      if (Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (probeError) {
          if (probeError?.code === "ESRCH") {
            try {
              if (Number(fs.readFileSync(lockPath, "utf8")) === owner) fs.unlinkSync(lockPath);
            } catch {}
          }
        }
      }
      waitBriefly();
    }
  }
  throw new Error("OAuth refresh lock timed out");
}

function assertSafeTokenEndpoint(endpoint) {
  const url = new URL(endpoint);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("OAuth token endpoint must use HTTPS");
  }
  return url.toString();
}

async function oauthHeaders() {
  if (request.auth !== "oauth") return {};
  const safeName = String(request.server || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "default";
  const tokenPath = path.join(request.home, "mcp-tokens", `${safeName}.json`);
  const clientPath = path.join(request.home, "mcp-tokens", `${safeName}.client.json`);
  const metaPath = path.join(request.home, "mcp-tokens", `${safeName}.meta.json`);
  let tokens = readJson(tokenPath);
  if (tokenIsFresh(tokens, tokenPath)) return { Authorization: `Bearer ${tokens.access_token}` };
  if (!tokens?.refresh_token) throw new Error("OAuth access token is expired and no refresh token is available");

  const unlock = acquireRefreshLock(`${tokenPath}.kotoba-refresh.lock`);
  try {
    tokens = readJson(tokenPath);
    if (tokenIsFresh(tokens, tokenPath)) return { Authorization: `Bearer ${tokens.access_token}` };
    if (!tokens?.refresh_token) throw new Error("OAuth refresh token is unavailable");
    const meta = readJson(metaPath);
    const client = readJson(clientPath);
    if (!meta?.issuer || !meta?.token_endpoint || !tokens.hermes_issuer || tokens.hermes_issuer !== meta.issuer) {
      throw new Error("OAuth issuer metadata does not match the cached refresh token");
    }
    const endpoint = assertSafeTokenEndpoint(meta.token_endpoint);
    const clientId = request.oauth?.client_id || client?.client_id;
    const clientSecret = request.oauth?.client_secret || client?.client_secret;
    if (!clientId) throw new Error("OAuth client registration is missing");

    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    let authMethod = client?.token_endpoint_auth_method || "none";
    if (clientSecret && ["", "none"].includes(authMethod)) authMethod = "client_secret_post";
    if (authMethod === "client_secret_post") {
      if (!clientSecret) throw new Error("OAuth client secret is missing");
      form.set("client_secret", clientSecret);
    }
    else if (authMethod === "client_secret_basic") {
      if (!clientSecret) throw new Error("OAuth client secret is missing");
      const encoded = (value) => new URLSearchParams({ value }).toString().slice(6);
      headers.authorization = `Basic ${Buffer.from(`${encoded(clientId)}:${encoded(clientSecret)}`).toString("base64")}`;
    } else if (authMethod !== "none") {
      throw new Error("OAuth token endpoint authentication method is unsupported");
    }

    const response = await fetch(endpoint, { method: "POST", headers, body: form, redirect: "manual" });
    if (!response.ok) throw new Error(`OAuth token refresh failed: HTTP ${response.status}`);
    const replacement = await response.json();
    if (typeof replacement.access_token !== "string" || !replacement.access_token || !(Number(replacement.expires_in) > 0)) {
      throw new Error("OAuth token refresh returned an invalid token response");
    }
    const saved = {
      ...tokens,
      ...replacement,
      refresh_token: replacement.refresh_token || tokens.refresh_token,
      scope: replacement.scope || tokens.scope,
      hermes_issuer: meta.issuer,
      expires_at: Date.now() / 1000 + Number(replacement.expires_in),
    };
    const temp = `${tokenPath}.kotoba-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temp, JSON.stringify(saved), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temp, tokenPath);
      fs.chmodSync(tokenPath, 0o600);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
    return { Authorization: `${saved.token_type || "Bearer"} ${saved.access_token}` };
  } finally {
    unlock();
  }
}

async function post(url, headers, session, body) {
  const outgoing = {
    ...headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (session.id) outgoing["mcp-session-id"] = session.id;
  const response = await fetch(url, { method: "POST", headers: outgoing, body: JSON.stringify(body) });
  session.id ||= response.headers.get("mcp-session-id");
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!text.trim()) return null;
  if ((response.headers.get("content-type") || "").includes("text/event-stream")) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
    const rows = data.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    return body.id === undefined ? (rows.at(-1) || null) : (rows.find((row) => row.id === body.id) || null);
  }
  return JSON.parse(text);
}

async function main() {
  const headers = { ...(request.headers || {}), ...(await oauthHeaders()) };
  const session = { id: null };
  const initialized = await post(request.url, headers, session, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "itonami-agent", version: "0.1" } },
  });
  if (initialized?.error) throw new Error("MCP initialization failed");
  await post(request.url, headers, session, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const response = await post(request.url, headers, session, {
    jsonrpc: "2.0", id: 2, method: request.method, params: request.params,
  });
  if (response?.error) throw new Error("MCP request failed");
  process.stdout.write(JSON.stringify(response?.result || {}));
}

main().catch((error) => {
  const safe = String(error?.message || "MCP HTTP request failed");
  process.stderr.write(safe);
  process.exit(1);
});
