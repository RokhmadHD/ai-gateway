package tui

import "github.com/tensanq/proxy-scraper/internal/model"

type phase int

const (
	phaseIdle phase = iota
	phaseScraping
	phaseChecking
	phaseGeoIP
	phaseDone
	phaseError
)

func (p phase) String() string {
	switch p {
	case phaseScraping:
		return "scraping sources"
	case phaseChecking:
		return "checking liveness"
	case phaseGeoIP:
		return "resolving geoip"
	case phaseDone:
		return "done"
	case phaseError:
		return "error"
	default:
		return "idle"
	}
}

// ── Messages sent by the background pipeline goroutine ──────────────────

type phaseMsg struct{ phase phase }

type sourceListMsg struct{ names []string }

type sourceStartMsg struct{ name string }

type sourceDoneMsg struct {
	name  string
	count int
	err   error
}

type scrapeDoneMsg struct{ total int }

type checkProgressMsg struct {
	done, total int64
	alive       int
}

type checkResultMsg struct{ p model.Proxy }

type checkDoneMsg struct{ alive int }

type geoipProgressMsg struct{ done, total int }

type allDoneMsg struct {
	proxies   []model.Proxy
	outFile   string
	saveError error
}

type fatalMsg struct{ err error }
