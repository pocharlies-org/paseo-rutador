// Lo pendiente por agente para la píldora del composer: propuestas esperando un clic y ofertas esperando respuesta.
// La fuente es el timeline y `estado`: al abrir el cliente se rehidrata con la API tipada (timeline.refetch + RPC estado) —
// el transformer solo no basta: no corre si la fila no está montada. Después mantienen el registro las tarjetas montadas y
// el fin de cada turno. El historial es el registro de las propuestas anteriores a un reinicio del daemon: `estado` conoce
// los finales (registro) y lo que está en memoria, las pendientes salen del timeline y son arrancables porque el servidor
// consulta el registro antes de crear la sesión (no se duplican las acciones).
import { TOOL_PREFIX } from "../shared/contract.ts";

export type Final = "started" | "dismissed";
export type Pendiente = { taskId: string; title: string; prompt: string; kind: "oferta" | "propuesta" };
export type ToolCallLike = { name: string; status: string; detail: unknown };

/** La clave de una oferta: su task_id no se conoce hasta que se responde, y por agente solo puede haber una abierta. */
export const OFERTA = "oferta";

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

/** La propuesta pendiente o la oferta abierta que muestra la fila de un `start_session`; null si no es ninguna de las dos. */
export function pendienteDe(item: ToolCallLike): Pendiente | null {
  if (item.name !== `${TOOL_PREFIX}start_session`) return null;
  const { input, output } = partes(item);
  if (str(input.proposal_id)) return null; // el brief de una oferta contestada: no es una tarjeta nueva
  if (input.initiation === "own_initiative" && item.status === "completed" && /^Proposed /.test(output)) {
    const taskId = /task_id: (task_[a-z0-9]+)/.exec(output)?.[1];
    if (!taskId) return null;
    return { taskId, title: str(input.title), prompt: str(input.prompt), kind: "propuesta" };
  }
  if (input.initiation === "offer" && item.status === "running") {
    return { taskId: "", title: str(input.title), prompt: "", kind: "oferta" };
  }
  return null;
}

export type Escaneo = {
  pendientes: Pendiente[];
  finales: { taskId: string; final: Final }[];
  /** Claves de propuesta cuyas filas vio el escaneo: solo de ésas puede borrar; lo registrado en vivo fuera del rango se queda. */
  conocidas: Set<string>;
  asking: boolean;
  vioRutador: boolean;
};

/** De las llamadas a herramientas de un timeline (de las viejas a las nuevas) y de `estado`: qué está pendiente y cómo acabó
 * cada propuesta. Una propuesta está pendiente salvo que el historial o el servidor diga que empezó o se retiró; una oferta
 * solo mientras el servidor espera la respuesta (`asking`): tras un reinicio la píldora no la lleva, y la contesta la
 * tarjeta del timeline, que le manda la elección al agente como mensaje. */
export function pendientesDesdeTimeline(items: ToolCallLike[], states: Record<string, string>): Escaneo {
  const finales = new Map<string, Final>();
  const propuestas = new Map<string, Pendiente>();
  const conocidas = new Set<string>();
  let oferta: Pendiente | null = null;
  let vioRutador = false;
  for (const item of items) {
    if (!item.name.startsWith(TOOL_PREFIX)) continue;
    vioRutador = true;
    const f = finalDe(item);
    if (f) {
      finales.set(f.taskId, f.final);
      conocidas.add(f.taskId);
    }
    const p = pendienteDe(item);
    if (!p) continue;
    if (p.kind === "oferta") oferta = p; // la última fila de oferta manda: las anteriores ya se contestaron
    else {
      propuestas.set(p.taskId, p);
      conocidas.add(p.taskId);
    }
  }
  for (const [taskId, state] of Object.entries(states)) {
    if (state === "started" || state === "dismissed") finales.set(taskId, state);
  }
  const asking = Object.values(states).includes("asking");
  const pendientes: Pendiente[] = [];
  for (const [taskId, p] of propuestas) {
    const final = finales.get(taskId) ?? states[taskId];
    if (final === "started" || final === "dismissed") continue;
    pendientes.push(p);
  }
  if (asking && oferta) pendientes.unshift(oferta);
  return { pendientes, finales: [...finales].map(([taskId, final]) => ({ taskId, final })), conocidas, asking, vioRutador };
}

