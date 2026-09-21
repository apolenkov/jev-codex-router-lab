import type { RouterInput } from "./contracts.js";
import { route } from "./router.js";
import type { SystemOneClientPort } from "./semantic-gateway.js";
import { TypeSafeGateway } from "./typesafe-gateway.js";

const input: RouterInput = {
  taskId: "synthetic-offline-example",
  taskRevision: 1,
  taskText: "Fix a synthetic parser regression without changing its public contract.",
  policyVersion: "offline-example-v1",
  catalogHash: "sha256:synthetic-catalog",
  explicitSkillIds: [],
  requiredSkillIds: ["systematic-debugging"],
  skills: [
    {
      id: "systematic-debugging",
      description: "Find the root cause before changing code.",
      excerpt: "Reproduce, isolate, and verify.",
    },
  ],
  contextFragments: [
    {
      id: "synthetic-protected-context",
      summary: "SYNTHETIC-PRIVATE-BODY",
      protected: true,
    },
  ],
};

let protectedBodyWasSent = false;
const fakeClient: SystemOneClientPort = {
  systemOne: async (request) => {
    protectedBodyWasSent = JSON.stringify(request).includes("SYNTHETIC-PRIVATE-BODY");
    throw new Error("synthetic offline service failure");
  },
};

const decision = await route(input, new TypeSafeGateway(fakeClient));
if (protectedBodyWasSent) {
  throw new Error("protected context crossed the semantic boundary");
}
console.log(JSON.stringify({ example: "offline-fake-gateway", fake: true, decision }, null, 2));
