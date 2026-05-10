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

	cfg := j.manager.Config
	repo := j.manager.Repository
	countBefore, _ := repo.Scene.Count(ctx)

	var scanOptions *config.ScanMetadataOptions
	if cfg.GetAutomationStartupScan() {
		logger.Info("Startup sequence: Starting Scan...")
		// Load saved Scan preferences from UI/SQLite
		scanOptions = cfg.GetDefaultScanSettings()
		if scanOptions == nil {
			scanOptions = &config.ScanMetadataOptions{
				ScanGenerateCovers:   true,
				ScanGeneratePreviews: true,
				ScanGenerateSprites:  true,
				ScanGeneratePhashes:  true,
				Rescan:               true,
			}
		}
		nonSequential := false
		scanInput := ScanMetadataInput{
			ScanMetadataOptions: *scanOptions,
		}
		scanInput.SequentialScanning = &nonSequential

		scanJob, err := j.manager.CreateScanJob(scanInput)
		if err == nil {
			if err := scanJob.Execute(ctx, progress); err != nil {
				logger.Errorf("Startup sequence: Scan failed: %v", err)
				stats.Status = "PARTIAL_FAILURE"
			}
		}
	} else {
		logger.Info("Startup sequence: Scan skipped (disabled in Automation settings).")
	}
	countAfter, _ := repo.Scene.Count(ctx)
	stats.ScanNewFiles = countAfter - countBefore
	stats.ScanTotalFiles = countAfter

	if cfg.GetAutomationStartupIdentify() {
		logger.Info("Startup sequence: Starting Identify...")
		identifyOptions := cfg.GetDefaultIdentifySettings()
		if identifyOptions == nil {
			stashBoxes := cfg.GetStashBoxes()
			var sources []*identify.Source
			for _, sb := range stashBoxes {
				endpoint := sb.Endpoint
				sources = append(sources, &identify.Source{
					Source: &scraper.Source{
						StashBoxEndpoint: &endpoint,
					},
				})
			}
			identifyOptions = &identify.Options{
				Sources: sources,
			}
		}

		if scanOptions != nil {
			identifyOptions.ScanRescan = scanOptions.Rescan
		} else {
			identifyOptions.ScanRescan = true
		}

		identifyJob := CreateIdentifyJob(*identifyOptions)
		if err := identifyJob.Execute(ctx, progress); err != nil {
			logger.Errorf("Startup sequence: Identify failed: %v", err)
			stats.Status = "PARTIAL_FAILURE"
		}

	} else {
		logger.Info("Startup sequence: Identify skipped (disabled in Automation settings).")
	}
	stats.IdentifySuccess = countAfter

	if cfg.GetAutomationCloudPush() {
		logger.Info("Startup sequence: Starting immediate Cloud Push...")
		pushTask := CreateCloudPushTask()
		if err := pushTask.Execute(ctx, progress); err != nil {
			logger.Errorf("Startup sequence: Cloud Push failed: %v", err)
			stats.Status = "PARTIAL_FAILURE"
		}
		logger.Info("Startup sequence: Uploading sync history to Supabase...")
		if err := pushTask.PushHistory(ctx, stats); err != nil {
			logger.Errorf("Startup sequence: Failed to upload sync history: %v", err)
		}
	} else {
		logger.Info("Startup sequence: Cloud Push skipped (disabled in Automation settings).")
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


