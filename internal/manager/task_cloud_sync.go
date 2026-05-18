package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
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
	cloudTableScenes      = "stash_scenes"
	cloudTableAppSettings = "stash_app_settings"
	cloudTableHistory     = "stash_sync_history"
	cloudBatchSize        = 100
)

type cloudSyncHistoryRow struct {
	Timestamp       string          `json:"timestamp"`
	Status          string          `json:"status"`
	ScanNewFiles    int             `json:"scan_new_files"`
	ScanTotalFiles  int             `json:"scan_total_files"`
	IdentifySuccess int             `json:"identify_success"`
	IdentifyFailed  int             `json:"identify_failed"`
	CloudPushRows   int             `json:"cloud_push_rows"`
	Details         json.RawMessage `json:"details"`
	UpdatedAt       string          `json:"updated_at"`
}


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

	if supabaseURL == "" || supabaseKey == "" {
		return fmt.Errorf("Supabase URL and Key must be configured for Cloud Sync")
	}

	c := &cloudClient{url: supabaseURL, key: supabaseKey}

	if t.isPush {
		return t.push(ctx, progress, c)
	}
	return t.pull(ctx, progress, c)
}

// cloudClient handles Supabase REST calls directly to Tables over HTTP.
type cloudClient struct {
	url string
	key string
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

	maxRetries := 5
	var lastErr error

	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			waitTime := time.Duration(attempt*attempt) * time.Second
			logger.Infof("cloud sync: retrying %s upsert in %v (attempt %d/%d)...", table, waitTime, attempt, maxRetries)
			
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(waitTime):
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return fmt.Errorf("create request: %w", err)
		}

		req.Header.Set("Authorization", "Bearer "+c.key)
		req.Header.Set("apikey", c.key)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Prefer", "resolution=merge-duplicates,return=minimal")

		// log row count if it's a slice
		rowSlice, ok := rows.([]interface{})
		if ok {
			logger.Infof("cloud sync: upserting %d rows to %s...", len(rowSlice), table)
		} else {
			logger.Infof("cloud sync: upserting rows to %s...", table)
		}


		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			logger.Warnf("cloud sync: upsert %s attempt %d failed: %v", table, attempt, err)
			continue
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			lastErr = fmt.Errorf("upsert %s failed (%d): %s", table, resp.StatusCode, string(b))
			logger.Warnf("cloud sync: upsert %s attempt %d failed with status %d", table, attempt, resp.StatusCode)
			
			// If it's a 4xx error (client error), don't bother retrying as it's likely a schema mismatch
			if resp.StatusCode >= 400 && resp.StatusCode < 500 {
				return lastErr
			}
			continue
		}

		return nil // Success!
	}

	return fmt.Errorf("upsert %s failed after %d attempts: %w", table, maxRetries, lastErr)
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

// Row types corresponding perfectly to your Supabase tables.

