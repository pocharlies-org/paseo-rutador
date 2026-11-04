// What happened to each own-initiative card (started or dismissed), on disk: the in-memory Sessions die with the daemon,
// and a card drawn from history must neither start a dismissed proposal nor start one twice.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Final = "started" | "dismissed";

const MAX = 500; // shortcut: keeps the latest 500 cards, older ones would start again from history; a real store if that bites

export class Registro {
  private entries: Record<string, Final>;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    try {
      this.entries = JSON.parse(readFileSync(path, "utf8")) as Record<string, Final>;
    } catch {
      this.entries = {};
    }
  }

  get(agentId: string, taskId: string): Final | undefined {
    return this.entries[`${agentId}:${taskId}`];
  }

  /** Records how a card ended; `undefined` forgets it (a start that failed can be clicked again). */
  set(agentId: string, taskId: string, final: Final | undefined): void {
    const key = `${agentId}:${taskId}`;
    delete this.entries[key]; // re-insert last, so trimming drops the oldest
    if (final) this.entries[key] = final;
    const keys = Object.keys(this.entries);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete this.entries[k];
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.entries));
    } catch (error) {
      console.error("rutador: could not save card states", error); // the in-memory state still holds until a restart
    }
  }

  /** The cards of an agent, by task id. */
  ofAgent(agentId: string): Record<string, Final> {
    const out: Record<string, Final> = {};
    const prefix = `${agentId}:`;
    for (const [k, v] of Object.entries(this.entries)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    return out;
  }
}
