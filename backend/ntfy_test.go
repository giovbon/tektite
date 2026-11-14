package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRepresentativeTitleUsesMessageAndAttachmentNames(t *testing.T) {
	message := "Reunião de planejamento do orçamento de marketing. O orçamento precisa de aprovação."
	title := representativeTitle(message, []string{"planilha_orcamento_marketing.xlsx"}, "fallback")

	for _, expected := range []string{"planejamento", "orçamento", "marketing"} {
		if !strings.Contains(strings.ToLower(title), expected) {
			t.Fatalf("title = %q, want it to mention %q", title, expected)
		}
	}
	if words := strings.Fields(title); len(words) != 3 {
		t.Fatalf("title = %q, want 3 representative words", title)
	}
	if strings.Contains(strings.ToLower(title), "reunião") {
		t.Fatalf("title = %q should have dropped the less representative word", title)
	}
	if !strings.HasPrefix(title, "Planejamento") {
		t.Fatalf("title = %q, want the first selected word capitalized", title)
	}
}

func TestRepresentativeTitleHandlesRealisticCapture(t *testing.T) {
	title := representativeTitle(
		"Boleto do condomínio vence sexta-feira. Segue o boleto em anexo.",
		[]string{"boleto_condominio_setembro.pdf"},
		"fallback",
	)
	if title != "Boleto condomínio setembro" {
		t.Fatalf("title = %q, want %q", title, "Boleto condomínio setembro")
	}
}

func TestRepresentativeTitleIgnoresStopwordsAndFallsBack(t *testing.T) {
	title := representativeTitle("Preciso comprar leite e pão amanhã, por favor.", []string{"lista_compras.txt"}, "fallback")
	if strings.Contains(strings.ToLower(title), "preciso") ||
		strings.Contains(strings.ToLower(title), "amanhã") ||
		strings.Contains(strings.ToLower(title), "favor") {
		t.Fatalf("title = %q contains stopwords", title)
	}
	for _, expected := range []string{"leite", "lista", "compras"} {
		if !strings.Contains(strings.ToLower(title), expected) {
			t.Fatalf("title = %q, want it to mention %q", title, expected)
		}
	}

	if got := representativeTitle("", nil, "Captura ntfy 2026-11-14 10-10"); got != "Captura ntfy 2026-11-14 10-10" {
		t.Fatalf("empty message title = %q, want fallback", got)
	}
	if got := representativeTitle("oi, tudo bem?", nil, "Captura ntfy"); got != "Captura ntfy" {
		t.Fatalf("stopword-only message title = %q, want fallback", got)
	}
}

