// shortcut: DOM bridge to Paseo's composer (the SDK has no draft API — getpaseo/paseo #4688). Same climb as paseo-sugiere's
// composer-bridge, but here we READ the draft (to classify it) and CLEAR it (after routing), never write into it. Removed when the
// SDK exposes the draft. If a Paseo update moves the selectors, readDraft returns null and the pill simply never appears.
const COMPOSER = '[data-testid="message-input-root"] textarea[data-composer-input]';

const anchors = new Map<string, Set<Element>>(); // agentId -> the pill icon(s) of that agent; one agent can be open in two panes

export function registerPillAnchor(agentId: string, node: Element): () => void {
  const nodes = anchors.get(agentId) ?? new Set<Element>();
  nodes.add(node);
  anchors.set(agentId, nodes);
  return () => {
    nodes.delete(node);
    if (!nodes.size && anchors.get(agentId) === nodes) anchors.delete(agentId);
  };
}

const visibleComposers = (root: Element) =>
  Array.from(root.querySelectorAll<HTMLTextAreaElement>(COMPOSER)).filter((box) => box.getClientRects().length > 0);

// The composer of the pane the pill sits in: climb from the pill until an ancestor holds a visible composer, and take it only if it
// is the only one there. Two panes side by side meet at an ancestor with two, which is ambiguous: null, never the wrong agent.
function composerFor(anchor: Element): HTMLTextAreaElement | null {
  for (let el = anchor.parentElement; el && el !== document.body; el = el.parentElement) {
    const found = visibleComposers(el);
    if (found.length) return found.length === 1 ? found[0]! : null;
  }
  return null;
}

/** The current draft of an agent's composer, or null when there is no unambiguous composer (no pill anchor, two panes, no DOM). */
export function readDraft(agentId: string): string | null {
  if (typeof document === "undefined") return null;
  for (const anchor of anchors.get(agentId) ?? []) {
    const box = composerFor(anchor);
    if (box) return box.value;
  }
  return null;
}

/** Empties the draft so the host does not also send it after a route. The prototype setter + an `input` event is how the host's
 * own onChange sees it (the same way sugiere writes); returns true only when the box ends up empty. */
export function clearDraft(agentId: string): boolean {
  if (typeof document === "undefined") return false;
  for (const anchor of anchors.get(agentId) ?? []) {
    const box = composerFor(anchor);
    if (!box) continue;
    const before = box.value;
    box.focus();
    const done = document.execCommand("delete");
    if (!done || box.value !== "") {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "");
      box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
    }
    void before;
    return box.value === "";
  }
  return false;
}
