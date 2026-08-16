const fs = require('node:fs');
const path = require('node:path');

function createDataStore(filePath = path.join(__dirname, 'filtered-data.json')) {
  const targetPath = path.resolve(filePath);

  function ensureFile() {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, '[]', 'utf8');
    }
  }

  function read() {
    ensureFile();
    try {
      const raw = fs.readFileSync(targetPath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function write(records) {
    ensureFile();
    fs.writeFileSync(targetPath, JSON.stringify(records, null, 2), 'utf8');
  }

  return {
    list() {
      return read();
    },
    get(id) {
      return read().find((item) => String(item.id) === String(id)) || null;
    },
    upsert(record) {
      const records = read();
      const index = records.findIndex((item) => String(item.id) === String(record.id));
      const nextRecord = {
        ...record,
        id: String(record.id || `record-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`),
        updatedAt: new Date().toISOString(),
      };

      if (index >= 0) {
        records[index] = { ...records[index], ...nextRecord };
      } else {
        records.push({
          ...nextRecord,
          createdAt: record.createdAt || new Date().toISOString(),
        });
      }

      write(records);
      return nextRecord;
    },
    remove(id) {
      const nextRecords = read().filter((item) => String(item.id) !== String(id));
      write(nextRecords);
      return nextRecords;
    },
    replaceAll(records) {
      const sanitized = Array.isArray(records) ? records : [];
      write(sanitized);
      return sanitized;
    },
  };
}

module.exports = { createDataStore };
