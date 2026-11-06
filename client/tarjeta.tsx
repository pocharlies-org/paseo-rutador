import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { type ComponentType, useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { CARD_KIND, cardSchema, empezar, estado, modelos, responder, TOOL_PREFIX, type CardData } from "../shared/contract.ts";
import { estadoFinal, finalDe, marcarFinal, ponerPendiente, quitarPendiente, str, suscribirPendientes, textOf, type ToolCallLike } from "./pendientes.ts";

// The tool calls become cards in the conversation, like Claude Desktop's: an offer asks «Nueva sesión» / «Hazlo aquí» while
// the agent waits; an own-initiative proposal is a «Nueva tarea» card the user starts with a click; a session started on the
// user's word is one line. dismiss_task leaves no row (its card says «Retirada»).
//
// makeCard is shared with the composer pill (client/pildora.tsx), which draws the same Card for what the timeline left
// pending; how each card ended lives in client/pendientes.ts, so a card and the pill always show the same state.

function cardFrom(item: ToolCallLike & { name: string; status: string }): CardData | null {
  const detail = (item.detail ?? {}) as { type?: string; input?: unknown; output?: unknown };
  const input = (detail.input ?? {}) as Record<string, unknown>;
  const output = textOf(detail.output);
  const proposalId = str(input.proposal_id);
  const initiation = proposalId ? "brief" : input.initiation;
  if (initiation !== "offer" && initiation !== "user_asked" && initiation !== "own_initiative" && initiation !== "brief") return null;
  const status = item.status as CardData["status"];
  return {
    status: ["running", "completed", "failed", "canceled"].includes(status) ? status : "running",
    initiation,
    title: str(input.title),
    prompt: str(input.prompt),
    taskId: proposalId || (/task_id: (task_[a-z0-9]+)/.exec(output)?.[1] ?? null),
    result: output,
  };
}

function outcome(d: CardData): string {
  const r = d.result;
  if (d.initiation === "offer" && /^\[Tool call interrupted/.test(r)) return "Cerrada · Paseo se reinició antes de que contestaras";
  if (d.status === "failed" || /^(title|prompt|initiation|proposal_id) .*(required|must)/.test(r)) return "No se pudo: " + r.slice(0, 160);
  if (d.status === "canceled" || /withdrawn before the user answered/.test(r)) return "Cerrada";
  if (/chose "Hazlo aquí"/.test(r)) return "Hazlo aquí · sigue en esta sesión";
  if (/sent a new message instead/.test(r)) return "Cerrada · escribiste otro mensaje";
  if (/chose "Nueva sesión".*could not be started/.test(r)) return "No se pudo abrir la sesión nueva · sigue aquí";
  if (/chose "Nueva sesión"/.test(r)) return "Nueva sesión · se abre con el brief del agente";
  if (/already up/.test(r)) return "Ya hay una oferta abierta";
  return r.slice(0, 160);
}

type Models = { current: string | null; models: { id: string; label: string }[] };

const modelsOf = new Map<string, Promise<Models>>(); // one fetch per agent, shared by its cards and by the pill's cards

/** The card and its actions, on this client's RPCs. `Card` also registers itself in the pill's store when it is a pending
 * proposal or an open offer, so the pill lights up for what the user is looking at even on an agent never scanned. */
export function makeCard(client: PluginClientContext): ComponentType<PluginTimelineItemProps<CardData>> {
  /** «Modelo: Opus 5.5 ▾» and, open, the list of the session's provider's models. `value` null = the session's own. */
  function ModelPicker({ agentId, value, onChange, disabled, c }: { agentId: string; value: string | null; onChange: (id: string) => void; disabled: boolean; c: PluginTimelineItemProps["theme"]["colors"] }) {
    const [data, setData] = useState<Models | null>(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
      let p = modelsOf.get(agentId);
      if (!p) {
        p = client.rpc(modelos, { agentId });
        modelsOf.set(agentId, p);
        p.catch(() => modelsOf.delete(agentId));
      }
      let live = true;
      p.then((m) => live && setData(m), () => {});
      return () => void (live = false);
    }, [agentId]);
    if (!data?.models.length) return null;
    const chosen = value ?? data.current;
    const label = (id: string | null) => data.models.find((m) => m.id === id)?.label ?? id ?? "el de esta sesión";
    return (
      <View style={{ marginTop: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Modelo de la sesión nueva" disabled={disabled} onPress={() => setOpen(!open)}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            Modelo: <Text style={{ color: c.foreground, fontWeight: "500" }}>{label(chosen)}</Text> {open ? "▴" : "▾"}
          </Text>
        </Pressable>
        {open ? (
          <ScrollView style={{ maxHeight: 220, marginTop: 4, borderWidth: 1, borderColor: c.border, borderRadius: 6, backgroundColor: c.surface1 }}>
            {data.models.map((m) => (
              <Pressable
                key={m.id}
                accessibilityRole="button"
                accessibilityLabel={m.label}
                onPress={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                style={{ paddingVertical: 5, paddingHorizontal: 10, backgroundColor: m.id === chosen ? c.surface2 : "transparent" }}
              >
                <Text style={{ color: c.foreground, fontSize: 13 }}>{m.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </View>
    );
  }

  function Card({ agentId, item, theme }: PluginTimelineItemProps<CardData>) {
    const c = theme.colors;
    const d = item.data;
    const [sent, setSent] = useState<string | null>(null);
    const [fetched, setState] = useState<string | null>(null);
    const [model, setModel] = useState<string | null>(null);
    const [relayed, setRelayed] = useState(false);
    const final = useSyncExternalStore(suscribirPendientes, () => (d.taskId ? estadoFinal(d.taskId) : undefined));
    const state = final ?? fetched;

    const refresh = useCallback(() => {
      if (d.initiation !== "own_initiative" || !d.taskId) return;
      void client.rpc(estado, { agentId }).then((s) => setState(s.tasks[d.taskId!] ?? null), () => {});
    }, [agentId, d.initiation, d.taskId]);
    useEffect(refresh, [refresh]);

    // The pill shows what the timeline left pending; a mounted card is proof of pending for this agent.
    useEffect(() => {
      if (d.initiation === "own_initiative" && d.status === "completed" && d.taskId) ponerPendiente(agentId, { taskId: d.taskId, title: d.title, prompt: d.prompt, kind: "propuesta" });
      else if (d.initiation === "offer" && d.status === "running") ponerPendiente(agentId, { taskId: "", title: d.title, prompt: "", kind: "oferta" });
    }, [agentId, d]);

    const button = (label: string, onPress: () => void, primary = false) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={sent !== null}
        onPress={onPress}
        style={{
          paddingVertical: 5,
          paddingHorizontal: 12,
          borderWidth: 1,
          borderColor: primary ? c.accent : c.border,
          backgroundColor: primary ? c.accent : "transparent",
          borderRadius: 6,
          opacity: sent !== null ? 0.5 : 1,
        }}
      >
        <Text style={{ color: primary ? c.accentForeground : c.foreground, fontSize: 13, fontWeight: "500" }}>{label}</Text>
      </Pressable>
    );
    const answer = (choice: "new" | "here") => {
      setSent(choice);
      void client.rpc(responder, { agentId, choice, title: d.title, ...(choice === "new" && model ? { model } : {}) }).then(
        (r) => {
          if (!r.ok) return setSent(null);
          if (r.relayed) setRelayed(true);
          quitarPendiente(agentId, ""); // answered: nothing to answer in the pill either
        },
        () => setSent(null),
      );
    };
    const start = () => {
      if (!d.taskId) return;
      setSent("start");
      void client.rpc(empezar, { agentId, taskId: d.taskId, title: d.title, prompt: d.prompt, ...(model ? { model } : {}) }).then(
        (r) => {
          if (!r.ok) setSent(null);
          else marcarFinal(d.taskId!, "started"); // the card and the pill end together, without waiting for `estado`
          refresh();
        },
        () => setSent(null),
      );
    };

    const heading =
      d.initiation === "offer" ? "¿En una sesión nueva?" : d.initiation === "own_initiative" ? "Nueva tarea" : "Sesión nueva";
    let body: ReactNode;
    if (d.initiation === "offer" && d.status === "running") {
      body = (
        <>
          <ModelPicker agentId={agentId} value={model} onChange={setModel} disabled={sent !== null} c={c} />
          <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
            {button("Nueva sesión", () => answer("new"), true)}
            {button("Hazlo aquí", () => answer("here"))}
          </View>
          {relayed ? (
            <Text style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 6 }}>
              Paseo se reinició mientras esperaba · tu elección ({sent === "here" ? "Hazlo aquí" : "Nueva sesión"}) se envió al agente como mensaje
            </Text>
          ) : null}
        </>
      );
    } else if (d.initiation === "own_initiative" && d.status === "completed" && d.taskId) {
      const done = state === "started" || sent === "start";
      body =
        state === "dismissed" ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 4 }}>Retirada</Text>
        ) : done ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 4 }}>Empezada en una sesión nueva</Text>
        ) : (
          <>
            <ModelPicker agentId={agentId} value={model} onChange={setModel} disabled={sent !== null} c={c} />
            <View style={{ marginTop: 8, flexDirection: "row" }}>{button("Empezar", start, true)}</View>
          </>
        );
    } else if (d.status === "running") {
      body = <Text style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 4 }}>Abriendo…</Text>;
    } else if (d.initiation === "user_asked" || d.initiation === "brief") {
      const ok = /now runs in its own session|^Started (session|the proposal)/.test(d.result);
      body = <Text style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 4 }}>{ok ? "En marcha en su propia sesión" : outcome(d)}</Text>;
    } else {
      body = <Text style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 4 }}>{outcome(d)}</Text>;
    }

    return (
      <View style={{ marginVertical: 6, paddingVertical: 8, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: c.accent }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{heading}</Text>
        {d.title ? <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600", marginTop: 2 }}>{d.title}</Text> : null}
        {d.initiation === "own_initiative" && d.prompt ? (
          <Text numberOfLines={3} style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 4 }}>
            {d.prompt.split("\n\nContexto:")[0]}
          </Text>
        ) : null}
        {body}
      </View>
    );
  }

  return Card;
}

export function addSessionCards(client: PluginClientContext): () => void {
  const Card = makeCard(client);
  const offRenderer = client.addTimelineRenderer({ kind: CARD_KIND, version: 1, schema: cardSchema, Component: Card });
  const offTransformer = client.addTimelineTransformer({
    id: "rutador-cards",
    query: { itemType: "tool_call" },
    transform: ({ item }) => {
      if (!item.name.startsWith(TOOL_PREFIX)) return undefined;
      const f = finalDe(item);
      if (f) marcarFinal(f.taskId, f.final); // the transformer sees the dismiss and the proposal_id start; the card does not
      if (item.name === `${TOOL_PREFIX}dismiss_task`) return { items: [] };
      if (item.name !== `${TOOL_PREFIX}start_session`) return undefined;
      const data = cardFrom(item);
      return data ? { items: [{ type: "plugin", kind: CARD_KIND, version: 1, data }] } : undefined;
    },
  });
  return () => {
    offRenderer();
    offTransformer();
  };
}
