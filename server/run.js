'use strict';
const path = require('path');
const DB = require('./db');
const { buildSeed } = require('./seed');
const { createApp } = require('./app');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');
const db = new DB(dbFile);
if (db.data.gen === 0) {
  db.loadSeed(buildSeed());
  console.log('已初始化种子数据');
}

const server = createApp({ db, rootDir: path.join(__dirname, '..') });
const port = Number(process.env.PORT || 8080);
server.listen(port, () => {
  console.log(`时令美食地图服务已启动（数据代 gen=${db.data.gen}）`);
  console.log(`  访客地图:  http://localhost:${port}/map.html`);
  console.log(`  编辑后台:  http://localhost:${port}/admin.html`);
});
