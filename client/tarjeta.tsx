import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { CARD_KIND, cardSchema, empezar, estado, responder, TOOL_PREFIX, type CardData } from "../shared/contract.ts";

// The tool calls become cards in the conversation, like Claude Desktop's: an offer asks «Nueva sesión» / «Hazlo aquí» while
// the agent waits; an own-initiative proposal is a «Nueva tarea» card the user starts with a click; a session started on the
// user's word is one line. dismiss_task leaves no row (its card says «Retirada»).

/** The text of an MCP tool result as Paseo hands it over: a string, a content array, or `{ content: [...] }`. */
export function textOf(output: unknown): string {
  if (typeof output === "string") return output;
  const parts = Array.isArray(output) ? output : Array.isArray((output as { content?: unknown })?.content) ? (output as { content: unknown[] }).content : [];
  const text = parts.map((p) => (typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : "")).join("");
  return text || (output == null ? "" : JSON.stringify(output));
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function cardFrom(item: { name: string; status: string; detail: unknown }): CardData | null {
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
  if (d.status === "failed" || /^(title|prompt|initiation|proposal_id) .*(required|must)/.test(r)) return "No se pudo: " + r.slice(0, 160);
  if (d.status === "canceled" || /withdrawn before the user answered/.test(r)) return "Cerrada";
  if (/chose "Hazlo aquí"/.test(r)) return "Hazlo aquí · sigue en esta sesión";
  if (/sent a new message instead/.test(r)) return "Cerrada · escribiste otro mensaje";
  if (/chose "Nueva sesión".*could not be started/.test(r)) return "No se pudo abrir la sesión nueva · sigue aquí";
  if (/chose "Nueva sesión"/.test(r)) return "Nueva sesión · se abre con el brief del agente";
  if (/already up/.test(r)) return "Ya hay una oferta abierta";
  return r.slice(0, 160);
}

export function addSessionCards(client: PluginClientContext): () => void {
  function Card({ agentId, item, theme }: PluginTimelineItemProps<CardData>) {
    const c = theme.colors;
    const d = item.data;
    const [sent, setSent] = useState<string | null>(null);
    const [state, setState] = useState<string | null>(null);

    const refresh = useCallback(() => {
      if (d.initiation !== "own_initiative" || !d.taskId) return;
      void client.rpc(estado, { agentId }).then((s) => setState(s.tasks[d.taskId!] ?? null), () => {});
    }, [agentId, d.initiation, d.taskId]);
    useEffect(refresh, [refresh]);

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
      void client.rpc(responder, { agentId, choice }).then((r) => !r.ok && setSent(null), () => setSent(null));
    };
    const start = () => {
      if (!d.taskId) return;
      setSent("start");
      void client.rpc(empezar, { agentId, taskId: d.taskId, title: d.title, prompt: d.prompt }).then(
        (r) => {
          if (!r.ok) setSent(null);
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
        <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
          {button("Nueva sesión", () => answer("new"), true)}
          {button("Hazlo aquí", () => answer("here"))}
        </View>
      );
    } else if (d.initiation === "own_initiative" && d.status === "completed" && d.taskId) {
      const done = state === "started" || sent === "start";
      body =
        state === "dismissed" ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 4 }}>Retirada</Text>
        ) : done ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 4 }}>Empezada en una sesión nueva</Text>
        ) : (
          <View style={{ marginTop: 8, flexDirection: "row" }}>{button("Empezar", start, true)}</View>
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

  const offRenderer = client.addTimelineRenderer({ kind: CARD_KIND, version: 1, schema: cardSchema, Component: Card });
  const offTransformer = client.addTimelineTransformer({
    id: "rutador-cards",
    query: { itemType: "tool_call" },
    transform: ({ item }) => {
      if (!item.name.startsWith(TOOL_PREFIX)) return undefined;
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
