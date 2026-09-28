/**
 * A launched pod's minted credential directory, moved to the one
 * `CHUG_SUITE_MINTED_DIRECTORY` names. Loaded with `--import`, this module
 * answers for the contract's environment module wherever the pod imports it,
 * so a suite can launch a pod on a machine that mounts nothing at the
 * contract's path.
 */
import { registerHooks } from "node:module";

export * from "@chuggy/worker-contract/workerEnvironment";
export const mintedCredentialDirectory =
  process.env["CHUG_SUITE_MINTED_DIRECTORY"];

const environmentModule = "@chuggy/worker-contract/workerEnvironment";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === environmentModule &&
      context.parentURL !== import.meta.url
      ? { url: import.meta.url, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
