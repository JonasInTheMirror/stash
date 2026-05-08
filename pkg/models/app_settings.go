package models

import "context"

type AppSettingsReaderWriter interface {
	GetSetting(ctx context.Context, key string) (string, error)
	SetSetting(ctx context.Context, key, value string) error
	AllSettings(ctx context.Context) (map[string]string, error)
}
