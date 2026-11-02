// The one resident call that answers "is this a task?". It goes to LiteLLM — the same route the Paseo daemon itself uses for the
// `claude` provider (base + token read from the daemon's own config, which this plugin shares: same host, same user). The local
// router-front alias paseo-sugiere uses (127.0.0.1:18791) is not up on paseo-0, so it is not used here. No base/token → no call →
// task:false (no pill), never an error.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 15_000; // a sí/no is a tiny decode; a slow route means "no pill", not a wait
const MAX_BYTES = 64 * 1024;

function route(): { base: string; token: string } | null {
  let base = process.env.ANTHROPIC_BASE_URL;
  let token = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!base || !token) {
    try {
      const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
      const env = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))?.agents?.providers?.claude?.env;
      base ??= env?.ANTHROPIC_BASE_URL;
      token ??= env?.ANTHROPIC_AUTH_TOKEN;
    } catch {}
  }
  return base && token ? { base, token } : null;
}

export async function residentRequest(body: string): Promise<{ status: number; text: string }> {
  const r = route();
  if (!r) return { status: 0, text: "" };
  const controller = new AbortController(); // AbortSignal.timeout is not in react-native's globals, which the client's types pull in
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${r.base.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: `Bearer ${r.token}` },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text: text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text };
  } finally {
    clearTimeout(timer);
  }
}
