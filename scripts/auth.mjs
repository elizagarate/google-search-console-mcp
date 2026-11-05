#!/usr/bin/env node
// Genera credenciales de usuario (authorized_user) SOLO con el scope webmasters.readonly.
// Alternativa a `gcloud auth application-default login`, que exige cloud-platform y
// sobrescribe el ADC por defecto (lo usa analytics-mcp).
//
// Uso:
//   node scripts/auth.mjs --client <archivo> --out <archivo> [--quota-project <id>]
//
// --client acepta un authorized_user existente (se reutilizan client_id y client_secret)
// o el JSON de un cliente OAuth de Google Cloud ("installed" o "web").

import { google } from "googleapis";
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!["client", "out", "quota-project"].includes(key) || argv[i + 1] === undefined) {
      throw new Error(`Argumento no válido: ${argv[i]}`);
    }
    out[key] = argv[i + 1];
  }
  if (!out.client || !out.out) throw new Error("Faltan --client y/o --out");
  return out;
}

// Extrae client_id y client_secret de cualquiera de los formatos admitidos.
async function loadClient(path) {
  const json = JSON.parse(await readFile(path, "utf8"));
  const src = json.installed || json.web || json;
  if (!src.client_id || !src.client_secret) {
    throw new Error("El archivo no contiene client_id y client_secret");
  }
  return { clientId: src.client_id, clientSecret: src.client_secret };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { clientId, clientSecret } = await loadClient(resolve(args.client));
  const outPath = resolve(args.out);

  // PKCE + state contra interceptación y CSRF
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  // Servidor de retorno solo en loopback y puerto efímero
  const server = http.createServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const url = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [SCOPE],
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  const code = await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("Tiempo agotado (5 min)")), 300_000);
    server.on("request", (req, res) => {
      const params = new URL(req.url, redirectUri).searchParams;
      if (!params.has("code") && !params.has("error")) {
        res.writeHead(404).end();
        return;
      }
      const okState = params.get("state") === state;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(okState && params.get("code")
        ? "Autorizado. Puedes cerrar esta pestaña."
        : "Error en la autorización. Revisa la terminal.");
      clearTimeout(timer);
      if (!okState) fail(new Error("state no coincide"));
      else if (params.get("error")) fail(new Error(`Google devolvió: ${params.get("error")}`));
      else ok(params.get("code"));
    });
    console.log(`Abre esta URL si el navegador no se abre solo:\n\n${url}\n`);
    execFile("open", [url], () => {});
  }).finally(() => server.close());

  const { tokens } = await oauth.getToken({ code, codeVerifier: verifier, redirect_uri: redirectUri });

  // Verifica que Google solo concedió el scope pedido
  const granted = (tokens.scope || "").split(" ").filter(Boolean);
  if (granted.length !== 1 || granted[0] !== SCOPE) {
    throw new Error(`Scopes inesperados: ${granted.join(", ") || "(ninguno)"}`);
  }
  if (!tokens.refresh_token) throw new Error("Google no devolvió refresh_token");

  const creds = {
    type: "authorized_user",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    ...(args["quota-project"] ? { quota_project_id: args["quota-project"] } : {}),
  };
  await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
  await writeFile(outPath, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  console.log(`Credenciales guardadas en ${outPath} (scope: ${SCOPE})`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
