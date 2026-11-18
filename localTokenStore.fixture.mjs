/**
 * One process asking a sign-in for a token `count` times against `site`,
 * under the shared store at `directory`, its clock at `nowMs` where given:
 * `node localTokenStore.fixture.mjs <site> <directory> <count> [nowMs]`. Each
 * call answered with a device sign-in writes its link and code as a line of
 * JSON.
 */
import { argv, stdout } from "node:process";
import { URL } from "node:url";

import { LocalSignInNeeded, localSignIn } from "./localSignIn.mjs";
import { localTokenStore } from "./localTokenStore.mjs";

const [site, directory, count, nowMs] = argv.slice(2);
const signIn = localSignIn(
  site,
  localTokenStore({ directory, origin: new URL(site).origin }),
  { nowMs: nowMs === undefined ? undefined : () => Number(nowMs) },
);
for (let called = 0; called < Number(count); called += 1)
  try {
    await signIn.token();
  } catch (failure) {
    if (!(failure instanceof LocalSignInNeeded)) throw failure;
    stdout.write(
      `${JSON.stringify({ deviceUrl: failure.deviceUrl, userCode: failure.userCode })}\n`,
    );
  }
await signIn.close();
