import { describe, expect, it, vi } from 'vitest';
import { processAutomationJob } from './automation.js';

// The processor only routes job types to service functions — stub the service
// layer and assert the wiring (incl. the Phase 19 `lifecycle-sweep`).
const h = vi.hoisted(() => ({
  runAutomationSweepJob: vi.fn(async () => ({ swept: 0 })),
  runAutomationRetrySweepJob: vi.fn(async () => ({ retried: 0 })),
  executeAutomationRun: vi.fn(async () => ({ runId: 'r1', status: 'SUCCEEDED' })),
  runLifecycleSweepJob: vi.fn(async () => ({ orgsPurged: 0, usersPurged: 0 })),
}));

vi.mock('@growth-agent/services', () => ({
  automation: {
    runAutomationSweepJob: h.runAutomationSweepJob,
    runAutomationRetrySweepJob: h.runAutomationRetrySweepJob,
    executeAutomationRun: h.executeAutomationRun,
  },
  organizations: { runLifecycleSweepJob: h.runLifecycleSweepJob },
}));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function job(data: unknown) {
  return { id: 'j1', data } as never;
}

describe('processAutomationJob', () => {
  it('routes sweep / retry-sweep / execute / lifecycle-sweep', async () => {
    await processAutomationJob(job({ type: 'sweep' }));
    expect(h.runAutomationSweepJob).toHaveBeenCalledOnce();

    await processAutomationJob(job({ type: 'retry-sweep' }));
    expect(h.runAutomationRetrySweepJob).toHaveBeenCalledOnce();

    await processAutomationJob(job({ type: 'execute', runId: 'r1' }));
    expect(h.executeAutomationRun).toHaveBeenCalledWith({ runId: 'r1' });

    await processAutomationJob(job({ type: 'lifecycle-sweep' }));
    expect(h.runLifecycleSweepJob).toHaveBeenCalledOnce();
  });

  it('throws on an unknown job type', async () => {
    await expect(processAutomationJob(job({ type: 'nope' }))).rejects.toThrow(/unknown automation/);
  });
});
