// LOCAL TESTING ONLY. A stand-in for Clerk's token issuer, so authenticated
// Convex functions can be tested against a local backend without creating real
// Clerk users. It signs RS256 JWTs shaped like Clerk session tokens (aud
// "convex") with a key pair generated at startup, and serves the OIDC discovery
// and JWKS documents Convex fetches to verify them.
//
// Point only a LOCAL Convex deployment at it:
//   node scripts/local-auth-issuer.mjs            # listens on 127.0.0.1:8790
//   npx convex env set CLERK_FRONTEND_API_URL http://127.0.0.1:8790   # local deployment only
// Never set a shared or cloud deployment's CLERK_FRONTEND_API_URL to this.
//
// GET /mint?sub=user_x&email=a@b.test&ttl=60  ->  { token }   (tests only)
import { createServer } from "node:http";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function startIssuer({ port = 8790, host = "127.0.0.1" } = {}) {
  const issuer = `http://${host}:${port}`;
  const kid = "local-" + randomUUID().slice(0, 8);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };

  // Claims like a Clerk session token with the Convex integration enabled.
  function mint({ sub, email, ttl = 300, aud = "convex", iss = issuer, expired = false }) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", kid };
    const claims = {
      iss, sub, aud, azp: "http://127.0.0.1", sid: "sess_" + randomUUID().slice(0, 12),
      iat: expired ? now - 600 : now, nbf: expired ? now - 600 : now - 5, exp: expired ? now - 300 : now + ttl,
      ...(email ? { email } : {}),
    };
    const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const sig = createSign("RSA-SHA256").update(body).sign(privateKey);
    return `${body}.${b64url(sig)}`;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, issuer);
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return send(200, {
        issuer, jwks_uri: `${issuer}/.well-known/jwks.json`,
        authorization_endpoint: `${issuer}/authorize`, response_types_supported: ["code"],
        subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.pathname === "/.well-known/jwks.json") return send(200, { keys: [jwk] });
    if (url.pathname === "/mint") {
      const sub = url.searchParams.get("sub");
      if (!sub) return send(400, { error: "sub required" });
      return send(200, {
        token: mint({
          sub, email: url.searchParams.get("email") || undefined,
          ttl: Number(url.searchParams.get("ttl") || 300),
          aud: url.searchParams.get("aud") || "convex",
          expired: url.searchParams.get("expired") === "1",
        }),
      });
    }
    send(404, { error: "not found" });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ issuer, mint, close: () => server.close() })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8790);
  const { issuer } = await startIssuer({ port });
  console.log(`Local test issuer (NOT Clerk) at ${issuer}`);
}
