package tui

import "github.com/charmbracelet/lipgloss"

var (
	colPrimary = lipgloss.Color("#7CFFB2")
	colAccent  = lipgloss.Color("#FFB86C")
	colMuted   = lipgloss.Color("#6272A4")
	colError   = lipgloss.Color("#FF5555")
	colInfo    = lipgloss.Color("#8BE9FD")
	colDim     = lipgloss.Color("#44475A")
	colFg      = lipgloss.Color("#F8F8F2")

	titleStyle = lipgloss.NewStyle().
			Foreground(colPrimary).
			Bold(true).
			Padding(0, 1)

	phaseStyle = lipgloss.NewStyle().
			Foreground(colAccent).
			Bold(true)

	statKeyStyle = lipgloss.NewStyle().
			Foreground(colMuted).
			Width(14)

	statValStyle = lipgloss.NewStyle().
			Foreground(colFg).
			Bold(true)

	okStyle   = lipgloss.NewStyle().Foreground(colPrimary)
	warnStyle = lipgloss.NewStyle().Foreground(colAccent)
	errStyle  = lipgloss.NewStyle().Foreground(colError)
	dimStyle  = lipgloss.NewStyle().Foreground(colDim)
	infoStyle = lipgloss.NewStyle().Foreground(colInfo)

	panelStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colDim).
			Padding(0, 1)

	footerStyle = lipgloss.NewStyle().
			Foreground(colMuted).
			Padding(0, 1)
)
