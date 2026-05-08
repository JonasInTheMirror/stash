package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

const appSettingsTable = "app_settings"

type AppSettingsStore struct{}

func NewAppSettingsStore() *AppSettingsStore {
	return &AppSettingsStore{}
}

func (s *AppSettingsStore) GetSetting(ctx context.Context, key string) (string, error) {
	var value string
	q := `SELECT value FROM app_settings WHERE key = ?`
	err := dbWrapper.Get(ctx, &value, q, key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return value, err
}

func (s *AppSettingsStore) SetSetting(ctx context.Context, key, value string) error {
	q := `INSERT INTO app_settings (key, value, updated_at)
	      VALUES (?, ?, ?)
	      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
	_, err := dbWrapper.Exec(ctx, q, key, value, time.Now().UTC().Format(time.RFC3339))
	return err
}

func (s *AppSettingsStore) AllSettings(ctx context.Context) (map[string]string, error) {
	type row struct {
		Key   string `db:"key"`
		Value string `db:"value"`
	}
	var rows []row
	q := `SELECT key, value FROM app_settings`
	if err := dbWrapper.Select(ctx, &rows, q); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.Key] = r.Value
	}
	return out, nil
}
