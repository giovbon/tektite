package main

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCreateNoteNotifiesChangeSubscribers(t *testing.T) {
	app := newTestApp(t)
	changes, unsubscribe := app.subscribeChanges()
	defer unsubscribe()

	if _, err := app.CreateNote(Note{Title: "captura ntfy", Folder: "Inbox"}); err != nil {
		t.Fatalf("create note: %v", err)
	}

	select {
	case revision := <-changes:
		if revision == 0 {
			t.Fatal("change notification carried revision 0")
		}
	case <-time.After(time.Second):
		t.Fatal("note creation did not notify subscribers")
	}
}

func TestFolderTreeReportsCurrentRevision(t *testing.T) {
	app := newTestApp(t)
	app.notifyChange()

	response := performJSONRequest(t, app.Handler(t.TempDir()), http.MethodGet, "/api/folders", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("folder tree status = %d", response.Code)
	}
	if revision := response.Header().Get("X-Notes-Revision"); revision != "1" {
		t.Fatalf("folder tree revision = %q, want 1", revision)
	}
}

func TestEventsHandlerStreamsTreeEvents(t *testing.T) {
	app := newTestApp(t)
	server := httptest.NewServer(app.Handler(t.TempDir()))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("open event stream: %v", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		t.Fatalf("event stream status = %d", response.StatusCode)
	}
	if contentType := response.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "text/event-stream") {
		t.Fatalf("event stream content type = %q", contentType)
	}

	lines := make(chan string, 32)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(response.Body)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()

	waitForLine := func(want string, prefix bool) {
		t.Helper()
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		for {
			select {
			case line, ok := <-lines:
				if !ok {
					t.Fatalf("event stream closed before %q", want)
				}
				if line == want || (prefix && strings.HasPrefix(line, want)) {
					return
				}
			case <-timer.C:
				t.Fatalf("timed out waiting for %q", want)
			}
		}
	}

	waitForLine("retry: 2000", false)
	app.notifyChange()
	waitForLine("event: tree", false)
	waitForLine(`data: {"revision":1}`, false)
}
