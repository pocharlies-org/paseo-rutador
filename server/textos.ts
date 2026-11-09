// What the model reads: the server's instructions (Claude Code puts them in the system prompt, on a new session and on a
// resumed one alike), the card-tool descriptions and results. Adapted from Claude Desktop's own `ccd_session`
// server ("Starting other sessions", `start_session`, `dismiss_task`), minus what Paseo has no counterpart for (cloud and
// SSH targets, worktree choice, hand-off, wrap-up box, chapter marks, reports from the started session).
import { SERVER } from "../shared/contract.ts";

const START = `mcp__${SERVER}__start_session`;
const DISMISS = `mcp__${SERVER}__dismiss_task`;

export const INSTRUCTIONS = `## Starting other sessions

Work that should not happen here goes to its own session — \`${START}\`: a real Paseo session in this same workspace that the user can open, talk to and stop, shown in the sidebar. It starts from your brief alone and does not report back to you. \`initiation\` says whose task it is: "offer" is for a task the user named in their latest message — asked plainly, or as "suggest / split off / make a task (or session) for X" — and asks them, before anything starts, "Nueva sesión" (New session) or "Hazlo aquí" (Do it here); the call waits for their answer. "user_asked" starts it now because the user told you to. "own_initiative" is for work you propose yourself that the user has not told you to do — what you noticed, or the follow-up your own answer or work turned up: a card they may start (a click, or "start the second one" → \`start_session\` with just its \`proposal_id\`).
- Quick things (a question, a read, one edit, a handful of tool calls) stay here.
- A session is for independent work: the user can open, steer or review it apart from this task. If this task needs the result, keep it here or use a native subagent whose report returns to you. For a visible Paseo worker, use \`create_agent\` with \`notifyOnFinish: true\`, not \`start_session\`; include the objective, boundaries and acceptance criteria in the brief. Size, parallelism or a different repository do not make a dependent piece independent.
- If an independent producer session already exists, do not create a replacement or assume it has autopilot. Use \`coordinate_session\` with \`action: "link"\`, its \`agent_id\` and an \`objective\` including acceptance criteria. Only its registered coordinator continues it (\`action: "continue"\`, \`prompt\`, stable \`request_id\` UUID); reuse that ID after a lost tool response, never make up a new retry. Link sends no work by itself: inspect an already-idle producer and explicitly continue if needed. Use \`ESPERA: sesion <agent_id>\` only after the link reports watching; its result or interruption wakes you. Do not also use \`send_agent_prompt\` or \`notifyOnFinish\` on that linked producer: they bypass ownership or duplicate notifications. Native children keep their native channel. Do not poll. A finished turn is not a verified deliverable: inspect the result, continue the same worker if incomplete, and \`release\` the delegation after acceptance. Respect pending permissions, user intervention, cancellations and archived sessions; never restart around them. Never wait for your own ticket to close as a substitute for the actual external dependency.
- A turn whose request is a task of its own in that sense — and any turn where the user names a task and asks you to suggest, split off or make a task or session for it — does not start with the work: its first message is \`${START}\` with \`initiation\` "offer" and a \`title\` — nothing else, no prompt or background yet, so the card is up at once.
- "user_asked" only when the user asked in words for separate, parallel or background work or told you to start that piece now — one session per independent task; pieces whose results this task needs go to returning workers instead; if the user wants a visible session for such a piece, use \`create_agent\` with \`notifyOnFinish: true\`, not this independent-session tool. A task the user's message tells you to do is never "own_initiative": it is an "offer" (or "user_asked" when they said to start it), decided in the turn's first message. "own_initiative" is for a task of its own that you conclude or notice as you work (out-of-scope work, a fix spotted in passing, the follow-up your answer recommends — even to a question of theirs — unless the next bullet keeps it here): one card per independent piece, three per turn at most, none twice, never what you are about to do anyway.
- A follow-up you name gets a card, not just a sentence: when your reply tells the user that some work is a follow-up, a separate PR or for later, and it is real work worth doing next (not a one-line tweak or speculation), propose it before you end the turn. This holds for a turn that only answered a question. One piece of work that acts on what this session just found, such as the fix for what you diagnosed, stays here while this session has nothing else in flight (no unfinished change or open PR for other work): a new session would have to find it all again. Ask about it in your last line, write no brief, and do it on their yes. Any other gets a card: \`start_session\` "own_initiative" with a complete brief. The card is how you ask for their OK, so don't leave it as "needs your OK" or "want me to…?" in prose. When you are unsure which it is, a brief that would mostly retell what you found here means the work stays here.
- Right before each "user_asked" or "own_initiative" call, in the same message, write a bold title line and one sentence on what it will do; it has started only once the tool result says so.
- Every brief names the files/area and what done looks like, in your own words — synthesize, never "based on the findings". The new session has not seen this conversation: what it needs from here goes in \`background\`.
- A card you proposed that went stale (done here after all, unnecessary, or replaced by a better-scoped one) is withdrawn with \`${DISMISS}\`.
- Decide whether to offer, propose or start a session from this prompt, whether or not \`start_session\` is loaded yet. If it is only listed as a deferred tool and not loaded yet, load it first with \`ToolSearch\` (query "select:${START}", alone in its message); that load does not count as the turn's first message or first tool call.`;

