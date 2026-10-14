import { propagateStaleRecords } from '../src/runtime/session';
import { turnRecord } from './fixtures';

describe('manual record lineage', () => {
  it('propagates stale state through manual and extracted descendants', () => {
    const extracted = turnRecord({
      recordId: 'record-1',
      application: { status: 'stale', appliedAt: 1 },
      audit: { mode: 'standard', status: 'stale', violations: [], model: null }
    });
    const manual = turnRecord({
      kind: 'manual',
      recordId: 'record-2',
      parentRecordId: 'record-1'
    });
    const child = turnRecord({
      recordId: 'record-3',
      parentRecordId: 'record-2'
    });

    expect(propagateStaleRecords([extracted, manual, child])).toBe(2);
    expect(manual.application.status).toBe('stale');
    expect(child.audit.status).toBe('stale');
  });
});
