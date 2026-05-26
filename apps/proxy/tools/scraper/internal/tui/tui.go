package tui

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/tensanq/proxy-scraper/internal/checker"
	"github.com/tensanq/proxy-scraper/internal/geoip"
	"github.com/tensanq/proxy-scraper/internal/model"
	"github.com/tensanq/proxy-scraper/internal/scraper"
)

const maxAliveRows = 25

// Options mirror the CLI flags but are passed via struct so the TUI does
// not depend on the flag package.
type Options struct {
	Types       []model.ProxyType
	Check       bool
	GeoIP       bool
	AliveOnly   bool
	Concurrency int
	Timeout     time.Duration
	Target      string
	OutFile     string
}

type sourceState int

const (
	srcPending sourceState = iota
	srcRunning
	srcDone
	srcError
)

type sourceStatus struct {
	name  string
	state sourceState
	count int
	err   error
}

type Model struct {
	opts Options

	phase phase
	start time.Time

	width, height int

	spinner  spinner.Model
	progress progress.Model

	sources    []sourceStatus
	sourceIdx  map[string]int
	scrapedTot int

	checked    int64
	checkTotal int64
	alive      int

	geoDone, geoTotal int

	aliveTop []model.Proxy

	finalProxies []model.Proxy
	outFile      string
	saveErr      error
	fatalErr     error

	quitting bool
}

func newModel(opts Options) *Model {
	sp := spinner.New(spinner.WithSpinner(spinner.Dot))
	sp.Style = lipgloss.NewStyle().Foreground(colAccent)

	pr := progress.New(progress.WithDefaultGradient(), progress.WithoutPercentage())
	pr.Width = 40

	return &Model{
		opts:      opts,
		phase:     phaseIdle,
		start:     time.Now(),
		spinner:   sp,
		progress:  pr,
		sourceIdx: map[string]int{},
	}
}

// Run launches the TUI and runs the scraping pipeline concurrently.
// Returns the saved-output path, the resulting proxies, and any error.
func Run(ctx context.Context, opts Options) (string, []model.Proxy, error) {
	m := newModel(opts)
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithContext(ctx))

	go runPipeline(ctx, p, opts)

	final, err := p.Run()
	if err != nil {
		return "", nil, err
	}
	mm := final.(*Model)
	if mm.fatalErr != nil {
		return "", nil, mm.fatalErr
	}
	return mm.outFile, mm.finalProxies, mm.saveErr
}

// ── tea.Model implementation ─────────────────────────────────────────────

func (m *Model) Init() tea.Cmd {
	return tea.Batch(m.spinner.Tick)
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		barW := msg.Width - 30
		if barW < 20 {
			barW = 20
		}
		if barW > 80 {
			barW = 80
		}
		m.progress.Width = barW
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q":
			m.quitting = true
			return m, tea.Quit
		}

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd

	case phaseMsg:
		m.phase = msg.phase
		if msg.phase == phaseDone || msg.phase == phaseError {
			return m, nil
		}
		return m, nil

	case sourceListMsg:
		m.sources = make([]sourceStatus, len(msg.names))
		for i, n := range msg.names {
			m.sources[i] = sourceStatus{name: n, state: srcPending}
			m.sourceIdx[n] = i
		}
		return m, nil

	case sourceStartMsg:
		if i, ok := m.sourceIdx[msg.name]; ok {
			m.sources[i].state = srcRunning
		}
		return m, nil

	case sourceDoneMsg:
		if i, ok := m.sourceIdx[msg.name]; ok {
			m.sources[i].count = msg.count
			if msg.err != nil {
				m.sources[i].state = srcError
				m.sources[i].err = msg.err
			} else {
				m.sources[i].state = srcDone
			}
		}
		return m, nil

	case scrapeDoneMsg:
		m.scrapedTot = msg.total
		return m, nil

	case checkProgressMsg:
		m.checked = msg.done
		m.checkTotal = msg.total
		m.alive = msg.alive
		pct := 0.0
		if msg.total > 0 {
			pct = float64(msg.done) / float64(msg.total)
		}
		cmd := m.progress.SetPercent(pct)
		return m, cmd

	case checkResultMsg:
		if msg.p.Alive {
			m.insertAlive(msg.p)
		}
		return m, nil

	case checkDoneMsg:
		m.alive = msg.alive
		return m, nil

	case geoipProgressMsg:
		m.geoDone = msg.done
		m.geoTotal = msg.total
		pct := 0.0
		if msg.total > 0 {
			pct = float64(msg.done) / float64(msg.total)
		}
		cmd := m.progress.SetPercent(pct)
		return m, cmd

	case allDoneMsg:
		m.phase = phaseDone
		m.finalProxies = msg.proxies
		m.outFile = msg.outFile
		m.saveErr = msg.saveError
		return m, tea.Quit

	case fatalMsg:
		m.phase = phaseError
		m.fatalErr = msg.err
		return m, tea.Quit

	case progress.FrameMsg:
		newProg, cmd := m.progress.Update(msg)
		m.progress = newProg.(progress.Model)
		return m, cmd
	}

	return m, nil
}

