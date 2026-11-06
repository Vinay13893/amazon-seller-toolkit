// Node-only tests and the Preview check run outside Next's server bundler.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'server-only' ? 'next/dist/compiled/server-only/empty.js' : specifier, context)
  },
})
