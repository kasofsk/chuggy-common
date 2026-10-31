/**
 * A clock a suite hands a transport as its `wait` and its `now`. A pause is
 * taken at once and moves the clock by its length, so how long a plane was
 * away is measured without being waited for. `pauses` is each one asked for,
 * in order. It reads `startMs` until the first pause moves it.
 */
export function pausedClock(startMs = 0) {
  const pauses = [];
  let elapsed = startMs;
  return {
    pauses,
    now: () => elapsed,
    wait: async (milliseconds) => {
      pauses.push(milliseconds);
      elapsed += milliseconds;
    },
  };
}