// insertAlive maintains a sorted (by latency asc) top-N alive list.
func (m *Model) insertAlive(p model.Proxy) {
	m.aliveTop = append(m.aliveTop, p)
	sort.Slice(m.aliveTop, func(i, j int) bool {
		return m.aliveTop[i].Latency < m.aliveTop[j].Latency
	})
	if len(m.aliveTop) > maxAliveRows {
		m.aliveTop = m.aliveTop[:maxAliveRows]
	}
}

// ── View ─────────────────────────────────────────────────────────────────

func (m *Model) View() string {
	if m.quitting {
		return ""
	}
	if m.fatalErr != nil {
		return errStyle.Render("✗ error: "+m.fatalErr.Error()) + "\n"
	}

	var sections []string
	sections = append(sections, m.header())
	sections = append(sections, m.statsAndSources())

	switch m.phase {
	case phaseChecking, phaseGeoIP, phaseDone:
		sections = append(sections, m.progressBar())
	}
	if len(m.aliveTop) > 0 || m.phase == phaseDone {
		sections = append(sections, m.aliveTable())
	}
	sections = append(sections, m.footer())

	return lipgloss.JoinVertical(lipgloss.Left, sections...)
}

func (m *Model) header() string {
	title := titleStyle.Render("⚡ proxy-scraper")
	phaseLabel := phaseStyle.Render(m.phase.String())
	if m.phase != phaseDone && m.phase != phaseError {
		phaseLabel = m.spinner.View() + " " + phaseLabel
	} else if m.phase == phaseDone {
		phaseLabel = okStyle.Render("✓ ") + phaseLabel
	}
	elapsed := dimStyle.Render(fmtDuration(time.Since(m.start)))
	left := lipgloss.JoinHorizontal(lipgloss.Left, title, "  ", phaseLabel)
	gap := m.width - lipgloss.Width(left) - lipgloss.Width(elapsed)
	if gap < 1 {
		gap = 1
	}
	return left + strings.Repeat(" ", gap) + elapsed
}

func (m *Model) statsAndSources() string {
	// Left: sources list. Right: stat key/value.
	var srcLines []string
	srcLines = append(srcLines, lipgloss.NewStyle().Bold(true).Render(fmt.Sprintf("Sources (%d)", len(m.sources))))
	if len(m.sources) == 0 {
		srcLines = append(srcLines, dimStyle.Render("  …discovering"))
	}
	for _, s := range m.sources {
		var icon, name, count string
		switch s.state {
		case srcPending:
			icon = dimStyle.Render("○")
			name = dimStyle.Render(s.name)
		case srcRunning:
			icon = warnStyle.Render("◐")
			name = s.name
		case srcDone:
			icon = okStyle.Render("✓")
			name = s.name
			count = dimStyle.Render(fmt.Sprintf("%d", s.count))
		case srcError:
			icon = errStyle.Render("✗")
			name = errStyle.Render(s.name)
		}
		row := fmt.Sprintf("%s %-32s %s", icon, truncate(name, 32), count)
		srcLines = append(srcLines, row)
	}
	leftBlock := panelStyle.Width(maxInt(46, m.width/2-2)).Render(strings.Join(srcLines, "\n"))

	stats := []string{
		lipgloss.NewStyle().Bold(true).Render("Stats"),
		statRow("Scraped", fmt.Sprintf("%d", m.scrapedTot)),
		statRow("Checked", fmt.Sprintf("%d / %d", m.checked, m.checkTotal)),
		statRow("Alive", okStyle.Render(fmt.Sprintf("%d", m.alive))),
	}
	if m.opts.GeoIP {
		stats = append(stats, statRow("GeoIP", fmt.Sprintf("%d / %d", m.geoDone, m.geoTotal)))
	}
	stats = append(stats, statRow("Out file", m.opts.OutFile))
	rightBlock := panelStyle.Width(maxInt(36, m.width/2-2)).Render(strings.Join(stats, "\n"))

	return lipgloss.JoinHorizontal(lipgloss.Top, leftBlock, "  ", rightBlock)
}

func statRow(k, v string) string {
	return statKeyStyle.Render(k) + statValStyle.Render(v)
}

