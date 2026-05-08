package manager

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/stashapp/stash/internal/identify"
	"github.com/stashapp/stash/pkg/job"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/match"
	"github.com/stashapp/stash/pkg/models"
	"github.com/stashapp/stash/pkg/scene"
	"github.com/stashapp/stash/pkg/scraper"
	"github.com/stashapp/stash/pkg/sliceutil/stringslice"
	"github.com/stashapp/stash/pkg/stashbox"
	"github.com/stashapp/stash/pkg/txn"
	"golang.org/x/time/rate"
)

var ErrInput = errors.New("invalid request input")

// r18Limiter enforces a global 1-request-per-2s ceiling across all refine workers.
// Serialises r18.dev API calls so we never trigger rate limiting under parallel load.
var r18Limiter = rate.NewLimiter(rate.Every(2*time.Second), 1)

type rateLimitError struct {
	retryAfter time.Duration
}

func (e *rateLimitError) Error() string {
	return fmt.Sprintf("HTTP 429 (retry after %v)", e.retryAfter)
}

type IdentifyJob struct {
	postHookExecutor identify.SceneUpdatePostHookExecutor
	input            identify.Options

	stashBoxes []*models.StashBox
	progress   *job.Progress
}

func CreateIdentifyJob(input identify.Options) *IdentifyJob {
	return &IdentifyJob{
		postHookExecutor: instance.PluginCache,
		input:            input,
		stashBoxes:       instance.Config.GetStashBoxes(),
	}
}

func (j *IdentifyJob) Execute(ctx context.Context, progress *job.Progress) error {
	j.progress = progress

	// if no sources provided - just return
	if len(j.input.Sources) == 0 {
		return nil
	}

	sources, err := j.getSources()
	if err != nil {
		return err
	}

	// if scene ids provided, use those
	// otherwise, batch query for all scenes - ordering by path
	// don't use a transaction to query scenes
	r := instance.Repository
	if err := r.WithDB(ctx, func(ctx context.Context) error {
		if len(j.input.SceneIDs) == 0 {
			return j.identifyAllScenes(ctx, sources)
		}

		sceneIDs, err := stringslice.StringSliceToIntSlice(j.input.SceneIDs)
		if err != nil {
			return fmt.Errorf("invalid scene IDs: %w", err)
		}

		progress.SetTotal(len(sceneIDs))
		for _, id := range sceneIDs {
			if job.IsCancelled(ctx) {
				break
			}

			scene, err := r.Scene.Find(ctx, id)
			if err != nil {
				logger.Errorf("identify: finding scene id %d: %v", id, err)
				progress.Increment()
				continue
			}
			if scene == nil {
				logger.Warnf("identify: scene id %d not found", id)
				progress.Increment()
				continue
			}
			if scene.Organized {
				logger.Debugf("identify: skipping already-organized scene %d", id)
				progress.Increment()
				continue
			}

			j.identifyScene(ctx, scene, sources)
		}

		return nil
	}); err != nil {
		logger.Errorf("error encountered while identifying scenes: %v", err)
	}

	instance.TriggerCloudSync()
	return nil
}

func (j *IdentifyJob) wantsOrganized() bool {
	return j.input.Options != nil && j.input.Options.SetOrganized != nil && *j.input.Options.SetOrganized
}

// cloneOptionsWithoutOrganized returns a shallow copy of opts with SetOrganized
// set to nil so the identify step never marks scenes organized — the organized
// flag is applied manually only after a successful JAV title refinement.
func cloneOptionsWithoutOrganized(opts *identify.MetadataOptions) *identify.MetadataOptions {
	if opts == nil {
		return nil
	}
	cloned := *opts
	cloned.SetOrganized = nil
	return &cloned
}

