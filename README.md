# paseo-rutador

Plugin de Paseo que ofrece sesiones nuevas igual que Claude Desktop. Es el agente quien decide, con
las mismas reglas que Desktop ("Starting other sessions"), y la conversación muestra una tarjeta.

- **Oferta** (`initiation: "offer"`): cuando le pides una tarea propia, el primer mensaje del agente es
  `start_session` con un título y nada más. Sale la tarjeta **«Nueva sesión» / «Hazlo aquí»** y la llamada espera tu
  respuesta. «Hazlo aquí»: el agente sigue en esta sesión. «Nueva sesión»: el agente escribe el brief y se abre un
  agente hermano en el mismo workspace (mismo proveedor, modo y nivel de razonamiento). Si escribes otro
  mensaje en vez de contestar, la oferta se cierra. Si Paseo se reinicia mientras la tarjeta espera, la llamada del
  agente se pierde, pero los botones siguen funcionando: tu elección le llega al agente como mensaje (con el modelo que
  elegiste) y la tarjeta avisa de que Paseo se reinició.
- **Modelo**: la tarjeta trae «Modelo: … ▾» con los modelos del proveedor de la sesión (Opus, qwen38 local, GPT…).
  Por defecto, el de esta sesión; si eliges otro, la sesión nueva arranca con él y su nivel de razonamiento por defecto.
- **Lo pediste tú** (`"user_asked"`): «ábrelo en otra sesión» la abre ya.
- **Propuesta** (`"own_initiative"`): una tarea que el agente propone por su cuenta (un seguimiento, algo que vio de
  paso) sale como tarjeta **«Nueva tarea»** con «Empezar»; como mucho tres por turno. `dismiss_task` la retira y la tarjeta pasa a «Retirada» al momento.
- Lo rápido (una pregunta, una edición, unas pocas herramientas) se queda en la sesión.
- **Trabajo del que depende el encargo actual**: se hace aquí, con un subagente que devuelve su informe o con un hijo de Paseo (`create_agent`, `notifyOnFinish: true`). `start_session` sigue siendo para trabajos independientes, no para piezas que el coordinador necesita integrar. Una sesión productora existente se continúa, no se duplica: el fin de su turno puede ser un resultado parcial, no una entrega verificada.

## Coordinación explícita

Para un productor independiente que ya existe en el mismo workspace, `coordinate_session` ofrece cuatro acciones:

- `link`: registra `agent_id` y `objective` (entregable y criterios), con un solo coordinador. No envía trabajo ni activa autopilot.
- `continue`: envía `prompt` al productor parado, con `request_id` UUID estable. Reutilizar ese ID no repite el envío.
- `status`: consulta el resultado retenido cuando hay un evento o una incidencia; no se usa para sondear.
- `release`: libera la responsabilidad tras verificar la entrega; no para ni archiva sesiones.

Mientras está trabajando, el coordinador cierra con `ESPERA: sesion <agent_id>` y recibe un `EVENTO` por fin de turno o interrupción.
El fin de turno puede ser parcial: el coordinador verifica los criterios y continúa al mismo productor. Los hijos nativos conservan su
`notifyOnFinish`; no se enlazan también aquí. El productor enlazado debe tener autopilot apagado, y `paseo-sugiere` respeta su propietario.

El registro atómico `$PASEO_HOME/rutador-coordinaciones.json` conserva propiedad, resultados e IDs de envío. Tras recarga se reconcilia
con el historial y el estado real al primer hook o RPC que proporciona la API de Paseo; no hay temporizador ni sondeo de modelos.
Un envío de admisión incierta nunca se repite automáticamente. Permisos, intervención humana, cancelación o archivado pausan el enlace;
las incidencias quedan en el historial del coordinador. No se desarchiva ni se contesta un permiso desde la coordinación.

Límites deliberados: no hay coordinación anidada, no se toma control de hijos nativos, y una finalización perdida durante la desconexión
solo se acepta si el snapshot conserva una señal nueva de finalización; si no, se conserva una incidencia para revisión, no una entrega falsa.
La espera `sesion` necesita que el contrato de cierre del host y el parser del autopilot la admitan; desplegar solo este plugin no basta.

## Cómo está hecho

- **Servidor**: en `agent.session_open` (sesión creada o reanudada, solo proveedor `claude`) añade su propio servidor
  MCP `rutador` (HTTP en 127.0.0.1, un URL por agente, token bearer, `alwaysLoad`) con `start_session` y
  `dismiss_task`. Las reglas de Desktop van en las `instructions` del servidor, que Claude Code mete en el prompt de
  sistema. No es una tool de plugin de Paseo porque el daemon corta esas a los 10 minutos y una oferta espera lo que
  haga falta: la respuesta de `tools/call` es un stream SSE que manda `notifications/progress` cada 15 s (Claude Code
  corta una herramienta que pasa 300 s sin respuesta ni progreso). Puerto y token se guardan en
  `$PASEO_HOME/rutador-mcp.json` y se reutilizan al recargar el plugin, así que las sesiones abiertas no se quedan sin
  las tools. Textos en `server/textos.ts`; la máquina de
  estados de ofertas y propuestas, sin I/O, en `server/sesiones.ts` (con su test). Cómo acabó cada propuesta
  (empezada o retirada) se guarda en `$PASEO_HOME/rutador-tareas.json` (`server/registro.ts`), para que tras un
  reinicio del daemon una tarjeta retirada o ya empezada no arranque nada. Solo las dos tools de tarjetas (`start_session`
  y `dismiss_task`) se aprueban en `agent.permission_requested`, porque la tarjeta ya es la pregunta. Otras operaciones
  no heredan esa aprobación por compartir el prefijo del plugin.
- **Cliente**: un transformer convierte la llamada `mcp__rutador__start_session` en la tarjeta (`client/tarjeta.tsx`);
  los botones van por RPC al servidor (`shared/contract.ts`). `paseo-plan` deja pasar las llamadas `mcp__rutador__*`
  (su transformer se queda con todos los demás tool calls).
- **Píldora del composer** (`client/pildora.tsx`, `client/pendientes.ts`): bajo el chat, una píldora por agente con lo
  pendiente —propuestas sin empezar y ofertas sin responder— en un popover que reutiliza la tarjeta y sus acciones. Al
  abrir el cliente se rehidrata con la API tipada (`agents.list` suscrito + `timeline.refetch` + RPC `estado`), no solo
  como side effect del transformer: si las filas no están montadas, el transformer no corre. El historial es el registro
  de las propuestas anteriores a un reinicio (lo arrancable lo decide el servidor con `server/registro.ts`, así que no se
  duplican acciones); una rehidratación vieja no pisa un cambio en vivo, y al acabar el turno de un agente que usa el
  rutador la píldora se refresca.
- Al habilitar o recargar el plugin, cada sesión parada recarga su proceso antes de su siguiente mensaje y entonces
  recibe el servidor; las que están trabajando siguen como estaban hasta terminar.

## Desarrollo

```bash
npm install
npm run typecheck
npm test
```
