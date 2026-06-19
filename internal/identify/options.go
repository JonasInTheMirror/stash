package identify

import (
	"fmt"
	"io"
	"strconv"

	"github.com/stashapp/stash/pkg/models"
	"github.com/stashapp/stash/pkg/scraper"
)

type Source struct {
	Source *scraper.Source `json:"source"`
	// Options defined for a source override the defaults
	Options *MetadataOptions `json:"options"`
}

type Options struct {
	// An ordered list of sources to identify items with. Only the first source that finds a match is used.
	Sources []*Source `json:"sources"`
	// Options defined here override the configured defaults
	Options *MetadataOptions `json:"options"`
	// scene ids to identify
	SceneIDs []string `json:"sceneIDs"`
	// paths of scenes to identify - ignored if scene ids are set
	Paths []string `json:"paths"`
	// When true, skip scenes that are already marked as organized.
	// Deprecated: use ProcessOrganized instead.
	ScanRescan bool `json:"scanRescan"`
	// When true, scenes already marked as organized will still be processed
	// by identify. When false, organized scenes are skipped.
	// Defaults to true if not set.
	ProcessOrganized *bool `json:"processOrganized"`
}

// ShouldProcessOrganized returns true when organized scenes should be
// processed by identify. ProcessOrganized takes precedence; falls back to
// ScanRescan for backward compatibility.
func (o Options) ShouldProcessOrganized() bool {
	if o.ProcessOrganized != nil {
		return *o.ProcessOrganized
	}
	return o.ScanRescan
}


type MetadataOptions struct {
	// any fields missing from here are defaulted to MERGE and createMissing false
	FieldOptions []*FieldOptions `json:"fieldOptions"`
	// defaults to true if not provided
	SetCoverImage *bool `json:"setCoverImage"`
	SetOrganized  *bool `json:"setOrganized"`
	// defaults to true if not provided

	// Deprecated: use PerformerGenders instead
	IncludeMalePerformers *bool `json:"includeMalePerformers"`

	// Filter to only include performers with these genders. If not provided, all genders are included.
	PerformerGenders []models.GenderEnum `json:"performerGenders"`
	// defaults to true if not provided
	SkipMultipleMatches *bool `json:"skipMultipleMatches"`
	// ID of tag to tag skipped multiple matches with
	SkipMultipleMatchTag *string `json:"skipMultipleMatchTag"`
	// defaults to true if not provided
	SkipSingleNamePerformers *bool `json:"skipSingleNamePerformers"`
	// ID of tag to tag skipped single name performers with
	SkipSingleNamePerformerTag *string `json:"skipSingleNamePerformerTag"`
}

type FieldOptions struct {
	Field    string        `json:"field"`
	Strategy FieldStrategy `json:"strategy"`
	// creates missing objects if needed - only applicable for performers, tags and studios
	CreateMissing *bool `json:"createMissing"`
}

type FieldStrategy string

const (
	// Never sets the field value
	FieldStrategyIgnore FieldStrategy = "IGNORE"
	// For multi-value fields, merge with existing.
	// For single-value fields, ignore if already set
	FieldStrategyMerge FieldStrategy = "MERGE"
	// Always replaces the value if a value is found.
	//   For multi-value fields, any existing values are removed and replaced with the
	//   scraped values.
	FieldStrategyOverwrite FieldStrategy = "OVERWRITE"
)

var AllFieldStrategy = []FieldStrategy{
	FieldStrategyIgnore,
	FieldStrategyMerge,
	FieldStrategyOverwrite,
}

func (e FieldStrategy) IsValid() bool {
	switch e {
	case FieldStrategyIgnore, FieldStrategyMerge, FieldStrategyOverwrite:
		return true
	}
	return false
}

func (e FieldStrategy) String() string {
	return string(e)
}

func (e *FieldStrategy) UnmarshalGQL(v interface{}) error {
	str, ok := v.(string)
	if !ok {
		return fmt.Errorf("enums must be strings")
	}

	*e = FieldStrategy(str)
	if !e.IsValid() {
		return fmt.Errorf("%s is not a valid IdentifyFieldStrategy", str)
	}
	return nil
}

func (e FieldStrategy) MarshalGQL(w io.Writer) {
	fmt.Fprint(w, strconv.Quote(e.String()))
}
