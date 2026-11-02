import type { PluginButtonContentProps, PluginButtonIconProps, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { clasificar } from "../shared/contract.ts";
import { clearDraft, readDraft, registerPillAnchor } from "./composer.ts";

// One pill per idle agent, shown only while its composer draft reads as a task (the resident decides, server-side). Opening it gives
// the two routes Dani asked for: a new session in the SAME workspace, or run it here as a subagent. The draft is read fresh on click,
// so whatever is in the box at that moment is what gets routed; the box is then emptied so the current session does not also send it.
const SUBAGENT_PREFIX = "Ejecuta esto como subagente (usa la herramienta Agent) y dime el resultado:\n";
const POLL_MS = 500; // how often the draft is re-read; the resident is only called when the draft settles and changed
const MIN_CHARS = 4; // below this there is nothing that reads as a task; skip the call

type Agent = { id: string; workspaceId?: string | null; provider?: string; status: string; archivedAt?: string | null };

function RutadorIcon(props: PluginButtonIconProps) {
  const node = useRef<View>(null);
  const agentId = props.context === "agent" ? props.agentId : null;
  const { compact } = props.layout;
  useEffect(() => {
    // A compact layout can host the agent in a sheet with no composer of its own, where the climb could meet another agent's.
    if (!agentId || compact || !node.current) return;
    return registerPillAnchor(agentId, node.current as unknown as Element);
  }, [agentId, compact]);
  return (
    <View ref={node}>
      <Icon name="Sparkles" size={props.size} color={props.color} />
    </View>
  );
}

// The host's popover is already the frame: two plain rows, no box. The draft is read at click time by the handlers, not captured here.
function RouteCard({ theme, close, agentId, onNew, onSub }: PluginButtonContentProps & { agentId: string; onNew: (id: string) => void; onSub: (id: string) => void }) {
  const styles = useMemo(
    () => ({
      col: { gap: 10, paddingVertical: 4, minWidth: 240 },
      btn: { paddingVertical: 6 },
      txt: { color: theme.colors.foreground, fontSize: 13 },
    }),
    [theme],
  );
  return (
    <View style={styles.col}>
      <Pressable accessibilityLabel="Nueva sesión en el workspace" onPress={() => { onNew(agentId); close(); }} style={styles.btn}>
        <Text style={styles.txt}>＋ Nueva sesión (mismo workspace)</Text>
      </Pressable>
      <Pressable accessibilityLabel="Subagente en esta sesión" onPress={() => { onSub(agentId); close(); }} style={styles.btn}>
        <Text style={styles.txt}>↳ Subagente aquí</Text>
      </Pressable>
    </View>
  );
}

export function addRutadorPill(client: PluginClientContext): () => void {
  const agents = new Map<string, Agent>();
  const pills = new Map<string, ReturnType<PluginClientContext["addComposerPill"]>>();
  const taskOf = new Map<string, boolean>(); // last classification of the agent's draft
  const classified = new Map<string, string>(); // the exact text that classification was for
  const inFlight = new Set<string>(); // a classify call in flight: do not stack them
  let stopped = false;
  const lifetime = new AbortController();

  const remove = (id: string) => {
    pills.get(id)?.remove();
    pills.delete(id);
    agents.delete(id);
    taskOf.delete(id);
    classified.delete(id);
  };

  const show = (agent: Agent) => {
    if (stopped) return;
    if (!agent.workspaceId || agent.archivedAt) return remove(agent.id);
    agents.set(agent.id, agent);
    if (agent.status !== "idle") {
      taskOf.delete(agent.id);
      classified.delete(agent.id);
    }
    const isTask = agent.status === "idle" && taskOf.get(agent.id) === true;
    // The pill stays mounted while the agent is idle (visible) so its icon registers the composer anchor — the draft cannot be read
    // without it (a hidden pill never mounts, so it could never detect a task: the egg-and-the-rock). It only lights up ("⇄ Rutear")
    // once the resident says the draft is a task; the ✦ otherwise is the same always-on affordance paseo-sugiere uses.
    const button = {
      title: isTask ? "Abrir esta tarea en otra sesión, o ejecutarla aquí como subagente" : "Rutador: escribe una tarea y aparecerá aquí para rutearla",
      icon: RutadorIcon,
      label: isTask ? "⇄ Rutear" : "✦",
      visible: agent.status === "idle",
      behavior: {
        kind: "popover" as const,
        Content: (props: PluginButtonContentProps) => <RouteCard {...props} agentId={agent.id} onNew={newSession} onSub={subagent} />,
      },
    };
    const pill = pills.get(agent.id);
    if (pill) pill.update(button);
    else pills.set(agent.id, client.addComposerPill({ id: "rutador", workspaceId: agent.workspaceId, agentId: agent.id, button }));
  };

  // New sibling agent in the same workspace, seeded with the draft; then the draft is emptied so this session does not run it too.
  const newSession = (agentId: string) => {
    const agent = agents.get(agentId);
    const draft = readDraft(agentId)?.trim();
    if (!agent?.workspaceId || !draft) return;
    void client.paseo.workspaces
      .ref(agent.workspaceId)
      .agents.create({ config: { provider: agent.provider ?? "claude" }, prompt: draft, title: draft.slice(0, 60) })
      .then(() => { clearDraft(agentId); taskOf.delete(agentId); classified.delete(agentId); show(agent); })
      .catch((error) => console.error("rutador: no se pudo crear la sesión nueva", error));
  };

  // Same session: hand the draft to the current agent told to run it as a subagent; then empty the draft.
  const subagent = (agentId: string) => {
    const agent = agents.get(agentId);
    const draft = readDraft(agentId)?.trim();
    if (!agent || !draft) return;
    void client.paseo.agents
      .ref(agentId)
      .send(SUBAGENT_PREFIX + draft)
      .then(() => { clearDraft(agentId); taskOf.delete(agentId); classified.delete(agentId); show(agent); })
      .catch((error) => console.error("rutador: no se pudo lanzar el subagente", error));
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const id of [...pills.keys()]) remove(id);
          for (const { agent } of entries) show(agent as Agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else show(update.agent as Agent);
        },
      });
    })
    .catch((error) => {
      if (!stopped) console.error("rutador: agent observation failed", error);
    });

  // Poll each idle agent's draft; when it settled on new text long enough to be a task, ask the resident once and refresh the pill.
  const poll = setInterval(() => {
    for (const agent of agents.values()) {
      if (agent.status !== "idle") continue;
      const draft = readDraft(agent.id);
      if (draft === null) continue;
      const text = draft.trim();
      if (text.length < MIN_CHARS) {
        if (taskOf.get(agent.id)) { taskOf.delete(agent.id); show(agent); }
        continue;
      }
      if (classified.get(agent.id) === text || inFlight.has(agent.id)) continue;
      inFlight.add(agent.id);
      void client.rpc(clasificar, { text }).then(
        ({ task }) => {
          inFlight.delete(agent.id);
          if (stopped) return;
          classified.set(agent.id, text);
          if (taskOf.get(agent.id) !== task) { taskOf.set(agent.id, task); show(agent); }
        },
        () => inFlight.delete(agent.id),
      );
    }
  }, POLL_MS);

  return () => {
    stopped = true;
    lifetime.abort();
    clearInterval(poll);
    for (const id of [...pills.keys()]) remove(id);
  };
}
