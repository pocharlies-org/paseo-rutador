// The one resident call that decides whether a composer draft is a task. It goes to LiteLLM (server/residente.ts). The model is the
// resident; a wrong name just means no pill (task:false), never an error. Pure here — the body and the parse are what the test covers.
export const CLASSIFY_MODEL = "qwen38-flash-next";
export const CLASSIFY_MAX_TOKENS = 6;

// Only sí/no. A task is something the assistant should DO; a question, small talk or a meta-instruction about the chat is not.
export const CLASSIFY_INSTRUCTION = `Decide si el texto que te llega es una TAREA que el asistente debería ejecutar (hacer, crear, arreglar, cambiar, buscar, analizar, desplegar algo), frente a una pregunta, un saludo, un comentario o una orden sobre la propia charla.
Responde ÚNICAMENTE con una palabra: "sí" si es una tarea que merece ejecutarse, "no" en caso contrario.`;

/** The call body: the instruction in `system`, the draft as the single user turn, no tools. */
export function classifyBody(text: string): string {
  return JSON.stringify({
    model: CLASSIFY_MODEL,
    max_tokens: CLASSIFY_MAX_TOKENS,
    tools: [],
    system: CLASSIFY_INSTRUCTION,
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  });
}

/** The resident's sí/no → boolean. Anything unparseable is `false` (no pill), never a guess. The first word, accents stripped: JS
 * `\b` does not treat "í" as a word char, so `^sí\b` never matches — normalize first (measured: the accented answer failed the test). */
export function isTask(response: unknown): boolean {
  const parts = Array.isArray((response as { content?: unknown })?.content) ? ((response as { content: unknown[] }).content as any[]) : [];
  const text = parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const first = (text.match(/^[a-z]+/) ?? [""])[0];
  return first === "si" || first === "yes";
}
