// The two tools the agent calls (start_session, dismiss_task) and the card's clicks, on top of the Sessions state machine.
// A started session is a sibling agent in the caller's workspace, same provider, model, mode and thinking level.
import type { PaseoApi } from "@getpaseo/client";
import type { McpToolResult } from "./mcp.ts";
import { Registro } from "./registro.ts";
import { Sessions, type Task } from "./sesiones.ts";
import { result } from "./textos.ts";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const brief = (prompt: string, background: string) => (background ? `${prompt}\n\nContexto:\n${background}` : prompt);

export class Rutador {
  readonly sessions = new Sessions();
  private readonly registro: Registro;
  private readonly paseo: () => PaseoApi | null;

  constructor(paseo: () => PaseoApi | null, registroPath: string) {
    this.paseo = paseo;
    this.registro = new Registro(registroPath);
  }

  /** The models the user can pick on a card: those of the session's provider, and the one it runs now. */
  async models(agentId: string): Promise<{ current: string | null; models: { id: string; label: string }[] }> {
    const paseo = this.paseo();
    if (!paseo) return { current: null, models: [] };
    const parent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!parent) return { current: null, models: [] };
    const list = await paseo.providers.listModels(parent.provider);
    return { current: parent.model ?? null, models: (list.models ?? []).map((m) => ({ id: m.id, label: m.label ?? m.id })) };
  }

  /** A sibling agent in the same workspace as `parentId`, seeded with the brief, on the parent's provider and mode, and
   * on `model` when the user picked one (then with that model's own default thinking level). Returns its id. */
  private async createSibling(parentId: string, title: string, prompt: string, model?: string): Promise<string> {
    const paseo = this.paseo();
    if (!paseo) throw new Error("Paseo API not ready");
    const parent = (await paseo.agents.ref(parentId).refresh())?.agent;
    if (!parent?.workspaceId) throw new Error("the session has no workspace");
    const picked = model && model !== parent.model ? model : undefined;
    const runs = picked ?? parent.model;
    const child = await paseo.workspaces.ref(parent.workspaceId).agents.create({
      config: {
        provider: runs ? `${parent.provider}/${runs}` : parent.provider,
        ...(parent.currentModeId ? { modeId: parent.currentModeId } : {}),
        ...(!picked && parent.thinkingOptionId ? { thinkingOptionId: parent.thinkingOptionId } : {}),
      },
      title: title.slice(0, 200),
      prompt,
    });
    return child.id;
  }

  /** Claims, creates, and records; on failure the task goes back to where it was. */
  private async startTask(agentId: string, taskId: string, prompt: string, model?: string): Promise<{ task: Task; childId: string } | { error: string }> {
    const claim = this.sessions.claim(agentId, taskId);
    if ("refused" in claim) return { error: claim.refused };
    try {
      const childId = await this.createSibling(agentId, claim.task.title, prompt, model ?? claim.task.model);
      this.sessions.started(taskId, childId);
      if (claim.task.kind === "proposal") this.registro.set(agentId, taskId, "started");
      return { task: claim.task, childId };
    } catch (error) {
      this.sessions.release(taskId, claim.was);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async startSession(agentId: string, args: Record<string, unknown>, signal: AbortSignal, onOffer: (agentId: string) => () => void): Promise<McpToolResult> {
    const proposalId = str(args.proposal_id);
    const prompt = str(args.prompt);
    const background = str(args.background);
    const title = str(args.title);

    if (proposalId) {
      const task = this.sessions.get(proposalId);
      if (!task || task.agentId !== agentId) return { isError: true, text: `proposal_id must be the task_id a start_session offer or proposal of this session returned.` };
      if (task.state === "awaiting_brief" && !prompt) return { isError: true, text: `The user chose New session: send the brief with proposal_id — prompt is required.` };
      const started = await this.startTask(agentId, proposalId, task.state === "awaiting_brief" ? brief(prompt, background) : (task.prompt ?? ""));
      if ("error" in started) {
        if (task.kind === "offer" && task.state === "awaiting_brief") return { text: result.unstarted(proposalId, started.error) };
        return { isError: true, text: `Not started (${started.error}).` };
      }
      return { text: task.kind === "offer" ? result.briefStarted(proposalId, task.title, started.childId) : result.proposalStarted(proposalId, task.title, started.childId) };
    }

    if (!title) return { isError: true, text: "title is required." };
    switch (args.initiation) {
      case "offer": {
        const opened = this.sessions.offer(agentId, title);
        if ("busy" in opened) return { text: result.busy(opened.busy.taskId, opened.busy.title) };
        const { task, outcome } = opened;
        const onAbort = () => this.sessions.withdraw(agentId);
        signal.addEventListener("abort", onAbort, { once: true });
        const stopWatching = onOffer(agentId); // a new user message closes the offer
        try {
          const o = await outcome;
          if (o.kind === "here") return { text: result.doItHere(task.taskId) };
          if (o.kind === "new") return { text: result.writeBrief(task.taskId, task.title) };
          if (o.kind === "superseded") return { text: result.superseded(task.taskId) };
          return { text: result.withdrawn(task.taskId) };
        } finally {
          signal.removeEventListener("abort", onAbort);
          stopWatching();
        }
      }
      case "user_asked": {
        if (!prompt) return { isError: true, text: `prompt is required for "user_asked": the brief — the task, the files or area, what done looks like.` };
        const childId = await this.createSibling(agentId, title, brief(prompt, background));
        return { text: result.started(title, childId) };
      }
      case "own_initiative": {
        if (!prompt) return { isError: true, text: `prompt is required for "own_initiative": the brief — the task, the files or area, what done looks like.` };
        const proposed = this.sessions.propose(agentId, title, brief(prompt, background));
        if ("limit" in proposed) return { text: result.limit() };
        const others = this.sessions.ofAgent(agentId).filter((t) => t.kind === "proposal" && t.state === "pending" && t.taskId !== proposed.task.taskId);
        return { text: result.proposed(proposed.task.taskId, title, others) };
      }
      default:
        return {
          isError: true,
          text: `initiation is required: "offer" (a task from the user's latest message — they choose New session or Do it here), "user_asked" (the user told you to start this session) or "own_initiative" (work you propose yourself — it waits as a proposal).`,
        };
    }
  }

  /** A click on an offer card. When the offer is gone because Paseo restarted (`relay`), the answer reaches the agent
   * as a message with the same text the tool call would have returned. */
  async answer(agentId: string, choice: "new" | "here", title: string, model?: string): Promise<{ ok: boolean; relayed?: boolean }> {
    if (this.sessions.answer(agentId, choice, model)) return { ok: true };
    const paseo = this.paseo();
    if (!paseo || !title) return { ok: false };
    const task = this.sessions.relay(agentId, title, choice, model);
    if (!task) return { ok: false };
    try {
      await paseo.agents.ref(agentId).send(result.relayed(choice === "here" ? result.doItHere(task.taskId) : result.writeBrief(task.taskId, title)));
      return { ok: true, relayed: true };
    } catch (error) {
      this.sessions.forget(task.taskId);
      console.error("rutador: could not relay the answer", error);
      return { ok: false };
    }
  }

  /** Where each card of the agent stands, for the client. */
  states(agentId: string): Record<string, string> {
    const out: Record<string, string> = {};
    Object.assign(out, this.registro.ofAgent(agentId));
    for (const t of this.sessions.ofAgent(agentId)) out[t.taskId] = t.state;
    return out;
  }

  dismissTask(agentId: string, args: Record<string, unknown>): McpToolResult {
    const taskId = str(args.task_id);
    if (!taskId) return { isError: true, text: "task_id is required." };
    let was = this.sessions.dismiss(agentId, taskId);
    if (was === "unknown") was = this.registro.get(agentId, taskId) ?? "pending"; // a card from before a restart: only the record knows it
    const dismissed = was === "pending" || was === "awaiting_brief" || was === "asking";
    if (dismissed) this.registro.set(agentId, taskId, "dismissed");
    return { text: dismissed ? result.dismissed(taskId) : result.dismissNoop(taskId, was) };
  }

  /** A click on an own-initiative card. A task this process does not know (the daemon restarted since) starts from the
   * brief the card carries, which is the agent's own tool input, unless the record says it was started or dismissed. */
  async startFromCard(agentId: string, taskId: string, title: string, prompt: string, model?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.sessions.get(taskId)) {
      if (!prompt) return { ok: false, error: "sin brief" };
      const final = this.registro.get(agentId, taskId);
      if (final) return { ok: false, error: final };
      this.registro.set(agentId, taskId, "started"); // before the await: a second click finds it taken
      try {
        await this.createSibling(agentId, title, prompt, model);
        return { ok: true };
      } catch (error) {
        this.registro.set(agentId, taskId, undefined);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const started = await this.startTask(agentId, taskId, this.sessions.get(taskId)!.prompt ?? prompt, model);
    return "error" in started ? { ok: false, error: started.error } : { ok: true };
  }
}
