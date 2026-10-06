// The packaged self-test's look at Node's own trust store (SR-05): how many certificates
// NODE_EXTRA_CA_CERTS added to it. A packaged app's answer is 0 even when it was started with that
// variable naming a CA file: Electron's SetNodeOptions (shell/common/node_bindings.cc) unsets it
// before Node reads it while the EnableNodeOptionsEnvironmentVariable fuse is off (scripts/fuses.cjs).
// It reads a list and never connects (tests/byok/egress_test.mjs names it).
import tls from 'node:tls';

/** The certificates Node added from NODE_EXTRA_CA_CERTS, or null where this Node can't say. */
export function extraCaCount() {
  try { return typeof tls.getCACertificates === 'function' ? tls.getCACertificates('extra').length : null; } catch { return null; }
}
