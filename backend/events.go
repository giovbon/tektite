package main

import (
	"fmt"
	"io"
	"net/http"
	"time"
)

// The app keeps one lightweight event stream per open browser tab. Tree
// changes are coalesced because a single refresh is enough for any number of
// notes created in a burst (for example, while a backup is restored).
//
// Every notification carries a revision number. Browsers also receive the
// current revision when they load the folder tree, so they can discard the
// echo of a change they have already fetched themselves.
const (
	eventStreamHeartbeat = 25 * time.Second
	eventStreamBuffer    = 1
)

func (a *App) subscribeChanges() (<-chan uint64, func()) {
	changes := make(chan uint64, eventStreamBuffer)

	a.eventsMu.Lock()
	if a.events == nil {
		a.events = make(map[chan uint64]struct{})
	}
	a.events[changes] = struct{}{}
	a.eventsMu.Unlock()

	return changes, func() {
		a.eventsMu.Lock()
		delete(a.events, changes)
		a.eventsMu.Unlock()
	}
}

func (a *App) notifyChange() {
	a.eventsMu.Lock()
	defer a.eventsMu.Unlock()

	a.eventsSeq++
	revision := a.eventsSeq
	for changes := range a.events {
		// Keep only the newest revision: a pending older one is redundant.
		select {
		case changes <- revision:
		default:
			select {
			case <-changes:
			default:
			}
			select {
			case changes <- revision:
			default:
			}
		}
	}
}

func (a *App) currentRevision() uint64 {
	a.eventsMu.Lock()
	defer a.eventsMu.Unlock()
	return a.eventsSeq
}

func (a *App) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}

	controller := http.NewResponseController(w)
	// The server has a global write timeout, but an event stream is expected
	// to stay open indefinitely. Clear the deadline for this connection.
	_ = controller.SetWriteDeadline(time.Time{})

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")

	changes, unsubscribe := a.subscribeChanges()
	defer unsubscribe()

	if _, err := io.WriteString(w, "retry: 2000\n\n"); err != nil {
		return
	}
	if err := controller.Flush(); err != nil {
		return
	}

	heartbeat := time.NewTicker(eventStreamHeartbeat)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": keep-alive\n\n"); err != nil {
				return
			}
			if err := controller.Flush(); err != nil {
				return
			}
		case revision := <-changes:
			if _, err := fmt.Fprintf(w, "event: tree\ndata: {\"revision\":%d}\n\n", revision); err != nil {
				return
			}
			if err := controller.Flush(); err != nil {
				return
			}
		}
	}
}
