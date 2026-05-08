package manager

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/pkg/job"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
)

const (
	cloudTablePerformers  = "stash_performers"
	cloudTableStudios     = "stash_studios"
	cloudTableTags        = "stash_tags"
	cloudTableAppSettings = "stash_app_settings"
	cloudBatchSize        = 500
	cloudStorageSceneDir  = "scenes"
	cloudMetadataPackage  = "metadata/stash-metadata.zip"
)

type CloudSyncTask struct {
	isPush bool
}

func CreateCloudPushTask() *CloudSyncTask {
	return &CloudSyncTask{isPush: true}
}

func CreateCloudPullTask() *CloudSyncTask {
	return &CloudSyncTask{isPush: false}
}

func (t *CloudSyncTask) Execute(ctx context.Context, progress *job.Progress) error {
	cfg := config.GetInstance()
	supabaseURL := cfg.GetCloudSyncSupabaseURL()
	supabaseKey := cfg.GetCloudSyncSupabaseKey()
	supabaseBucket := cfg.GetCloudSyncSupabaseBucket()

	if supabaseURL == "" || supabaseKey == "" || supabaseBucket == "" {
		return fmt.Errorf("Supabase URL, Key, and Bucket must be configured for Cloud Sync")
	}

	c := &cloudClient{url: supabaseURL, key: supabaseKey, bucket: supabaseBucket}
	if err := c.ensureStorageBucket(ctx); err != nil {
		return err
	}

	if t.isPush {
		return t.push(ctx, progress, c)
	}
	return t.pull(ctx, progress, c)
}

// cloudClient handles Supabase REST calls.
type cloudClient struct {
	url    string
	key    string
	bucket string
}

