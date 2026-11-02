import type { PluginClientContext } from "@getpaseo/plugin/client";
import { addRutadorPill } from "./client/rutador-pill.tsx";

export default function contribute(client: PluginClientContext) {
  const pill = addRutadorPill(client);
  return () => pill();
}
