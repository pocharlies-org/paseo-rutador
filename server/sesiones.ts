// The offers and proposals of every agent, with no I/O: the MCP tool and the card's RPCs drive it, the test covers it.
//
//   offer:    asking ──answer "here"──▶ here            (the tool returns "do it here")
//                    ──answer "new"───▶ awaiting_brief ──brief──▶ started
//                    ──user typed past─▶ closed          (the tool returns "they sent a new message instead")
//                    ──call aborted───▶ closed
//   proposal: pending ──click or proposal_id──▶ started
//                     ──dismiss_task──────────▶ dismissed
//
// One asking offer per agent: an offer is the only call of its message and blocks the turn, so a second one is a mistake.

export type Choice = "new" | "here";
export type OfferOutcome = { kind: "new" } | { kind: "here" } | { kind: "superseded" } | { kind: "withdrawn" };
export type TaskState = "asking" | "awaiting_brief" | "pending" | "started" | "here" | "closed" | "dismissed";

export interface Task {
  taskId: string;
  agentId: string;
  title: string;
  prompt?: string;
  kind: "offer" | "proposal";
  state: TaskState;
  childAgentId?: string;
}

export const MAX_PROPOSALS_PER_TURN = 3;

const randomId = () => `task_${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;

export class Sessions {
  private tasks = new Map<string, Task>();
  private asking = new Map<string, { taskId: string; resolve: (outcome: OfferOutcome) => void }>(); // by agentId
  private proposedThisTurn = new Map<string, number>(); // by agentId

  private readonly newId: () => string;

  constructor(newId: () => string = randomId) {
    this.newId = newId;
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /** The tasks of an agent, for its cards. */
  ofAgent(agentId: string): Task[] {
    return [...this.tasks.values()].filter((t) => t.agentId === agentId);
  }

  /** Opens an offer and returns the promise the tool call waits on; `busy` when the agent already has one up. */
  offer(agentId: string, title: string): { task: Task; outcome: Promise<OfferOutcome> } | { busy: Task } {
    const open = this.asking.get(agentId);
    if (open) return { busy: this.tasks.get(open.taskId)! };
    const task: Task = { taskId: this.newId(), agentId, title, kind: "offer", state: "asking" };
    this.tasks.set(task.taskId, task);
    const outcome = new Promise<OfferOutcome>((resolve) => this.asking.set(agentId, { taskId: task.taskId, resolve }));
    return { task, outcome };
  }

  private settle(agentId: string, state: TaskState, outcome: OfferOutcome): boolean {
    const open = this.asking.get(agentId);
    if (!open) return false;
    this.asking.delete(agentId);
    this.tasks.get(open.taskId)!.state = state;
    open.resolve(outcome);
    return true;
  }

  /** The user's click on the card. False when the agent has no offer up (answered already, closed, never opened). */
  answer(agentId: string, choice: Choice): boolean {
    return choice === "here" ? this.settle(agentId, "here", { kind: "here" }) : this.settle(agentId, "awaiting_brief", { kind: "new" });
  }

  /** The user sent a new message instead of answering: the offer closes and the task gets no session. */
  supersede(agentId: string): boolean {
    return this.settle(agentId, "closed", { kind: "superseded" });
  }

  /** The tool call went away (turn interrupted, connection closed). */
  withdraw(agentId: string): boolean {
    return this.settle(agentId, "closed", { kind: "withdrawn" });
  }

  turnStarted(agentId: string): void {
    this.proposedThisTurn.delete(agentId);
  }

  /** An own-initiative card. `limit` once the agent proposed three this turn. */
  propose(agentId: string, title: string, prompt: string): { task: Task } | { limit: true } {
    const n = this.proposedThisTurn.get(agentId) ?? 0;
    if (n >= MAX_PROPOSALS_PER_TURN) return { limit: true };
    this.proposedThisTurn.set(agentId, n + 1);
    const task: Task = { taskId: this.newId(), agentId, title, prompt, kind: "proposal", state: "pending" };
    this.tasks.set(task.taskId, task);
    return { task };
  }

  /** Claims a task to start its session: an accepted offer (with its brief) or a pending proposal. The caller creates the
   * session and then calls `started` or, on failure, `release`. A task of another agent, or in any other state, is refused. */
  claim(agentId: string, taskId: string): { task: Task; was: TaskState } | { refused: TaskState | "unknown" } {
    const task = this.tasks.get(taskId);
    if (!task || task.agentId !== agentId) return { refused: "unknown" };
    if (task.state !== "awaiting_brief" && task.state !== "pending") return { refused: task.state };
    const was = task.state;
    task.state = "started";
    return { task, was };
  }

  started(taskId: string, childAgentId: string): void {
    const task = this.tasks.get(taskId);
    if (task) task.childAgentId = childAgentId;
  }

  release(taskId: string, was: TaskState): void {
    const task = this.tasks.get(taskId);
    if (task?.state === "started" && !task.childAgentId) task.state = was;
  }

  /** dismiss_task: withdraws a pending card. Returns the state the task was in. */
  dismiss(agentId: string, taskId: string): TaskState | "unknown" {
    const task = this.tasks.get(taskId);
    if (!task || task.agentId !== agentId) return "unknown";
    if (task.state === "asking") {
      this.withdraw(agentId);
      return "asking";
    }
    const was = task.state;
    if (was === "pending" || was === "awaiting_brief") task.state = "dismissed";
    return was;
  }
}
