import type { PluginClientContext } from "@getpaseo/plugin/client";
import { addSessionCards } from "./client/tarjeta.tsx";
import { addComposerPills } from "./client/pildora.tsx";

export default function contribute(client: PluginClientContext) {
  const offCards = addSessionCards(client);
  const offPills = addComposerPills(client);
  return () => {
    offCards();
    offPills();
  };
}