type cloudSceneRow struct {
	ID           int      `json:"id"`
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

func pageFilter(page int) *models.FindFilterType {
	ps := cloudBatchSize
	sort := "id"
	return &models.FindFilterType{
		Page:    &page,
		PerPage: &ps,
		Sort:    &sort,
	}
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

// push serializes all local entities changed since last push and upserts into Supabase Tables.
func (t *CloudSyncTask) push(ctx context.Context, progress *job.Progress, c *cloudClient) error {
	progress.SetTotal(100)
	progress.SetProcessed(5)

	cfg := config.GetInstance()
	now := time.Now().UTC().Format(time.RFC3339)
	since := cfg.GetCloudSyncLastPushAt() // Only push items changed since the last successful sync
	repo := GetInstance().Repository

	if err := t.pushPerformers(ctx, c, repo, since); err != nil {
		return fmt.Errorf("push performers failed: %w", err)
	}
	progress.SetProcessed(20)

	if err := t.pushStudios(ctx, c, repo, since); err != nil {
		return fmt.Errorf("push studios failed: %w", err)
	}
	progress.SetProcessed(40)

	if err := t.pushTags(ctx, c, repo, since); err != nil {
		return fmt.Errorf("push tags failed: %w", err)
	}
	progress.SetProcessed(60)

	if err := t.pushScenes(ctx, c, repo, since); err != nil {
		return fmt.Errorf("push scenes failed: %w", err)
	}
	progress.SetProcessed(80)

	if err := t.pushAppSettings(ctx, c, repo); err != nil {
		return fmt.Errorf("push app settings failed: %w", err)
	}
	progress.SetProcessed(100)

	cfg.SetCloudSyncLastPushAt(now)
	logger.Infof("Cloud Sync delta push complete: only changed items were synced")
	return nil
}


func (t *CloudSyncTask) PushHistory(ctx context.Context, row cloudSyncHistoryRow) error {
	cfg := config.GetInstance()
	supabaseURL := cfg.GetCloudSyncSupabaseURL()
	supabaseKey := cfg.GetCloudSyncSupabaseKey()

	if supabaseURL == "" || supabaseKey == "" {
		return nil // skip if not configured
	}

	c := &cloudClient{url: supabaseURL, key: supabaseKey}
	return c.upsertWithConflict(ctx, cloudTableHistory, "", []cloudSyncHistoryRow{row})
}

func (t *CloudSyncTask) pushScenes(ctx context.Context, c *cloudClient, repo models.Repository, since string) error {
	logger.Infof("cloud sync: pushing scenes changed since %s...", since)
	
	page := 1
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		var rows []cloudSceneRow
		err := repo.WithReadTxn(ctx, func(ctx context.Context) error {
			filter := &models.SceneFilterType{}
			if f := tsFilter(since); f != nil {
				filter.UpdatedAt = f
			}

			// Use paginated filter with ID sorting
			result, err := repo.Scene.Query(ctx, models.SceneQueryOptions{
				QueryOptions: models.QueryOptions{FindFilter: pageFilter(page)},
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
				// Explicitly load relations before calling .List() to prevent Go panic
				_ = s.LoadURLs(ctx, repo.Scene)
				_ = s.LoadTagIDs(ctx, repo.Scene)
				_ = s.LoadPerformerIDs(ctx, repo.Scene)

				row := cloudSceneRow{
					ID:           s.ID,
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
		})

		if err != nil {
			return err
		}

		if len(rows) == 0 {
			break
		}

		if err := c.upsertWithConflict(ctx, cloudTableScenes, "id", rows); err != nil {
			return fmt.Errorf("upsert scenes page %d: %w", page, err)
		}

		logger.Infof("cloud sync: pushed page %d of scenes", page)


		// If we got fewer rows than requested, we're at the end
		if len(rows) < cloudBatchSize {
			break
		}
		page++
	}

	return nil
}


func (t *CloudSyncTask) pushPerformers(ctx context.Context, c *cloudClient, repo models.Repository, since string) error {
	logger.Infof("cloud sync: pushing performers changed since %s...", since)
	
	page := 1
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		var rows []cloudPerformerRow
		err := repo.WithReadTxn(ctx, func(ctx context.Context) error {
			filter := &models.PerformerFilterType{}
			if f := tsFilter(since); f != nil {
				filter.UpdatedAt = f
			}

			performers, _, err := repo.Performer.Query(ctx, filter, pageFilter(page))

			if err != nil {
				return fmt.Errorf("query performers: %w", err)
			}

			for _, p := range performers {
				_ = p.LoadURLs(ctx, repo.Performer)
				_ = p.LoadTagIDs(ctx, repo.Performer)
				_ = p.LoadAliases(ctx, repo.Performer)

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
		})

		if err != nil {
			return err
		}

		if len(rows) == 0 {
			break
		}

		if err := c.upsertWithConflict(ctx, cloudTablePerformers, "id", rows); err != nil {
			return fmt.Errorf("upsert performers page %d: %w", page, err)
		}

		logger.Infof("cloud sync: pushed page %d of performers", page)


		if len(rows) < cloudBatchSize {
			break
		}
		page++
	}

	return nil
}


func (t *CloudSyncTask) pushStudios(ctx context.Context, c *cloudClient, repo models.Repository, since string) error {
	logger.Infof("cloud sync: pushing studios changed since %s...", since)
	
	page := 1
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		var rows []cloudStudioRow
		err := repo.WithReadTxn(ctx, func(ctx context.Context) error {
			filter := &models.StudioFilterType{}
			if f := tsFilter(since); f != nil {
				filter.UpdatedAt = f
			}

			studios, _, err := repo.Studio.Query(ctx, filter, pageFilter(page))

			if err != nil {
				return fmt.Errorf("query studios: %w", err)
			}

			for _, s := range studios {
				_ = s.LoadURLs(ctx, repo.Studio)
				_ = s.LoadAliases(ctx, repo.Studio)

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
		})

		if err != nil {
			return err
		}

		if len(rows) == 0 {
			break
		}

		if err := c.upsertWithConflict(ctx, cloudTableStudios, "id", rows); err != nil {
			return fmt.Errorf("upsert studios page %d: %w", page, err)
		}

		logger.Infof("cloud sync: pushed page %d of studios", page)


		if len(rows) < cloudBatchSize {
			break
		}
		page++
	}

	return nil
}


func (t *CloudSyncTask) pushTags(ctx context.Context, c *cloudClient, repo models.Repository, since string) error {
	logger.Infof("cloud sync: pushing tags changed since %s...", since)
	
	page := 1
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		var rows []cloudTagRow
		err := repo.WithReadTxn(ctx, func(ctx context.Context) error {
			filter := &models.TagFilterType{}
			if f := tsFilter(since); f != nil {
				filter.UpdatedAt = f
			}

			tags, _, err := repo.Tag.Query(ctx, filter, pageFilter(page))

			if err != nil {
				return fmt.Errorf("query tags: %w", err)
			}

			for _, tag := range tags {
				_ = tag.LoadAliases(ctx, repo.Tag)
				_ = tag.LoadParentIDs(ctx, repo.Tag)
				_ = tag.LoadChildIDs(ctx, repo.Tag)

				rows = append(rows, cloudTagRow{
					ID:          tag.ID,
					Name:        tag.Name,
					SortName:    tag.SortName,
					Description: tag.Description,
					Favorite:    tag.Favorite,
					Aliases:     tag.Aliases.List(),
					ParentIDs:   tag.ParentIDs.List(),
					ChildIDs:    tag.ChildIDs.List(),
					UpdatedAt:   tag.UpdatedAt.UTC().Format(time.RFC3339),
				})
			}
			return nil
		})

		if err != nil {
			return err
		}

		if len(rows) == 0 {
			break
		}

		if err := c.upsertWithConflict(ctx, cloudTableTags, "id", rows); err != nil {
			return fmt.Errorf("upsert tags page %d: %w", page, err)
		}

		logger.Infof("cloud sync: pushed page %d of tags", page)


		if len(rows) < cloudBatchSize {
			break
		}
		page++
	}

	return nil
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

// pull fetches remote changes from Supabase Tables incrementally.
func (t *CloudSyncTask) pull(ctx context.Context, progress *job.Progress, c *cloudClient) error {
	progress.SetTotal(100)
	progress.SetProcessed(5)

	cfg := config.GetInstance()
	now := time.Now().UTC().Format(time.RFC3339)
	since := ""
	repo := GetInstance().Repository

	if err := t.pullPerformers(ctx, c, repo, since); err != nil {
		return fmt.Errorf("pull performers failed: %w", err)
	}
	progress.SetProcessed(20)

	if err := t.pullStudios(ctx, c, repo, since); err != nil {
		return fmt.Errorf("pull studios failed: %w", err)
	}
	progress.SetProcessed(40)

	if err := t.pullTags(ctx, c, repo, since); err != nil {
		return fmt.Errorf("pull tags failed: %w", err)
	}
	progress.SetProcessed(60)

	if err := t.pullScenes(ctx, c, repo, since); err != nil {
		return fmt.Errorf("pull scenes failed: %w", err)
	}
	progress.SetProcessed(80)

	if err := t.pullAppSettings(ctx, c, repo, cfg); err != nil {
		return fmt.Errorf("pull app settings failed: %w", err)
	}
	progress.SetProcessed(100)

	cfg.SetCloudSyncLastPullAt(now)
	logger.Infof("Cloud Sync pull complete: synced directly from Supabase tables")
	return nil
}

func (t *CloudSyncTask) pullScenes(ctx context.Context, c *cloudClient, repo models.Repository, since string) error {
	data, err := c.fetchSince(ctx, cloudTableScenes, since)
	if err != nil {
		return err
	}

	var rows []cloudSceneRow
	if err := json.Unmarshal(data, &rows); err != nil {
		return fmt.Errorf("unmarshal scenes: %w", err)
	}

	if len(rows) == 0 {
		return nil
	}

	updated := 0
	if err := repo.WithTxn(ctx, func(ctx context.Context) error {
		for _, row := range rows {
			existing, err := repo.Scene.Find(ctx, row.ID)
			if err != nil || existing == nil {
				continue
			}

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
				logger.Warnf("cloud pull: update scene %d: %v", existing.ID, err)
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
	if cloudSyncTimer != nil {
		cloudSyncTimer.Stop()
	}

	cloudSyncTimer = time.AfterFunc(cloudSyncDebounce, func() {
		// Check if a sync is already queued or running
		queue := m.JobManager.GetQueue()
		for _, j := range queue {
			if j.Description == "Cloud Sync (Auto-Push)" {
				return
			}
		}

		logger.Infof("Triggering automated Cloud Sync Push due to recent metadata changes...")
		m.JobManager.Add(context.Background(), "Cloud Sync (Auto-Push)", CreateCloudPushTask())
	})
	cloudSyncMu.Unlock()
}


func (m *Manager) TriggerCloudPullOnStartup() {
	if m.Config.GetCloudSyncSupabaseURL() == "" || m.Config.GetCloudSyncSupabaseKey() == "" {
		return
	}
	if !m.Config.GetAutomationCloudPull() {
		logger.Info("Cloud Sync pull on startup skipped (disabled in Automation settings).")
		return
	}

	time.AfterFunc(2*time.Second, func() {
		logger.Infof("Triggering Cloud Sync pull on startup...")
		m.JobManager.Start(context.Background(), "Cloud Sync (Startup Pull)", CreateCloudPullTask())
	})
}