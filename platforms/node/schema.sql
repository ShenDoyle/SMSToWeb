-- SMS Gateway D1 schema
-- 设备表：device 列存 App 模板 name 字段（自定义设备名），device+sim 唯一；alias 为可选别名
CREATE TABLE IF NOT EXISTS devices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device     TEXT    NOT NULL DEFAULT 'unknown',
  sim        TEXT    NOT NULL DEFAULT '',
  alias      TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_key ON devices(device, sim);

-- 消息表：30 天保留，超期由 cron 清理；source 区分来源（sms=短信 / notify=通用推送，可自定义）
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER NOT NULL REFERENCES devices(id),
  sender      TEXT    NOT NULL DEFAULT '',
  content     TEXT    NOT NULL DEFAULT '',
  received_at TEXT    NOT NULL,
  source      TEXT    NOT NULL DEFAULT 'sms',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_device_time ON messages(device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(received_at);
-- 去重：同设备+发件人+内容+秒级时间 不重复入库
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup
  ON messages(device_id, sender, content, received_at);
-- 来源筛选索引
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source, received_at DESC);

-- 已有库升级：为旧 messages 表补 source 列（新库执行上面的建表已包含，此句幂等报错可忽略）
-- ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'sms';
-- 已有库升级（软删除）：为旧 messages 表补 deleted_at 列（新库建表已包含；D1/Turso 旧库需手动执行一次）
-- ALTER TABLE messages ADD COLUMN deleted_at TEXT;
