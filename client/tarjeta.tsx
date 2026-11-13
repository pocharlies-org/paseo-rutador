import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Animated, Easing, Pressable, ScrollView, Text, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { CARD_KIND, cardSchema, empezar, estado, modelos, responder, TOOL_PREFIX, type CardData } from "../shared/contract.ts";
import { estadoFinal, finalDe, marcarFinal, str, suscribirFinales, textOf, type ToolCallLike } from "./pendientes.ts";

// The tool calls become cards in the conversation, like Claude Desktop's: an offer asks «Nueva sesión» / «Hazlo aquí» while
// the agent waits; an own-initiative proposal is a «Nueva tarea» card the user starts with a click; a session started on the
// user's word is one line. dismiss_task leaves no row (its card says «Retirada»).
//
// El aspecto es el de las tarjetas de Claude Desktop: superficie elevada con borde fino y esquinas redondeadas, el icono en
// su baldosa, título grande y subtítulo apagado, y las acciones abajo a la derecha —la primaria rellena con el acento y a la
// derecha del todo, la secundaria quieta—, con el modelo como chip a la izquierda. Entra con un fundido corto que sube unos
// píxeles. Solo colores de `theme.colors`, así vale igual en claro y en oscuro. Una tarjeta que ya no pide nada se queda en
// su título y una línea apagada con cómo acabó.

type Colors = PluginTimelineItemProps["theme"]["colors"];
type Models = { current: string | null; models: { id: string; label: string }[] };

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

/** La entrada de Claude Desktop: fundido de 220 ms que sube 6 px y crece desde el 98 %, una vez por montaje. En web no hay
 * driver nativo (react-native-web avisaría y animaría en JS igualmente), así que solo se pide fuera de web. */
function useEntrada(nativo: boolean) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.timing(v, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: nativo });
    a.start();
    return () => a.stop();
  }, [v, nativo]);
  return useMemo(
    () => ({
      opacity: v,
      transform: [
        { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) },
        { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1] }) },
      ],
    }),
    [v],
  );
}

/** Pressable con el hover del escritorio además del pressed: el tipo de React Native solo da `pressed` al estilo. */
function Pulsable({ style, ...props }: Omit<PressableProps, "style"> & { style: (s: { pressed: boolean; hovered: boolean }) => StyleProp<ViewStyle> }) {
  const [hovered, setHovered] = useState(false);
  return <Pressable {...props} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} style={({ pressed }) => style({ pressed, hovered })} />;
}

/** Primario: relleno con el acento. Secundario: solo el borde, y la superficie al pasar por encima. Los dos se hunden un
 * poco al pulsar; mientras la respuesta va al servidor quedan atenuados y no responden. */
function Boton({ label, onPress, primary = false, disabled, c }: { label: string; onPress: () => void; primary?: boolean; disabled: boolean; c: Colors }) {
  return (
    <Pulsable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed, hovered }) => ({
        paddingVertical: 7,
        paddingHorizontal: 14,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: primary ? c.accent : c.border,
        backgroundColor: primary ? c.accent : hovered && !disabled ? c.surface2 : "transparent",
        opacity: disabled ? 0.5 : pressed ? 0.85 : primary && hovered ? 0.92 : 1,
        transform: [{ scale: pressed && !disabled ? 0.97 : 1 }],
      })}
    >
      <Text style={{ color: primary ? c.accentForeground : c.foreground, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pulsable>
  );
}

