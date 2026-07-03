package transcoder

import (
	"fmt"

	"github.com/stashapp/stash/pkg/ffmpeg"
)

type ScreenshotOptions struct {
	OutputPath string
	OutputType ScreenshotOutputType

	// Quality is the quality scale. See https://ffmpeg.org/ffmpeg.html#Main-options
	Quality int

	// Width is the width to scale the screenshot to. If 0, no scaling will be applied.
	Width int
	// Height is the height to scale the screenshot to. If 0, no scaling will be applied.
	// Not used if Width is set.
	Height int

	// Verbosity is the logging verbosity. Defaults to LogLevelError if not set.
	Verbosity ffmpeg.LogLevel

	UseSelectFilter bool

	// SlowSeek uses accurate seek by placing -ss after the input.
	SlowSeek bool
}

func (o *ScreenshotOptions) setDefaults() {
	if o.Verbosity == "" {
		o.Verbosity = ffmpeg.LogLevelError
	}
}

type ScreenshotOutputType struct {
	codec  *ffmpeg.VideoCodec
	format ffmpeg.Format
}

func (t ScreenshotOutputType) Args() []string {
	var ret []string
	if t.codec != nil {
		ret = append(ret, t.codec.Args()...)
	}
	if t.format != "" {
		ret = append(ret, t.format.Args()...)
	}

	return ret
}

var (
	ScreenshotOutputTypeImage2 = ScreenshotOutputType{
		format: "image2",
	}
	ScreenshotOutputTypeBMP = ScreenshotOutputType{
		codec:  &ffmpeg.VideoCodecBMP,
		format: "rawvideo",
	}
)

func ScreenshotTime(input string, t float64, options ScreenshotOptions) ffmpeg.Args {
	options.setDefaults()

	var args ffmpeg.Args
	args = args.LogLevel(options.Verbosity)
	args = args.Overwrite()
	if !options.SlowSeek {
		args = args.Seek(t)
	}
	args = args.ErrDetectIgnore()
	args = args.Input(input)
	if options.SlowSeek {
		args = args.Seek(t)
	}
	args = args.VideoFrames(1)

	if options.Quality > 0 {
		args = args.FixedQualityScaleVideo(options.Quality)
	}

	var vf ffmpeg.VideoFilter

	if options.Width > 0 {
		vf = vf.ScaleWidth(options.Width)
		args = args.VideoFilter(vf)
	} else if options.Height > 0 {
		vf = vf.ScaleHeight(options.Height)
		args = args.VideoFilter(vf)
	}

	args = args.AppendArgs(options.OutputType)
	args = args.Output(options.OutputPath)

	return args
}

type ScreenshotBatchOptions struct {
	// OutputPattern is the image2 output pattern, e.g. /tmp/dir/%05d.bmp
	OutputPattern string
	OutputType    ScreenshotOutputType

	// Interval is the time in seconds between captured frames.
	Interval float64

	// MaxFrames caps the number of frames captured. If 0, no cap is applied.
	MaxFrames int

	// Width is the width to scale the screenshots to. If 0, no scaling will be applied.
	Width int
	// Height is the height to scale the screenshots to. If 0, no scaling will be applied.
	// Not used if Width is set.
	Height int

	// Verbosity is the logging verbosity. Defaults to LogLevelError if not set.
	Verbosity ffmpeg.LogLevel
}

// ScreenshotBatch captures a frame every Interval seconds in a single
// sequential decode pass. It is far cheaper than repeated accurate seeks
// for files where fast (input) seeking is unreliable.
func ScreenshotBatch(input string, options ScreenshotBatchOptions) ffmpeg.Args {
	if options.Verbosity == "" {
		options.Verbosity = ffmpeg.LogLevelError
	}

	var args ffmpeg.Args
	args = args.LogLevel(options.Verbosity)
	args = args.Overwrite()
	args = args.ErrDetectIgnore()
	args = args.Input(input)

	if options.MaxFrames > 0 {
		args = args.VideoFrames(options.MaxFrames)
	}

	var vf ffmpeg.VideoFilter
	vf = vf.Append(fmt.Sprintf("fps=1/%f", options.Interval))
	if options.Width > 0 {
		vf = vf.ScaleWidth(options.Width)
	} else if options.Height > 0 {
		vf = vf.ScaleHeight(options.Height)
	}
	args = args.VideoFilter(vf)

	args = args.AppendArgs(options.OutputType)
	args = args.Output(options.OutputPattern)

	return args
}

// ScreenshotFrame uses the select filter to get a single frame from the video.
// It is very slow and should only be used for files with very small duration in secs / frame count.
func ScreenshotFrame(input string, frame int, options ScreenshotOptions) ffmpeg.Args {
	options.setDefaults()

	var args ffmpeg.Args
	args = args.LogLevel(options.Verbosity)
	args = args.Overwrite()
	args = args.ErrDetectIgnore()

	args = args.Input(input)

	args = args.VideoFrames(1)

	args = args.VSync(ffmpeg.VSyncMethodPassthrough)

	var vf ffmpeg.VideoFilter
	// keep only frame number options.Frame)
	vf = vf.Select(frame)

	if options.Width > 0 {
		vf = vf.ScaleWidth(options.Width)
	}

	args = args.VideoFilter(vf)

	args = args.AppendArgs(options.OutputType)
	args = args.Output(options.OutputPath)

	return args
}
