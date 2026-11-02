# paseo-rutador

Plugin de Paseo. Cuando escribes una **tarea** en el composer (el residente lo decide con una llamada barata), aparece una píldora
`✦ Rutador`. Al abrirla, dos opciones:

- **Nueva sesión (mismo workspace)** — crea un agente hermano en el mismo workspace con la tarea como primer prompt y vacía el composer.
- **Subagente aquí** — manda la tarea al agente actual pidiéndole que la ejecute con su herramienta `Agent`, y vacía el composer.

Molde calcado de `paseo-sugiere` (misma píldora de composer). El server solo responde `task: true/false` con una llamada al residente
vía **LiteLLM** (base + token de la config del daemon); el router local `qwen38-off` que usa sugiere no está levantado en paseo-0. Toda la
detección y el ruteo viven en el client. Si no hay ruta al residente, no sale la píldora (nunca un error).

## Desarrollo

```bash
npm install
npm run typecheck
npm test
```
