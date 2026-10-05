/**
 * A clock a suite hands a transport as its `wait` and its `now`. A pause is
 * taken at once and moves the clock by its length, so how long a plane was
 * away is measured without being waited for. `pauses` is each one asked for,
 * in order.
 */
export function pausedClock() {
  const pauses = [];
  let elapsed = 0;
  return {
    pauses,
    now: () => elapsed,
    wait: async (milliseconds) => {
      pauses.push(milliseconds);
      elapsed += milliseconds;
    },
  };
}
