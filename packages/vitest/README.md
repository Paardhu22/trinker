# @trinker_vul/vitest

Run [Trinker](https://github.com/Paardhu22/trinker) security scans inside your own test suite.

```ts
import { assertSecure } from "@trinker_vul/vitest";
assertSecure(result); // fails on a confirmed finding AND on a check that never ran
```

Or as matchers:

```ts
import "@trinker_vul/vitest/setup";            // Vitest; for Jest: expect.extend(trinkerMatchers)
expect(result).toBeSecure();
```

Also: `toBeCompleteScan`, `toHaveNoConfirmedFindings`, `toHaveFindingIds`.
