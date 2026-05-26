package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/mattn/go-isatty"

	"github.com/tensanq/proxy-scraper/internal/checker"
	"github.com/tensanq/proxy-scraper/internal/geoip"
	"github.com/tensanq/proxy-scraper/internal/model"
	"github.com/tensanq/proxy-scraper/internal/scraper"
	"github.com/tensanq/proxy-scraper/internal/tui"
)

func main() {
	var (
		typesArg   = flag.String("types", "http,socks4,socks5", "comma-separated proxy types to include")
		doCheck    = flag.Bool("check", true, "test each proxy for liveness")
		doGeo      = flag.Bool("geoip", true, "resolve country/city via ip-api.com")
		onlyAlive  = flag.Bool("alive-only", false, "output only proxies that passed the live check")
		conc       = flag.Int("concurrency", 200, "number of concurrent liveness checks")
		timeoutDur = flag.Duration("timeout", 8*time.Second, "per-proxy check timeout")
		target     = flag.String("target", "https://api.ipify.org", "URL used to validate a proxy")
		outFile    = flag.String("out", "proxies.json", "output file (.json / .txt / .csv inferred from extension)")
		quiet      = flag.Bool("quiet", false, "suppress progress logs (text mode only)")
		progress   = flag.Bool("progress", false, "emit newline-delimited JSON progress events to stderr")
		useTUI     = flag.String("tui", "auto", "TUI mode: auto | on | off")
	)
	flag.Parse()

	types := parseTypes(*typesArg)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	tuiOn := false
	switch *useTUI {
	case "on":
		tuiOn = true
	case "off":
		tuiOn = false
	default:
		tuiOn = isatty.IsTerminal(os.Stdout.Fd())
	}

	opts := tui.Options{
		Types:       types,
		Check:       *doCheck,
		GeoIP:       *doGeo,
		AliveOnly:   *onlyAlive,
		Concurrency: *conc,
		Timeout:     *timeoutDur,
		Target:      *target,
		OutFile:     *outFile,
	}

	if tuiOn {
		runTUI(ctx, opts)
		return
	}
	runHeadless(ctx, opts, *quiet, *progress)
}

func runTUI(ctx context.Context, opts tui.Options) {
	_, proxies, err := tui.Run(ctx, opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tui error: %v\n", err)
		os.Exit(1)
	}
	if len(proxies) == 0 {
		fmt.Fprintln(os.Stderr, "no proxies collected")
		return
	}
	if err := writeOutput(opts.OutFile, proxies); err != nil {
		fmt.Fprintf(os.Stderr, "write %s: %v\n", opts.OutFile, err)
		os.Exit(1)
	}
	alive := 0
	for _, p := range proxies {
		if p.Alive {
			alive++
		}
	}
	fmt.Printf("✓ %d proxies (%d alive) saved to %s\n", len(proxies), alive, opts.OutFile)
}