func (c *cloudClient) ensureStorageBucket(ctx context.Context) error {
	endpoint := fmt.Sprintf("%s/storage/v1/bucket/%s", c.url, url.PathEscape(c.bucket))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("create bucket lookup request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("apikey", c.key)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("lookup storage bucket %s: %w", c.bucket, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		return nil
	}
	if resp.StatusCode != http.StatusNotFound {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("lookup storage bucket %s failed (%d): %s", c.bucket, resp.StatusCode, string(b))
	}

	body, err := json.Marshal(map[string]interface{}{
		"id":     c.bucket,
		"name":   c.bucket,
		"public": false,
	})
	if err != nil {
		return fmt.Errorf("marshal bucket create request: %w", err)
	}

	req, err = http.NewRequestWithContext(ctx, http.MethodPost, c.url+"/storage/v1/bucket", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create bucket request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("apikey", c.key)
	req.Header.Set("Content-Type", "application/json")

	resp, err = client.Do(req)
	if err != nil {
		return fmt.Errorf("create storage bucket %s: %w", c.bucket, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("create storage bucket %s failed (%d): %s", c.bucket, resp.StatusCode, string(b))
	}
	return nil
}

func (c *cloudClient) upsert(ctx context.Context, table string, rows interface{}) error {
	return c.upsertWithConflict(ctx, table, "", rows)
}

func (c *cloudClient) upsertWithConflict(ctx context.Context, table string, onConflict string, rows interface{}) error {
	body, err := json.Marshal(rows)
	if err != nil {
		return fmt.Errorf("marshal rows: %w", err)
	}

	endpoint := fmt.Sprintf("%s/rest/v1/%s", c.url, table)
	if onConflict != "" {
		endpoint += "?on_conflict=" + url.QueryEscape(onConflict)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("apikey", c.key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Prefer", "resolution=merge-duplicates,return=minimal")

	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("upsert %s: %w", table, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upsert %s failed (%d): %s", table, resp.StatusCode, string(b))
	}
	return nil
}

func (c *cloudClient) fetchSince(ctx context.Context, table, since string) ([]byte, error) {
	endpoint := fmt.Sprintf("%s/rest/v1/%s?select=*", c.url, table)
	if since != "" {
		endpoint += "&updated_at=gte." + url.QueryEscape(since)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("apikey", c.key)
	req.Header.Set("Prefer", "return=representation")

	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", table, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("fetch %s failed (%d): %s", table, resp.StatusCode, string(b))
	}

	return io.ReadAll(resp.Body)
}

func (c *cloudClient) uploadStorageJSON(ctx context.Context, objectPath string, row interface{}) error {
	body, err := json.Marshal(row)
	if err != nil {
		return fmt.Errorf("marshal storage object: %w", err)
	}

	endpoint := fmt.Sprintf("%s/storage/v1/object/%s/%s", c.url, url.PathEscape(c.bucket), objectPath)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create storage upload request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("apikey", c.key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-upsert", "true")

	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("upload storage object %s: %w", objectPath, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upload storage object %s failed (%d): %s", objectPath, resp.StatusCode, string(b))
	}
	return nil
}

func (c *cloudClient) uploadStorageFile(ctx context.Context, objectPath string, filePath string, contentType string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("open storage upload file %s: %w", filePath, err)
	}
	defer f.Close()

	endpoint := fmt.Sprintf("%s/storage/v1/object/%s/%s", c.url, url.PathEscape(c.bucket), objectPath)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, f)
	if err != nil {
		return fmt.Errorf("create storage upload request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("apikey", c.key)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("x-upsert", "true")

	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("upload storage object %s: %w", objectPath, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upload storage object %s failed (%d): %s", objectPath, resp.StatusCode, string(b))
	}
	return nil
}

func (c *cloudClient) downloadStorageFile(ctx context.Context, objectPath string, filePath string) error {
	endpoint := fmt.Sprintf("%s/storage/v1/object/%s/%s", c.url, url.PathEscape(c.bucket), objectPath)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("create storage download request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("apikey", c.key)

	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download storage object %s: %w", objectPath, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("download storage object %s failed (%d): %s", objectPath, resp.StatusCode, string(b))
	}

	out, err := os.Create(filePath)
	if err != nil {
		return fmt.Errorf("create storage download file %s: %w", filePath, err)
	}
	defer out.Close()

	if _, err := io.Copy(out, resp.Body); err != nil {
		return fmt.Errorf("write storage download file %s: %w", filePath, err)
	}
	return nil
}

type cloudStorageObject struct {
	Name      string `json:"name"`
	UpdatedAt string `json:"updated_at"`
}

func (c *cloudClient) listStorageObjects(ctx context.Context, prefix string, offset int) ([]cloudStorageObject, error) {
	body, err := json.Marshal(map[string]interface{}{
		"prefix": prefix,
		"limit":  cloudBatchSize,
		"offset": offset,
		"sortBy": map[string]string{"column": "name", "order": "asc"},
	})
	if err != nil {
		return nil, fmt.Errorf("marshal storage list request: %w", err)
	}

	endpoint := fmt.Sprintf("%s/storage/v1/object/list/%s", c.url, url.PathEscape(c.bucket))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create storage list request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("apikey", c.key)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("list storage objects: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("list storage objects failed (%d): %s", resp.StatusCode, string(b))
	}

	var objects []cloudStorageObject
	if err := json.NewDecoder(resp.Body).Decode(&objects); err != nil {
		return nil, fmt.Errorf("decode storage list response: %w", err)
	}
	return objects, nil
}

func (c *cloudClient) downloadStorageObject(ctx context.Context, objectPath string, row interface{}) error {
	endpoint := fmt.Sprintf("%s/storage/v1/object/%s/%s", c.url, url.PathEscape(c.bucket), objectPath)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("create storage download request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("apikey", c.key)

	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download storage object %s: %w", objectPath, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("download storage object %s failed (%d): %s", objectPath, resp.StatusCode, string(b))
	}

	if err := json.NewDecoder(resp.Body).Decode(row); err != nil {
		return fmt.Errorf("decode storage object %s: %w", objectPath, err)
	}
	return nil
}

func cloudSceneObjectPath(path string) string {
	return cloudStorageSceneDir + "/" + base64.RawURLEncoding.EncodeToString([]byte(path)) + ".json"
}

func cloudStorageObjectPath(prefix string, objectName string) string {
	if strings.HasPrefix(objectName, prefix+"/") {
		return objectName
	}
	return prefix + "/" + objectName
}

// Row types

type cloudSceneRow struct {
	Path         string   `json:"path"`
	Title        string   `json:"title"`
	Code         string   `json:"code"`
	Details      string   `json:"details"`
	Director     string   `json:"director"`
	Date         *string  `json:"date"`
	Rating       *int     `json:"rating"`
	Organized    bool     `json:"organized"`
	StudioID     *int     `json:"studio_id"`
	URLs         []string `json:"urls"`
	TagIDs       []int    `json:"tag_ids"`
	PerformerIDs []int    `json:"performer_ids"`
	UpdatedAt    string   `json:"updated_at"`
}

type cloudPerformerRow struct {
	ID             int      `json:"id"`
	Name           string   `json:"name"`
	Disambiguation string   `json:"disambiguation"`
	Gender         *string  `json:"gender"`
	Birthdate      *string  `json:"birthdate"`
	Ethnicity      string   `json:"ethnicity"`
	Country        string   `json:"country"`
	EyeColor       string   `json:"eye_color"`
	Height         *int     `json:"height"`
	Weight         *int     `json:"weight"`
	HairColor      string   `json:"hair_color"`
	Favorite       bool     `json:"favorite"`
	Rating         *int     `json:"rating"`
	Details        string   `json:"details"`
	URLs           []string `json:"urls"`
	TagIDs         []int    `json:"tag_ids"`
	Aliases        []string `json:"aliases"`
	UpdatedAt      string   `json:"updated_at"`
}

type cloudStudioRow struct {
	ID        int      `json:"id"`
	Name      string   `json:"name"`
	ParentID  *int     `json:"parent_id"`
	Rating    *int     `json:"rating"`
	Favorite  bool     `json:"favorite"`
	Details   string   `json:"details"`
	URLs      []string `json:"urls"`
	Aliases   []string `json:"aliases"`
	UpdatedAt string   `json:"updated_at"`
}

type cloudAppSettingsRow struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	UpdatedAt string `json:"updated_at"`
}

type cloudTagRow struct {
	ID          int      `json:"id"`
	Name        string   `json:"name"`
	SortName    string   `json:"sort_name"`
	Description string   `json:"description"`
	Favorite    bool     `json:"favorite"`
	Aliases     []string `json:"aliases"`
	ParentIDs   []int    `json:"parent_ids"`
	ChildIDs    []int    `json:"child_ids"`
	UpdatedAt   string   `json:"updated_at"`
}

func allPages() *models.FindFilterType {
	pp := -1
	return &models.FindFilterType{PerPage: &pp}
}

func tsFilter(since string) *models.TimestampCriterionInput {
	if since == "" {
		return nil
	}
	return &models.TimestampCriterionInput{
		Value:    since,
		Modifier: models.CriterionModifierGreaterThan,
	}
}

// push serializes all local entities changed since last push and upserts into Supabase.
func (t *CloudSyncTask) push(ctx context.Context, progress *job.Progress, c *cloudClient) error {
	progress.SetTotal(100)
	progress.SetProcessed(5)

	cfg := config.GetInstance()
	now := time.Now().UTC().Format(time.RFC3339)

	zipPath, cleanup, err := t.exportMetadataZip(ctx)
	if err != nil {
		return err
	}
	defer cleanup()
	progress.SetProcessed(60)

	if err := c.uploadStorageFile(ctx, cloudMetadataPackage, zipPath, "application/zip"); err != nil {
		return err
	}
	progress.SetProcessed(100)

	cfg.SetCloudSyncLastPushAt(now)
	logger.Infof("Cloud Sync push complete: uploaded metadata package to %s/%s", c.bucket, cloudMetadataPackage)
	return nil
}

func (t *CloudSyncTask) exportMetadataZip(ctx context.Context) (string, func(), error) {
	tmpDir, err := os.MkdirTemp("", "stash-cloud-export-*")
	if err != nil {
		return "", nil, fmt.Errorf("create cloud export temp dir: %w", err)
	}
	cleanup := func() {
		if err := os.RemoveAll(tmpDir); err != nil {
			logger.Warnf("cloud sync: remove export temp dir %s: %v", tmpDir, err)
		}
	}

	exportDir := filepath.Join(tmpDir, "metadata")
	if err := os.MkdirAll(exportDir, 0755); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("create cloud export metadata dir: %w", err)
	}

	var wg sync.WaitGroup
	wg.Add(1)
	task := ExportTask{
		repository:          GetInstance().Repository,
		full:                true,
		baseDir:             exportDir,
		fileNamingAlgorithm: config.GetInstance().GetVideoFileNamingAlgorithm(),
		shortFilenames:      true,
	}
	task.Start(ctx, &wg)
	wg.Wait()

	zipPath := filepath.Join(tmpDir, "stash-metadata.zip")
	z, err := os.Create(zipPath)
	if err != nil {
		cleanup()
		return "", nil, fmt.Errorf("create cloud export zip: %w", err)
	}
	if err := task.zipFiles(z); err != nil {
		z.Close()
		cleanup()
		return "", nil, fmt.Errorf("zip cloud export metadata: %w", err)
	}
	if err := z.Close(); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("close cloud export zip: %w", err)
	}

	return zipPath, cleanup, nil
}

func (t *CloudSyncTask) pushScenes(ctx context.Context, c *cloudClient, repo models.Repository, since string) error {
	var rows []cloudSceneRow

	if err := repo.WithReadTxn(ctx, func(ctx context.Context) error {
		filter := &models.SceneFilterType{}
		if f := tsFilter(since); f != nil {
			filter.UpdatedAt = f
		}

		result, err := repo.Scene.Query(ctx, models.SceneQueryOptions{
			QueryOptions: models.QueryOptions{FindFilter: allPages()},
			SceneFilter:  filter,
		})
		if err != nil {
			return fmt.Errorf("query scenes: %w", err)
		}

		scenes, err := result.Resolve(ctx)
		if err != nil {
			return fmt.Errorf("resolve scenes: %w", err)
		}

		for _, s := range scenes {
			if err := s.LoadRelationships(ctx, repo.Scene); err != nil {
				logger.Warnf("cloud sync: load scene %d: %v", s.ID, err)
			}
			if err := s.LoadFiles(ctx, repo.Scene); err != nil {
				logger.Warnf("cloud sync: load scene %d files: %v", s.ID, err)
				continue
			}
			primaryFile := s.Files.Primary()
			if primaryFile == nil || primaryFile.Path == "" {
				logger.Warnf("cloud sync: skipping scene %d because it has no primary file path", s.ID)
				continue
			}

			row := cloudSceneRow{
				Path:         primaryFile.Path,
				Title:        s.Title,
				Code:         s.Code,
				Details:      s.Details,
				Director:     s.Director,
				Rating:       s.Rating,
				Organized:    s.Organized,
				StudioID:     s.StudioID,
				URLs:         s.URLs.List(),
				TagIDs:       s.TagIDs.List(),
				PerformerIDs: s.PerformerIDs.List(),
				UpdatedAt:    s.UpdatedAt.UTC().Format(time.RFC3339),
			}
			if s.Date != nil {
				d := s.Date.String()
				row.Date = &d
			}
			rows = append(rows, row)
		}
		return nil
	}); err != nil {
		return err
	}

	for _, row := range rows {
		if err := c.uploadStorageJSON(ctx, cloudSceneObjectPath(row.Path), row); err != nil {
			return err
		}
	}
	logger.Infof("cloud sync: uploaded %d scene objects to bucket %s", len(rows), c.bucket)
	return nil
}

func (t *CloudSyncTask) pushPerformers(ctx context.Context, c *cloudClient, repo models.Repository, since string) error {
	var rows []cloudPerformerRow

	if err := repo.WithReadTxn(ctx, func(ctx context.Context) error {
		filter := &models.PerformerFilterType{}
		if f := tsFilter(since); f != nil {
			filter.UpdatedAt = f
		}

		performers, _, err := repo.Performer.Query(ctx, filter, allPages())
		if err != nil {
			return fmt.Errorf("query performers: %w", err)
		}

		for _, p := range performers {
			if err := p.LoadRelationships(ctx, repo.Performer); err != nil {
				logger.Warnf("cloud sync: load performer %d: %v", p.ID, err)
			}

			row := cloudPerformerRow{
				ID:             p.ID,
				Name:           p.Name,
				Disambiguation: p.Disambiguation,
				Ethnicity:      p.Ethnicity,
				Country:        p.Country,
				EyeColor:       p.EyeColor,
				Height:         p.Height,
				Weight:         p.Weight,
				HairColor:      p.HairColor,
				Favorite:       p.Favorite,
				Rating:         p.Rating,
				Details:        p.Details,
				URLs:           p.URLs.List(),
				TagIDs:         p.TagIDs.List(),
				Aliases:        p.Aliases.List(),
				UpdatedAt:      p.UpdatedAt.UTC().Format(time.RFC3339),
			}
			if p.Gender != nil {
				g := string(*p.Gender)
				row.Gender = &g
			}
			if p.Birthdate != nil {
				d := p.Birthdate.String()
				row.Birthdate = &d
			}
			rows = append(rows, row)
		}
		return nil
	}); err != nil {
		return err
	}

	return upsertBatched(ctx, c, cloudTablePerformers, "", rows)
}

func (t *CloudSyncTask) pushStudios(ctx context.Context, c *cloudClient, repo models.Repository, since string) error {
	var rows []cloudStudioRow

	if err := repo.WithReadTxn(ctx, func(ctx context.Context) error {
		filter := &models.StudioFilterType{}
		if f := tsFilter(since); f != nil {
			filter.UpdatedAt = f
		}

		studios, _, err := repo.Studio.Query(ctx, filter, allPages())
		if err != nil {
			return fmt.Errorf("query studios: %w", err)
		}

		for _, s := range studios {
			if err := s.LoadRelationships(ctx, repo.Performer); err != nil {
				logger.Warnf("cloud sync: load studio %d: %v", s.ID, err)
			}

			rows = append(rows, cloudStudioRow{
				ID:        s.ID,
				Name:      s.Name,
				ParentID:  s.ParentID,
				Rating:    s.Rating,
				Favorite:  s.Favorite,
				Details:   s.Details,
				URLs:      s.URLs.List(),
				Aliases:   s.Aliases.List(),
				UpdatedAt: s.UpdatedAt.UTC().Format(time.RFC3339),
			})
		}
		return nil
	}); err != nil {
		return err
	}

	return upsertBatched(ctx, c, cloudTableStudios, "", rows)
}

func (t *CloudSyncTask) pushTags(ctx context.Context, c *cloudClient, repo models.Repository, since string) error {
	var rows []cloudTagRow

	if err := repo.WithReadTxn(ctx, func(ctx context.Context) error {
		filter := &models.TagFilterType{}
		if f := tsFilter(since); f != nil {
			filter.UpdatedAt = f
		}

		tags, _, err := repo.Tag.Query(ctx, filter, allPages())
		if err != nil {
			return fmt.Errorf("query tags: %w", err)
		}

		for _, tg := range tags {
			if err := tg.LoadAliases(ctx, repo.Tag); err != nil {
				logger.Warnf("cloud sync: load tag %d aliases: %v", tg.ID, err)
			}
			if err := tg.LoadParentIDs(ctx, repo.Tag); err != nil {
				logger.Warnf("cloud sync: load tag %d parents: %v", tg.ID, err)
			}
			if err := tg.LoadChildIDs(ctx, repo.Tag); err != nil {
				logger.Warnf("cloud sync: load tag %d children: %v", tg.ID, err)
			}

			rows = append(rows, cloudTagRow{
				ID:          tg.ID,
				Name:        tg.Name,
				SortName:    tg.SortName,
				Description: tg.Description,
				Favorite:    tg.Favorite,
				Aliases:     tg.Aliases.List(),
				ParentIDs:   tg.ParentIDs.List(),
				ChildIDs:    tg.ChildIDs.List(),
				UpdatedAt:   tg.UpdatedAt.UTC().Format(time.RFC3339),
			})
		}
		return nil
	}); err != nil {
		return err
	}

	return upsertBatched(ctx, c, cloudTableTags, "", rows)
}

func upsertBatched[T any](ctx context.Context, c *cloudClient, table string, onConflict string, rows []T) error {
	if len(rows) == 0 {
		return nil
	}
	for i := 0; i < len(rows); i += cloudBatchSize {
		end := i + cloudBatchSize
		if end > len(rows) {
			end = len(rows)
		}
		if err := c.upsertWithConflict(ctx, table, onConflict, rows[i:end]); err != nil {
			return err
		}
	}
	logger.Infof("cloud sync: upserted %d rows to %s", len(rows), table)
	return nil
}

// pull fetches remote changes from Supabase and applies them to local records.
func (t *CloudSyncTask) pull(ctx context.Context, progress *job.Progress, c *cloudClient) error {
	progress.SetTotal(100)
	progress.SetProcessed(5)

	cfg := config.GetInstance()
	now := time.Now().UTC().Format(time.RFC3339)

	zipPath, cleanup, err := t.downloadMetadataZip(ctx, c)
	if err != nil {
		return err
	}
	defer cleanup()
	progress.SetProcessed(50)

	t.importMetadataZip(ctx, zipPath)
	progress.SetProcessed(100)

	cfg.SetCloudSyncLastPullAt(now)
	logger.Infof("Cloud Sync pull complete: imported metadata package from %s/%s", c.bucket, cloudMetadataPackage)
	return nil
}

func (t *CloudSyncTask) downloadMetadataZip(ctx context.Context, c *cloudClient) (string, func(), error) {
	tmpDir, err := os.MkdirTemp("", "stash-cloud-import-*")
	if err != nil {
		return "", nil, fmt.Errorf("create cloud import temp dir: %w", err)
	}
	cleanup := func() {
		if err := os.RemoveAll(tmpDir); err != nil {
			logger.Warnf("cloud sync: remove import temp dir %s: %v", tmpDir, err)
		}
	}

	zipPath := filepath.Join(tmpDir, "stash-metadata.zip")
	if err := c.downloadStorageFile(ctx, cloudMetadataPackage, zipPath); err != nil {
		cleanup()
		return "", nil, err
	}

	return zipPath, cleanup, nil
}

func (t *CloudSyncTask) importMetadataZip(ctx context.Context, zipPath string) {
	baseDir := filepath.Dir(zipPath)
	task := ImportTask{
		repository:          GetInstance().Repository,
		resetter:            GetInstance().Database,
		BaseDir:             baseDir,
		TmpZip:              zipPath,
		Reset:               false,
		DuplicateBehaviour:  ImportDuplicateEnumOverwrite,
		MissingRefBehaviour: models.ImportMissingRefEnumIgnore,
		fileNamingAlgorithm: config.GetInstance().GetVideoFileNamingAlgorithm(),
	}
	task.Start(ctx)
}

func (t *CloudSyncTask) pullScenes(ctx context.Context, c *cloudClient, repo models.Repository, since string) error {
	var rows []cloudSceneRow
	offset := 0
	for {
		objects, err := c.listStorageObjects(ctx, cloudStorageSceneDir, offset)
		if err != nil {
			return err
		}
		if len(objects) == 0 {
			break
		}
		for _, object := range objects {
			if since != "" && object.UpdatedAt != "" && object.UpdatedAt < since {
				continue
			}
			var row cloudSceneRow
			if err := c.downloadStorageObject(ctx, cloudStorageObjectPath(cloudStorageSceneDir, object.Name), &row); err != nil {
				logger.Warnf("cloud pull: download scene object %s: %v", object.Name, err)
				continue
			}
			rows = append(rows, row)
		}
		if len(objects) < cloudBatchSize {
			break
		}
		offset += len(objects)
	}

	if len(rows) == 0 {
		return nil
	}

	updated := 0
	if err := repo.WithTxn(ctx, func(ctx context.Context) error {
		for _, row := range rows {
			if row.Path == "" {
				logger.Warnf("cloud pull: skipping scene row with empty path")
				continue
			}
			matches, err := repo.Scene.FindByPath(ctx, row.Path)
			if err != nil {
				logger.Warnf("cloud pull: find scene by path %q: %v", row.Path, err)
				continue
			}
			if len(matches) == 0 {
				logger.Warnf("cloud pull: skipping scene path %q because it was not found locally", row.Path)
				continue
			}
			if len(matches) > 1 {
				logger.Warnf("cloud pull: path %q matched %d local scenes; updating the first match", row.Path, len(matches))
			}
			existing := matches[0]

			partial := models.ScenePartial{
				Title:     models.NewOptionalString(row.Title),
				Code:      models.NewOptionalString(row.Code),
				Details:   models.NewOptionalString(row.Details),
				Director:  models.NewOptionalString(row.Director),
				Organized: models.NewOptionalBool(row.Organized),
				Rating:    models.NewOptionalIntPtr(row.Rating),
				StudioID:  models.NewOptionalIntPtr(row.StudioID),
			}
			if row.Date != nil {
				if d, parseErr := models.ParseDate(*row.Date); parseErr == nil {
					partial.Date = models.NewOptionalDatePtr(&d)
				}
			}

			if _, err := repo.Scene.UpdatePartial(ctx, existing.ID, partial); err != nil {
				logger.Warnf("cloud pull: update scene %d (%s): %v", existing.ID, row.Path, err)
				continue
			}
			updated++
		}
		return nil
	}); err != nil {
		return err
	}

	logger.Infof("cloud pull: updated %d/%d scenes", updated, len(rows))
	return nil
}

func (t *CloudSyncTask) pullPerformers(ctx context.Context, c *cloudClient, repo models.Repository, since string) error {
	data, err := c.fetchSince(ctx, cloudTablePerformers, since)
	if err != nil {
		return err
	}

	var rows []cloudPerformerRow
	if err := json.Unmarshal(data, &rows); err != nil {
		return fmt.Errorf("unmarshal performers: %w", err)
	}

	if len(rows) == 0 {
		return nil
	}

	updated := 0
	if err := repo.WithTxn(ctx, func(ctx context.Context) error {
		for _, row := range rows {
			existing, err := repo.Performer.Find(ctx, row.ID)
			if err != nil || existing == nil {
				continue
			}

			partial := models.PerformerPartial{
				Name:           models.NewOptionalString(row.Name),
				Disambiguation: models.NewOptionalString(row.Disambiguation),
				Ethnicity:      models.NewOptionalString(row.Ethnicity),
				Country:        models.NewOptionalString(row.Country),
				EyeColor:       models.NewOptionalString(row.EyeColor),
				Height:         models.NewOptionalIntPtr(row.Height),
				Weight:         models.NewOptionalIntPtr(row.Weight),
				HairColor:      models.NewOptionalString(row.HairColor),
				Favorite:       models.NewOptionalBool(row.Favorite),
				Rating:         models.NewOptionalIntPtr(row.Rating),
				Details:        models.NewOptionalString(row.Details),
			}
			if row.Gender != nil {
				partial.Gender = models.NewOptionalString(*row.Gender)
			}
			if row.Birthdate != nil {
				if d, parseErr := models.ParseDate(*row.Birthdate); parseErr == nil {
					partial.Birthdate = models.NewOptionalDatePtr(&d)
				}
			}

			if _, err := repo.Performer.UpdatePartial(ctx, row.ID, partial); err != nil {
				logger.Warnf("cloud pull: update performer %d: %v", row.ID, err)
				continue
			}
			updated++
		}
		return nil
	}); err != nil {
		return err
	}

	logger.Infof("cloud pull: updated %d/%d performers", updated, len(rows))
	return nil
}

func (t *CloudSyncTask) pullStudios(ctx context.Context, c *cloudClient, repo models.Repository, since string) error {
	data, err := c.fetchSince(ctx, cloudTableStudios, since)
	if err != nil {
		return err
	}

	var rows []cloudStudioRow
	if err := json.Unmarshal(data, &rows); err != nil {
		return fmt.Errorf("unmarshal studios: %w", err)
	}

	if len(rows) == 0 {
		return nil
	}

	updated := 0
	if err := repo.WithTxn(ctx, func(ctx context.Context) error {
		for _, row := range rows {
			existing, err := repo.Studio.Find(ctx, row.ID)
			if err != nil || existing == nil {
				continue
			}

			partial := models.StudioPartial{
				ID:       row.ID,
				Name:     models.NewOptionalString(row.Name),
				ParentID: models.NewOptionalIntPtr(row.ParentID),
				Rating:   models.NewOptionalIntPtr(row.Rating),
				Favorite: models.NewOptionalBool(row.Favorite),
				Details:  models.NewOptionalString(row.Details),
			}

			if _, err := repo.Studio.UpdatePartial(ctx, partial); err != nil {
				logger.Warnf("cloud pull: update studio %d: %v", row.ID, err)
				continue
			}
			updated++
		}
		return nil
	}); err != nil {
		return err
	}

	logger.Infof("cloud pull: updated %d/%d studios", updated, len(rows))
	return nil
}

func (t *CloudSyncTask) pullTags(ctx context.Context, c *cloudClient, repo models.Repository, since string) error {
	data, err := c.fetchSince(ctx, cloudTableTags, since)
	if err != nil {
		return err
	}

	var rows []cloudTagRow
	if err := json.Unmarshal(data, &rows); err != nil {
		return fmt.Errorf("unmarshal tags: %w", err)
	}

	if len(rows) == 0 {
		return nil
	}

	updated := 0
	if err := repo.WithTxn(ctx, func(ctx context.Context) error {
		for _, row := range rows {
			existing, err := repo.Tag.Find(ctx, row.ID)
			if err != nil || existing == nil {
				continue
			}

			partial := models.TagPartial{
				Name:        models.NewOptionalString(row.Name),
				SortName:    models.NewOptionalString(row.SortName),
				Description: models.NewOptionalString(row.Description),
				Favorite:    models.NewOptionalBool(row.Favorite),
			}

			if _, err := repo.Tag.UpdatePartial(ctx, row.ID, partial); err != nil {
				logger.Warnf("cloud pull: update tag %d: %v", row.ID, err)
				continue
			}
			updated++
		}
		return nil
	}); err != nil {
		return err
	}

	logger.Infof("cloud pull: updated %d/%d tags", updated, len(rows))
	return nil
}

func (t *CloudSyncTask) pushAppSettings(ctx context.Context, c *cloudClient, repo models.Repository) error {
	var rows []cloudAppSettingsRow

	if err := repo.WithReadTxn(ctx, func(ctx context.Context) error {
		settings, err := repo.AppSettings.AllSettings(ctx)
		if err != nil {
			return fmt.Errorf("read app settings: %w", err)
		}
		now := time.Now().UTC().Format(time.RFC3339)
		for k, v := range settings {
			rows = append(rows, cloudAppSettingsRow{Key: k, Value: v, UpdatedAt: now})
		}
		return nil
	}); err != nil {
		return err
	}

	return upsertBatched(ctx, c, cloudTableAppSettings, "key", rows)
}

func (t *CloudSyncTask) pullAppSettings(ctx context.Context, c *cloudClient, repo models.Repository, cfg *config.Config) error {
	data, err := c.fetchSince(ctx, cloudTableAppSettings, "")
	if err != nil {
		return err
	}

	var rows []cloudAppSettingsRow
	if err := json.Unmarshal(data, &rows); err != nil {
		return fmt.Errorf("unmarshal app settings: %w", err)
	}

	if len(rows) == 0 {
		return nil
	}

	if err := repo.WithTxn(ctx, func(ctx context.Context) error {
		for _, row := range rows {
			if err := repo.AppSettings.SetSetting(ctx, row.Key, row.Value); err != nil {
				logger.Warnf("cloud pull: store app setting %s: %v", row.Key, err)
			}
		}
		return nil
	}); err != nil {
		return err
	}

	// Apply pulled settings to in-memory config and persist to YAML.
	for _, row := range rows {
		cfg.SetString(row.Key, row.Value)
	}
	if err := cfg.Write(); err != nil {
		logger.Warnf("cloud pull: write config after app settings pull: %v", err)
	}

	logger.Infof("cloud pull: applied %d app settings", len(rows))
	return nil
}

// TriggerCloudSync debounced push on metadata changes.
var (
	cloudSyncMu       sync.Mutex
	cloudSyncTimer    *time.Timer
	cloudSyncDebounce = 5 * time.Minute
)

func (m *Manager) TriggerCloudSync() {
	if !m.Config.GetCloudSyncAutoPush() {
		return
	}

	cloudSyncMu.Lock()
	defer cloudSyncMu.Unlock()

	if cloudSyncTimer != nil {
		cloudSyncTimer.Stop()
	}

	cloudSyncTimer = time.AfterFunc(cloudSyncDebounce, func() {
		logger.Infof("Triggering automated Cloud Sync Push due to recent metadata changes...")
		m.JobManager.Add(context.Background(), "Cloud Sync (Auto-Push)", CreateCloudPushTask())
	})
}

func (m *Manager) TriggerCloudPullOnStartup() {
	if m.Config.GetCloudSyncSupabaseURL() == "" || m.Config.GetCloudSyncSupabaseKey() == "" {
		return
	}

	time.AfterFunc(10*time.Second, func() {
		logger.Infof("Triggering Cloud Sync pull on startup...")
		m.JobManager.Add(context.Background(), "Cloud Sync (Startup Pull)", CreateCloudPullTask())
	})
}