func (j *IdentifyJob) identifyAllScenes(ctx context.Context, sources []identify.ScraperSource) error {
	r := instance.Repository

	sceneFilter := scene.FilterFromPaths(j.input.Paths)

	sort := "path"
	findFilter := &models.FindFilterType{
		Sort: &sort,
	}

	// get the count
	pp := 0
	findFilter.PerPage = &pp
	countResult, err := r.Scene.Query(ctx, models.SceneQueryOptions{
		QueryOptions: models.QueryOptions{
			FindFilter: findFilter,
			Count:      true,
		},
		SceneFilter: sceneFilter,
	})
	if err != nil {
		return fmt.Errorf("error getting scene count: %w", err)
	}

	j.progress.SetTotal(countResult.Count)

	wantOrganized := j.wantsOrganized()

	// Two-stage pipeline: many fast identify workers feed a small pool of refine workers.
	// Refine is throttled by the global r18Limiter (1 req/2s) so worker count just
	// controls queue depth — keep it small to avoid goroutine pile-up.
	const numIdentifyWorkers = 100
	const numRefineWorkers = 5
	identifyCh := make(chan *models.Scene, numIdentifyWorkers)
	refineCh := make(chan *models.Scene, numIdentifyWorkers*3)

	// Stage 1: fast identify workers
	var identifyWg sync.WaitGroup
	for i := 0; i < numIdentifyWorkers; i++ {
		identifyWg.Add(1)
		go func() {
			defer identifyWg.Done()
			for s := range identifyCh {
				if job.IsCancelled(ctx) {
					continue
				}
				j.identifySceneOnly(ctx, s, sources)
				refineCh <- s
			}
		}()
	}

	// Close refineCh once all identify workers have finished.
	go func() {
		identifyWg.Wait()
		close(refineCh)
	}()

	// Stage 2: slow refine workers — throttled by r18Limiter, few workers needed
	var refineWg sync.WaitGroup
	for i := 0; i < numRefineWorkers; i++ {
		refineWg.Add(1)
		go func() {
			defer refineWg.Done()
			for s := range refineCh {
				if job.IsCancelled(ctx) {
					continue
				}
				titleFound := j.refineJAVTitle(ctx, s)
				if wantOrganized && titleFound {
					j.setOrganized(ctx, s)
				}
			}
		}()
	}

	batchErr := scene.BatchProcess(ctx, r.Scene, sceneFilter, findFilter, func(scene *models.Scene) error {
		if job.IsCancelled(ctx) {
			return nil
		}
		if scene.Organized {
			j.progress.Increment()
			return nil
		}
		identifyCh <- scene
		return nil
	})

	close(identifyCh)
	refineWg.Wait() // always wait for refine even when batch errors

	if batchErr != nil {
		logger.Errorf("identify: batch process error (refine still ran): %v", batchErr)
	}
	return batchErr
}

// identifySceneOnly runs just the identify step without JAV title refinement.
// SetOrganized is suppressed — it is applied after refinement confirms an English title.
func (j *IdentifyJob) identifySceneOnly(ctx context.Context, s *models.Scene, sources []identify.ScraperSource) {
	if job.IsCancelled(ctx) {
		return
	}

	opts := cloneOptionsWithoutOrganized(j.input.Options)

	var taskError error
	j.progress.ExecuteTask("Identifying "+s.Path, func() {
		r := instance.Repository
		task := identify.SceneIdentifier{
			TxnManager:         r.TxnManager,
			SceneReaderUpdater: r.Scene,
			StudioReaderWriter: r.Studio,
			PerformerCreator:   r.Performer,
			TagFinderCreator:   r.Tag,

			DefaultOptions:              opts,
			Sources:                     sources,
			SceneUpdatePostHookExecutor: j.postHookExecutor,
		}

		taskError = task.Identify(ctx, s)
	})

	if taskError != nil {
		logger.Errorf("Error encountered identifying %s: %v", s.Path, taskError)
	}

	j.progress.Increment()
}

// identifyScene is used for the scene-ID specific path. Runs identify + refine
// + organized gate sequentially (acceptable since targeted, not bulk).
func (j *IdentifyJob) identifyScene(ctx context.Context, s *models.Scene, sources []identify.ScraperSource) {
	wantOrganized := j.wantsOrganized()
	j.identifySceneOnly(ctx, s, sources)
	titleFound := j.refineJAVTitle(ctx, s)
	if wantOrganized && titleFound {
		j.setOrganized(ctx, s)
	}
}

