import { expect } from "vitest";
import { trinkerMatchers } from "./index.js";

expect.extend(trinkerMatchers);

interface TrinkerMatchers<R = unknown> {
  /** Every planned check reached a verdict and none confirmed an unaccepted violation. */
  toBeSecure(): R;
  /** Every planned check reached a verdict. */
  toBeCompleteScan(): R;
  toHaveNoConfirmedFindings(): R;
  toHaveFindingIds(expected: readonly string[]): R;
}

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-explicit-any -- declaration merging must repeat Vitest's own signature
  interface Assertion<T = any> extends TrinkerMatchers<T> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- as above
  interface AsymmetricMatchersContaining extends TrinkerMatchers {}
}