func (m *Model) progressBar() string {
	var label string
	var rate float64
	switch m.phase {
	case phaseChecking:
		elapsed := time.Since(m.start).Seconds()
		if elapsed > 0 {
			rate = float64(m.checked) / elapsed
		}
		label = fmt.Sprintf("Checking  %d/%d  •  %d alive  •  %.0f/s", m.checked, m.checkTotal, m.alive, rate)
	case phaseGeoIP:
		label = fmt.Sprintf("GeoIP  %d/%d IPs", m.geoDone, m.geoTotal)
	case phaseDone:
		label = okStyle.Render(fmt.Sprintf("Done — %d alive proxies", m.alive))
	}
	return panelStyle.Width(m.width - 4).Render(label + "\n" + m.progress.View())
}

func (m *Model) aliveTable() string {
	header := dimStyle.Render(fmt.Sprintf("%-7s %-22s %-3s %-8s %s", "TYPE", "ADDRESS", "CC", "LATENCY", "SOURCE"))
	rows := []string{header}
	for _, p := range m.aliveTop {
		cc := p.CountryCode
		if cc == "" {
			cc = "?"
		}
		lat := fmt.Sprintf("%dms", p.Latency.Milliseconds())
		row := fmt.Sprintf("%-7s %-22s %-3s %-8s %s",
			p.Type, p.Addr(), cc, lat, truncate(p.Source, 30))
		rows = append(rows, row)
	}
	title := lipgloss.NewStyle().Bold(true).Render(
		fmt.Sprintf("Top alive (sorted by latency, %d shown)", len(m.aliveTop)))
	return panelStyle.Width(m.width - 4).Render(title + "\n" + strings.Join(rows, "\n"))
}

func (m *Model) footer() string {
	hints := "[q] quit"
	if m.phase == phaseDone {
		hints = okStyle.Render("✓ output: ") + m.outFile + "    " + hints
		if m.saveErr != nil {
			hints = errStyle.Render("save error: "+m.saveErr.Error()) + "    " + hints
		}
	}
	return footerStyle.Render(hints)
}

// ── helpers ──────────────────────────────────────────────────────────────

func truncate(s string, n int) string {
	if lipgloss.Width(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func fmtDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%.0fs", d.Seconds())
	}
	return fmt.Sprintf("%dm %ds", int(d.Minutes()), int(d.Seconds())%60)
}

// ── Pipeline runner ──────────────────────────────────────────────────────

func runPipeline(ctx context.Context, p *tea.Program, opts Options) {
	defer func() {
		if r := recover(); r != nil {
			p.Send(fatalMsg{err: fmt.Errorf("pipeline panic: %v", r)})
		}
	}()

	// Phase: scraping
	scrapers := scraper.Default(opts.Types)
	p.Send(sourceListMsg{names: scraper.SourceNames(scrapers)})
	p.Send(phaseMsg{phase: phaseScraping})

	proxies := scraper.RunAll(ctx, scrapers, scraper.Progress{
		OnSourceStart: func(name string) { p.Send(sourceStartMsg{name: name}) },
		OnSourceDone: func(name string, count int, err error) {
			p.Send(sourceDoneMsg{name: name, count: count, err: err})
		},
	})
	p.Send(scrapeDoneMsg{total: len(proxies)})

	// Phase: checking
	if opts.Check {
		p.Send(phaseMsg{phase: phaseChecking})
		var (
			aliveMu sync.Mutex
			alive   int
		)

		copts := checker.DefaultOptions()
		copts.Concurrency = opts.Concurrency
		copts.Timeout = opts.Timeout
		copts.TargetURL = opts.Target
		copts.OnResult = func(pr model.Proxy) {
			if !pr.Alive {
				return
			}
			aliveMu.Lock()
			alive++
			aliveMu.Unlock()
			p.Send(checkResultMsg{p: pr})
		}
		copts.OnProgress = func(done, total int64) {
			aliveMu.Lock()
			cur := alive
			aliveMu.Unlock()
			p.Send(checkProgressMsg{done: done, total: total, alive: cur})
		}
		proxies = checker.Check(ctx, proxies, copts)
		p.Send(checkDoneMsg{alive: alive})
	}

	if opts.AliveOnly {
		filtered := proxies[:0]
		for _, pr := range proxies {
			if pr.Alive {
				filtered = append(filtered, pr)
			}
		}
		proxies = filtered
	}

	if opts.GeoIP && len(proxies) > 0 {
		p.Send(phaseMsg{phase: phaseGeoIP})
		proxies = geoip.Lookup(ctx, proxies, nil, func(done, total int) {
			p.Send(geoipProgressMsg{done: done, total: total})
		})
	}

	sort.Slice(proxies, func(i, j int) bool {
		if proxies[i].Alive != proxies[j].Alive {
			return proxies[i].Alive
		}
		return proxies[i].Latency < proxies[j].Latency
	})

	// Save (writer is provided by caller via opts.OutFile; the actual
	// writing happens in main.go after the TUI exits so we just signal).
	p.Send(allDoneMsg{proxies: proxies, outFile: opts.OutFile})
}