func TestNtfyCaptureStoresOneNoteInInboxWithAttachment(t *testing.T) {
	eventTime := time.Now().Add(time.Minute).Unix()
	attachmentBytes := []byte("image bytes")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/inbox/json":
			if r.URL.Query().Get("since") == "" {
				t.Errorf("ntfy subscription is missing the since parameter")
			}
			event := ntfyEvent{
				ID:      "Msg1",
				Time:    eventTime,
				Event:   "message",
				Topic:   "inbox",
				Title:   "Orçamento",
				Message: "Reunião de planejamento do orçamento de marketing",
				Attachment: ntfyAttachment{
					Name: "planilha_orcamento_marketing.png",
					Type: "image/png",
					URL:  serverURL(r) + "/file",
					Size: int64(len(attachmentBytes)),
				},
			}
			if err := json.NewEncoder(w).Encode(event); err != nil {
				t.Errorf("encode event: %v", err)
			}
		case "/file":
			_, _ = w.Write(attachmentBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	monitor, err := NewNtfyMonitor(app, NtfyConfig{
		Enabled:   true,
		ServerURL: server.URL,
		Topic:     "inbox",
		Folder:    "Inbox",
		Tags:      []string{"ntfy", "captura"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := monitor.listen(context.Background()); err == nil {
		t.Fatal("listen returned nil after the stream ended, want EOF")
	}

	page, err := app.ListNotes("Inbox", "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Items) != 1 {
		t.Fatalf("Inbox notes = %#v, want one captured note", page)
	}
	note, err := app.GetNote(page.Items[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if note.Folder != "Inbox" {
		t.Fatalf("note folder = %q, want Inbox", note.Folder)
	}
	if !strings.Contains(strings.ToLower(note.Title), "orçamento") {
		t.Fatalf("note title = %q, want representative words from message and attachment", note.Title)
	}
	for _, expected := range []string{
		"Reunião de planejamento do orçamento de marketing",
		"Capturado em ",
		"![planilha_orcamento_marketing.png](",
	} {
		if !strings.Contains(note.Content, expected) {
			t.Fatalf("captured note content is missing %q:\n%s", expected, note.Content)
		}
	}
	if got, want := strings.Join(note.Tags, ","), "ntfy,captura"; got != want {
		t.Fatalf("note tags = %q, want %q", got, want)
	}
	attachments, err := app.ListAttachments(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attachments) != 1 || attachments[0].Filename != "planilha_orcamento_marketing.png" {
		t.Fatalf("attachments = %#v, want the ntfy attachment", attachments)
	}
	_, filePath, err := app.GetAttachment(note.ID, attachments[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	storedBytes, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(storedBytes) != string(attachmentBytes) {
		t.Fatalf("stored attachment = %q, want %q", storedBytes, attachmentBytes)
	}
	if filepath.Base(filePath) == "" {
		t.Fatalf("attachment storage path is empty")
	}

	// A new monitor instance must load the persisted state and ignore the
	// same event when the stream is replayed.
	secondMonitor, err := NewNtfyMonitor(app, NtfyConfig{
		Enabled:   true,
		ServerURL: server.URL,
		Topic:     "inbox",
		Folder:    "Inbox",
		Tags:      []string{"ntfy", "captura"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := secondMonitor.listen(context.Background()); err == nil {
		t.Fatal("listen returned nil after the stream ended, want EOF")
	}
	page, err = app.ListNotes("Inbox", "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 {
		t.Fatalf("Inbox notes after replay = %d, want the capture to remain idempotent", page.Total)
	}
}

func TestNtfyDoesNotImportHistoricalMessagesOnFirstRun(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		event := ntfyEvent{
			ID:      "Old1",
			Time:    1700000000,
			Event:   "message",
			Topic:   "inbox",
			Message: "mensagem antiga sobre viagem",
		}
		if err := json.NewEncoder(w).Encode(event); err != nil {
			t.Errorf("encode event: %v", err)
		}
	}))
	defer server.Close()

	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	monitor, err := NewNtfyMonitor(app, NtfyConfig{
		Enabled:   true,
		ServerURL: server.URL,
		Topic:     "inbox",
		Folder:    "Inbox",
		Tags:      []string{"ntfy"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := monitor.listen(context.Background()); err == nil {
		t.Fatal("listen returned nil after the stream ended, want EOF")
	}
	page, err := app.ListNotes("", "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 0 {
		t.Fatalf("historical messages were imported: %#v", page)
	}
}

func TestLoadNtfyConfigDefaults(t *testing.T) {
	t.Setenv("NTFY_ENABLED", "true")
	t.Setenv("NTFY_SERVER_URL", "")
	t.Setenv("NTFY_TOPIC", "inbox")
	t.Setenv("NTFY_USERNAME", "")
	t.Setenv("NTFY_PASSWORD", "")
	t.Setenv("NTFY_FOLDER", "")
	t.Setenv("NTFY_TAGS", "")

	config, err := LoadNtfyConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !config.Enabled || config.ServerURL != "https://ntfy.sh" || config.Topic != "inbox" {
		t.Fatalf("ntfy config = %#v, want enabled defaults", config)
	}
	if config.Folder != "Inbox" || strings.Join(config.Tags, ",") != "ntfy" {
		t.Fatalf("ntfy folder/tags = %q/%v, want Inbox/[ntfy]", config.Folder, config.Tags)
	}

	// Public topic (no authentication)
	t.Setenv("NTFY_ENABLED", "false")
	config, err = LoadNtfyConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.Enabled {
		// Should be disabled
	}

	// Protected topic (with authentication)
	t.Setenv("NTFY_ENABLED", "true")
	t.Setenv("NTFY_USERNAME", "myuser")
	t.Setenv("NTFY_PASSWORD", "mypass")
	config, err = LoadNtfyConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !config.Enabled || config.Username != "myuser" || config.Password != "mypass" {
		t.Fatalf("protected config not loaded correctly: %#v", config)
	}

	t.Setenv("NTFY_ENABLED", "not-a-bool")
	if _, err := LoadNtfyConfig(); err == nil {
		t.Fatal("LoadNtfyConfig accepted an invalid boolean")
	}
}

func TestNewNtfyMonitorRejectsUnsafeConfiguration(t *testing.T) {
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	tests := []struct {
		name   string
		config NtfyConfig
	}{
		{
			name: "invalid server scheme",
			config: NtfyConfig{
				Enabled: true, ServerURL: "file:///tmp", Topic: "inbox", Folder: "Inbox", Tags: []string{"ntfy"},
			},
		},
		{
			name: "topic path traversal",
			config: NtfyConfig{
				Enabled: true, ServerURL: "https://ntfy.example", Topic: "../inbox", Folder: "Inbox", Tags: []string{"ntfy"},
			},
		},
		{
			name: "folder path traversal",
			config: NtfyConfig{
				Enabled: true, ServerURL: "https://ntfy.example", Topic: "inbox", Folder: "../outside", Tags: []string{"ntfy"},
			},
		},
		{
			name: "missing password",
			config: NtfyConfig{
				Enabled: true, ServerURL: "https://ntfy.example", Topic: "inbox", Username: "user", Folder: "Inbox", Tags: []string{"ntfy"},
			},
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := NewNtfyMonitor(app, testCase.config); err == nil {
				t.Fatal("NewNtfyMonitor succeeded, want a configuration error")
			}
		})
	}
}

func serverURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s", scheme, r.Host)
}