/** La lista de modelos que despliega el chip: dentro de la tarjeta, bajo el pie, con el elegido marcado. */
function ListaModelos({ models, chosen, onPick, c, nativo }: { models: Models["models"]; chosen: string | null; onPick: (id: string) => void; c: Colors; nativo: boolean }) {
  const entrada = useEntrada(nativo);
  return (
    <Animated.View style={[{ marginTop: 10, alignSelf: "flex-start", minWidth: 220, maxWidth: "100%", borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: c.surface0, overflow: "hidden" }, entrada]}>
      <ScrollView style={{ maxHeight: 220 }} contentContainerStyle={{ paddingVertical: 4 }}>
        {models.map((m) => (
          <Pulsable
            key={m.id}
            accessibilityRole="button"
            accessibilityLabel={m.label}
            accessibilityState={{ selected: m.id === chosen }}
            onPress={() => onPick(m.id)}
            style={({ pressed, hovered }) => ({ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: pressed || hovered ? c.surface2 : "transparent" })}
          >
            <Text style={{ flex: 1, color: c.foreground, fontSize: 13, fontWeight: m.id === chosen ? "600" : "400" }}>{m.label}</Text>
            <View style={{ width: 14 }}>{m.id === chosen ? <Icon name="Check" size={14} color={c.accent} /> : null}</View>
          </Pulsable>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

const modelsOf = new Map<string, Promise<Models>>(); // one fetch per agent, shared by its cards

export function addSessionCards(client: PluginClientContext): () => void {
  /** El pie de una tarjeta que pide algo: el modelo de la sesión nueva como chip («Opus 5.5 ⌄») a la izquierda, que despliega
   * los del proveedor de la sesión, y los botones a la derecha. `value` null = el de esta sesión. Sin modelos que ofrecer
   * (el RPC falló o el proveedor no lista), no hay chip y los botones siguen a la derecha. */
  function Acciones({ agentId, value, onChange, disabled, c, nativo, children }: { agentId: string; value: string | null; onChange: (id: string) => void; disabled: boolean; c: Colors; nativo: boolean; children: ReactNode }) {
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
    const chosen = value ?? data?.current ?? null;
    const label = data?.models.find((m) => m.id === chosen)?.label ?? chosen ?? "Modelo de esta sesión";
    return (
      <View style={{ marginTop: 14 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {data?.models.length ? (
            <Pulsable
              accessibilityRole="button"
              accessibilityLabel="Modelo de la sesión nueva"
              disabled={disabled}
              onPress={() => setOpen(!open)}
              style={({ pressed, hovered }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingVertical: 5,
                paddingLeft: 10,
                paddingRight: 8,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: open || (hovered && !disabled) ? c.surface2 : "transparent",
                opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "500" }}>{label}</Text>
              <Icon name={open ? "ChevronUp" : "ChevronDown"} size={13} color={c.foregroundMuted} />
            </Pulsable>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, marginLeft: "auto" }}>{children}</View>
        </View>
        {open && !disabled && data ? (
          <ListaModelos
            models={data.models}
            chosen={chosen}
            onPick={(id) => {
              onChange(id);
              setOpen(false);
            }}
            c={c}
            nativo={nativo}
          />
        ) : null}
      </View>
    );
  }

  function Card({ agentId, item, theme, layout }: PluginTimelineItemProps<CardData>) {
    const c = theme.colors;
    const d = item.data;
    const nativo = layout.platform !== "web";
    const entrada = useEntrada(nativo);
    const [sent, setSent] = useState<string | null>(null);
    const [fetched, setState] = useState<string | null>(null);
    const [model, setModel] = useState<string | null>(null);
    const [relayed, setRelayed] = useState(false);
    const final = useSyncExternalStore(suscribirFinales, () => (d.taskId ? estadoFinal(d.taskId) : undefined));
    const state = final ?? fetched;

    const refresh = useCallback(() => {
      if (d.initiation !== "own_initiative" || !d.taskId) return;
      void client.rpc(estado, { agentId }).then((s) => setState(s.tasks[d.taskId!] ?? null), () => {});
    }, [agentId, d.initiation, d.taskId]);
    useEffect(refresh, [refresh]);

    const answer = (choice: "new" | "here") => {
      setSent(choice);
      void client.rpc(responder, { agentId, choice, title: d.title, ...(choice === "new" && model ? { model } : {}) }).then(
        (r) => {
          if (!r.ok) return setSent(null);
          if (r.relayed) setRelayed(true);
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
          else marcarFinal(d.taskId!, "started"); // una tarjeta que se vuelve a montar sale ya «Empezada», sin esperar a `estado`
          refresh();
        },
        () => setSent(null),
      );
    };

    // Lo que la tarjeta pide (el pie con el modelo y los botones) o, si ya no pide nada, cómo acabó: la línea bajo el título.
    let line: string;
    let ask: ReactNode = null;
    if (d.initiation === "offer" && d.status === "running") {
      line = "¿En una sesión nueva? El agente espera tu respuesta.";
      ask = (
        <>
          <Acciones agentId={agentId} value={model} onChange={setModel} disabled={sent !== null} c={c} nativo={nativo}>
            <Boton label="Hazlo aquí" onPress={() => answer("here")} disabled={sent !== null} c={c} />
            <Boton label="Nueva sesión" onPress={() => answer("new")} primary disabled={sent !== null} c={c} />
          </Acciones>
          {relayed ? (
            <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, marginTop: 10 }}>
              Paseo se reinició mientras esperaba · tu elección ({sent === "here" ? "Hazlo aquí" : "Nueva sesión"}) se envió al agente como mensaje
            </Text>
          ) : null}
        </>
      );
    } else if (d.initiation === "own_initiative" && d.status === "completed" && d.taskId) {
      if (state === "dismissed") line = "Retirada";
      else if (state === "started" || sent === "start") line = "Empezada en una sesión nueva";
      else {
        line = "Nueva tarea · la propone el agente";
        ask = (
          <Acciones agentId={agentId} value={model} onChange={setModel} disabled={sent !== null} c={c} nativo={nativo}>
            <Boton label="Empezar" onPress={start} primary disabled={sent !== null} c={c} />
          </Acciones>
        );
      }
    } else if (d.status === "running") {
      line = "Abriendo…";
    } else if (d.initiation === "user_asked" || d.initiation === "brief") {
      line = /now runs in its own session|^Started (session|the proposal)/.test(d.result) ? "En marcha en su propia sesión" : outcome(d);
    } else {
      line = outcome(d);
    }

    const live = ask !== null;
    const opening = !live && d.status === "running";
    const heading = d.initiation === "offer" ? "¿En una sesión nueva?" : d.initiation === "own_initiative" ? "Nueva tarea" : "Sesión nueva";
    const icon = d.initiation === "offer" ? "MessageSquarePlus" : d.initiation === "own_initiative" ? "ListPlus" : "ArrowUpRight";
    const tone = live ? c.accent : /^No se pudo/.test(line) ? c.statusDanger : c.foregroundMuted;
    return (
      <Animated.View style={[{ marginVertical: 8, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }, entrada]}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
          <View style={{ width: 32, height: 32, borderRadius: 9, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" }}>
            {opening ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : <Icon name={icon} size={16} color={tone} />}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: c.foreground, fontSize: 15, lineHeight: 20, fontWeight: "600" }}>{d.title || heading}</Text>
            <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18, marginTop: 2 }}>{line}</Text>
            {live && d.initiation === "own_initiative" && d.prompt ? (
              <Text numberOfLines={3} style={{ color: c.foreground, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
                {d.prompt.split("\n\nContexto:")[0]}
              </Text>
            ) : null}
          </View>
        </View>
        {ask}
      </Animated.View>
    );
  }

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
