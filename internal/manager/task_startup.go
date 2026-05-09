package manager

import (
	"context"
	"time"

	"github.com/stashapp/stash/internal/identify"
	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/pkg/job"
	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/scraper"
)

type StartupJob struct {
	manager *Manager
}

func (j *StartupJob) Execute(ctx context.Context, progress *job.Progress) error {
	logger.Info("Startup sequence: Starting Scan...")
	scanInput := ScanMetadataInput{
		ScanMetadataOptions: config.ScanMetadataOptions{
			Rescan:               true,
			ScanGenerateCovers:   true,
			ScanGeneratePreviews: true,
			ScanGenerateSprites:  true,
			ScanGeneratePhashes:  true,
		},
	}
	scanJob, err := j.manager.CreateScanJob(scanInput)
	if err != nil {
		return err
	}
	// Note: scanJob.Execute will call TriggerCloudSync at the end, but it's debounced.
	if err := scanJob.Execute(ctx, progress); err != nil {
		logger.Errorf("Startup sequence: Scan failed: %v", err)
	}

	logger.Info("Startup sequence: Starting Identify...")
	// Use all configured Stash-Box instances as identification sources.
	stashBoxes := j.manager.Config.GetStashBoxes()
	var sources []*identify.Source
	for _, sb := range stashBoxes {
		endpoint := sb.Endpoint
		sources = append(sources, &identify.Source{
			Source: &scraper.Source{
				StashBoxEndpoint: &endpoint,
			},
		})
	}

	if len(sources) > 0 {
		identifyJob := CreateIdentifyJob(identify.Options{
			Sources: sources,
		})
		if err := identifyJob.Execute(ctx, progress); err != nil {
			logger.Errorf("Startup sequence: Identify failed: %v", err)
		}
	} else {
		logger.Info("Startup sequence: No Stash-Boxes configured, skipping Identify.")
	}

	logger.Info("Startup sequence: Starting immediate Cloud Push...")
	pushTask := CreateCloudPushTask()
	if err := pushTask.Execute(ctx, progress); err != nil {
		logger.Errorf("Startup sequence: Cloud Push failed: %v", err)
	}

	logger.Info("Startup sequence: Finished.")

	return nil
}


func (s *Manager) TriggerStartupTasks() {
	// Wait 2 seconds after startup to allow system to settle before starting intensive tasks.
	time.AfterFunc(2*time.Second, func() {
		logger.Info("Triggering Startup sequence (Scan & Identify)...")
		s.JobManager.Start(context.Background(), "Startup Tasks (Scan & Identify)", &StartupJob{manager: s})
	})
}