func runHeadless(ctx context.Context, opts tui.Options, quiet bool, progress bool) {
	logger := os.Stderr
	if quiet {
		f, _ := os.Open(os.DevNull)
		logger = f
	}
	scraper.SetLogger(logger)
	events := newProgressEmitter(os.Stderr, progress)

	fmt.Fprintln(logger, "→ scraping sources...")
	scrapers := scraper.Default(opts.Types)
	events.emit("phase", map[string]any{
		"name":          "scraping",
		"sources_total": len(scrapers),
	})
	var sourceMu sync.Mutex
	sourcesDone := 0
	proxies := scraper.RunAll(ctx, scrapers, scraper.Progress{
		OnSourceDone: func(name string, count int, err error) {
			sourceMu.Lock()
			sourcesDone++
			done := sourcesDone
			sourceMu.Unlock()
			evt := map[string]any{
				"name":  name,
				"count": count,
				"done":  done,
				"total": len(scrapers),
			}
			if err != nil {
				evt["err"] = err.Error()
			}
			events.emit("source_done", evt)
		},
	})
	fmt.Fprintf(logger, "→ scraped %d unique proxies from %d sources\n", len(proxies), len(scrapers))
	events.emit("phase", map[string]any{"name": "scraped"})

	if opts.Check {
		fmt.Fprintln(logger, "→ checking liveness...")
		events.emit("phase", map[string]any{
			"name":        "checking",
			"check_total": len(proxies),
		})
		copts := checker.DefaultOptions()
		copts.Concurrency = opts.Concurrency
		copts.Timeout = opts.Timeout
		copts.TargetURL = opts.Target
		copts.Logger = logger
		var aliveMu sync.Mutex
		alive := 0
		copts.OnResult = func(p model.Proxy) {
			if !p.Alive {
				return
			}
			aliveMu.Lock()
			alive++
			aliveMu.Unlock()
		}
		copts.OnProgress = func(done, total int64) {
			aliveMu.Lock()
			currentAlive := alive
			aliveMu.Unlock()
			events.emit("check_progress", map[string]any{
				"done":  done,
				"total": total,
				"alive": currentAlive,
			})
		}
		proxies = checker.Check(ctx, proxies, copts)

		alive = 0
		for _, p := range proxies {
			if p.Alive {
				alive++
			}
		}
		fmt.Fprintf(logger, "→ alive: %d / %d\n", alive, len(proxies))
		events.emit("phase", map[string]any{
			"name":  "checked",
			"alive": alive,
		})
	}

	if opts.AliveOnly {
		proxies = filterAlive(proxies)
	}

	if opts.GeoIP && len(proxies) > 0 {
		fmt.Fprintln(logger, "→ resolving geoip...")
		events.emit("phase", map[string]any{"name": "geoip"})
		proxies = geoip.Lookup(ctx, proxies, logger, nil)
	}

	sort.Slice(proxies, func(i, j int) bool {
		if proxies[i].Alive != proxies[j].Alive {
			return proxies[i].Alive
		}
		return proxies[i].Latency < proxies[j].Latency
	})

	events.emit("phase", map[string]any{"name": "writing"})
	if err := writeOutput(opts.OutFile, proxies); err != nil {
		fmt.Fprintf(os.Stderr, "write %s: %v\n", opts.OutFile, err)
		os.Exit(1)
	}
	fmt.Fprintf(logger, "→ wrote %d proxies to %s\n", len(proxies), opts.OutFile)
	events.emit("done", map[string]any{"count": len(proxies)})
}

type progressEmitter struct {
	enabled bool
	enc     *json.Encoder
	mu      sync.Mutex
}

func newProgressEmitter(w *os.File, enabled bool) *progressEmitter {
	return &progressEmitter{
		enabled: enabled,
		enc:     json.NewEncoder(w),
	}
}

func (e *progressEmitter) emit(event string, fields map[string]any) {
	if !e.enabled {
		return
	}
	fields["event"] = event
	e.mu.Lock()
	defer e.mu.Unlock()
	_ = e.enc.Encode(fields)
}

func parseTypes(s string) []model.ProxyType {
	var out []model.ProxyType
	for _, raw := range strings.Split(s, ",") {
		t := strings.ToLower(strings.TrimSpace(raw))
		switch t {
		case "http":
			out = append(out, model.HTTP)
		case "https":
			out = append(out, model.HTTPS)
		case "socks4":
			out = append(out, model.SOCKS4)
		case "socks5":
			out = append(out, model.SOCKS5)
		}
	}
	return out
}

func filterAlive(in []model.Proxy) []model.Proxy {
	out := in[:0]
	for _, p := range in {
		if p.Alive {
			out = append(out, p)
		}
	}
	return out
}

func writeOutput(path string, proxies []model.Proxy) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	switch {
	case strings.HasSuffix(path, ".json"):
		enc := json.NewEncoder(f)
		enc.SetIndent("", "  ")
		return enc.Encode(proxies)

	case strings.HasSuffix(path, ".csv"):
		w := csv.NewWriter(f)
		_ = w.Write([]string{"ip", "port", "type", "alive", "latency_ms", "country", "country_code", "city", "isp", "source"})
		for _, p := range proxies {
			_ = w.Write([]string{
				p.IP,
				fmt.Sprintf("%d", p.Port),
				string(p.Type),
				fmt.Sprintf("%t", p.Alive),
				fmt.Sprintf("%d", p.Latency.Milliseconds()),
				p.Country,
				p.CountryCode,
				p.City,
				p.ISP,
				p.Source,
			})
		}
		w.Flush()
		return w.Error()

	default: // .txt
		for _, p := range proxies {
			fmt.Fprintf(f, "%s://%s:%d", p.Type, p.IP, p.Port)
			if p.CountryCode != "" {
				fmt.Fprintf(f, " | %s", p.CountryCode)
			}
			switch {
			case p.CheckedAt.IsZero():
				// liveness check disabled — no status to print
			case p.Alive:
				fmt.Fprintf(f, " | %dms", p.Latency.Milliseconds())
			default:
				fmt.Fprintf(f, " | DEAD")
			}
			fmt.Fprintln(f)
		}
		return nil
	}
}