export const START_DESCRIPTION = `Start a separate Paseo session (a sibling agent in this workspace) for independent work while you stay with the user (when: see "Starting other sessions" in this server's instructions). This is not a worker whose result this task needs: use a native subagent or create_agent with notifyOnFinish for that. \`initiation\` says who wants it: "user_asked" starts it now and returns its id; "offer" is for a task the user named in their latest message (new work here, or "suggest / split off / make a task or session for X"): called with a title alone, it shows a "Nueva sesión" / "Hazlo aquí" (New session / Do it here) card and WAITS for their answer, so it must be the only call in that message (no other tool); the result then tells you to carry on here, or to send the brief with proposal_id so the session starts; "own_initiative" is for work you propose yourself that the user has not told you to do — something you noticed, or the follow-up your own answer or work turned up (when your reply calls work a follow-up or a separate PR, propose it here rather than only saying so, unless it acts on what this session just found and so stays here), never what "Starting other sessions" keeps here or gives to a subagent; the user sees a card and nothing runs until they start it, by clicking it or by telling you (then call this again with just proposal_id).
"user_asked" and "own_initiative" both need a \`prompt\` — the brief: the task, the files or area, what done looks like — and the call is refused without it; \`background\` does not stand in for it. Only an "offer" is a title alone.
The new session starts fresh: it gets your \`prompt\` and \`background\`, never this conversation.`;

export const START_SCHEMA = {
  type: "object",
  properties: {
    initiation: {
      type: "string",
      enum: ["user_asked", "own_initiative", "offer"],
      description: `"user_asked": the user asked in words for separate, parallel or background work, or told you to start this piece — it starts now (not for a piece "Starting other sessions" gives to a subagent). "offer": a task the user named in their latest message (new work for this session, or one they asked you to suggest, split off or make a session for) — the user is asked first and the call waits for their answer; send only title with it (the brief follows, with proposal_id, if they choose New session). "own_initiative": work you propose yourself that the user has not told you to do — something you noticed, or the follow-up your own answer or work turned up; it waits as a proposal card until the user starts it; never for a task the user's message tells you to do, nor for the one piece of work "Starting other sessions" keeps here, nor for what it gives to a subagent. Required unless proposal_id is set.`,
    },
    proposal_id: {
      type: "string",
      description: `The task_id of an offer the user answered with New session (send it with prompt and background: the brief), or of a proposal the user told you to start (send it alone, exactly as proposed). To change a proposal, dismiss_task it and propose a new one.`,
    },
    title: { type: "string", description: "Under 60 chars; names the task. Shown on the card and as the session's title. Required unless proposal_id is set." },
    prompt: {
      type: "string",
      description: `The brief: the task, the files or area, what done looks like. Required for "user_asked" and "own_initiative" — the call is refused without it, and \`background\` does not stand in for it; an "offer" leaves it out (the card shows the title) and you send it with proposal_id once they choose New session. Here and in \`background\`, put file paths and code identifiers in backticks.`,
    },
    background: {
      type: "string",
      description: "A few sentences of overall goal, decisions and constraints so far, and how this piece fits — for someone who has not seen this conversation.",
    },
  },
} as const;

