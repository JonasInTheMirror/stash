CREATE TABLE IF NOT EXISTS `app_settings` (
  `key`        varchar(255) NOT NULL PRIMARY KEY,
  `value`      text,
  `updated_at` datetime NOT NULL
);
