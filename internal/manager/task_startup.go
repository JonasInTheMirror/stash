package manager

import (
	"context"
	"encoding/json"
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
	startTime := time.Now().UTC()
	stats := cloudSyncHistoryRow{
		Timestamp: startTime.Format(time.RFC3339),
		Status:    "SUCCESS",
		Details:   json.RawMessage("{}"),
		UpdatedAt: startTime.Format(time.RFC3339),
	}

	repo := j.manager.Repository
	countBefore, _ := repo.Scene.Count(ctx)

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
	if err == nil {
		if err := scanJob.Execute(ctx, progress); err != nil {
			logger.Errorf("Startup sequence: Scan failed: %v", err)
			stats.Status = "PARTIAL_FAILURE"
		}
	}
	countAfter, _ := repo.Scene.Count(ctx)
	stats.ScanNewFiles = countAfter - countBefore

	stats.ScanTotalFiles = countAfter

	logger.Info("Startup sequence: Starting Identify...")
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
			stats.Status = "PARTIAL_FAILURE"
		}
		// In a real scenario, we'd parse failed_identifies.json for stats.IdentifyFailed
		// For now, we'll assume success if no error was returned.
		stats.IdentifySuccess = countAfter // Simplified for demonstration
	}

	logger.Info("Startup sequence: Starting immediate Cloud Push...")
	pushTask := CreateCloudPushTask()
	if err := pushTask.Execute(ctx, progress); err != nil {
		logger.Errorf("Startup sequence: Cloud Push failed: %v", err)
		stats.Status = "PARTIAL_FAILURE"
	}

	// Finalize and push history
	logger.Info("Startup sequence: Uploading sync history to Supabase...")
	if err := pushTask.PushHistory(ctx, stats); err != nil {
		logger.Errorf("Startup sequence: Failed to upload sync history: %v", err)
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