export const DISMISS_DESCRIPTION = `Withdraw a proposal you made with start_session (initiation "own_initiative" or "offer") that the user has not started.

Call this when it went stale: the work was done here after all (by you or the user), it turned out unnecessary, or you proposed a better-scoped replacement (propose the new one first, then dismiss the old task_id). A card the user answered has already left, "Hazlo aquí" (Do it here) included, so it needs no call.`;

export const DISMISS_SCHEMA = {
  type: "object",
  properties: {
    task_id: { type: "string", description: "The task_id the start_session proposal returned." },
    reason: {
      type: "string",
      description: 'Optional one-line reason the suggestion is no longer needed, e.g. "fixed in this session" or "superseded by task_ab12cd34".',
    },
  },
  required: ["task_id"],
} as const;

// ---- results

export const result = {
  doItHere: (id: string) => `The user chose "Hazlo aquí" (Do it here) (task_id: ${id}): do the task in this session now, as usual.`,
  writeBrief: (id: string, title: string) =>
    `The user chose "Nueva sesión" (New session) for "${title}" (task_id: ${id}). Write its brief now: call start_session once more with exactly proposal_id "${id}", prompt (the task as the user would send it to a fresh session: the files or area, what done looks like) and background (what that session needs from this conversation, a few sentences) — no other arguments and nothing else in that message. Do not do the task here. When that call returns, say in one line that it is running in its own session, then end your turn.`,
  superseded: (id: string) =>
    `The user did not answer the card: they sent a new message instead. The offer is closed (task_id: ${id}) and the task gets no session of its own, so do not offer it again. Their message may change the task or call it off, so deal with it first. If you can see it right after this result, respond to it, then do the task only if it still fits what they wrote. If you cannot see it, it is queued and reaches you only when this turn ends: do not start the task; say in one line that you will read their message first, and end your turn. When it arrives, respond to it, then do the task if it still fits.`,
  relayed: (answer: string) =>
    `[Paseo se reinició mientras la tarjeta esperaba y tu llamada a start_session se perdió; esta es la respuesta de la tarjeta.] ${answer}`,
  withdrawn: (id: string) => `The offer was withdrawn before the user answered (task_id: ${id}); do nothing further with it.`,
  busy: (id: string, title: string) =>
    `An offer is already up for "${title}" (task_id: ${id}) and waiting for the user; nothing new was shown. Make one offer at a time.`,
  briefStarted: (id: string, title: string, agentId: string) =>
    `The user chose "Nueva sesión" (New session): "${title}" now runs in its own session (agent_id: ${agentId}) from your brief (task_id: ${id}). Do not do the task here. Say in one line that it is running in its own session, then end your turn.`,
  proposalStarted: (id: string, title: string, agentId: string) =>
    `Started the proposal "${title}" (task_id: ${id}) in its own session (agent_id: ${agentId}), exactly as proposed. It runs on its own and does not report back here. At most one line saying so, then carry on.`,
  started: (title: string, agentId: string) =>
    `Started session "${title}" (agent_id: ${agentId}). It runs on its own in this workspace and does not report back here. Don't repeat the introduction: at most one line saying it is running in its own session, then end your turn — do not wait for it.`,
  unstarted: (id: string, why: string) =>
    `The user chose "Nueva sesión" (New session) but it could not be started (${why}) (task_id: ${id}). Do the task in this session as usual.`,
  proposed: (id: string, title: string, others: { taskId: string; title: string }[]) =>
    `Proposed "${title}" (task_id: ${id}). The user sees a card and nothing runs until they start it — with a click, or by telling you (then call start_session with proposal_id ${id} and nothing else). dismiss_task withdraws it if it goes stale. ` +
    (others.length ? `Also still waiting: ${others.map((o) => `${o.taskId} "${o.title}"`).join(", ")}. ` : "") +
    "Don't wait for it and don't repeat the introduction; carry on with what you were doing.",
  limit: () => `No card was shown: you already proposed three this turn, the most a turn may show. Name any further follow-up in your last line instead.`,
  dismissed: (id: string) => `Withdrew the proposal (task_id: ${id}); its card no longer starts anything.`,
  dismissNoop: (id: string, state: string) =>
    state === "started"
      ? `The proposal ${id} was already started; nothing was withdrawn. Do not retry.`
      : state === "unknown"
        ? `There is no proposal ${id} in this session; nothing was withdrawn.`
        : `The card ${id} was already answered or closed; it needs no call. Do not retry.`,
};
