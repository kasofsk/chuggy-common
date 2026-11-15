/**
 * One process's renewal of the sign-in in the shared store at `argv[2]` for
 * the site at `argv[3]`: it says `ready` before it asks for a token, then the
 * access token it was given.
 */
import process from "node:process";
import { URL } from "node:url";

import { localSignIn } from "./localSignIn.mjs";
import { localTokenStore } from "./localTokenStore.mjs";

const [directory, site] = process.argv.slice(2);
const signIn = localSignIn(
  site,
  localTokenStore(directory, new URL(site).origin),
);
process.stdout.write("ready\n");
process.stdout.write(`${await signIn.token()}\n`);
