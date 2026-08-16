const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDataStore } = require('../data-service');

test('createDataStore should add and list records', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-data-store-'));
  const filePath = path.join(tempDir, 'records.json');
  const store = createDataStore(filePath);

  store.upsert({
    id: 'R-001',
    patientName: 'Nguyễn Văn A',
    status: 'pending',
    note: 'Chờ duyệt',
    createdAt: new Date().toISOString(),
  });

  const records = store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].patientName, 'Nguyễn Văn A');

  store.upsert({
    id: 'R-001',
    patientName: 'Nguyễn Văn A',
    status: 'approved',
    note: 'Đã duyệt',
    createdAt: records[0].createdAt,
  });

  const updated = store.list();
  assert.equal(updated.length, 1);
  assert.equal(updated[0].status, 'approved');

  store.remove('R-001');
  assert.equal(store.list().length, 0);
});
