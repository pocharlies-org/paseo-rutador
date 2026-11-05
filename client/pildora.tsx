// La píldora del composer: lo que el timeline dejó pendiente (propuestas sin empezar, ofertas sin responder) accesible
// abajo del chat. Se rehidrata al abrir el cliente con la API tipada —agents.list suscrito, timeline.refetch y el RPC
// estado—, no como side effect del transformer: si las filas no están montadas, el transformer no corre. El roster que
// llega por suscripción es autoritativo (los agentes que faltan pierden su píldora), y una rehidratación vieja no reconcilia
// sobre un cambio en vivo (versión en pendientes.ts); los finales, que son monotónicos, siempre se aplican.
import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import { useEffect, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { CARD_KIND, estado, TOOL_PREFIX, type CardData } from "../shared/contract.ts";
import { makeCard } from "./tarjeta.tsx";
import { marcarFinal, notarRutador, pendientesDe, pendientesDesdeTimeline, reconciliar, suscribirPendientes, tieneRutador, versionVivo, type Pendiente, type ToolCallLike } from "./pendientes.ts"; // notarRutador y tieneRutador: el rastro de quién usa el rutador

const LIMITE = 200;
const MAX_PAGINAS = 5; // rango que recorre la rehidratación: un pendiente más viejo sigue en su tarjeta del chat, no en la píldora

export function addComposerPills(client: PluginClientContext): () => void {
  const Card = makeCard(client);
  const pills = new Map<string, PluginButtonRegistration<string>>();
  const workspaceDe = new Map<string, string>();
  const enCurso = new Map<string, Promise<void>>();
  const repetir = new Set<string>();
  const timelines = new Map<string, () => void>();
  const roster = new Map<string, { agent: { id: string; provider: string; workspaceId?: string; internal?: boolean; archivedAt?: string | null } }>();
  let vivo = true;
  let soltarRoster: () => void = () => {};

  /** Timeline + `estado`, de la API tipada: qué quedó pendiente para este agente. Una pasada por agente a la vez. */
  function rehidratar(agentId: string): Promise<void> {
    let p = enCurso.get(agentId);
    if (p) repetir.add(agentId);
    if (!p) {
      p = (async () => {
        try {
          const version = versionVivo();
          const estados = await client.rpc(estado, { agentId }).then((r) => r.tasks, () => ({}) as Record<string, string>);
          const paginas: { entries: { item: { type: string; name?: string; status?: string; detail?: unknown } }[]; hasOlder: boolean; startCursor?: { epoch: string; seq: number } | null }[] = [];
          let cursor: { epoch: string; seq: number } | undefined;
          for (let i = 0; i < MAX_PAGINAS; i++) {
            const page = await client.paseo.agents.ref(agentId).timeline.refetch(cursor ? { direction: "before", cursor, limit: LIMITE } : { limit: LIMITE });
            paginas.push(page);
            cursor = page.startCursor ?? cursor;
            if (!page.hasOlder || !page.startCursor) break;
          }
          const items: ToolCallLike[] = [];
          for (const page of paginas.reverse()) for (const e of page.entries) {
            const it = e.item;
            if (it.type === "tool_call" && typeof it.name === "string" && it.name.startsWith(TOOL_PREFIX)) items.push({ name: it.name, status: String(it.status ?? ""), detail: it.detail });
          }
          if (!vivo || !pills.has(agentId)) return;
          const scan = pendientesDesdeTimeline(items, estados);
          const actual = versionVivo() === version;
          if (scan.vioRutador) notarRutador(agentId);
          for (const f of scan.finales) marcarFinal(f.taskId, f.final); // monotónicos: siempre
          if (actual) reconciliar(agentId, scan);
          else repetir.add(agentId); // retry after concurrent changes rather than leave a newly discovered proposal hidden
        } catch {
          /* an agent whose timeline or estado cannot be read: nothing is claimed pending */
        } finally {
          enCurso.delete(agentId);
          if (repetir.delete(agentId) && vivo && pills.has(agentId)) void rehidratar(agentId);
        }
      })();
      enCurso.set(agentId, p);
    }
    return p;
  }

  function Contenido(props: PluginButtonContentProps) {
    if (props.context !== "agent") return null; // the pill is contributed per agent: the popover always arrives with its agentId
    const { agentId } = props;
    return <Lista theme={props.theme} host={props.host} layout={props.layout} agentId={agentId} />;
  }

  function Lista({ agentId, theme, host, layout }: PluginHostProps & { agentId: string }) {
    const items = useSyncExternalStore(suscribirPendientes, () => pendientesDe(agentId));
    useEffect(() => {
      void rehidratar(agentId); // abrir la píldora trae lo último, también si el agente no se rehidrató aún
    }, [agentId]);
    const c = theme.colors;
    const dataDe = (p: Pendiente): CardData =>
      p.kind === "oferta"
        ? { status: "running", initiation: "offer", title: p.title, prompt: "", taskId: null, result: "" }
        : { status: "completed", initiation: "own_initiative", title: p.title, prompt: p.prompt, taskId: p.taskId, result: "" };
    return (
      <View style={{ padding: 10, minWidth: 280, maxWidth: 380 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Sesiones nuevas pendientes</Text>
        {items.length === 0 ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 6 }}>Nada pendiente.</Text>
        ) : (
          <ScrollView style={{ maxHeight: 340, marginTop: 2 }}>
            {items.map((p) => (
              <Card key={p.taskId || "oferta"} agentId={agentId} item={{ type: "plugin", kind: CARD_KIND, version: 1, data: dataDe(p) }} timestamp={new Date()} theme={theme} host={host} layout={layout} />
            ))}
          </ScrollView>
        )}
      </View>
    );
  }

  function asegurarPill(agentId: string, workspaceId: string): void {
    const existente = pills.get(agentId);
    if (existente) {
      if (workspaceDe.get(agentId) === workspaceId) return;
      existente.remove(); // the pill is contributed against one workspace: a moved agent gets a new one
      pills.delete(agentId);
    }
    workspaceDe.set(agentId, workspaceId);
    const n = pendientesDe(agentId).length;
    pills.set(
      agentId,
      client.addComposerPill({
        id: "rutador-pendientes",
        workspaceId,
        agentId,
        button: {
          title: "Sesiones nuevas pendientes",
          icon: "inbox",
          label: n === 1 ? "1 pendiente" : `${n} pendientes`,
          visible: n > 0,
          behavior: { kind: "popover", Content: Contenido },
        },
      }),
    );
    if (!timelines.has(agentId)) {
      const sub = client.paseo.agents.ref(agentId).timeline.subscribe(({ event }) => {
        if (!vivo || !pills.has(agentId)) return;
        if (event.type === "replacement" || event.type === "subscription_restored" ||
          (event.type === "timeline" && event.item.type === "tool_call" && event.item.name.startsWith(TOOL_PREFIX))) {
          void rehidratar(agentId);
        }
      });
      sub.ready.catch(() => {});
      timelines.set(agentId, () => { void sub.release().catch(() => {}); });
    }
    void rehidratar(agentId);
  }

  /** The roster from the subscription is authoritative: agents that are not in it lose their pill. */
  function aplicarRoster(entries: readonly { agent: { id: string; provider: string; workspaceId?: string; internal?: boolean; archivedAt?: string | null } }[]): void {
    if (!vivo) return;
    const vistos = new Set<string>();
    for (const e of entries) {
      const a = e.agent;
      if (a.internal || a.archivedAt || a.provider !== "claude" || !a.workspaceId) continue;
      vistos.add(a.id);
      asegurarPill(a.id, a.workspaceId);
    }
    for (const agentId of [...pills.keys()]) {
      if (vistos.has(agentId)) continue;
      pills.get(agentId)!.remove();
      pills.delete(agentId);
      workspaceDe.delete(agentId);
      timelines.get(agentId)?.();
      timelines.delete(agentId);
      repetir.delete(agentId);
    }
  }

  function refrescarPills(): void {
    for (const [agentId, reg] of pills) {
      const n = pendientesDe(agentId).length;
      reg.update({ visible: n > 0, label: n === 1 ? "1 pendiente" : `${n} pendientes` });
    }
  }

  const offPendientes = suscribirPendientes(refrescarPills);
  // When a session that uses rutador ends its turn, refresh its pill: a proposal made while the user was elsewhere lights it up.
  const offAgentes = client.paseo.agents.subscribe((update) => {
    if (update.kind !== "upsert" || update.agent.status !== "idle" || !pills.has(update.agent.id)) return;
    if (tieneRutador(update.agent.id)) void rehidratar(update.agent.id);
  });
  void client
    .paseo.agents.list({ subscribe: {} })
    .then((l) => {
      if (!vivo) {
        void l.subscription.release().catch(() => {});
        return;
      }
      const snapshot = (entries: typeof l.entries) => {
        roster.clear();
        for (const entry of entries) roster.set(entry.agent.id, entry);
        aplicarRoster([...roster.values()]);
      };
      snapshot(l.entries);
      const off = l.subscription.subscribe({
        snapshot: (s) => snapshot(s.entries),
        update: (m) => {
          if (m.type !== "agent_update") return;
          if (m.payload.kind === "remove") roster.delete(m.payload.agentId);
          else roster.set(m.payload.agent.id, { agent: m.payload.agent });
          aplicarRoster([...roster.values()]);
        },
      });
      soltarRoster = () => {
        off();
        void l.subscription.release().catch(() => {});
      };
    })
    .catch(() => {}); // no roster: the pill never appears; the cards keep working

  return () => {
    vivo = false;
    offPendientes();
    offAgentes();
    soltarRoster();
    for (const reg of pills.values()) reg.remove();
    pills.clear();
    workspaceDe.clear();
    for (const release of timelines.values()) release();
    timelines.clear();
    repetir.clear();
    roster.clear();
    enCurso.clear();
  };
}
