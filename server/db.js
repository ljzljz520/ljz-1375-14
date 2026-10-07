'use strict';
const fs = require('fs');
const path = require('path');

const TABLES = ['stalls', 'ingredients', 'seasons', 'offerings', 'hours', 'closures'];

function emptyTables() {
  return Object.fromEntries(TABLES.map((t) => [t, {}]));
}

function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

// JSON 文件存储：drafts（编辑草稿）与 live（线上快照）分离；
// 发布 = 草稿整体晋升为 live 且 gen+1，索引/卡片/地图读取同一代数据。
class DB {
  constructor(file) {
    this.file = file || null;
    if (this.file && fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } else {
      this.data = {
        gen: 0, seq: 0,
        live: emptyTables(), drafts: emptyTables(),
        queue: {}, audit: [], edit_log: [],
      };
    }
    if (!this.data.drafts || Object.keys(this.data.drafts.stalls || {}).length === 0) {
      this.data.drafts = deepCopy(this.data.live);
    }
  }

  loadSeed(seed) {
    this.data = {
      gen: 0, seq: 0, queue: {}, audit: [], edit_log: [],
      ...seed,
    };
    this.data.drafts = deepCopy(this.data.live);
    this.save();
  }

  nextId(prefix) {
    this.data.seq += 1;
    return `${prefix}_${this.data.seq}`;
  }

  logEdit(entry) {
    this.data.edit_log.push({ at: new Date().toISOString(), ...entry });
    if (this.data.edit_log.length > 200) this.data.edit_log.shift();
  }

  // 发布：草稿 -> 线上，代号 +1（同代切换的原子点）
  publish({ by, note }) {
    this.data.live = deepCopy(this.data.drafts);
    this.data.gen += 1;
    this.data.audit.push({
      gen: this.data.gen,
      at: new Date().toISOString(),
      by,
      note: note || '',
    });
    this.save();
    return this.data.gen;
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file); // 原子替换
  }
}

module.exports = DB;
module.exports.TABLES = TABLES;
