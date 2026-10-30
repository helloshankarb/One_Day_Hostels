/**
 * Runs the local Cashfree API stub for manual UI walkthroughs against the emulators (project demo-odh-test).
 * Usage: node functions/scripts/cashfree-stub-server.ts
 */
import { CashfreeStub } from '../test/emulator/cashfree-stub.ts';

const stub = new CashfreeStub();
await stub.start(9911);
console.log('Cashfree stub listening on http://127.0.0.1:9911/pg (controls under /__stub/)');
