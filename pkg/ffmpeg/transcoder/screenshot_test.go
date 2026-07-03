package transcoder

import (
	"reflect"
	"testing"
)

func TestScreenshotTimeDefaultUsesFastSeek(t *testing.T) {
	options := ScreenshotOptions{
		OutputPath: "out.jpg",
		OutputType: ScreenshotOutputTypeImage2,
	}

	got := ScreenshotTime("input.webm", 12.5, options)
	want := []string{
		"-v", "error",
		"-y",
		"-ss", "12.5",
		"-err_detect", "ignore_err",
		"-i", "input.webm",
		"-frames:v", "1",
		"-f", "image2",
		"out.jpg",
	}

	if !reflect.DeepEqual([]string(got), want) {
		t.Fatalf("ScreenshotTime() = %#v, want %#v", []string(got), want)
	}
}

func TestScreenshotTimeSlowSeek(t *testing.T) {
	options := ScreenshotOptions{
		OutputPath: "out.jpg",
		OutputType: ScreenshotOutputTypeImage2,
		SlowSeek:   true,
	}

	got := ScreenshotTime("input.webm", 12.5, options)
	want := []string{
		"-v", "error",
		"-y",
		"-err_detect", "ignore_err",
		"-i", "input.webm",
		"-ss", "12.5",
		"-frames:v", "1",
		"-f", "image2",
		"out.jpg",
	}

	if !reflect.DeepEqual([]string(got), want) {
		t.Fatalf("ScreenshotTime() = %#v, want %#v", []string(got), want)
	}
}

func TestScreenshotBatch(t *testing.T) {
	options := ScreenshotBatchOptions{
		OutputPattern: "/tmp/sprites/%05d.bmp",
		OutputType:    ScreenshotOutputTypeImage2,
		Interval:      30.5,
		MaxFrames:     500,
		Width:         160,
	}

	got := ScreenshotBatch("input.mp4", options)
	want := []string{
		"-v", "error",
		"-y",
		"-err_detect", "ignore_err",
		"-i", "input.mp4",
		"-frames:v", "500",
		"-vf", "fps=1/30.500000,scale=160:-2",
		"-f", "image2",
		"/tmp/sprites/%05d.bmp",
	}

	if !reflect.DeepEqual([]string(got), want) {
		t.Fatalf("ScreenshotBatch() = %#v, want %#v", []string(got), want)
	}
}