func (j *IdentifyJob) setOrganized(ctx context.Context, s *models.Scene) {
	setSceneOrganized(ctx, s)
}

func setSceneOrganized(ctx context.Context, s *models.Scene) {
	partial := models.NewScenePartial()
	partial.Organized = models.NewOptionalBool(true)
	if err := txn.WithTxn(ctx, instance.Repository.TxnManager, func(ctx context.Context) error {
		_, err := instance.Repository.Scene.UpdatePartial(ctx, s.ID, partial)
		return err
	}); err != nil {
		logger.Errorf("Error setting organized flag for scene %d: %v", s.ID, err)
	}
}

func (j *IdentifyJob) getSources() ([]identify.ScraperSource, error) {
	var ret []identify.ScraperSource
	for _, source := range j.input.Sources {
		// get scraper source
		stashBox, err := j.getStashBox(source.Source)
		if err != nil {
			return nil, err
		}

		var src identify.ScraperSource
		if stashBox != nil {
			matcher := match.SceneRelationships{
				PerformerFinder: instance.Repository.Performer,
				TagFinder:       instance.Repository.Tag,
				StudioFinder:    instance.Repository.Studio,
			}

			src = identify.ScraperSource{
				Name: "stash-box: " + stashBox.Endpoint,
				Scraper: stashboxSource{
					Client:                 stashbox.NewClient(*stashBox, stashbox.ExcludeTagPatterns(instance.Config.GetScraperExcludeTagPatterns())),
					endpoint:               stashBox.Endpoint,
					txnManager:             instance.Repository.TxnManager,
					sceneFingerprintGetter: instance.SceneService,
					matcher:                matcher,
				},
				RemoteSite: stashBox.Endpoint,
			}
		} else {
			scraperID := *source.Source.ScraperID
			s := instance.ScraperCache.GetScraper(scraperID)
			if s == nil {
				return nil, fmt.Errorf("%w: scraper with id %q", models.ErrNotFound, scraperID)
			}
			src = identify.ScraperSource{
				Name: s.Name,
				Scraper: scraperSource{
					cache:     instance.ScraperCache,
					scraperID: scraperID,
				},
			}
		}

		src.Options = source.Options
		ret = append(ret, src)
	}

	return ret, nil
}

func (j *IdentifyJob) getStashBox(src *scraper.Source) (*models.StashBox, error) {
	if src.ScraperID != nil {
		return nil, nil
	}

	// must be stash-box
	if src.StashBoxIndex == nil && src.StashBoxEndpoint == nil {
		return nil, fmt.Errorf("%w: stash_box_index or stash_box_endpoint or scraper_id must be set", ErrInput)
	}

	return resolveStashBox(j.stashBoxes, *src)
}

func resolveStashBox(sb []*models.StashBox, source scraper.Source) (*models.StashBox, error) {
	if source.StashBoxIndex != nil {
		index := source.StashBoxIndex
		if *index < 0 || *index >= len(sb) {
			return nil, fmt.Errorf("%w: invalid stash_box_index: %d", models.ErrScraperSource, index)
		}

		return sb[*index], nil
	}

	if source.StashBoxEndpoint != nil {
		var ret *models.StashBox
		endpoint := *source.StashBoxEndpoint
		for _, b := range sb {
			if strings.EqualFold(endpoint, b.Endpoint) {
				ret = b
			}
		}

		if ret == nil {
			return nil, fmt.Errorf(`%w: stash-box with endpoint "%s"`, models.ErrNotFound, endpoint)
		}

		return ret, nil
	}

	// neither stash-box inputs were provided, so assume it is a scraper

	return nil, nil
}

type stashboxSource struct {
	*stashbox.Client
	endpoint string

	txnManager             models.TxnManager
	sceneFingerprintGetter sceneFingerprintGetter
	matcher                match.SceneRelationships
}

type sceneFingerprintGetter interface {
	GetScenesFingerprints(ctx context.Context, ids []int) ([]models.Fingerprints, error)
}

