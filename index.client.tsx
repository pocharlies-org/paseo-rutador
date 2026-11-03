import type { PluginClientContext } from "@getpaseo/plugin/client";
import { addSessionCards } from "./client/tarjeta.tsx";

export default function contribute(client: PluginClientContext) {
  return addSessionCards(client);
}
