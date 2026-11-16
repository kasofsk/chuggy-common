/**
 * The planes a decision made by feature is held against: every release of
 * major 1 naming no features, and each of them again with a list that names
 * the feature and with one that leaves it out.
 *
 * A PLANE NAMING NO FEATURES IS READ AS BEFORE FEATURES WERE LISTED: it takes a
 * feature from the version of its major the feature first shipped in, and a
 * feature with no version not at all. That rule is written here rather than
 * asked of the contract, so a client that stops following it fails.
 */

import {
  workerContractFeatures,
  workerContractFeaturesHeader,
  workerContractFeaturesText,
  workerContractHeader,
  workerContractRelease,
  workerContractVersionOf,
} from "@chuggy/worker-contract/workerContract";

/** Every release of major 1 from the first to one past the one spoken today, as a release header carries it. */
export function releasesOfMajorOne() {
  const { minor } = workerContractVersionOf(workerContractRelease);
  return Array.from({ length: minor + 2 }, (_, at) => `1.${String(at)}.0`);
}

/** Every feature of the contract's roster but `feature`. */
export function featuresWithout(feature) {
  return Object.keys(workerContractFeatures).filter(
    (named) => named !== feature,
  );
}

/**
 * Whether `plane`, a release and the features it lists, takes `feature`: by
 * its list where it lists any, and otherwise by its release.
 */
export function planeTakes(plane, feature) {
  if (plane.features !== undefined) return plane.features.includes(feature);
  const spoken = workerContractVersionOf(plane.release);
  const first = workerContractFeatures[feature];
  if (first === undefined) return false;
  return spoken.major === first.major && spoken.minor >= first.minor;
}

/**
 * Each plane `feature` is decided against, with whether it takes it: every
 * release naming no features, and each listing `feature` beside `alongside`,
 * and listing every other feature.
 */
export function planesDeciding(feature, alongside = []) {
  return releasesOfMajorOne().flatMap((release) =>
    [
      { release, features: undefined },
      { release, features: [...alongside, feature] },
      { release, features: featuresWithout(feature) },
    ].map((plane) => ({ ...plane, takes: planeTakes(plane, feature) })),
  );
}

/** A plane's headers naming its release and listing its features, none where it lists none. */
export function planeHeaders({ release, features }) {
  return {
    [workerContractHeader]: release,
    ...(features === undefined
      ? {}
      : {
          [workerContractFeaturesHeader]: workerContractFeaturesText(features),
        }),
  };
}

/** A plane as a case names it, for an assertion's message. */
export function planeNamed({ release, features }) {
  return features === undefined
    ? `${release} listing nothing`
    : `${release} listing ${features.join(", ")}`;
}
