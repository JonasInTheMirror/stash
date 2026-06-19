package manager

import (
	"context"
	"sync"
	"time"

	"github.com/stashapp/stash/pkg/job"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
	"github.com/stashapp/stash/pkg/scene"
)

// javRefineCronOnce ensures only one cron goroutine is ever started.
var javRefineCronOnce sync.Once

// StartJAVRefineCron starts a background goroutine that retries JAV title
// refinement once per hour for all scenes that have an r18 URL but whose
// title still lacks the " | <EnglishTitle>" suffix.
func StartJAVRefineCron(ctx context.Context) {
	javRefineCronOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(1 * time.Hour)
			defer ticker.Stop()

			// Run once shortly after startup so failures from the previous
			// session are retried quickly.
			initialDelay := time.NewTimer(10 * time.Second)
			defer initialDelay.Stop()


			for {
				select {
				case <-ctx.Done():
					return
				case <-initialDelay.C:
					submitJAVRefineJob(ctx)
				case <-ticker.C:
					submitJAVRefineJob(ctx)
				}
			}
		}()
	})
}

func submitJAVRefineJob(ctx context.Context) {
	const javRefineDesc = "JAV Refine (auto-retry unrefined)"
	for _, j := range instance.JobManager.GetQueue() {
		if j.Description == javRefineDesc {
			return
		}
	}
	instance.JobManager.Add(ctx, javRefineDesc, &retryUnrefinedJAVJob{})
}

// retryUnrefinedJAVJob implements job.JobExec.
// It finds all scenes that have an r18 URL but are missing the English title
// suffix, then calls refineJAVTitle on each one.
type retryUnrefinedJAVJob struct{}

func (j *retryUnrefinedJAVJob) Execute(ctx context.Context, progress *job.Progress) error {
	r := instance.Repository
	wantOrganized := false

	// Build filter: URL contains "r18" AND title excludes " | "
	r18Value := "r18"
	r18Modifier := models.CriterionModifierIncludes

	titleSuffix := " | "
	titleModifier := models.CriterionModifierExcludes

	sceneFilter := &models.SceneFilterType{
		URL: &models.StringCriterionInput{
			Value:    r18Value,
			Modifier: r18Modifier,
		},
		Title: &models.StringCriterionInput{
			Value:    titleSuffix,
			Modifier: titleModifier,
		},
	}

	sort := "path"
	findFilter := &models.FindFilterType{Sort: &sort}

	// Count first so we can set progress total
	pp := 0
	findFilter.PerPage = &pp
	var countResult *models.SceneQueryResult
	if err := r.WithReadTxn(ctx, func(ctx context.Context) error {
		var qerr error
		countResult, qerr = r.Scene.Query(ctx, models.SceneQueryOptions{
			QueryOptions: models.QueryOptions{
				FindFilter: findFilter,
				Count:      true,
			},
			SceneFilter: sceneFilter,
		})
		return qerr
	}); err != nil {
		logger.Errorf("jav-refine-cron: counting scenes: %v", err)
		return err
	}

	if countResult.Count == 0 {
		logger.Infof("jav-refine-cron: nothing to do")
		return nil
	}

	logger.Infof("jav-refine-cron: %d scenes need refinement", countResult.Count)
	progress.SetTotal(countResult.Count)

	// Use a small pool of workers throttled by the shared r18Limiter.
	const numWorkers = 3
	workCh := make(chan *models.Scene, numWorkers*4)

	var wg sync.WaitGroup
	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for s := range workCh {
				if job.IsCancelled(ctx) {
					continue
				}
				titleFound := refineJAVTitleFn(ctx, s)
				if wantOrganized && titleFound {
					setSceneOrganized(ctx, s)
				}
				progress.Increment()
			}
		}()
	}

	if err := r.WithReadTxn(ctx, func(ctx context.Context) error {
		return scene.BatchProcess(ctx, r.Scene, sceneFilter, findFilter, func(s *models.Scene) error {
			if job.IsCancelled(ctx) {
				return nil
			}
			workCh <- s
			return nil
		})
	}); err != nil {
		logger.Errorf("jav-refine-cron: batch process error: %v", err)
	}

	close(workCh)
	wg.Wait()

	instance.TriggerCloudSync()
	return nil
}

// refineJAVTitleFn is a package-level wrapper so both IdentifyJob and the
// cron job share the same retry/rate-limit logic without duplicating code.
func refineJAVTitleFn(ctx context.Context, s *models.Scene) bool {
	stub := &IdentifyJob{}
	return stub.refineJAVTitle(ctx, s)
}
