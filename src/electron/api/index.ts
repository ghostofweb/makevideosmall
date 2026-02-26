import { registerSystemAPIs } from "./system.js";
import { registerVideoAPIs } from "./video.js";

export function registerAllIPCs() {
  console.log("⚙️ Booting Cognitive Engine IPC Hooks...");
  registerSystemAPIs();
  registerVideoAPIs();
}