/**
 * logger.js
 * -----------------------------------------------------------
 * Ghi log ra file (logs/YYYY-MM-DD.log) + console, có timestamp.
 * Dùng chung cho main.js.
 * -----------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function logFilePath() {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `${d}.log`);
}

function write(level, item, message) {
  const line = `[${timestamp()}] [${level}] [item=${item}] ${message}`;
  console.log(line);
  fs.appendFileSync(logFilePath(), line + '\n');
}

module.exports = {
  info: (item, msg) => write('INFO', item, msg),
  saved: (item, msg) => write('SAVED', item, msg),
  skippedMissing: (item, msg) => write('SKIP_MISSING', item, msg),
  skippedInvalid: (item, msg) => write('SKIP_INVALID', item, msg),
  pendingReview: (item, msg) => write('CAN_XEM_LAI', item, msg),
  incomplete: (item, msg) => write('CHUA_HOAN_THIEN', item, msg),
  signed: (item, msg) => write('DA_KY_HO_SO', item, msg),
  warn: (item, msg) => write('WARN', item, msg),
  error: (item, msg) => write('ERROR', item, msg),
};
