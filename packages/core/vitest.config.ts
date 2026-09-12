import { defineConfig } from 'vitest/config'

// Pinned to vitest ^4 (not the newer ^5) repo-wide because 5.0.0 dropped
// the `bench` API this package's bench/ suite relies on as the closest
// Node analog to `go test -bench` — see the root README.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    benchmark: {
      include: ['bench/**/*.bench.ts'],
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
})