// ---- el registro en vivo: lo que ve la píldora

const pendientes = new Map<string, Map<string, Pendiente>>(); // agentId → clave → pendiente
const instantaneas = new Map<string, Pendiente[]>(); // el array estable que devuelve useSyncExternalStore
const finales = new Map<string, Final>(); // taskId → cómo acabó: tarjeta y píldora lo leen de aquí
const oidores = new Set<() => void>();
const conRutador = new Set<string>(); // agentes que han usado el rutador: sólo ésos se rehidratan al acabar un turno

const NINGUNO: Pendiente[] = [];

// Un cambio en vivo (clic, tarjeta montada, final) sube la versión: una rehidratación que empezó antes no debe reconciliar
// sobre datos viejos lo que el usuario acaba de tocar. Los finales sí se aplican siempre: son monotónicos.
let version = 0;
export const versionVivo = () => version;

function notificar(): void {
  version++;
  queueMicrotask(() => oidores.forEach((l) => l())); // los transformers corren mientras el timeline pinta: no hay setState ahí
}

export function suscribirPendientes(listener: () => void): () => void {
  oidores.add(listener);
  return () => void oidores.delete(listener);
}

/** Estable mientras nada cambia: snapshot de `useSyncExternalStore`. */
export function pendientesDe(agentId: string): Pendiente[] {
  return instantaneas.get(agentId) ?? NINGUNO;
}

export function estadoFinal(taskId: string): Final | undefined {
  return finales.get(taskId);
}

export function tieneRutador(agentId: string): boolean {
  return conRutador.has(agentId);
}

export function notarRutador(agentId: string): void {
  conRutador.add(agentId);
}

function cambiar(agentId: string, clave: string, p: Pendiente | null): void {
  const m = pendientes.get(agentId);
  const had = m?.get(clave);
  if (!p) {
    if (!m || !had) return;
    m.delete(clave);
  } else if (had && had.title === p.title && had.prompt === p.prompt && had.kind === p.kind) return;
  else {
    const destino = m ?? new Map<string, Pendiente>();
    destino.set(clave, p);
    pendientes.set(agentId, destino);
  }
  const actual = pendientes.get(agentId);
  if (actual?.size) instantaneas.set(agentId, [...actual.values()]);
  else {
    instantaneas.delete(agentId);
    if (actual) pendientes.delete(agentId);
  }
  notificar();
}

/** Alta de una tarjeta montada o de una oferta recién abierta. Una propuesta ya terminada no vuelve a registrarse. */
export function ponerPendiente(agentId: string, p: Pendiente): void {
  conRutador.add(agentId);
  if (p.taskId && finales.get(p.taskId)) return;
  cambiar(agentId, p.taskId || OFERTA, p);
}

export function quitarPendiente(agentId: string, taskId: string): void {
  cambiar(agentId, taskId || OFERTA, null);
}

/** Cómo acabó una propuesta (la ve la tarjeta por `suscribirPendientes`); la píldora la retira al momento. */
export function marcarFinal(taskId: string, final: Final): void {
  if (finales.get(taskId) === final) return;
  finales.set(taskId, final);
  for (const [agentId, m] of [...pendientes]) if (m.delete(taskId)) {
    if (m.size) instantaneas.set(agentId, [...m.values()]);
    else {
      instantaneas.delete(agentId);
      pendientes.delete(agentId);
    }
  }
  notificar();
}

/** Rehidratación: fija o retira lo que el escaneo conoce; lo registrado en vivo fuera del rango escaneado no se toca.
 * La oferta la manda `estado`: sin un `asking` del servidor no hay nada que contestar. */
export function reconciliar(agentId: string, scan: Escaneo): void {
  if (scan.vioRutador) conRutador.add(agentId);
  const keep = new Map(scan.pendientes.map((p) => [p.taskId || OFERTA, p]));
  const m = pendientes.get(agentId);
  if (m) for (const clave of [...m.keys()]) if (scan.conocidas.has(clave) && !keep.has(clave)) cambiar(agentId, clave, null);
  if (!scan.asking) cambiar(agentId, OFERTA, null);
  for (const [clave, p] of keep) cambiar(agentId, clave, p);
}
