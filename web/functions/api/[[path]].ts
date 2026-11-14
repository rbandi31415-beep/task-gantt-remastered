// Cloudflare Pages Function: the only thing that talks to GitHub.
// The browser never sees the GitHub token; every request must carry a valid Cloudflare Access
// login whose email is on the allow-list, and only safe task paths in one repo can be touched.
import { GitHubRepo, Http, GitHubError, safeRel } from "../../../src/share/core";

export interface Env {
  GITHUB_TOKEN: string; // fine-grained token: Contents read/write on REPO only (secret)
  REPO: string; // "owner/name"
  BRANCH?: string;
  ACCESS_TEAM_DOMAIN: string; // e.g. "yourteam.cloudflareaccess.com"
  ACCESS_AUD: string; // the Access application's audience tag
  ALLOWED_EMAILS: string; // comma-separated (secret)
}

type Ctx = { request: Request; env: Env };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// ── Cloudflare Access JWT verification (RS256 against the team's published keys) ──
const b64urlBytes = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
let certCache: { at: number; keys: JsonWebKey[] } | null = null;
export async function verifyAccessJwt(
  token: string,
  env: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">,
  fetchKeys: () => Promise<JsonWebKey[]> = async () => {
    if (certCache && Date.now() - certCache.at < 10 * 60_000) return certCache.keys;
    const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    const keys = ((await res.json()) as { keys: JsonWebKey[] }).keys;
    certCache = { at: Date.now(), keys };
    return keys;
  },
  nowSec = () => Math.floor(Date.now() / 1000)
): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { kid?: string; alg?: string };
  let payload: { aud?: string | string[]; exp?: number; nbf?: number; email?: string; iss?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const jwk = (await fetchKeys()).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlBytes(parts[2]) as BufferSource,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss && payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  const now = nowSec();
  if (!payload.exp || payload.exp < now) return null;
  if (payload.nbf && payload.nbf > now + 60) return null;
  return payload.email?.toLowerCase() ?? null;
}

// Who is calling? null = not allowed. Fails closed if Access isn't configured.
export async function caller(request: Request, env: Env, verify = verifyAccessJwt): Promise<string | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ALLOWED_EMAILS) return null;
  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    request.headers.get("Cookie")?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1] ??
    "";
  if (!token) return null;
  const email = await verify(token, env);
  if (!email) return null;
  const allowed = env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(email) ? email : null;
}

export const fetchHttp: Http = async (method, url, token, body) => {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dermaglow-gantt",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, json: data };
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function handle(request: Request, env: Env, http: Http = fetchHttp, who = caller): Promise<Response> {
  const email = await who(request, env);
  if (!email) return json({ error: "Not signed in, or this email isn't allowed." }, 403);
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, "");
  const [owner, name] = (env.REPO ?? "").split("/");
  const repo = new GitHubRepo(http, { owner, repo: name, branch: env.BRANCH || "main", token: env.GITHUB_TOKEN });

  try {
    if (route === "me" && request.method === "GET") return json({ email });

    if (route === "tasks" && request.method === "GET") {
      const head = await repo.head();
      if (!head) return json({ files: [] });
      const files = await repo.files(head.tree);
      const out = await Promise.all(
        [...files].map(async ([rel, sha]) => ({ rel, sha, text: dec.decode(await repo.blob(sha)) }))
      );
      return json({ files: out });
    }

    if (route === "tasks" && (request.method === "PUT" || request.method === "DELETE")) {
      const rel = url.searchParams.get("rel") ?? "";
      if (!safeRel(rel)) return json({ error: "Not a task path" }, 400);
      if (request.method === "PUT") {
        const body = (await request.json()) as { text?: unknown; sha?: unknown };
        if (typeof body.text !== "string" || body.text.length > 200_000) return json({ error: "Bad note text" }, 400);
        const sha = await repo.putFile(
          rel,
          enc.encode(body.text),
          typeof body.sha === "string" ? body.sha : undefined,
          `Web edit by ${email}: ${rel}`
        );
        return json({ sha });
      }
      const sha = url.searchParams.get("sha") ?? "";
      if (!sha) return json({ error: "Missing sha" }, 400);
      await repo.deleteFile(rel, sha, `Web delete by ${email}: ${rel}`);
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 409 || e.status === 422))
      return json({ error: "Someone changed this task since you loaded it. Reload and try again.", conflict: true }, 409);
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

export const onRequest = (ctx: Ctx): Promise<Response> => handle(ctx.request, ctx.env);
