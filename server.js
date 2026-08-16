const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createDataStore } = require('./data-service');
const {
  readFilterConfig,
  saveFilterConfig,
  readSendStoreFilterConfig,
  saveSendStoreFilterConfig,
} = require('./filter-config');

const app = express();
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const store = createDataStore(path.join(__dirname, 'filtered-data.json'));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/records', (req, res) => {
  const records = store.list();
  res.json(records);
});

app.get('/api/filter-config', (req, res) => {
  res.json(readFilterConfig());
});

app.get('/api/send-store-filter-config', (req, res) => {
  res.json(readSendStoreFilterConfig());
});

app.get('/api/khoa-options', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'khoa-options.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      res.status(500).json({ error: 'Không thể đọc danh sách khoa.' });
      return;
    }

    try {
      const parsed = JSON.parse(data);
      res.json(Array.isArray(parsed) ? parsed : []);
    } catch (error) {
      res.status(500).json({ error: 'Dữ liệu khoa không hợp lệ.' });
    }
  });
});

app.post('/api/filter-config', (req, res) => {
  const payload = req.body || {};
  const config = saveFilterConfig(payload);
  res.json(config);
});

app.post('/api/send-store-filter-config', (req, res) => {
  const payload = req.body || {};
  const config = saveSendStoreFilterConfig(payload);
  res.json(config);
});

app.post('/api/run-main', (req, res) => {
  const payload = req.body || {};
  const filters = saveFilterConfig(payload);

  const child = spawn('node', ['main.js'], {
    cwd: __dirname,
    env: { ...process.env, FILTER_CONFIG: JSON.stringify(filters) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let error = '';

  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    error += chunk.toString();
  });

  child.on('close', (code) => {
    res.json({
      ok: code === 0,
      code,
      output,
      error,
      filters,
    });
  });
});

app.post('/api/run-send-store', (req, res) => {
  const payload = req.body || {};
  const filters = saveSendStoreFilterConfig(payload);

  const child = spawn('node', ['send-store-main.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      SEND_STORE_FILTER_CONFIG: JSON.stringify(filters),
      FILTER_CONFIG: JSON.stringify(readFilterConfig()),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let error = '';

  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    error += chunk.toString();
  });

  child.on('close', (code) => {
    res.json({
      ok: code === 0,
      code,
      output,
      error,
      filters,
    });
  });
});

app.post('/api/records', (req, res) => {
  const payload = req.body || {};
  const record = store.upsert(payload);
  res.status(201).json(record);
});

app.put('/api/records/:id', (req, res) => {
  const payload = req.body || {};
  const record = store.upsert({ ...payload, id: req.params.id });
  res.json(record);
});

app.delete('/api/records/:id', (req, res) => {
  const records = store.remove(req.params.id);
  res.json({ removed: true, records });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'UI is running' });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, host, () => {
  console.log(`UI đang chạy tại http://${host}:${port}`);
  console.log(`Mở trong trình duyệt: http://localhost:${port}`);
});
