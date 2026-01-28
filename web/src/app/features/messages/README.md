# Messages V2 (messages)

This directory contains the new, modularized message flow implementation.
It replaces the legacy monolithic `messages.js`.

## Migration Strategy
We are progressively migrating functions from `messages.js` to this directory.
New logic should strictly live here or in `messages-flow/`.

## Structure
- `index.js`: Common utilities and re-exports.
- (Future modules to be added)