func (s stashboxSource) ScrapeScenes(ctx context.Context, sceneID int) ([]*models.ScrapedScene, error) {
	var fps []models.Fingerprints
	if err := txn.WithReadTxn(ctx, s.txnManager, func(ctx context.Context) error {
		var err error
		fps, err = s.sceneFingerprintGetter.GetScenesFingerprints(ctx, []int{sceneID})
		return err
	}); err != nil {
		return nil, fmt.Errorf("error getting scene fingerprints: %w", err)
	}

	results, err := s.FindSceneByFingerprints(ctx, fps[0])
	if err != nil {
		return nil, fmt.Errorf("error querying stash-box using scene ID %d: %w", sceneID, err)
	}

	if err := txn.WithReadTxn(ctx, s.txnManager, func(ctx context.Context) error {
		for _, ret := range results {
			if err := s.matcher.MatchRelationships(ctx, ret, s.endpoint); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return nil, fmt.Errorf("error matching scene relationships: %w", err)
	}

	if len(results) > 0 {
		return results, nil
	}

	return nil, nil
}

func (s stashboxSource) String() string {
	return fmt.Sprintf("stash-box %s", s.endpoint)
}

type scraperSource struct {
	cache     *scraper.Cache
	scraperID string
}

func (s scraperSource) ScrapeScenes(ctx context.Context, sceneID int) ([]*models.ScrapedScene, error) {
	content, err := s.cache.ScrapeID(ctx, s.scraperID, sceneID, scraper.ScrapeContentTypeScene)
	if err != nil {
		return nil, err
	}

	// don't try to convert nil return value
	if content == nil {
		return nil, nil
	}

	if scene, ok := content.(models.ScrapedScene); ok {
		return []*models.ScrapedScene{&scene}, nil
	}

	return nil, errors.New("could not convert content to scene")
}

func (s scraperSource) String() string {
	return fmt.Sprintf("scraper %s", s.scraperID)
}

var r18CIDRE = regexp.MustCompile(`(?i)(?:id=|combined=|cid=)([^/&?]+)`)

// refineJAVTitle retries refineJAVTitleAttempt with exponential backoff.
// On 429 it honours the Retry-After header (or waits 60s) before retrying.
// Returns true when an English title was found and written to the DB.
func (j *IdentifyJob) refineJAVTitle(ctx context.Context, s *models.Scene) bool {
	const maxRetries = 20
	const baseDelay = 3 * time.Second

	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if job.IsCancelled(ctx) {
			return false
		}

		found, err := j.refineJAVTitleAttempt(ctx, s)
		if err == nil {
			return found
		}
		lastErr = err

		var delay time.Duration
		var rlErr *rateLimitError
		if errors.As(err, &rlErr) {
			delay = rlErr.retryAfter + time.Duration(rand.Intn(5000))*time.Millisecond
			logger.Warnf("identify: scene %d rate limited by r18.dev, waiting %v (attempt %d/%d)", s.ID, delay, attempt+1, maxRetries)
		} else {
			backoff := time.Duration(math.Pow(2, float64(attempt))) * baseDelay
			delay = backoff + time.Duration(rand.Intn(2000))*time.Millisecond
			logger.Debugf("identify: scene %d retry %d/%d after error: %v, waiting %v", s.ID, attempt+1, maxRetries, err, delay)
		}

		select {
		case <-ctx.Done():
			return false
		case <-time.After(delay):
		}
	}

	logger.Errorf("Failed to refine JAV title for scene %d after %d attempts: %v", s.ID, maxRetries, lastErr)
	recordFailedIdentify(s, lastErr)
	return false
}

var failedIdentifyMutex sync.Mutex

func recordFailedIdentify(s *models.Scene, err error) {
	failedIdentifyMutex.Lock()
	defer failedIdentifyMutex.Unlock()

	type failedRecord struct {
		SceneID int       `json:"scene_id"`
		Path    string    `json:"path"`
		Error   string    `json:"error"`
		Time    time.Time `json:"time"`
	}

	record := failedRecord{
		SceneID: s.ID,
		Path:    s.Path,
		Error:   err.Error(),
		Time:    time.Now(),
	}

	downloadPath := GetInstance().Paths.Generated.Downloads
	if downloadPath == "" {
		return
	}
	filePath := filepath.Join(downloadPath, "failed_identifies.json")

	// Read existing records
	var records []failedRecord
	if data, readErr := os.ReadFile(filePath); readErr == nil {
		json.Unmarshal(data, &records)
	}

	records = append(records, record)

	// Write back
	if data, marshalErr := json.MarshalIndent(records, "", "  "); marshalErr == nil {
		os.WriteFile(filePath, data, 0644)
	}
}

// refineJAVTitleAttempt fetches the English title from r18.dev and updates the DB.
// Returns (true, nil) when an English title was found and written.
// Returns (false, nil) when the scene has no r18 URL or no English title (not an error).
func (j *IdentifyJob) refineJAVTitleAttempt(ctx context.Context, s *models.Scene) (bool, error) {
	// 1. Skip if title already has " | "
	if strings.Contains(s.Title, " | ") {
		return false, nil
	}

	// 2. Find R18 URL — refresh scene from DB to get URLs populated by the identify step
	scene, err := instance.Repository.Scene.Find(ctx, s.ID)
	if err != nil {
		return false, fmt.Errorf("finding scene: %w", err)
	}
	if scene == nil {
		return false, fmt.Errorf("scene not found")
	}
	_ = scene.LoadURLs(ctx, instance.Repository.Scene)

	var r18URL string
	for _, u := range scene.URLs.List() {
		if strings.Contains(u, "r18.dev") || strings.Contains(u, "r18.com") {
			r18URL = u
			break
		}
	}

	if r18URL == "" {
		return false, nil
	}

	match := r18CIDRE.FindStringSubmatch(r18URL)
	var cid string
	if len(match) > 1 {
		cid = match[1]
	} else {
		// Try fallback: last path segment
		parts := strings.Split(strings.Trim(r18URL, "/"), "/")
		if len(parts) > 0 {
			last := parts[len(parts)-1]
			if regexp.MustCompile(`^[a-zA-Z0-9]+$`).MatchString(last) {
				cid = last
			}
		}
	}

	if cid == "" {
		return false, nil
	}

	// 3. Fetch JSON from r18.dev — throttled by global rate limiter (1 req/2s)
	if err := r18Limiter.Wait(ctx); err != nil {
		return false, fmt.Errorf("rate limiter: %w", err)
	}

	url := fmt.Sprintf("https://r18.dev/videos/vod/movies/detail/-/combined=%s/json", cid)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return false, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8")
	req.Header.Set("Referer", fmt.Sprintf("https://r18.dev/videos/vod/movies/detail/-/id=%s/", cid))

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false, fmt.Errorf("performing request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusTooManyRequests {
		retryAfter := 60 * time.Second
		if ra := resp.Header.Get("Retry-After"); ra != "" {
			if secs, parseErr := strconv.Atoi(ra); parseErr == nil && secs > 0 {
				retryAfter = time.Duration(secs) * time.Second
			}
		}
		return false, &rateLimitError{retryAfter: retryAfter}
	}

	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	var data struct {
		TitleEn string `json:"title_en"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return false, fmt.Errorf("decoding JSON: %w", err)
	}

	if data.TitleEn == "" || data.TitleEn == "null" {
		return false, nil
	}

	newTitle := decensor(data.TitleEn) + " | " + scene.Title

	scenePartial := models.NewScenePartial()
	scenePartial.Title = models.NewOptionalString(newTitle)

	if err := txn.WithTxn(ctx, instance.Repository.TxnManager, func(ctx context.Context) error {
		_, err := instance.Repository.Scene.UpdatePartial(ctx, scene.ID, scenePartial)
		return err
	}); err != nil {
		return false, fmt.Errorf("updating DB: %w", err)
	}

	logger.Infof("Refined JAV title for scene %d: %s", scene.ID, newTitle)
	return true, nil
}

func decensor(s string) string {
	s = strings.ReplaceAll(s, "●", "*")
	s = strings.ReplaceAll(s, "L*ap", "Rape")
	return s
}
