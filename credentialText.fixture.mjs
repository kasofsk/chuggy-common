/**
 * Texts and credentials drawn to break a scrub that reads a text in pieces:
 * few letters, so one credential is another's head, tail or middle and a text
 * is full of their beginnings. Every draw comes from a seed, so a failing case
 * is named by it and runs again.
 */

import { credentialScrubCharsMin } from "./runEvidence.mjs";

/** A generator of numbers in [0, 1) that `seed` decides. */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/** A whole number in [0, bound). */
export const drawnBelow = (random, bound) => Math.floor(random() * bound);
const below = drawnBelow;
const oneOf = (random, values) => values[below(random, values.length)];

const letters = ["a", "b", "a", "b", "c", "-"];
const lettersOf = (random, length) =>
  Array.from({ length }, () => oneOf(random, letters)).join("");

/** What the scrub writes in a credential's place, which a credential may itself be part of. */
const redactionPart = "redacted credential";

/**
 * A few credentials, each long enough to be scrubbed: drawn letters, one
 * letter pair repeated, one holding another, one beginning where another
 * ends, and part of the scrub's own redaction.
 */
export function drawnSecrets(random) {
  const secrets = [];
  const count = 1 + below(random, 4);
  while (secrets.length < count) {
    const length = credentialScrubCharsMin + below(random, 8);
    const other = secrets.length > 0 ? oneOf(random, secrets) : undefined;
    const shape = below(random, other === undefined ? 2 : 5);
    if (shape === 0) secrets.push(lettersOf(random, length));
    else if (shape === 1)
      secrets.push(lettersOf(random, 2).repeat(length).slice(0, length));
    else if (shape === 2)
      secrets.push(`${lettersOf(random, 3)}${other}${lettersOf(random, 3)}`);
    else if (shape === 3)
      secrets.push(
        `${other.slice(-(1 + below(random, other.length - 1)))}${lettersOf(random, length)}`,
      );
    else secrets.push(redactionPart);
  }
  return secrets;
}

/** One piece of a text: letters, a credential, or a credential cut short, cut into or one letter off. */
function drawnPiece(random, secrets) {
  const secret = oneOf(random, secrets);
  const at = below(random, secret.length);
  switch (below(random, 8)) {
    case 0:
    case 1:
      return secret;
    case 2:
      return secret.slice(0, at);
    case 3:
      return secret.slice(at);
    case 4:
      return `${secret.slice(0, at)}${oneOf(random, letters)}${secret.slice(at + 1)}`;
    case 5:
      return oneOf(random, ["\u{1f426}", " ", "\n", "é"]);
    default:
      return lettersOf(random, 1 + below(random, 6));
  }
}

/** A text of up to `piecesMax` pieces, credentials and their parts among them. */
export function drawnText(random, secrets, piecesMax) {
  const pieces = 1 + below(random, piecesMax);
  return Array.from({ length: pieces }, () => drawnPiece(random, secrets)).join(
    "",
  );
}

/** `text` cut into pieces at drawn places, a surrogate pair's middle among them. */
export function drawnCuts(random, text, pieceCharsMax) {
  const pieces = [];
  for (let at = 0; at < text.length;) {
    const length = 1 + below(random, pieceCharsMax);
    pieces.push(text.slice(at, at + length));
    at += length;
  }
  return pieces;
}
