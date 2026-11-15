/**
 * One process renewing a sign-in `count` times against `site`, under the
 * shared store at `directory`: `node localTokenStore.fixture.mjs <site>
 * <directory> <count>`.
 */
import { argv } from "node:process";
import { URL } from "node:url";

import { localSignIn } from "./localSignIn.mjs";
import { localTokenStore } from "./localTokenStore.mjs";

const [site, directory, count] = argv.slice(2);
const signIn = localSignIn(
  site,
  localTokenStore({ directory, origin: new URL(site).origin }),
);
for (let renewed = 0; renewed < Number(count); renewed += 1)
  await signIn.token();
signIn.close();
