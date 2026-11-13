// Lo que la tarjeta lee de las llamadas del rutador y cómo acabó cada propuesta, sin React para que lo prueben los tests.
// Los finales los ve el transformer —el `dismiss_task` que retira una propuesta, el `start_session` con su proposal_id que
// la empieza— y la tarjeta no, porque esas filas no la pintan; se encuentran aquí y la tarjeta pasa a «Retirada» o
// «Empezada» en cuanto llega la llamada. Lo que el transformer no llegó a ver (filas sin montar, un reinicio del daemon) lo
// trae la propia tarjeta con el RPC `estado`, que lee el registro del servidor.
import { TOOL_PREFIX } from "../shared/contract.ts";

export type Final = "started" | "dismissed";
export type ToolCallLike = { name: string; status: string; detail: unknown };

/** The text of an MCP tool result as Paseo hands it over: a string, `{ output: "…" }` (what the Claude provider sends,
 * measured), a content array, or `{ content: [...] }`. */
export function textOf(output: unknown): string {
  if (typeof output === "string") return output;
  if (typeof (output as { output?: unknown })?.output === "string") return (output as { output: string }).output;
  const parts = Array.isArray(output) ? output : Array.isArray((output as { content?: unknown })?.content) ? (output as { content: unknown[] }).content : [];
  const text = parts.map((p) => (typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : "")).join("");
  return text || (output == null ? "" : JSON.stringify(output));
}

export const str = (v: unknown) => (typeof v === "string" ? v : "");

function partes(item: ToolCallLike): { input: Record<string, unknown>; output: string } {
  const detail = (item.detail ?? {}) as { input?: unknown; output?: unknown };
  return { input: (detail.input ?? {}) as Record<string, unknown>, output: textOf(detail.output) };
}

/** Cómo un tool call termina una propuesta: un `dismiss_task` que la retiró, o un `start_session` con su proposal_id que la empezó. */
export function finalDe(item: ToolCallLike): { taskId: string; final: Final } | null {
  const { input, output } = partes(item);
  if (item.name === `${TOOL_PREFIX}dismiss_task`) {
    const taskId = str(input.task_id);
    return taskId && /^Withdrew the proposal/.test(output) ? { taskId, final: "dismissed" } : null;
  }
  if (item.name === `${TOOL_PREFIX}start_session`) {
    const proposalId = str(input.proposal_id);
    return proposalId && /^Started the proposal/.test(output) ? { taskId: proposalId, final: "started" } : null;
  }
  return null;
}

// ---- cómo acabó cada propuesta: lo escriben el transformer y el clic en «Empezar», lo lee la tarjeta

const finales = new Map<string, Final>(); // taskId → cómo acabó
const oidores = new Set<() => void>();

export function suscribirFinales(listener: () => void): () => void {
  oidores.add(listener);
  return () => void oidores.delete(listener);
}

export function estadoFinal(taskId: string): Final | undefined {
  return finales.get(taskId);
}

export function marcarFinal(taskId: string, final: Final): void {
  if (finales.get(taskId) === final) return;
  finales.set(taskId, final);
  queueMicrotask(() => oidores.forEach((l) => l())); // los transformers corren mientras el timeline pinta: no hay setState ahí
}
